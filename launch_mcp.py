#!/usr/bin/env python3
"""Launch the local editor on demand, then serve MCP over stdio."""
import os
import re
import runpy
import subprocess
import sys
import time
import urllib.error
import urllib.request
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def ready(base):
    try:
        with urllib.request.urlopen(base + '/api/health', timeout=2) as response:
            result = json.load(response)
            if not result.get('ok') or 'frame_product' not in result.get('operations', []):
                raise RuntimeError('This port belongs to another service. Choose a different FRAME_URL port.')
            return True
    except urllib.error.HTTPError as exc:
        raise RuntimeError('This port belongs to another service. Choose a different FRAME_URL port.') from exc
    except urllib.error.URLError:
        return False


def main():
    base = os.environ.get('FRAME_URL', 'http://127.0.0.1:8876').rstrip('/')
    if not re.fullmatch(r'http://(?:127\.0\.0\.1|localhost):\d+', base):
        raise SystemExit('FRAME_URL must be loopback HTTP.')
    if not ready(base):
        state = Path.home() / '.local' / 'state' / 'frame-mcp'
        state.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env['PORT'] = base.rsplit(':', 1)[1]
        with (state / ('editor-' + env['PORT'] + '.log')).open('ab') as log:
            process = subprocess.Popen([sys.executable, str(ROOT / 'run.py')],
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                       start_new_session=True, env=env)
        for _ in range(80):
            if ready(base):
                break
            if process.poll() is not None:
                raise SystemExit('Frame could not start. See ' + str(state) + ' for its editor log.')
            time.sleep(.25)
        else:
            raise SystemExit('Frame did not become ready within 20 seconds. Inspect its editor log and retry.')
    sys.path.insert(0, str(ROOT / 'frame'))
    runpy.run_path(str(ROOT / 'frame' / 'quick_mcp.py'), run_name='__main__')


if __name__ == '__main__':
    main()
