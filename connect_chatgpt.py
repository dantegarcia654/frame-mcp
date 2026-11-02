#!/usr/bin/env python3
"""Connect this copy of Frame using the official OpenAI tunnel client."""
import argparse
import getpass
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE = Path.home() / '.local' / 'share' / 'frame-mcp'

def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Frame-MCP-Setup', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)

def install_client():
    existing = shutil.which('tunnel-client')
    if existing:
        return existing
    system = {'Darwin': 'darwin', 'Linux': 'linux'}.get(platform.system())
    arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'amd64', 'AMD64': 'amd64'}.get(platform.machine())
    if not system or not arch:
        raise SystemExit('Automatic tunnel setup currently supports macOS and Linux. See the official tunnel-client releases for other platforms.')
    release = fetch_json('https://api.github.com/repos/openai/tunnel-client/releases/latest')
    name = f'tunnel-client-{release["tag_name"]}-{system}-{arch}.zip'
    asset = next(a for a in release['assets'] if a['name'] == name)
    digest = asset.get('digest', '')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
        raise SystemExit('Official release has no SHA256 digest; download and verify manually.')
    target = STATE / 'tunnel-client' / release['tag_name']
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive = target / name
    with urllib.request.urlopen(asset['browser_download_url'], timeout=120) as response, archive.open('wb') as output:
        shutil.copyfileobj(response, output)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != digest[7:]:
        raise SystemExit('Tunnel-client archive checksum mismatch.')
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            if Path(entry.filename).name != entry.filename:
                raise SystemExit('Unexpected archive layout.')
        bundle.extractall(target)
    for name in ('tunnel-client', 'cloudflared'):
        (target / name).chmod(0o755)
    return str(target / 'tunnel-client')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tunnel_id', help='Your own tunnel ID, linked to your ChatGPT workspace')
    parser.add_argument('--alias', default='frame', help='Managed tunnel runtime alias')
    args = parser.parse_args()
    if not re.fullmatch(r'tunnel_[0-9a-f]{32}', args.tunnel_id):
        parser.error('Expected tunnel_ followed by 32 lowercase hex characters.')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,40}', args.alias):
        parser.error('Alias must use letters, digits, underscore or hyphen.')
    python = ROOT / '.venv' / 'bin' / 'python'
    if not python.exists():
        raise SystemExit('Run python3 setup.py first.')
    client = install_client()
    private = STATE / 'private'
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    private.chmod(0o700)
    key_file = private / f'{args.alias}-runtime-key'
    if not key_file.exists():
        key = getpass.getpass('OpenAI runtime key (Tunnels Read + Use only): ').strip()
        if not key.startswith('sk-'):
            raise SystemExit('Expected an OpenAI runtime API key.')
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(key)
    command = shlex.join([str(python), str(ROOT / 'frame' / 'quick_mcp.py')])
    subprocess.run([client, 'runtimes', 'connect', '--alias', args.alias, '--profile', args.alias,
                    '--tunnel-id', args.tunnel_id, '--runtime-api-key', f'file:{key_file}',
                    '--mcp-command', command], check=True)
    result = subprocess.run([client, 'runtimes', 'status', args.alias, '--json'], check=True, capture_output=True, text=True)
    status = json.loads(result.stdout)
    checks = {key: status.get(key) for key in ('process_running', 'healthy', 'ready')}
    print(json.dumps(checks, indent=2))
    if not all(checks.values()):
        raise SystemExit('Tunnel is not ready. Keep the Frame editor running and inspect tunnel-client status.')
    print('In ChatGPT Plugins: Add custom MCP server → name Frame → Tunnel → your tunnel ID → No authentication → Create and connect.')
    print('The tunnel controls access; the local stdio bridge has no additional OAuth flow.')

if __name__ == '__main__':
    main()
