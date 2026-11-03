#!/usr/bin/env python3
"""Rebuild the reviewed runtime manifest and deterministic public source archive."""
from pathlib import Path
import hashlib
import json
import re
import zipfile
root = Path(__file__).resolve().parent
payload = root / 'plugins/frame/runtime'
files = sorted(p for p in payload.rglob('*') if p.is_file() and p.name != 'MANIFEST.json' and '__pycache__' not in p.parts)
entries=[]
for p in files:
    if p.is_symlink() or set(p.relative_to(root).parts) & {'jobs', 'studio-jobs', 'node_modules', '.venv'}:
        raise SystemExit('Unexpected runtime file: ' + str(p))
    entries.append({'path':str(p.relative_to(payload)), 'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(payload/'MANIFEST.json').write_text(json.dumps({'files':entries},indent=2)+'\n')
version=json.loads((root/'plugins/frame/.codex-plugin/plugin.json').read_text())['version']
dist=root/'dist';dist.mkdir(exist_ok=True)
archive=dist/('Frame-MCP-v'+version+'.zip')
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:
    for p in sorted(root.rglob('*')):
        if not p.is_file() or set(p.relative_to(root).parts) & {'.git','dist','__pycache__'}:continue
        if p.is_symlink():raise SystemExit('Unexpected release symlink')
        data=p.read_bytes()
        if re.search(rb'/Users/[A-Za-z0-9._-]+/',data) or re.search(rb'sk-(?:proj-|admin-)?[A-Za-z0-9_-]{20,}',data):raise SystemExit('Private data in '+str(p))
        entry=zipfile.ZipInfo('Frame-MCP/'+str(p.relative_to(root)),date_time=(2026,11,3,0,0,0));entry.external_attr=(0o100755 if p.name=='install.sh' else 0o100644)<<16;entry.compress_type=zipfile.ZIP_DEFLATED;z.writestr(entry,data)
sha=hashlib.sha256(archive.read_bytes()).hexdigest();(dist/'SHA256SUMS.txt').write_text(sha+'  '+archive.name+'\n');print(json.dumps({'archive':str(archive),'sha256':sha,'runtime_files':len(entries)}))
