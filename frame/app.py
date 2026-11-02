#!/usr/bin/env python3
"""Katana: natural-language video edits, backed by measured source footage."""
import json
import os
import re
import shutil
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from editor import analyze, probe, render
from proposals import build_proposal
from planner import codex_executable, plan
from frame_bridge import validate_operation,compose
import studio
import frame_product
import quick_timeline
import quick_annotations
import quick_revision
import quick_assets
import sys

ROOT = Path(__file__).resolve().parent
WORK = ROOT / 'jobs'
WORK.mkdir(exist_ok=True)
MAX_UPLOAD = 700 * 1024 * 1024
LOCK = threading.RLock()
TASKS = {}
BUSY = set()
WORKERS = threading.Semaphore(1)
ID = r'[a-f0-9]{32}'


def save(folder, data):
    temporary = folder / 'project.tmp'
    temporary.write_text(json.dumps(data, indent=2))
    temporary.replace(folder / 'project.json')


def project(pid):
    if not re.fullmatch(ID, pid):
        raise ValueError('Invalid project.')
    folder = WORK / pid
    if not (folder / 'input.mp4').exists():
        raise FileNotFoundError('Video not found. Upload a clip first.')
    with LOCK:
        if (folder / 'project.json').exists():
            return json.loads((folder / 'project.json').read_text())
        # Adopt videos uploaded through V0 without changing their original or existing export.
        data = {'id': pid, 'name': 'Earlier upload ' + pid[:6], 'created': folder.stat().st_mtime,
                'versions': [], 'history': [], 'current_segments': None, 'current_version': None}
        save(folder, data)
        return data


def public_project(data):
    view = dict(data)
    view['source_url'] = '/media/' + data['id'] + '/input.mp4'
    analysis = WORK / data['id'] / 'analysis.json'
    if analysis.exists():
        view['source_duration'] = json.loads(analysis.read_text())['duration']
    view['pending_proposal'] = next((p for p in data.get('proposals', [])
                                    if p['id'] == data.get('pending_proposal_id')
                                    and p['status'] in ('pending', 'rendering')), None)
    return view


def worker(tid, pid, prompt, restore):
    task = TASKS[tid]
    def stage(message):
        with LOCK:
            task['stage'] = message
    try:
        with WORKERS:
            folder = WORK / pid
            data = project(pid)
            info = analyze(folder, stage)
            baseline = data['current_segments'] or [[0, info['duration']]]
            current = [[0, info['duration']]] if restore else baseline
            pending = None if restore else public_project(data)['pending_proposal']
            revision = folder / 'proposals' / tid
            revision.mkdir(parents=True)
            stage('Finding complete thoughts and proposing cuts')
            active=next((v for v in data['versions'] if v['id']==data['current_version']),None)
            decision = plan(folder, revision, prompt, info, current, data['history'], pending,
                            None if restore else (active or {}).get('split_screen'))
            message, action = decision['message'], decision['action']
            if action=='edit' and active and active.get('split_screen') and not restore:
                action='clarify'
                message='I can revise this composition’s graphics or layout. To change its underlying cuts, select the earlier cut or start from original first, then compose again; I won’t silently drop your graphics.'
            if action in ('edit','compose'):
                if action=='compose':
                    duration=sum(b-a for a,b in current)
                    operation=validate_operation(decision['split_screen'],duration)
                    proposal={'operation':'create_split_screen','split_screen':operation,'segments':current,
                              'cuts':[],'sections':[{'start':a,'end':b,'text':'','reason':'Retain the current footage and dialogue.'} for a,b in current],
                              'thoughts':[],'warnings':info['warnings'],'boundary_mode':'visual',
                              'estimated_duration':round(duration,2),'removed_duration':0,'changed':True,
                              'start_from_original':restore}
                else:
                    proposal = build_proposal(decision, info, baseline)
                if not proposal['changed']:
                    action = 'answer'
                    message = 'That proposal keeps your current selection intact. No new cut needs approval. ' + message
                else:
                    for old in data.get('proposals', []):
                        if old['status'] == 'pending':
                            old['status'] = 'superseded'
                    proposal.update(id=tid, prompt=prompt, message=message, status='pending',
                                    created=time.time(), base_version=data['current_version'],
                                    baseline=baseline, original_duration=round(info['duration'],2))
                    data.setdefault('proposals', []).append(proposal)
                    data['pending_proposal_id'] = tid
                    (revision / 'proposal.json').write_text(json.dumps(proposal, indent=2))
                    task['proposal'] = proposal
                    action = 'proposal'
                    message += ' Review the slices below. Nothing has been rendered yet.'
            data['history'].extend([{'role': 'user', 'content': prompt},
                                    {'role': 'assistant', 'content': message, 'action': action}])
            with LOCK:
                save(folder, data)
                task.update(status='done', stage='Proposal ready' if action == 'proposal' else 'Done',
                            action=action, message=message, warnings=info['warnings'],
                            project=public_project(data))
    except Exception as exc:
        with LOCK:
            task.update(status='failed', stage='Failed', error=str(exc)[-1800:])
    finally:
        with LOCK:
            BUSY.discard(pid)


