"""Keep MCP usable when the local editor has not started or has stopped."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

_healthy_until = 0.0


def health(base):
    try:
        with urllib.request.urlopen(base + '/api/health', timeout=2) as response:
            value = json.load(response)
        expected = hashlib.sha256(str(Path(__file__).resolve().parent).encode()).hexdigest()
        if not value.get('ok') or 'frame_product' not in value.get('operations', []) or value.get('runtime_id') != expected:
            raise RuntimeError('Another service owns the Frame port. Choose a different FRAME_URL port.')
        return True
    except urllib.error.HTTPError as exc:
        raise RuntimeError('Another service owns the Frame port. Choose a different FRAME_URL port.') from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, ConnectionRefusedError):
            return False
        raise RuntimeError('The Frame service is not responding. Wait, then refresh the connection.') from exc


def ensure_server(base):
    global _healthy_until
    # Check identity on every call; a restarted or occupied port must never be reused blindly.
    if not re.fullmatch(r'http://(?:127\.0\.0\.1|localhost):\d+', base):
        raise ValueError('Frame must use a loopback HTTP address.')
    port = base.rsplit(':', 1)[1]
    state = Path.home() / '.local' / 'state' / 'frame-mcp'
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / ('start-' + port + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not health(base):
            env = os.environ.copy()
            env['PORT'] = port
            with (state / ('editor-' + port + '.log')).open('ab') as log:
                process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('app.py'))],
                                           stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                           start_new_session=True, env=env)
            for _ in range(80):
                if health(base):
                    break
                if process.poll() is not None:
                    raise RuntimeError('Frame could not start. Inspect its local editor log and refresh.')
                time.sleep(.25)
            else:
                raise RuntimeError('Frame did not start within 20 seconds. Inspect its local editor log and refresh.')
        _healthy_until = time.monotonic() + 2
