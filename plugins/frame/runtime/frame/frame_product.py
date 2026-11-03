"""One local Frame journey, backed by Studio voice and the semantic compositor.

Projects and immutable versions live inside Studio's data directory. Accepted
jobs are idempotent; narration is checkpointed before any graphics work.
"""
import copy
import hashlib
import json
import math
import re
import shutil
import threading
import time
import uuid
import wave
from pathlib import Path
from urllib.parse import urlparse

import studio
import studio_inputs
from studio_delivery import voice_units, collapse_timeline
from studio_director import direct, validate_plan

ROOT = Path(__file__).resolve().parent
STORE = studio.STORE / 'frame'
LOCK = threading.RLock()
ID = r'[a-f0-9]{32}'
BUSY = ('planning', 'rendering')
MAX_WORDS = 80
DEMO = '5574d82afab14194aeaa2390bfe514ef'
FISH_BOOTSTRAP_LOCK = threading.Lock()
FISH_BOOTSTRAP_ATTEMPTED = False


class Conflict(ValueError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False))
    temporary.replace(path)


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(ID, value):
        raise ValueError('Invalid project or version.')
    return value


def load(pid):
    with LOCK:
        try:
            return json.loads((STORE / identifier(pid) / 'project.json').read_text())
        except FileNotFoundError as exc:
            raise ValueError('This Frame project was not found.') from exc


def save(project):
    write(STORE / project['id'] / 'project.json', project)


def version(project, vid=None):
    vid = vid or project['active_version_id']
    for item in project['versions']:
        if item['id'] == vid:
            return item
    raise ValueError('This saved version was not found.')


def folder(pid, vid):
    return STORE / identifier(pid) / 'versions' / identifier(vid)


def update(pid, vid, **values):
    with LOCK:
        project = load(pid)
        item = version(project, vid)
        item.update(values)
        if vid == project['active_version_id']:
            for key in ('status', 'stage', 'error'):
                if key in values:
                    project[key] = values[key]
        if values.get('status') == 'complete':
            project['current_version_id'] = vid
        project['updated'] = time.time()
        save(project)


def public(project):
    keys = ('id', 'name', 'idea', 'script', 'created', 'updated', 'status', 'stage',
            'error', 'active_version_id', 'current_version_id')
    result = {key: project.get(key) for key in keys}
    result['versions'] = []
    for item in project['versions']:
        row = {key: item.get(key) for key in ('id', 'number', 'status', 'stage', 'feedback',
                                             'summary', 'result', 'error', 'created', 'base_version_id')}
        q = item.get('quote')
        row['quote'] = ({key: q.get(key) for key in ('quote_id', 'total_credits', 'available_credits',
                          'has_sufficient_balance', 'created_at')} if q else None)
        if row['quote']:
            row['quote']['expires_at'] = q['created_at'] + 900
        result['versions'].append(row)
    return result


def projects():
    rows = []
    for path in STORE.glob('*/project.json'):
        try:
            d = json.loads(path.read_text())
            rows.append({key: d.get(key) for key in ('id', 'name', 'status', 'created', 'updated')})
        except (OSError, ValueError):
            continue
    return sorted(rows, key=lambda row: row.get('updated') or row['created'], reverse=True)


def config():
    from studio_mcp_voice import capabilities
    import studio_fish_mcp
    global FISH_BOOTSTRAP_ATTEMPTED
    cap = capabilities()
    # A saved authorization can outlive a process or access token. Discover the
    # existing account's tools once, without speech calls or a new login flow.
    if not cap.get('ready'):
        with FISH_BOOTSTRAP_LOCK:
            if not FISH_BOOTSTRAP_ATTEMPTED and studio_fish_mcp.status().get('authorized'):
                FISH_BOOTSTRAP_ATTEMPTED = True
                try:
                    studio_fish_mcp.verify()
                except (OSError, ValueError, RuntimeError):
                    pass  # Keep the existing connection UI available for a manual retry.
                cap = capabilities()
    existing = []
    for path in studio.STORE.glob('*/project.json'):
        try:
            d = json.loads(path.read_text())
            t = path.parent / 'render' / 'timing.json'
            if d.get('status') == 'complete' and t.is_file():
                timing = json.loads(t.read_text())
                if 1 <= timing.get('duration', 0) <= 60 and not d.get('assets'):
                    existing.append({'id': d['id'], 'name': d['name']})
        except (OSError, ValueError, TypeError):
            continue
    return {'fish_ready': bool(cap.get('ready')), 'voice_name': (cap.get('selected_voice') or {}).get('name', 'Fish narrator'),
            'default_provider': 'fish-mcp', 'limits': {'script_chars': 1800, 'script_words': MAX_WORDS, 'seconds': 60},
            'demo_studio_id': DEMO if any(d['id'] == DEMO for d in existing) else None,
            'existing_studio': existing, 'revision_scope': 'Visual direction; narration stays unchanged.'}


