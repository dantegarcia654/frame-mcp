"""Isolated Fish MCP OAuth connection. No API-key configuration is touched.

Only verify() makes read-only MCP initialization/discovery calls. call_tool()
requires a discovered name and never retries a possibly mutating tool request.
"""
import base64
import hashlib
import json
import os
import secrets
import stat
import threading
import time
from pathlib import Path
from urllib.parse import urlencode, urlparse

import requests

RESOURCE = 'https://api.fish.audio/mcp'
ISSUER = 'https://api.fish.audio'
AUTHORIZE = 'https://fish.audio/oauth/authorize'
TOKEN = 'https://api.fish.audio/oauth/token'
REGISTER = 'https://api.fish.audio/oauth/register'
PROTOCOL = '2025-03-26'
CONFIG_PATH = Path.home() / '.config/frame-studio/fish-mcp.json'
MAX_BODY = 8 * 1024 * 1024
STATE_TTL = 600
LOCK = threading.RLock()
PENDING = {}
SESSION = {}


class FishMCPError(RuntimeError):
    pass


def _load():
    path = Path(CONFIG_PATH)
    if not path.exists():
        return {}
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise FishMCPError('The Fish connection file is not a private owned file.')
    if stat.S_IMODE(info.st_mode) != 0o600:
        path.chmod(0o600)
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            raise ValueError()
        return data
    except (OSError, ValueError):
        raise FishMCPError('The saved Fish connection could not be read. Disconnect and connect again.') from None


def _save(data):
    path = Path(CONFIG_PATH)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise FishMCPError('The Fish connection path must not be a symbolic link.')
    temporary = path.with_name('.fish-mcp-' + secrets.token_hex(12) + '.tmp')
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(data, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(str(temporary), str(path))
        path.chmod(0o600)
    finally:
        if temporary.exists():
            temporary.unlink()


def _secret(value):
    return isinstance(value, str) and 0 < len(value) <= 16384 and not any(c in value for c in '\r\n')


def _redact(value, credentials):
    hidden = [credentials.get(key) for key in ('access_token', 'refresh_token') if credentials.get(key)]
    if isinstance(value, str):
        for item in hidden:
            value = value.replace(item, '[redacted]')
        return value
    if isinstance(value, dict):
        return {key: _redact(item, credentials) for key, item in value.items()
                if key not in ('access_token', 'refresh_token', 'client_secret', 'code_verifier')}
    if isinstance(value, list):
        return [_redact(item, credentials) for item in value]
    return value


def _sse_message(data, expected_id):
    lines = [line[5:].lstrip(' ') for line in data.splitlines() if line.startswith('data:')]
    if not lines:
        return None
    payload = '\n'.join(lines)
    if payload == '[DONE]':
        return None
    try:
        item = json.loads(payload)
    except ValueError:
        raise FishMCPError('Fish MCP returned malformed event data.') from None
    return item if isinstance(item, dict) and item.get('id') == expected_id else None


def _read_response(response, expected_id=None):
    """Bounded JSON/SSE reader; stop at the matching SSE result, not stream EOF."""
    advertised = response.headers.get('Content-Length')
    if advertised:
        try:
            if int(advertised) > MAX_BODY:
                raise FishMCPError('Fish MCP response exceeded the size limit.')
        except ValueError:
            raise FishMCPError('Fish MCP returned an invalid response length.') from None
    sse = 'text/event-stream' in response.headers.get('Content-Type', '').lower()
    content, pending = bytearray(), ''
    deadline = time.monotonic() + 120
    for chunk in response.iter_content(chunk_size=65536):
        if time.monotonic() > deadline:
            raise FishMCPError('Fish MCP response timed out.')
        if not chunk:
            continue
        content.extend(chunk)
        if len(content) > MAX_BODY:
            raise FishMCPError('Fish MCP response exceeded the size limit.')
        if sse:
            # Re-decode complete accumulated UTF-8, retaining split multibyte tails.
            try:
                pending = bytes(content).decode('utf-8').replace('\r\n', '\n')
            except UnicodeDecodeError as exc:
                if exc.end == len(content):
                    continue
                raise FishMCPError('Fish MCP returned invalid text encoding.') from None
            for event in pending.split('\n\n')[:-1]:
                item = _sse_message(event, expected_id)
                if item is not None:
                    return item
    if sse:
        item = _sse_message(pending.rsplit('\n\n', 1)[-1], expected_id)
        if item is not None:
            return item
        raise FishMCPError('Fish MCP ended without a matching response.')
    if not content:
        return None
    try:
        return json.loads(content)
    except (ValueError, UnicodeDecodeError):
        raise FishMCPError('Fish returned an invalid JSON response.') from None


def _request(endpoint, *, expected_id=None, notification=False, **kwargs):
    if endpoint not in (REGISTER, TOKEN, RESOURCE):
        raise FishMCPError('Unexpected Fish endpoint.')
    response = None
    try:
        response = requests.post(endpoint, allow_redirects=False, stream=True,
                                 timeout=(10, 45), **kwargs)
        if not 200 <= response.status_code < 300:
            # Never expose response bodies, echoed codes, tokens, or proxy errors.
            raise FishMCPError('Fish request was refused (HTTP %d).' % response.status_code)
        session = response.headers.get('Mcp-Session-Id')
        if session is not None and (not _secret(session) or len(session) > 1024):
            raise FishMCPError('Fish returned an invalid session header.')
        if notification:
            return None, session
        return _read_response(response, expected_id), session
    except requests.RequestException:
        raise FishMCPError('Fish could not be reached. Check the connection and retry the connection check.') from None
    finally:
        if response is not None:
            response.close()


def _callback_uri(uri):
    if not isinstance(uri, str):
        raise FishMCPError('Use the local Frame callback URL.')
    parsed = urlparse(uri)
    try:
        port = parsed.port
    except ValueError:
        raise FishMCPError('Use the local Frame callback URL.') from None
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')
            or parsed.username or parsed.password or not port or not 1 <= port <= 65535
            or parsed.path != '/api/studio/fish-mcp/callback' or parsed.query or parsed.fragment):
        raise FishMCPError('Use the local Frame callback URL.')
    return uri


