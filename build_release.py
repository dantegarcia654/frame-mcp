#!/usr/bin/env python3
"""Build a source-only release from the reviewed tracked file list."""
import hashlib
import re
import subprocess
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent
files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
dist = root / 'dist'
dist.mkdir(exist_ok=True)
target = dist / 'Frame-MCP-v0.1.0.zip'
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
    for name in sorted(filter(None, files)):
        path = root / name
        if path.is_symlink() or set(Path(name).parts) & {'.venv', 'jobs', 'studio-jobs', '.git', 'dist'}:
            raise SystemExit(f'Unexpected release file: {name}')
        data = path.read_bytes()
        if re.search(rb'/Users/[A-Za-z0-9._-]+/', data) or re.search(rb'sk-(?:proj-|admin-)?[A-Za-z0-9_-]{20,}', data):
            raise SystemExit(f'Private path or API key in {name}')
        entry = zipfile.ZipInfo('Frame-MCP/' + name, date_time=(2026, 11, 2, 0, 0, 0))
        entry.external_attr = 0o100644 << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        bundle.writestr(entry, data)
digest = hashlib.sha256(target.read_bytes()).hexdigest()
(dist / 'SHA256SUMS.txt').write_text(f'{digest}  {target.name}\n')
print(f'{target.name}: {target.stat().st_size} bytes; SHA256 {digest}')
