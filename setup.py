#!/usr/bin/env python3
"""Install Frame locally without changing any existing MCP configuration."""
import json
import shutil
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def main():
    if sys.version_info < (3, 9):
        raise SystemExit('Install Python 3.9 or newer first.')
    missing = [name for name in ('ffmpeg', 'ffprobe') if not shutil.which(name)]
    if missing:
        raise SystemExit('Install FFmpeg first (macOS: brew install ffmpeg; Ubuntu: sudo apt install ffmpeg).')
    env = ROOT / '.venv'
    python = env / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
    if not python.exists():
        venv.create(env, with_pip=True)
    subprocess.run([str(python), '-m', 'pip', 'install', '-r', str(ROOT / 'requirements.txt')], check=True)
    config = {'mcpServers': {'frame': {'command': str(python), 'args': [str(ROOT / 'frame' / 'quick_mcp.py')]}}}
    (ROOT / 'mcp.json').write_text(json.dumps(config, indent=2) + '\n')
    print('Installed. Start the editor in a terminal:')
    print(f'  "{python}" "{ROOT / "run.py"}"')
    print('Then open http://127.0.0.1:8876/quick')
    print('For ChatGPT web: python3 connect_chatgpt.py YOUR_TUNNEL_ID')
    print('For a local MCP client: use the generated mcp.json entry.')

if __name__ == '__main__':
    main()