def start_login(redirect_uri):
    redirect_uri = _callback_uri(redirect_uri)
    with LOCK:
        data = _load()
        registrations = data.setdefault('registrations', {})
        client = registrations.get(redirect_uri)
        if not client:
            registered, _ = _request(REGISTER, json={'client_name': 'Frame Studio',
                'redirect_uris': [redirect_uri], 'grant_types': ['authorization_code', 'refresh_token'],
                'response_types': ['code'], 'token_endpoint_auth_method': 'none'})
            if not isinstance(registered, dict) or not _secret(registered.get('client_id')):
                raise FishMCPError('Fish did not register the local application.')
            if registered.get('token_endpoint_auth_method', 'none') != 'none':
                raise FishMCPError('Fish requires an unsupported client authentication method.')
            client = {'client_id': registered['client_id']}
            registrations[redirect_uri] = client
            _save(data)
        now = time.monotonic()
        for old in list(PENDING):
            if now - PENDING[old]['created'] >= STATE_TTL:
                del PENDING[old]
        state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode('ascii')).digest()).decode().rstrip('=')
        PENDING[state] = {'created': now, 'verifier': verifier, 'redirect_uri': redirect_uri,
                          'client_id': client['client_id']}
        query = {'response_type': 'code', 'client_id': client['client_id'], 'redirect_uri': redirect_uri,
                 'scope': 'mcp', 'resource': RESOURCE, 'state': state,
                 'code_challenge': challenge, 'code_challenge_method': 'S256'}
        return {'authorization_url': AUTHORIZE + '?' + urlencode(query), 'expires_in': STATE_TTL,
                'resource': RESOURCE}


def _parameter(params, name):
    value = params.get(name)
    if isinstance(value, list):
        return value[0] if len(value) == 1 else None
    return value


