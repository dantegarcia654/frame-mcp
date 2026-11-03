"""Serve the same Frame UI on loopback for hosts without MCP Apps."""
import json
from urllib.parse import urlparse

def route(handler, app, method):
    path = urlparse(handler.path).path
    if method == 'GET' and path == '/frame':
        handler.send(200, (app.ROOT / 'frame_local.html').read_bytes(), 'text/html; charset=utf-8')
        return True
    if method == 'POST' and path == '/api/frame/stop':
        import hashlib
        import threading
        expected = hashlib.sha256(str(app.ROOT.resolve()).encode()).hexdigest()
        if handler.headers.get('X-Frame-Runtime') != expected or handler.headers.get('Origin'):
            handler.json(403, {'error': 'Use the installed Frame stop command.'})
            return True
        busy = {'working', 'planning', 'rendering', 'queued', 'analyzing'}
        def active(value):
            # Queued commentary is a saved request, not a running worker.
            if not isinstance(value, dict):
                return False
            if value.get('status') in busy:
                return True
            return any(item.get('status') in busy for key in ('exports', 'proposals')
                       for item in value.get(key, []) if isinstance(item, dict))
        with app.quick_timeline.LOCK:
            for folder in app.WORK.iterdir():
                if not folder.is_dir():
                    continue
                for name in ('timeline.json', 'project.json'):
                    file = folder / name
                    if file.exists() and active(json.loads(file.read_text())):
                        handler.json(409, {'error': 'Frame is busy. Wait for active work before stopping.'})
                        return True
            app.DRAINING = True
        handler.json(200, {'stopping': True})
        threading.Thread(target=handler.server.shutdown, daemon=True).start()
        return True
    if method != 'POST' or path != '/api/frame/tools':
        return False
    origin = handler.headers.get('Origin')
    allowed = {'http://127.0.0.1:' + str(handler.server.server_port), 'http://localhost:' + str(handler.server.server_port)}
    if origin not in allowed:
        handler.close_connection = True
        handler.json(403, {'error': 'Use the Frame local page.'})
        return True
    try:
        size = int(handler.headers.get('Content-Length', '0'))
        if not 0 < size <= 16000 or handler.headers.get('Content-Type') != 'application/json':
            raise ValueError('Invalid editor request.')
        handler.connection.settimeout(20)
        request = json.loads(handler.rfile.read(size))
        import quick_mcp
        if not isinstance(request, dict) or request.get('name') not in quick_mcp.SPECS:
            raise ValueError('Unknown editor tool.')
        quick_mcp.BASE = 'http://127.0.0.1:' + str(handler.server.server_port)
        result = quick_mcp.dispatch({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': request})['result']
        handler.json(200, result)
    except (ValueError, TypeError, KeyError) as exc:
        handler.json(400, {'isError': True, 'content': [{'type': 'text', 'text': str(exc)}]})
    return True
