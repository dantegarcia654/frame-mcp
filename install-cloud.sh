#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != --openai-cloud || "$(uname -s)" != Linux ]]; then
  echo 'Frame cloud installer: run only inside an OpenAI Codex Linux cloud task.' >&2
  echo 'Select Work in > Cloud first, then pass --openai-cloud. Nothing was installed.' >&2
  exit 2
fi
# --openai-cloud is an explicit assertion by the caller, not a provider detector.
# Never install a local Codex plugin or start a laptop tunnel from this script.
command -v python3 >/dev/null || { echo 'Python 3.9+ is required in the cloud environment.' >&2; exit 1; }
python3 -c 'import sys; assert sys.version_info >= (3,9), "Python 3.9+ required"'
frame_root="$PWD/.frame-cloud"
if [[ -e "$frame_root" && ! -f "$frame_root/FRAME-CLOUD-INSTALL" ]]; then
  echo 'Refusing to overwrite an existing .frame-cloud directory.' >&2; exit 1
fi
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null || ! python3 -m venv --help >/dev/null 2>&1; then
  command -v apt-get >/dev/null || { echo 'Ask cloud setup to install ffmpeg and python3-venv.' >&2; exit 1; }
  if [[ "$(id -u)" == 0 ]]; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg python3-venv
  elif command -v sudo >/dev/null && sudo -n true 2>/dev/null; then
    sudo -n apt-get update -qq
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg python3-venv
  else
    echo 'Cloud setup needs permission to install ffmpeg and python3-venv. Ask the setup agent to install them.' >&2; exit 1
  fi
fi
# Fetch and verify an immutable, allowlisted source archive before extraction.
python3 - "$frame_root" <<'PY'
import hashlib, io, pathlib, sys, tarfile, urllib.request
root = pathlib.Path(sys.argv[1])
url = 'https://github.com/dantegarcia654/frame-mcp/releases/download/cloud-preview-20261102-2/frame-cloud-preview-20261102-2.tar.gz'
expected = '93122fd90a586f51ca5a94bde4792d8e204cf7afc2e43212114979ad13cc6dd3'
request = urllib.request.Request(url, headers={'User-Agent': 'Frame-Cloud-Installer/1.0'})
with urllib.request.urlopen(request, timeout=90) as response:
    data = response.read(16 * 1024 * 1024 + 1)
if len(data) > 16 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected:
    raise SystemExit('Frame source archive checksum mismatch; no files extracted.')
with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
    for item in archive.getmembers():
        p = pathlib.PurePosixPath(item.name)
        if p.is_absolute() or '..' in p.parts or not (item.isfile() or item.isdir()):
            raise SystemExit('Unsafe source archive member.')
        if set(p.parts) & {'jobs', 'private', '.venv', '.git'}:
            raise SystemExit('Unexpected runtime data in source archive.')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    archive.extractall(root)
(root / 'FRAME-CLOUD-INSTALL').write_text(expected + '\n')
PY
python3 -m venv "$frame_root/.venv"
"$frame_root/.venv/bin/python" -m pip install --disable-pip-version-check -r "$frame_root/requirements.txt"
python3 - "$frame_root" <<'PY'
from pathlib import Path
import json, shlex, socket, sys
root = Path(sys.argv[1]).resolve()
config = root / 'runtime.json'
if not config.exists():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    config.write_text(json.dumps({'base_url': 'http://127.0.0.1:' + str(port)}) + '\n')
(root / 'frame').mkdir(exist_ok=True)
# Launcher is outside the source directory because frame/ is a Python module folder.
launcher = '#!/usr/bin/env bash\nset -euo pipefail\nexec ' + shlex.quote(str(root / '.venv/bin/python')) + ' ' + shlex.quote(str(root / 'frame_cli.py')) + ' "$@"\n'
(root / 'frame-command').write_text(launcher)
(root / 'frame-command').chmod(0o700)
PY
"$frame_root/frame-command" tools >/dev/null
cat <<TXT
Frame cloud command tools installed in $frame_root.
Run: $frame_root/.venv/bin/python $frame_root/cloud_smoke.py
Then attach a short MP4 and ask Codex to edit it with $frame_root/frame-command.
This installs into the current cloud task. It does not configure an embedded MCP panel.
TXT