def _store_tokens(data, payload, client_id, redirect_uri):
    if not isinstance(payload, dict) or not _secret(payload.get('access_token')):
        raise FishMCPError('Fish did not return a valid authorization token.')
    if str(payload.get('token_type', 'Bearer')).lower() != 'bearer':
        raise FishMCPError('Fish returned an unsupported token type.')
    expires = payload.get('expires_in', 3600)
    if isinstance(expires, bool) or not isinstance(expires, (int, float)) or not 0 < expires <= 31536000:
        raise FishMCPError('Fish returned an invalid token lifetime.')
    refresh = payload.get('refresh_token', data.get('refresh_token'))
    if refresh is not None and not _secret(refresh):
        raise FishMCPError('Fish returned an invalid refresh token.')
    data.update(access_token=payload['access_token'], expires_at=time.time() + expires,
                client_id=client_id, redirect_uri=redirect_uri, verified=False)
    if refresh:
        data['refresh_token'] = refresh
    else:
        data.pop('refresh_token', None)
    data.pop('last_error', None)
    _save(data)
    SESSION.clear()


def finish_login(params):
    if not isinstance(params, dict):
        raise FishMCPError('Invalid Fish authorization callback.')
    state = _parameter(params, 'state')
    with LOCK:
        pending = PENDING.pop(state, None) if isinstance(state, str) else None
        if not pending or time.monotonic() - pending['created'] >= STATE_TTL:
            raise FishMCPError('This Fish login expired or was already used. Start a new connection.')
        if _parameter(params, 'iss') != ISSUER:
            raise FishMCPError('Fish authorization issuer did not match.')
        if _parameter(params, 'error'):
            raise FishMCPError('Fish authorization was not completed.')
        code = _parameter(params, 'code')
        if not _secret(code):
            raise FishMCPError('Fish authorization code is missing or invalid.')
        payload, _ = _request(TOKEN, data={'grant_type': 'authorization_code', 'code': code,
            'client_id': pending['client_id'], 'redirect_uri': pending['redirect_uri'],
            'code_verifier': pending['verifier'], 'resource': RESOURCE})
        data = _load()
        # A new authorization must not retain a prior account's refresh token.
        data.pop('refresh_token', None)
        data.pop('tools', None)
        _store_tokens(data, payload, pending['client_id'], pending['redirect_uri'])
        return _public(data)


def _access():
    with LOCK:
        data = _load()
        if not _secret(data.get('access_token')):
            raise FishMCPError('Connect Fish before checking its tools.')
        if data.get('expires_at', 0) > time.time() + 30:
            return data
        if not _secret(data.get('refresh_token')):
            raise FishMCPError('Fish authorization expired. Connect again.')
        payload, _ = _request(TOKEN, data={'grant_type': 'refresh_token',
            'refresh_token': data['refresh_token'], 'client_id': data['client_id'], 'resource': RESOURCE})
        _store_tokens(data, payload, data['client_id'], data['redirect_uri'])
        return data


def _public(data):
    authorized = bool(_secret(data.get('access_token')))
    connected = bool(authorized and data.get('verified') and data.get('expires_at', 0) > time.time())
    tools = data.get('tools', []) if connected else []
    pending = any(time.monotonic() - item['created'] < STATE_TTL for item in PENDING.values())
    return {'authorized': authorized, 'connected': connected, 'pending': pending, 'resource': RESOURCE,
            'verified_at': data.get('verified_at') if connected else None,
            'tool_count': len(tools), 'tools': _redact(tools, data)}


def status():
    with LOCK:
        try:
            return _public(_load())
        except (FishMCPError, OSError):
            return {'authorized': False, 'connected': False, 'pending': False,
                    'resource': RESOURCE, 'verified_at': None, 'tool_count': 0, 'tools': [],
                    'error': 'The saved Fish connection could not be read.'}