def validate_brief(body):
    script, idea = body.get('script', ''), body.get('idea', '')
    if not isinstance(script, str) or not 1 <= len(script.strip()) <= 1800:
        raise ValueError('Add a script of 1 to 1,800 characters.')
    if len(script.split()) > MAX_WORDS:
        raise ValueError('Use up to 80 words for this one-minute video experience.')
    if not isinstance(idea, str) or len(idea) > 1800:
        raise ValueError('Keep the idea under 1,800 characters.')
    return script.strip(), idea.strip()


def request(body):
    rid = body.get('request_id')
    if not isinstance(rid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', rid):
        raise ValueError('A saved request ID is required. Reload the page and try again.')
    return rid


def replay(rid, signature):
    # Called under LOCK, before provider validation or any side effect.
    for path in STORE.glob('*/project.json'):
        project = json.loads(path.read_text())
        for item in project.get('requests', []):
            if item['id'] == rid:
                if item['signature'] != signature:
                    raise Conflict('This request ID already belongs to different inputs.')
                return project
    return None


def room():
    if sum(p['status'] in BUSY for p in projects()) >= 3:
        raise Conflict('Three videos are already queued. Wait for one to finish.')
    STORE.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(STORE).free < 800 * 1024 * 1024:
        raise ValueError('At least 800 MB of free disk space is needed to make a video.')


def new_version(number=1, **values):
    return {'id': uuid.uuid4().hex, 'number': number, 'created': time.time(), 'status': 'planning',
            'stage': 'Preparing your video', 'error': None, 'feedback': '', 'summary': None,
            'result': None, 'quote': None, 'plan': None, **values}


def new_project(script, idea, voice, rid, signature, item):
    now = time.time()
    return {'id': uuid.uuid4().hex, 'name': script[:64], 'script': script, 'idea': idea,
            'voice': voice, 'created': now, 'updated': now, 'status': item['status'],
            'stage': item['stage'], 'error': None, 'active_version_id': item['id'],
            'current_version_id': None, 'versions': [item],
            'requests': [{'id': rid, 'signature': signature, 'version_id': item['id']}]}


def launch(pid, vid):
    threading.Thread(target=worker, args=(pid, vid), daemon=True).start()


def generate(body):
    script, idea = validate_brief(body)
    rid = request(body)
    provider = body.get('provider', 'fish-mcp')
    if provider not in ('fish-mcp', 'edge'):
        raise ValueError('Choose Fish narration or the explicitly labeled preview voice.')
    signature = digest({'action': 'generate', 'script': script, 'idea': idea, 'provider': provider})
    with LOCK:
        old = replay(rid, signature)
        if old:
            return public(old)
        room()
        voice = studio_inputs.validate_voice({'mode': 'ai', 'provider': provider}, script)
        item = new_version()
        project = new_project(script, idea, voice, rid, signature, item)
        save(project)
    launch(project['id'], item['id'])
    return public(project)


def fingerprint(project, item):
    plan = item['plan']
    return digest({'script': project['script'], 'voice': project['voice'],
                   'delivery': plan.get('delivery'), 'identity': plan['identity'],
                   'narration': [s['narration'] for s in plan['scenes']]})


def synthesis_intent(project, item):
    """Bind recovery artifacts to the exact invocation before any speech call."""
    voice, plan = project['voice'], item['plan']
    result = {'fingerprint': fingerprint(project, item), 'provider': voice.get('provider')}
    if voice.get('provider') == 'fish-mcp':
        from studio_mcp_voice import _compile, _digest
        units = _compile(voice_units(plan), plan['identity'], voice['voice_id'], voice['model'])
        result.update(request_sha256=_digest(units), voice_id=voice['voice_id'], model=voice['model'])
    else:
        result['request_sha256'] = digest({'units': voice_units(plan), 'identity': plan['identity'], 'voice': voice})
    return result


def reconcile_paid_receipt(project, item):
    """Recover saved provider responses; an unproven outcome remains blocked."""
    output = folder(project['id'], item['id']) / 'audio'
    path = output / 'mcp-narration-receipt.json'
    if not path.exists():
        return None
    from studio_mcp_voice import _compile, _digest, _write as write_receipt
    voice, plan = project['voice'], item['plan']
    units = _compile(voice_units(plan), plan['identity'], voice['voice_id'], voice['model'])
    receipt = json.loads(path.read_text())
    records = receipt.get('units')
    if (receipt.get('request_sha256') != _digest(units)
            or receipt.get('voice_id') != voice['voice_id'] or receipt.get('model') != voice['model']
            or not isinstance(records, list) or len(records) != len(units)):
        raise ValueError('The saved Fish receipt does not match this narration. No speech was resubmitted.')
    changed = False
    for index, (record, unit) in enumerate(zip(records, units)):
        if not isinstance(record, dict) or record.get('status') not in ('planned', 'submitted', 'unknown', 'received', 'complete'):
            raise ValueError('The saved Fish receipt is invalid. No speech was resubmitted.')
        if record['status'] in ('submitted', 'unknown', 'received'):
            response_path = output / ('mcp-unit-%02d' % index) / 'provider-result.json'
            if not response_path.is_file():
                raise ValueError('A Fish request has an unknown outcome. It will not be submitted again.')
            envelope = json.loads(response_path.read_text())
            if (envelope.get('request_sha256') != _digest(unit['payload'])
                    or not isinstance(envelope.get('response'), dict)):
                raise ValueError('The saved Fish response does not match this request. No speech was resubmitted.')
            if record['status'] != 'received':
                record['status'] = 'received'
                changed = True
    if changed:
        write_receipt(path, receipt)
    return receipt


def validate_audio(timing, audio, script):
    if not isinstance(timing, dict) or timing.get('fps') != 30:
        raise ValueError('Narration timing must use 30 frames per second.')
    frames = timing.get('frames')
    if isinstance(frames, bool) or not isinstance(frames, int) or not 30 <= frames <= 1800:
        raise ValueError('This experience supports videos from one to 60 seconds. Your narration is saved.')
    if ' '.join(' '.join(s['narration'].split()) for s in timing['scenes']) != ' '.join(script.split()):
        raise ValueError('Saved narration does not match the exact script.')
    with wave.open(str(audio), 'rb') as source:
        if (source.getframerate(), source.getnchannels(), source.getsampwidth(), source.getnframes()) != (48000, 1, 2, frames * 1600):
            raise ValueError('Saved narration has inconsistent audio or frame timing.')
    cursor = 0
    for scene in timing['scenes']:
        start, end = scene['start_frame'], scene['end_frame']
        if start != cursor or not isinstance(end, int) or end <= start or end > frames:
            raise ValueError('Narration scenes must be contiguous.')
        cursor = end
        previous = start / 30
        if not scene.get('words'):
            raise ValueError('Narration needs measured word timing.')
        for word in scene['words']:
            a, b = word['start'], word['end']
            if any(isinstance(x, bool) or not isinstance(x, (float, int)) or not math.isfinite(x) for x in (a, b)):
                raise ValueError('Invalid measured word timing.')
            if not start / 30 <= a <= b <= end / 30 + .00001 or a < previous:
                raise ValueError('Words must stay in their measured scene.')
            previous = a
    if cursor != frames:
        raise ValueError('Narration does not cover the complete video.')


def checkpoint(project, item, timing, source=None):
    target = folder(project['id'], item['id']) / 'audio'
    target.mkdir(parents=True, exist_ok=True)
    origin = Path(source or timing['audio'])
    validate_audio(timing, origin, project['script'])
    actual = sha(origin)
    if timing.get('audio_sha256') and timing['audio_sha256'] != actual:
        raise ValueError('The saved narration changed. It will not be regenerated automatically.')
    output = target / 'narration.wav'
    if origin.resolve() != output.resolve():
        shutil.copy2(origin, output)
    saved = copy.deepcopy(timing)
    saved['audio'] = str(output)
    saved['audio_sha256'] = actual
    write(target / 'checkpoint.json', {'fingerprint': fingerprint(project, item),
          'audio_sha256': actual, 'timing_sha256': digest(saved), 'timing': saved})
    return saved


def read_checkpoint(project, item):
    path = folder(project['id'], item['id']) / 'audio' / 'checkpoint.json'
    if not path.exists():
        # Synthesis may finish just before the process exits. Only artifacts
        # bound before synthesis and carrying the exact completed WAV hash can
        # fill that narrow checkpoint gap; a bare WAV never authorizes reuse.
        recovered = recover_completed_narration(project, item)
        if recovered is not None:
            return recovered
        if item.get('source_studio_id') or item.get('base_version_id') or (path.parent / 'narration.wav').exists():
            raise ValueError('The saved narration checkpoint is missing. It will not be regenerated automatically.')
        return None
    saved = json.loads(path.read_text())
    timing = saved['timing']
    audio = path.parent / 'narration.wav'
    if (saved.get('fingerprint') != fingerprint(project, item)
            or digest(timing) != saved.get('timing_sha256')
            or not audio.is_file() or sha(audio) != saved.get('audio_sha256')):
        raise ValueError('The saved narration checkpoint changed. It will not be regenerated automatically.')
    timing['audio'] = str(audio)
    validate_audio(timing, audio, project['script'])
    return timing


def recover_completed_narration(project, item):
    output = folder(project['id'], item['id']) / 'audio'
    intent_path = output / 'intent.json'
    if not intent_path.exists():
        return None
    intent = json.loads(intent_path.read_text())
    expected = synthesis_intent(project, item)
    if intent != expected:
        raise ValueError('The saved speech request changed. It will not be regenerated automatically.')
    audio = output / 'narration.wav'
    measured = output / 'measured-timing.json'
    raw_result = output / 'mcp-narration.json'
    if not audio.exists():
        if measured.exists() or raw_result.exists():
            raise ValueError('Completed narration audio is missing. It will not be generated again.')
        return None
    if measured.is_file():
        timing = json.loads(measured.read_text())
        if (timing.get('generation_fingerprint') != expected['fingerprint']
                or timing.get('speech_request_sha256') != expected['request_sha256']):
            raise ValueError('Saved narration timing does not match this generation request.')
    elif expected['provider'] == 'fish-mcp' and raw_result.is_file():
        timing = json.loads(raw_result.read_text())
        if (timing.get('request_sha256') != expected['request_sha256']
                or timing.get('voice_id') != expected['voice_id'] or timing.get('model') != expected['model']):
            raise ValueError('The completed Fish narration does not match this generation request.')
        timing = collapse_timeline(timing, item['plan'])
    else:
        return None
    expected_hash = timing.get('audio_sha256')
    if not isinstance(expected_hash, str) or not re.fullmatch(r'[a-f0-9]{64}', expected_hash) or expected_hash != sha(audio):
        raise ValueError('Completed narration audio is unbound or changed. It will not be generated again.')
    timing['audio'] = str(audio)
    validate_audio(timing, audio, project['script'])
    return checkpoint(project, item, timing, audio)


def import_studio(body):
    sid, rid = identifier(body.get('studio_id')), request(body)
    signature = digest({'action': 'import', 'studio_id': sid})
    with LOCK:
        old = replay(rid, signature)
        if old:
            return public(old)
        room()
        source = studio.load(sid)
        if source.get('status') != 'complete':
            raise ValueError('Choose a completed Studio video with saved narration.')
        if source.get('assets'):
            raise ValueError('Continue projects with supplied images or footage in Advanced Studio.')
        validate_plan(source['plan'], source['script'], [])
        origin = studio.STORE / sid / 'render'
        timing = json.loads((origin / 'timing.json').read_text())
        audio = origin / 'narration.wav'
        validate_audio(timing, audio, source['script'])
        item = new_version(plan=copy.deepcopy(source['plan']), source_studio_id=sid,
                           status='rendering', stage='Reusing your saved narration')
        project = new_project(source['script'], source.get('direction', ''), source.get('voice', {}), rid, signature, item)
        checkpoint(project, item, timing, audio)
        # Immutable provenance for the existing performance, without provider URLs or credentials.
        receipt = origin / 'mcp-narration-receipt.json'
        if receipt.is_file():
            write(folder(project['id'], item['id']) / 'audio' / 'source-receipt.json',
                  {'studio_id': sid, 'receipt_sha256': sha(receipt), 'audio_sha256': sha(audio)})
        save(project)
    launch(project['id'], item['id'])
    return public(project)


def revise(pid, body):
    rid = request(body)
    feedback = body.get('feedback')
    if not isinstance(feedback, str) or not 1 <= len(feedback.strip()) <= 1800:
        raise ValueError('Describe the visual change in 1 to 1,800 characters.')
    base = identifier(body.get('base_version_id'))
    signature = digest({'action': 'revise', 'project': pid, 'base': base, 'feedback': feedback.strip()})
    with LOCK:
        old = replay(rid, signature)
        if old:
            return public(old)
        project = load(pid)
        if project['status'] in BUSY or project['status'] == 'awaiting_quote':
            raise Conflict('Finish the current version before requesting another change.')
        parent = version(project, base)
        if parent['status'] != 'complete':
            raise ValueError('Choose a completed version to revise.')
        narration = read_checkpoint(project, parent)
        if narration is None:
            raise ValueError('The original narration checkpoint is missing.')
        room()
        item = new_version(len(project['versions']) + 1, status='rendering', stage='Directing your visual revision',
                           feedback=feedback.strip(), base_version_id=base, plan=copy.deepcopy(parent['plan']),
                           previous_graphics=copy.deepcopy(parent.get('graphics_plan')))
        checkpoint(project, item, narration)
        project['versions'].append(item)
        project['requests'].append({'id': rid, 'signature': signature, 'version_id': item['id']})
        project.update(active_version_id=item['id'], status=item['status'], stage=item['stage'], error=None)
        save(project)
    launch(pid, item['id'])
    return public(project)


def quote_version(pid, vid):
    from studio_mcp_voice import quote
    with LOCK:
        project = load(pid)
        item = version(project, identifier(vid))
        if item['id'] != project['active_version_id']:
            raise Conflict('Only the current version can receive a narration quote.')
        if item['status'] not in ('awaiting_quote', 'failed') or not item.get('plan'):
            raise Conflict('This version is not waiting for a narration quote.')
        if project['voice'].get('provider') != 'fish-mcp' or read_checkpoint(project, item) is not None:
            raise ValueError('This version does not need new Fish narration.')
        reconcile_paid_receipt(project, item)
        voice = project['voice']
        quoted = quote(voice_units(item['plan']), item['plan']['identity'], voice['voice_id'], voice['model'])
        item.update(quote=quoted, status='awaiting_quote', stage='Review the narration cost', error=None, approved_quote_id=None)
        project.update(status=item['status'], stage=item['stage'], error=None)
        save(project)
    return public(project)


def approve(pid, body):
    from studio_mcp_voice import _approved, _compile
    with LOCK:
        project = load(pid)
        item = version(project, identifier(body.get('version_id')))
        if item['id'] != project['active_version_id']:
            raise Conflict('Only the current version can be generated.')
        if item['status'] in ('rendering', 'complete') and item.get('approved_quote_id') == body.get('quote_id'):
            return public(project)
        if item['status'] != 'awaiting_quote':
            raise Conflict('Review a narration quote before generating this version.')
        q = item.get('quote')
        if not q or body.get('quote_id') != q['quote_id']:
            raise ValueError('Review and confirm the displayed Fish credit quote.')
        voice = project['voice']
        units = _compile(voice_units(item['plan']), item['plan']['identity'], voice['voice_id'], voice['model'])
        _approved(q, units, voice['voice_id'], voice['model'])
        item.update(approved_quote_id=q['quote_id'], status='rendering', stage='Preparing your narration', error=None)
        project.update(status=item['status'], stage=item['stage'], error=None)
        save(project)
    launch(pid, item['id'])
    return public(project)


def retry(pid, body):
    with LOCK:
        project = load(pid)
        item = version(project, identifier(body.get('version_id')))
        if item['id'] != project['active_version_id']:
            raise Conflict('Retry the current version; earlier versions remain saved.')
        if item['status'] in BUSY or item['status'] == 'complete':
            return public(project)
        if item['status'] != 'failed':
            raise Conflict('This version is not waiting for a retry.')
        narration = read_checkpoint(project, item) if item.get('plan') else None
        # Paid attempts are never restarted under a stale, unrelated or absent approval.
        if narration is None and project['voice'].get('provider') == 'fish-mcp':
            reconcile_paid_receipt(project, item)
        room()
        item.update(status='rendering' if item.get('plan') else 'planning', stage='Resuming this version', error=None)
        project.update(status=item['status'], stage=item['stage'], error=None)
        save(project)
    launch(pid, item['id'])
    return public(project)


def prepare_narration(project, item, stage):
    cached = read_checkpoint(project, item)
    if cached is not None:
        stage('Using the saved narration')
        return cached
    voice, plan = project['voice'], item['plan']
    output = folder(project['id'], item['id']) / 'audio'
    output.mkdir(parents=True, exist_ok=True)
    intent = synthesis_intent(project, item)
    intent_path = output / 'intent.json'
    if intent_path.exists() and json.loads(intent_path.read_text()) != intent:
        raise ValueError('This saved speech request belongs to different inputs.')
    write(intent_path, intent)
    if voice['provider'] == 'fish-mcp':
        from studio_mcp_voice import synthesize_mcp
        if not item.get('quote') or not item.get('approved_quote_id') or item['approved_quote_id'] != item['quote'].get('quote_id'):
            raise ValueError('Confirm the narration quote before generating speech.')
        timeline = synthesize_mcp(output, voice_units(plan), plan['identity'], stage,
                    voice_id=voice['voice_id'], model=voice['model'], expected_quote=item['quote'])
    elif voice['provider'] == 'edge':
        from studio_voice import synthesize_narration
        timeline = synthesize_narration(output, voice_units(plan), plan['identity'], stage)
    else:
        raise ValueError('This voice can only be reused from a saved narration checkpoint.')
    timeline = collapse_timeline(timeline, plan)
    # Preserve generated audio even if the compatibility check rejects its length.
    timeline.update(audio_sha256=sha(timeline['audio']), generation_fingerprint=intent['fingerprint'],
                    speech_request_sha256=intent['request_sha256'])
    write(output / 'measured-timing.json', timeline)
    return checkpoint(project, item, timeline)


def worker(pid, vid):
    try:
        with studio.WORKER:
            project = load(pid)
            item = version(project, vid)
            stage = lambda message: update(pid, vid, stage=message)
            if not item.get('plan'):
                work = folder(pid, vid)
                work.mkdir(parents=True, exist_ok=True)
                direction = (project['idea'] + '\nCreate a concise video under one minute. Use coherent cream, ink and red semantic typography and graphics. '
                             'Prefer clear thought beats, each under 180 characters. Keep narration exact. Visuals will be composed by the semantic graphics director.')
                plan, review = direct(work, project['script'], direction, [], None, stage,
                                      studio_inputs.voice_context(project['voice']))
                validate_plan(plan, project['script'], [])
                # Conservative planning check happens before any paid speech call.
                pauses = sum(b.get('pause_after_ms', 0) for b in plan.get('delivery', {}).get('beats', [])) / 1000
                if len(project['script'].split()) / 1.7 + pauses > 58:
                    raise ValueError('This narration direction may exceed one minute. Use a shorter script.')
                update(pid, vid, plan=plan, summary=review['summary'])
                project = load(pid)
                item = version(project, vid)
            if project['voice'].get('provider') == 'fish-mcp' and read_checkpoint(project, item) is None:
                q = item.get('quote') or {}
                if (item.get('approved_quote_id') != q.get('quote_id') or not q
                        or not 0 <= time.time() - q.get('created_at', 0) <= 900):
                    update(pid, vid, status='awaiting_quote', stage='Checking narration cost')
                    quote_version(pid, vid)
                    return
            update(pid, vid, status='rendering', error=None)
            narration = prepare_narration(project, item, stage)
            from frame_graphics import render_graphics
            result = render_graphics(folder(pid, vid) / 'render', narration, item['plan'], project['idea'],
                                     feedback=item['feedback'], previous=item.get('previous_graphics'), stage=stage)
            output = folder(pid, vid) / 'render' / 'export.mp4'
            if not output.is_file() or not output.stat().st_size:
                raise RuntimeError('The compositor did not produce a complete video.')
            base = '/frame-media/' + pid + '/' + vid + '/'
            published = {key: result.get(key) for key in ('duration', 'frames', 'width', 'height', 'voice_provider', 'warnings', 'narration_sha256')}
            published.update(url=base+'export.mp4', poster_url=base+'poster.jpg', sha256=sha(output), summary=result['summary'])
            update(pid, vid, status='complete', stage='Your video is ready', result=published,
                   graphics_plan=result['graphics_plan'], summary=result['summary'], error=None)
    except Exception as exc:
        update(pid, vid, status='failed', stage='Your progress is saved', error=str(exc)[-1200:])


def recover():
    with LOCK:
        for path in STORE.glob('*/project.json'):
            try:
                project = json.loads(path.read_text())
                for item in project['versions']:
                    if item['status'] in BUSY:
                        item.update(status='failed', stage='Your progress is saved',
                                    error='The app restarted. Resume this version to continue from saved progress.')
                active = version(project)
                project.update(status=active['status'], stage=active['stage'], error=active.get('error'))
                save(project)
            except (OSError, ValueError, KeyError):
                continue


def get(handler):
    path = urlparse(handler.path).path
    try:
        if path in ('/', '/frame', '/frame.js', '/frame.css'):
            name = 'frame.html' if path in ('/', '/frame') else path[1:]
            mime = 'text/html; charset=utf-8' if name.endswith('.html') else ('text/css; charset=utf-8' if name.endswith('.css') else 'text/javascript; charset=utf-8')
            handler.send(200, (ROOT / name).read_bytes(), mime)
        elif path == '/api/frame/config':
            handler.json(200, config())
        elif path == '/api/frame/projects':
            handler.json(200, projects())
        elif match := re.fullmatch('/api/frame/projects/('+ID+')', path):
            handler.json(200, public(load(match[1])))
        elif match := re.fullmatch('/frame-media/('+ID+')/('+ID+')/(export.mp4|poster.jpg|contact.jpg)', path):
            project = load(match[1])
            item = version(project, match[2])
            if item['status'] != 'complete':
                raise ValueError('This video has not finished rendering.')
            handler.media(folder(match[1], match[2]) / 'render' / match[3], 'video/mp4' if path.endswith('.mp4') else 'image/jpeg')
        else:
            return False
    except (ValueError, OSError) as exc:
        handler.json(404, {'error': str(exc)})
    return True


def post(handler):
    path = urlparse(handler.path).path
    if not path.startswith('/api/frame/'):
        return False
    try:
        length = int(handler.headers.get('Content-Length', '0'))
        if not 0 < length <= 12000:
            raise ValueError('Invalid request size.')
        body = json.loads(handler.rfile.read(length))
        if not isinstance(body, dict):
            raise ValueError('Expected a JSON object.')
        if path == '/api/frame/generate':
            result = generate(body)
        elif path == '/api/frame/import':
            result = import_studio(body)
        elif match := re.fullmatch('/api/frame/projects/('+ID+')/(revise|render|retry|quote)', path):
            pid, action = match.groups()
            if action == 'quote':
                result = quote_version(pid, body.get('version_id'))
            else:
                result = {'revise': revise, 'render': approve, 'retry': retry}[action](pid, body)
        else:
            handler.json(404, {'error': 'Frame action not found.'})
            return True
        handler.json(202, result)
    except Conflict as exc:
        handler.close_connection = True
        handler.json(409, {'error': str(exc)})
    except (ValueError, OSError, RuntimeError, KeyError, TypeError) as exc:
        handler.close_connection = True
        handler.json(400, {'error': str(exc)})
    return True
