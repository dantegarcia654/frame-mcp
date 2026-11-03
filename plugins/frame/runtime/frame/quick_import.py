"""Import conversation attachments through the existing local upload pipeline."""
import http.client
import ipaddress
import json
import socket
import ssl
import tempfile
import time
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit

MAX_BYTES = 700 * 1024 * 1024


def public_target(url):
    p = urlsplit(url)
    if p.scheme != 'https' or not p.hostname or p.username or p.password or p.port not in (None, 443):
        raise ValueError('Attachment must use a public HTTPS download URL.')
    addresses = socket.getaddrinfo(p.hostname, 443, type=socket.SOCK_STREAM)
    ips = [a[4][0] for a in addresses]
    if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
        raise ValueError('Attachment URL must not address a private or local network.')
    return p, ips[0]


class PinnedHTTPS(http.client.HTTPSConnection):
    """Keep TLS hostname verification while connecting to the validated public IP."""
    def __init__(self, host, ip, timeout):
        super().__init__(host, timeout=timeout, context=ssl.create_default_context())
        self.ip = ip

    def connect(self):
        sock = socket.create_connection((self.ip, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


def download(url, output):
    deadline = time.monotonic() + 120
    for _ in range(4):
        target, ip = public_target(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('Attachment download timed out.')
        conn = PinnedHTTPS(target.hostname, ip, timeout=min(30, remaining))
        try:
            conn.request('GET', target.path + ('?' + target.query if target.query else ''),
                         headers={'Accept-Encoding': 'identity'})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if not location:
                    raise ValueError('Attachment redirect has no destination.')
                url = urljoin(url, location)
                continue  # Revalidate and pin every redirected destination.
            if response.status != 200:
                raise ValueError('Attachment unavailable or expired; attach it again.')
            length = response.getheader('Content-Length')
            if length is not None and not 0 < int(length) <= MAX_BYTES:
                raise ValueError('Attachment must be between 1 byte and 700 MB.')
            size = 0
            while True:
                if time.monotonic() >= deadline:
                    raise ValueError('Attachment download timed out.')
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError('Attachment exceeds 700 MB.')
                output.write(chunk)
            if size == 0 or (length is not None and size != int(length)):
                raise ValueError('Attachment download was incomplete.')
            return size
        finally:
            conn.close()
    raise ValueError('Too many attachment redirects.')


def upload(base, stream, name):
    stream.seek(0, 2)
    size = stream.tell()
    if not 0 < size <= MAX_BYTES:
        raise ValueError('Footage must be between 1 byte and 700 MB.')
    stream.seek(0)
    target = urlsplit(base)
    conn = http.client.HTTPConnection(target.hostname, target.port, timeout=180)
    try:
        conn.request('POST', '/upload', body=stream, headers={
            'Content-Type': 'video/mp4', 'Content-Length': str(size),
            'X-Filename': quote(Path(name).name[:180] or 'Conversation footage.mp4')})
        response = conn.getresponse()
        data = json.loads(response.read())
        if response.status != 200:
            raise ValueError(data.get('error', 'Could not import footage.'))
        pid = data['id']
        return {'project_id': pid, 'name': data.get('name', name),
                'editor_url': base + '/frame?project=' + pid,
                'status': 'imported', 'next_step': 'Open editor_url to preview and edit this footage.'}
    finally:
        conn.close()


def import_attachment(base, file):
    if not isinstance(file, dict) or not isinstance(file.get('file_id'), str) or not file['file_id']:
        raise ValueError('Pass the conversation attachment, including its file_id.')
    if not isinstance(file.get('download_url'), str) or not file['download_url']:
        raise ValueError('The host must supply a fresh attachment download_url.')
    mime = file.get('mime_type', '')
    if mime and not (mime.startswith('video/') or mime == 'application/octet-stream'):
        raise ValueError('FRAME imports video footage.')
    with tempfile.TemporaryFile() as stream:
        try:
            download(file['download_url'], stream)
        except ValueError:
            raise
        except Exception:
            # Never echo signed URL credentials from network exception messages.
            raise ValueError('Attachment download failed; request a fresh file handoff.') from None
        return upload(base, stream, file.get('file_name') or 'Conversation footage.mp4')


def import_local(base, source_path):
    if not isinstance(source_path, str) or not Path(source_path).is_absolute():
        raise ValueError('Use the absolute local video path supplied by the conversation host.')
    path = Path(source_path)
    if not path.is_file():
        raise ValueError('Conversation footage is not available at that local path.')
    with path.open('rb') as stream:
        return upload(base, stream, path.name)