def render_worker(tid, pid, proposal_id):
    task = TASKS[tid]
    def stage(message):
        with LOCK:
            task['stage'] = message
    try:
        with WORKERS:
            folder = WORK / pid
            data = project(pid)
            proposal = next(p for p in data['proposals'] if p['id'] == proposal_id)
            info = json.loads((folder / 'analysis.json').read_text())
            revision = folder / 'versions' / tid
            revision.mkdir(parents=True)
            # Render exactly the stored proposal. No second AI decision at approval time.
            keep = proposal['segments']
            frame_result=None
            if proposal.get('operation')=='create_split_screen':
                frame_result,frame_project=compose(folder,revision,proposal,data,stage)
                measured=frame_result['duration']
            else:
                measured = render(folder / 'input.mp4', revision, keep, info['audio'], stage)
            version = {'id': tid, 'proposal_id': proposal_id, 'number': len(data['versions']) + 1,
                       'prompt': proposal['prompt'], 'message': proposal['message'], 'segments': keep,
                       'duration': round(measured,2), 'original_duration': round(info['duration'],2),
                       'previous_duration': round(sum(b-a for a,b in proposal['baseline']),2),
                       'removed': round(max(0,info['duration']-sum(b-a for a,b in keep)),2),
                       'url': '/media/' + pid + '/versions/' + tid + '/edited.mp4'}
            if frame_result:
                version.update(split_screen=proposal['split_screen'],frame_project=str(frame_project),
                               frame_checkpoint=frame_result['id'],audio_mode=frame_result['audio_mode'],
                               preview_url='/media/'+pid+'/versions/'+tid+'/preview.mp4')
            (revision / 'plan.json').write_text(json.dumps({'approved_proposal': proposal, 'rendered': version},indent=2))
            data['versions'].append(version)
            data['current_segments'], data['current_version'] = keep, tid
            proposal['status'], proposal['rendered_version'] = 'rendered', tid
            data['pending_proposal_id'] = None
            message = ('Approved split-screen rendered: %.2fs, with timed graphics and the original dialogue. Preview and 1080×1920 download are ready.' if frame_result else 'Approved cut rendered: %.2fs. The export uses the exact source sections you reviewed.') % measured
            data['history'].append({'role': 'assistant', 'content': message, 'action': 'rendered'})
            with LOCK:
                save(folder,data)
                task.update(status='done', stage='Done', action='rendered', message=message,
                            version=version, project=public_project(data))
    except Exception as exc:
        with LOCK:
            data = project(pid)
            proposal = next((p for p in data.get('proposals',[]) if p['id']==proposal_id),None)
            if proposal:
                proposal.update(status='pending', error=str(exc)[-800:])
                save(WORK / pid,data)
            task.update(status='failed',stage='Failed',error=str(exc)[-1800:])
    finally:
        with LOCK:
            BUSY.discard(pid)