def _rpc(method, params, data, *, session=None, notification=False):
    request_id = None if notification else secrets.token_hex(16)
    body = {'jsonrpc': '2.0', 'method': method, 'params': params}
    if request_id is not None:
        body['id'] = request_id
    headers = {'Authorization': 'Bearer ' + data['access_token'],
               'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL}
    if session:
        headers['Mcp-Session-Id'] = session
    result, new_session = _request(RESOURCE, expected_id=request_id, notification=notification,
                                    headers=headers, json=body)
    if notification:
        return None, new_session
    if (not isinstance(result, dict) or result.get('jsonrpc') != '2.0'
            or result.get('id') != request_id or 'error' in result or 'result' not in result):
        raise FishMCPError('Fish MCP did not return a successful matching response.')
    return result['result'], new_session


def _tool_metadata(tool):
    if not isinstance(tool, dict) or not isinstance(tool.get('name'), str):
        raise FishMCPError('Fish MCP returned invalid tool metadata.')
    name = tool['name']
    if not name or len(name) > 200 or any(ord(c) < 32 for c in name):
        raise FishMCPError('Fish MCP returned an invalid tool name.')
    result = {'name': name, 'description': str(tool.get('description', ''))[:4000]}
    if isinstance(tool.get('inputSchema'), dict):
        if len(json.dumps(tool['inputSchema'])) > 131072:
            raise FishMCPError('Fish tool schema exceeded the size limit.')
        result['inputSchema'] = tool['inputSchema']
    if isinstance(tool.get('annotations'), dict):
        result['annotations'] = {key: value for key, value in tool['annotations'].items()
            if key in ('readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint') and isinstance(value, bool)}
    return result


def verify():
    with LOCK:
        data = _access()
        try:
            initialized, session = _rpc('initialize', {'protocolVersion': PROTOCOL,
                'capabilities': {}, 'clientInfo': {'name': 'Frame Studio', 'version': '1.0'}}, data)
            if not isinstance(initialized, dict) or initialized.get('protocolVersion') != PROTOCOL:
                raise FishMCPError('Fish MCP negotiated an unsupported protocol version.')
            _rpc('notifications/initialized', {}, data, session=session, notification=True)
            cursor, seen, tools = None, set(), []
            for _ in range(10):
                listing, _ = _rpc('tools/list', {'cursor': cursor} if cursor else {}, data, session=session)
                if not isinstance(listing, dict) or not isinstance(listing.get('tools'), list):
                    raise FishMCPError('Fish MCP returned an invalid tool list.')
                tools.extend(_tool_metadata(tool) for tool in listing['tools'])
                if len(tools) > 500:
                    raise FishMCPError('Fish MCP returned too many tools.')
                cursor = listing.get('nextCursor')
                if not cursor:
                    break
                if not isinstance(cursor, str) or cursor in seen or len(cursor) > 4096:
                    raise FishMCPError('Fish MCP returned an invalid tool cursor.')
                seen.add(cursor)
            else:
                raise FishMCPError('Fish MCP tool discovery exceeded the page limit.')
            if len({tool['name'] for tool in tools}) != len(tools):
                raise FishMCPError('Fish MCP returned duplicate tool names.')
            data.update(tools=_redact(tools, data), verified=True, verified_at=time.time())
            _save(data)
            SESSION.update(id=session, access_token=data['access_token'])
            return _public(data)
        except FishMCPError:
            data['verified'] = False
            _save(data)
            SESSION.clear()
            raise


def call_tool(name, args):
    if not isinstance(name, str) or not isinstance(args, dict):
        raise FishMCPError('Choose a discovered Fish tool and JSON arguments.')
    try:
        if len(json.dumps(args, allow_nan=False)) > 1024 * 1024:
            raise FishMCPError('Fish tool arguments exceeded the size limit.')
    except (TypeError, ValueError):
        raise FishMCPError('Fish tool arguments must be valid JSON.') from None
    with LOCK:
        data = _access()
        if name not in {tool['name'] for tool in data.get('tools', [])}:
            raise FishMCPError('This Fish tool has not been discovered. Check the connection first.')
        if not data.get('verified') or SESSION.get('access_token') != data['access_token']:
            verify()
            data = _load()
        if name not in {tool['name'] for tool in data.get('tools', [])}:
            raise FishMCPError('This Fish tool is no longer available.')
        try:
            result, _ = _rpc('tools/call', {'name': name, 'arguments': args}, data, session=SESSION.get('id'))
        except FishMCPError:
            raise FishMCPError('Fish tool result is unconfirmed. The request was not retried; check its outcome before submitting again.') from None
        return _redact(result, data)


def disconnect():
    with LOCK:
        data = _load()
        # Keep only nonsecret public-client registrations to avoid unnecessary DCR.
        _save({'registrations': data.get('registrations', {})})
        PENDING.clear()
        SESSION.clear()
        return _public({})
