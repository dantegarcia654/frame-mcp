#!/usr/bin/env python3
"""Install and run Frame with private persistent projects and verified code."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import venv
import urllib.request
import urllib.error
import time

ROOT = Path(__file__).resolve().parent
STATE = Path(os.environ.get('FRAME_DESKTOP_HOME', str(Path.home() / '.local/share/frame-mcp/desktop'))).expanduser().resolve()


def manifest_files(payload):
    raw = (payload / 'MANIFEST.json').read_bytes()
    entries = json.loads(raw)['files']
    seen = set()
    for entry in entries:
        name = entry['path']
        rel = Path(name)
        if not name or rel.is_absolute() or '..' in rel.parts or name in seen or set(rel.parts) & {'jobs', 'studio-jobs', '.venv'}:
            raise ValueError('Invalid runtime manifest path: ' + name)
        source = payload / rel
        if any(parent.is_symlink() for parent in [source, *source.parents] if parent != payload.parent and payload in (parent, *parent.parents)):
            raise ValueError('Symlink in runtime payload: ' + name)
        if not re.fullmatch('[a-f0-9]{64}', entry['sha256']) or hashlib.sha256(source.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError('Runtime integrity check failed: ' + name)
        seen.add(name)
    return hashlib.sha256(raw).hexdigest(), entries


def installed_ok(runtime, entries):
    return (STATE / 'projects').is_dir() and (runtime / 'frame/jobs').is_symlink() and (runtime / 'frame/jobs').resolve() == STATE / 'projects' and all((runtime / e['path']).is_file() and not (runtime / e['path']).is_symlink()
               and hashlib.sha256((runtime / e['path']).read_bytes()).hexdigest() == e['sha256'] for e in entries)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--doctor', action='store_true')
    parser.add_argument('--stop', action='store_true', help='Stop only this installation’s idle servers; refuse active work')
    parser.add_argument('--call', metavar='TOOL')
    parser.add_argument('--arguments', default='{}', help='JSON object of tool arguments')
    args = parser.parse_args()
    if sys.version_info < (3, 9) or sys.platform not in ('darwin', 'linux'):
        raise SystemExit('Frame needs Python 3.9+ on macOS or Linux.')
    if any(not shutil.which(name) for name in ('ffmpeg', 'ffprobe')):
        raise SystemExit('Install FFmpeg first: brew install ffmpeg (macOS), or sudo apt install ffmpeg (Ubuntu).')
    digest, entries = manifest_files(ROOT / 'runtime')
    runtime = STATE / 'runtimes' / digest
    requirements = hashlib.sha256((ROOT / 'runtime/requirements.txt').read_bytes()).hexdigest()
    environment = STATE / 'environments' / requirements
    python = environment / 'bin/python'
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / 'install.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.stop:
            for config in STATE.glob('endpoint-*.json'):
                old_digest = config.stem[len('endpoint-'):]
                if not re.fullmatch('[a-f0-9]{64}', old_digest):
                    continue
                old_runtime = STATE / 'runtimes' / old_digest / 'frame'
                endpoint = json.loads(config.read_text())['url']
                if not re.fullmatch(r'http://127\.0\.0\.1:\d+', endpoint):
                    raise ValueError('Invalid endpoint in ' + str(config))
                identity = hashlib.sha256(str(old_runtime.resolve()).encode()).hexdigest()
                try:
                    with urllib.request.urlopen(endpoint + '/api/health', timeout=2) as response:
                        health = json.load(response)
                except urllib.error.URLError as exc:
                    if isinstance(exc.reason, ConnectionRefusedError):
                        continue
                    raise SystemExit('Cannot verify the owned server. No stop attempted.')
                if health.get('runtime_id') != identity:
                    raise SystemExit('Another service owns the saved port. No stop attempted.')
                request = urllib.request.Request(endpoint + '/api/frame/stop', data=b'', headers={'X-Frame-Runtime': identity})
                try:
                    with urllib.request.urlopen(request, timeout=5) as response:
                        if not json.load(response).get('stopping'):
                            raise ValueError('Stop was not acknowledged.')
                except urllib.error.HTTPError as exc:
                    raise SystemExit('Frame did not stop: ' + exc.read(2000).decode())
                for _ in range(40):
                    try:
                        urllib.request.urlopen(endpoint + '/api/health', timeout=.2).close()
                    except urllib.error.URLError as exc:
                        if isinstance(exc.reason, ConnectionRefusedError):
                            break
                    except (ConnectionResetError, TimeoutError):
                        pass  # A reset is only an observation failure; verify this endpoint again.
                    time.sleep(.1)
                else:
                    raise SystemExit('Stop acknowledged but process is still responding; wait before restarting.')
            print(json.dumps({'stopped': True, 'projects_preserved': True}))
            return
        code_ready = installed_ok(runtime, entries)
        receipt = environment / 'requirements.sha256'
        environment_ready = python.exists() and receipt.exists() and receipt.read_text().strip() == requirements
        if environment_ready and (args.prepare or args.doctor):
            check = subprocess.run([str(python), '-c', 'import PIL, numpy, requests'], capture_output=True, timeout=20)
            environment_ready = check.returncode == 0
        prepared = environment_ready and code_ready
        if args.prepare:
            if not prepared:
                # Each source revision has its own immutable directory. Never overwrite running code.
                if runtime.exists() and not code_ready:
                    raise SystemExit('Installed code integrity mismatch. Preserve this runtime for inspection; reinstall into a new FRAME_DESKTOP_HOME.')
                staging = runtime if code_ready else STATE / 'runtimes' / (digest + '.installing')
                staging.mkdir(parents=True, exist_ok=True)
                if not code_ready:
                    for entry in entries:
                        target = staging / entry['path']
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(ROOT / 'runtime' / entry['path'], target)
                repair_lock = None
                if not environment_ready and (STATE / 'projects').is_dir():
                    repair_lock = (STATE / 'projects/.server.lock').open('a')
                    try:
                        fcntl.flock(repair_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        raise SystemExit('Stop this installation’s Frame server before repairing its environment; no project files changed.')
                if not environment_ready:
                    venv.create(environment, with_pip=True)
                requirements = hashlib.sha256((staging / 'requirements.txt').read_bytes()).hexdigest()
                receipt = environment / 'requirements.sha256'
                if not environment_ready:
                    subprocess.run([str(python), '-m', 'pip', 'install', '--force-reinstall', '-r', str(staging / 'requirements.txt')], check=True, stdout=sys.stderr)
                    receipt.write_text(requirements + '\n')
                projects = STATE / 'projects'
                legacy = STATE / 'runtime/frame/jobs'
                if not projects.exists() and legacy.is_dir():
                    # Copy once; retain every legacy byte as a backup. Never migrate a running old server.
                    processes = subprocess.check_output(['ps', '-axo', 'command'], text=True)
                    if str(STATE / 'runtime') in processes:
                        raise SystemExit('Legacy Frame is still running. Stop its server before migrating projects; no legacy files changed.')
                    migration = STATE / 'projects.migrating'
                    if migration.exists():
                        raise SystemExit('An interrupted legacy migration needs inspection: ' + str(migration))
                    for path in legacy.rglob('*'):
                        if path.is_symlink():
                            raise SystemExit('Inspect legacy project symlinks before migration.')
                    shutil.copytree(legacy, migration)
                    for source in legacy.rglob('*'):
                        if source.is_file() and hashlib.sha256(source.read_bytes()).digest() != hashlib.sha256((migration / source.relative_to(legacy)).read_bytes()).digest():
                            raise SystemExit('Legacy project verification failed; original data preserved.')
                    migration.rename(projects)
                projects.mkdir(exist_ok=True, mode=0o700)
                link = staging / 'frame/jobs'
                if link.is_symlink():
                    if link.resolve() != projects:
                        raise SystemExit('Unexpected project-store link in interrupted setup.')
                elif link.exists():
                    raise SystemExit('Unexpected project-store directory in interrupted setup.')
                else:
                    link.symlink_to(projects, target_is_directory=True)
                if not code_ready:
                    staging.rename(runtime)
            print('Frame runtime prepared. Projects persist in ' + str(STATE / 'projects'), file=sys.stderr)
            return
        if not prepared:
            raise SystemExit('Frame needs setup or its installed code changed. Run the install command before opening it.')
        config = STATE / ('endpoint-' + digest + '.json')
        if config.exists():
            endpoint = json.loads(config.read_text())['url']
        else:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                endpoint = 'http://127.0.0.1:' + str(probe.getsockname()[1])
            config.write_text(json.dumps({'url': endpoint}) + '\n')
        if not re.fullmatch(r'http://127\.0\.0\.1:\d+', endpoint):
            raise SystemExit('Invalid installed endpoint. Inspect ' + str(config))
    env = os.environ.copy()
    env['FRAME_URL'] = endpoint
    if args.doctor:
        print(json.dumps({'prepared': True, 'runtime': str(runtime), 'projects': str(STATE / 'projects'), 'url': endpoint, 'manifest_sha256': digest}))
        return
    if args.call:
        arguments = json.loads(args.arguments)
        if not isinstance(arguments, dict):
            raise SystemExit('--arguments must be a JSON object.')
        helper = ROOT / 'call_tool.py'
        os.execve(str(python), [str(python), str(helper), str(runtime), endpoint, args.call, args.arguments], env)
    os.execve(str(python), [str(python), str(runtime / 'launch_mcp.py')], env)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as exc:
        raise SystemExit('Frame setup error: ' + str(exc))