def recover_interrupted_renders():
    for file in WORK.glob('*/project.json'):
        data = json.loads(file.read_text())
        changed = False
        for proposal in data.get('proposals',[]):
            if proposal['status'] == 'rendering':
                proposal.update(status='pending',error='The server restarted during rendering. Review and approve again to retry.')
                changed = True
        if changed:
            save(file.parent,data)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def send(self, code, body, ctype='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def json(self, code, data):
        self.send(code, json.dumps(data).encode())

    def media(self, file, ctype):
        if not file.is_file():
            return self.json(404, {'error': 'File not found'})
        size = file.stat().st_size
        start, end = 0, size - 1
        range_header = self.headers.get('Range')
        if range_header:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header)
            if not match or not any(match.groups()):
                return self.send(416, b'Invalid byte range', 'text/plain')
            a, b = match.groups()
            if a:
                start, end = int(a), min(int(b), end) if b else end
            else:
                start = max(0, size - int(b))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%s' % size)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
        self.send_response(206 if range_header else 200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(end-start+1))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-store')
        if range_header:
            self.send_header('Content-Range', 'bytes %s-%s/%s' % (start, end, size))
        self.end_headers()
        try:
            with file.open('rb') as f:
                f.seek(start)
                remaining = end-start+1
                while remaining:
                    chunk = f.read(min(1024*1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def local_host(self):
        return self.headers.get('Host') in ('127.0.0.1:%s' % self.server.server_port,
                                            'localhost:%s' % self.server.server_port)

    def do_GET(self):
        if not self.local_host():
            self.close_connection = True
            return self.json(403, {'error': 'Use the loopback address.'})
        if quick_assets.route(self, sys.modules[__name__], "GET"):
            return
        if quick_revision.route(self, sys.modules[__name__], "GET"):
            return
        if quick_annotations.route(self, sys.modules[__name__], "GET"):
            return
        if quick_timeline.route(self, sys.modules[__name__], "GET"):
            return
        if frame_product.get(self):
            return
        if studio.get(self):
            return
        path = urlparse(self.path).path
        if path in ('/quick', '/quick/'):
            return self.send(200, (ROOT / 'revision.html').read_bytes(), 'text/html; charset=utf-8')
        if path == '/quick/timeline':
            return self.send(200, (ROOT / 'timeline.html').read_bytes(), 'text/html; charset=utf-8')
        if path == '/quick/proposals':
            return self.send(200, (ROOT / 'quick.html').read_bytes(), 'text/html; charset=utf-8')
        if path == '/editor':
            return self.send(200, (ROOT / 'index.html').read_bytes(), 'text/html; charset=utf-8')
        if path == '/review.js':
            return self.send(200, (ROOT / 'review.js').read_bytes(), 'text/javascript; charset=utf-8')
        if path == '/playback.js':
            return self.send(200, (ROOT / 'playback.js').read_bytes(), 'text/javascript; charset=utf-8')
        if path == '/api/health':
            return self.json(200, {'ok': True, 'version': 6, 'planner': bool(codex_executable()),
                                   'operations':['create_split_screen', 'create_script_video', 'frame_product']})
        if path == '/api/projects':
            result = []
            for folder in WORK.iterdir():
                if re.fullmatch(ID, folder.name) and (folder / 'input.mp4').exists():
                    try:
                        data = project(folder.name)
                        result.append({'id': data['id'], 'name': data['name'], 'created': data['created']})
                    except (OSError, ValueError):
                        continue
            return self.json(200, sorted(result, key=lambda p: p['created'], reverse=True))
        match = re.fullmatch('/api/projects/(' + ID + ')', path)
        if match:
            try:
                return self.json(200, public_project(project(match[1])))
            except (ValueError, FileNotFoundError) as exc:
                return self.json(404, {'error': str(exc)})
        match = re.fullmatch('/api/tasks/(' + ID + ')', path)
        if match:
            with LOCK:
                data = TASKS.get(match[1])
                return self.json(200, data) if data else self.json(404, {'error': 'Task not found. Reload to recover saved versions.'})
        match = re.fullmatch('/media/(' + ID + ')/(input.mp4|storyboard.jpg|versions/' + ID + '/(?:edited|preview).mp4)', path)
        if match:
            return self.media(WORK / match[1] / match[2], 'image/jpeg' if path.endswith('.jpg') else 'video/mp4')
        return self.json(404, {'error': 'Not found'})

    def do_POST(self):
        if not self.local_host():
            self.close_connection = True
            return self.json(403, {'error': 'Use the loopback address.'})
        # Local UI only: reject browser requests from unrelated sites.
        origin = self.headers.get('Origin')
        if origin and origin not in ('http://127.0.0.1:%s' % self.server.server_port,
                                      'http://localhost:%s' % self.server.server_port):
            self.close_connection = True
            return self.json(403, {'error': 'Use Katana from its local page.'})
        if quick_assets.route(self, sys.modules[__name__], "POST"):
            return
        if quick_revision.route(self, sys.modules[__name__], "POST"):
            return
        if quick_annotations.route(self, sys.modules[__name__], "POST"):
            return
        if quick_timeline.route(self, sys.modules[__name__], "POST"):
            return
        if frame_product.post(self):
            return
        if studio.post(self):
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            self.close_connection = True
            return self.json(400, {'error': 'Invalid request length'})
        if self.path == '/upload':
            if not 0 < length <= MAX_UPLOAD:
                self.close_connection = True
                return self.json(413, {'error': 'Video must be between 1 byte and 700 MB.'})
            pid = uuid.uuid4().hex
            folder = WORK / pid
            folder.mkdir()
            self.connection.settimeout(120)
            try:
                with (folder / 'input.mp4').open('wb') as f:
                    remaining = length
                    while remaining:
                        chunk = self.rfile.read(min(1024*1024, remaining))
                        if not chunk:
                            raise ValueError('Upload was interrupted. Please select the video again.')
                        f.write(chunk)
                        remaining -= len(chunk)
                probe(folder / 'input.mp4')
                name = Path(unquote(self.headers.get('X-Filename', 'Your video'))).name[:180]
                data = {'id': pid, 'name': name, 'created': time.time(), 'versions': [], 'history': [],
                        'current_segments': None, 'current_version': None}
                save(folder, data)
                return self.json(200, public_project(data))
            except Exception as exc:
                shutil.rmtree(folder, ignore_errors=True)
                self.close_connection = True
                return self.json(400, {'error': str(exc)[-1000:]})
        match = re.fullmatch('/api/projects/(' + ID + ')/(edit|select|approve|reject)', self.path)
        if not match or not 0 < length <= 16000:
            self.close_connection = True
            return self.json(400, {'error': 'Invalid request'})
        try:
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('Expected a JSON object.')
            pid, operation = match.groups()
            with LOCK:
                data = project(pid)
                if pid in BUSY:
                    return self.json(409, {'error': 'Katana is already working on this video.'})
                if operation == 'select':
                    version = next((v for v in data['versions'] if v['id'] == body.get('version')), None)
                    if not version:
                        raise ValueError('Version not found.')
                    if data['current_version'] != version['id']:
                        for proposal in data.get('proposals',[]):
                            if proposal['status'] == 'pending':
                                proposal['status'] = 'stale'
                        data['pending_proposal_id'] = None
                    data['current_version'] = version['id']
                    data['current_segments'] = version['segments']
                    save(WORK / pid, data)
                    return self.json(200, public_project(data))
                if operation in ('approve','reject'):
                    proposal = next((p for p in data.get('proposals',[]) if p['id']==body.get('proposal')),None)
                    if (not proposal or proposal['status'] != 'pending'
                            or proposal['id'] != data.get('pending_proposal_id')
                            or proposal['base_version'] != data['current_version']):
                        return self.json(409, {'error': 'This proposal is no longer current. Review a new proposal first.'})
                    if operation == 'reject':
                        proposal['status'] = 'rejected'
                        data['pending_proposal_id'] = None
                        data['history'].append({'role':'assistant','action':'rejected',
                            'content':'Proposal rejected. Your current cut is unchanged. Tell me what to try instead.'})
                        save(WORK / pid,data)
                        return self.json(200,public_project(data))
                    tid = uuid.uuid4().hex
                    proposal.update(status='rendering',approved_at=time.time())
                    save(WORK / pid,data)
                    TASKS[tid] = {'id':tid,'project_id':pid,'status':'working','stage':'Rendering approved proposal'}
                    BUSY.add(pid)
                    threading.Thread(target=render_worker,args=(tid,pid,proposal['id']),daemon=True).start()
                    return self.json(202,{'id':tid})
                prompt = body.get('prompt', '')
                if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 4000:
                    raise ValueError('Write an editing request or question (up to 4,000 characters).')
                tid = uuid.uuid4().hex
                TASKS[tid] = {'id': tid, 'project_id': pid, 'status': 'working', 'stage': 'Queued'}
                BUSY.add(pid)
                threading.Thread(target=worker, args=(tid, pid, prompt.strip(), bool(body.get('original', False))), daemon=True).start()
                return self.json(202, {'id': tid})
        except (ValueError, FileNotFoundError) as exc:
            return self.json(400, {'error': str(exc)})

    def log_message(self, fmt, *args):
        if urlparse(self.path).path == '/api/studio/fish-mcp/callback':
            return  # OAuth codes and state must never appear in access logs.
        print('%s %s' % (self.log_date_time_string(), fmt % args), flush=True)


if __name__ == '__main__':
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise SystemExit('Install FFmpeg first: brew install ffmpeg')
    port = int(os.environ.get('PORT', '8765'))
    quick_revision.recover(sys.modules[__name__])
    quick_timeline.recover(sys.modules[__name__])
    recover_interrupted_renders()
    studio.recover()
    frame_product.recover()
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('Katana running at http://127.0.0.1:%s' % port, flush=True)
    server.serve_forever()
