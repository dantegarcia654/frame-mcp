"""Persistent local script studio; existing footage editor stays independent."""
import json
import mimetypes
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import unquote, urlparse, parse_qs
from PIL import Image, ImageDraw, ImageOps
from editor import probe, run
from studio_director import direct, inspect_render, validate_plan
from studio_delivery import voice_units, collapse_timeline
import studio_inputs

ROOT = Path(__file__).resolve().parent
STORE = ROOT / 'studio-jobs'
ASSETS = STORE / 'assets'
ASSETS.mkdir(parents=True, exist_ok=True)
LOCK = threading.RLock()
WORKER = threading.Semaphore(1)
ID = r'[a-f0-9]{32}'
MAX_ASSET = 20 * 1024 * 1024


def save(data):
    folder = STORE / data['id']
    folder.mkdir(exist_ok=True)
    temp = folder / 'project.tmp'
    temp.write_text(json.dumps(data, indent=2))
    temp.replace(folder / 'project.json')


def load(pid):
    if not isinstance(pid, str) or not re.fullmatch(ID, pid):
        raise ValueError('Invalid studio project.')
    with LOCK:
        path = STORE / pid / 'project.json'
        if not path.is_file():
            raise ValueError('Studio project not found.')
        return json.loads(path.read_text())


def asset(aid):
    if not isinstance(aid, str) or not re.fullmatch(ID, aid):
        raise ValueError('Invalid asset.')
    try:
        return json.loads((ASSETS / aid / 'asset.json').read_text())
    except FileNotFoundError as exc:
        raise ValueError('An uploaded asset is missing. Upload it again.') from exc


def public_asset(data):
    return {k: v for k, v in data.items() if k not in ('path', 'preview_path')}


def public(data):
    return {**data, 'assets': [public_asset(a) for a in data['assets']]}


def update(pid, **values):
    with LOCK:
        data = load(pid)
        data.update(values)
        save(data)


def recover():
    studio_inputs.recover_voices()
    for path in STORE.glob('*/project.json'):
        try:
            data = json.loads(path.read_text())
            if data['status'] in ('planning', 'rendering'):
                data.update(status='failed', stage='Interrupted',
                            error='The app stopped during generation. Your inputs are saved. Create a new direction to retry.')
                save(data)
        except (ValueError, KeyError, OSError):
            continue


def plan_worker(pid, previous):
    try:
        with WORKER:
            data = load(pid)
            voice = data.get('voice',{'mode':'ai','provider':'edge','recording_id':None})
            plan, review = direct(STORE/pid, data['script'], data['direction'], data['assets'], previous,
                                  lambda text: update(pid, stage=text), studio_inputs.voice_context(voice))
            update(pid, status='ready', stage='Creative direction ready', plan=plan, review=review)
    except Exception as exc:
        update(pid, status='failed', stage='Planning failed', error=str(exc)[-1200:])


def render_worker(pid):
    try:
        with WORKER:
            from studio_render import render_studio
            data = load(pid)
            validate_plan(data['plan'], data['script'], data['assets'])
            folder = STORE/pid/'render'
            voice = studio_inputs.validate_voice(data.get('voice'),data['script'])
            stage = lambda text: update(pid,stage=text)
            narration = None
            if voice['mode']=='recording':
                from studio_recording import prepare_recorded_narration
                narration = prepare_recorded_narration(folder,data['plan']['scenes'],data['plan']['identity'],
                    studio_inputs.read_voice(voice['recording_id']),stage)
            elif voice['provider']=='fish-mcp':
                from studio_mcp_voice import synthesize_mcp
                narration=synthesize_mcp(folder,voice_units(data['plan']),data['plan']['identity'],stage,
                    voice_id=voice['voice_id'],model=voice['model'],expected_quote=data.get('narration_quote'))
                narration=collapse_timeline(narration,data['plan'])
            elif voice['provider']=='fish':
                from studio_fish import synthesize_fish
                reference=studio_inputs.read_voice(voice['recording_id']) if voice['mode']=='clone' else None
                narration=synthesize_fish(folder,voice_units(data['plan']),data['plan']['identity'],stage,reference=reference)
                narration=collapse_timeline(narration,data['plan'])
            result = render_studio(folder, data['plan'], data['assets'], stage, narration=narration)
            export = folder/'export.mp4'
            if not export.is_file():
                raise RuntimeError('The renderer did not produce an export.')
            info = probe(export, enforce_limit=False)
            if not info['audio'] or (info['width'], info['height']) != (1080, 1920):
                raise RuntimeError('Export verification failed: expected vertical 1080p video and narration.')
            run(['ffmpeg', '-v', 'error', '-i', str(export), '-f', 'null', '-'])
            warnings = list(result.get('warnings', []))
            qa = None
            if (folder/'contact.jpg').exists():
                update(pid, stage='Inspecting rendered composition and readability')
                try:
                    qa = inspect_render(folder, data['plan'], folder/'contact.jpg')
                    warnings.extend(qa.get('issues', []))
                except Exception:
                    warnings.append('Automatic visual review was unavailable. Review the preview before publishing.')
            result = {'url': '/studio-media/'+pid+'/export.mp4',
                      'preview_url': '/studio-media/'+pid+'/preview.mp4',
                      'duration': info['duration'], 'voice_provider': result.get('voice_provider', 'neural'),
                      'warnings': warnings, 'visual_review': qa,
                      'timing_url': '/studio-media/'+pid+'/timing.json'}
            update(pid, status='complete', stage='Video ready to review', result=result)
    except Exception as exc:
        update(pid, status='failed', stage='Generation failed', error=str(exc)[-1200:])


def get(handler):
    path = urlparse(handler.path).path
    if path == '/api/studio/fish-mcp/status':
        import studio_fish_mcp
        handler.json(200, studio_fish_mcp.status())
    elif path == '/api/studio/fish-mcp/callback':
        import studio_fish_mcp
        try:
            query = parse_qs(urlparse(handler.path).query, keep_blank_values=True)
            if any(len(values) != 1 for values in query.values()):
                raise ValueError('The sign-in response is invalid. Start sign-in again from Frame.')
            studio_fish_mcp.finish_login({key: values[0] for key, values in query.items()})
            try:
                studio_fish_mcp.verify()
            except (ValueError, OSError, RuntimeError):
                pass  # Preserve authorization; the visible Check connection action can retry discovery.
        except (ValueError, OSError, RuntimeError):
            handler.send(400, b'<!doctype html><meta name="referrer" content="no-referrer"><title>Fish Audio sign-in</title><p>Fish Audio sign-in could not finish. Your Frame projects are saved.</p><p><a href="/studio#fishSettings">Return to Frame and try sign-in again</a></p>', 'text/html; charset=utf-8')
            return True
        handler.send_response(303)
        handler.send_header('Location', '/studio#fishSettings')
        handler.send_header('Cache-Control', 'no-store')
        handler.send_header('Referrer-Policy', 'no-referrer')
        handler.send_header('Content-Length', '0')
        handler.end_headers()
    elif path in ('/studio', '/studio.js'):
        file = ROOT / ('studio.html' if path == '/studio' else 'studio.js')
        handler.send(200, file.read_bytes(), 'text/html; charset=utf-8' if path == '/studio' else 'text/javascript; charset=utf-8')
    elif path=='/api/studio/capabilities':
        handler.json(200,studio_inputs.capabilities())
    elif match := re.fullmatch('/api/studio/voice/('+ID+')',path):
        try:
            handler.json(200,studio_inputs.public_voice(studio_inputs.read_voice(match[1])))
        except ValueError as exc:
            handler.json(404,{'error':str(exc)})
    elif match := re.fullmatch('/studio-voice/('+ID+')/recording.wav',path):
        handler.media(studio_inputs.VOICES/match[1]/'analysis'/'recording.wav','audio/wav')
    elif path == '/api/studio/projects':
        rows = []
        for p in STORE.glob('*/project.json'):
            try:
                d = json.loads(p.read_text())
                rows.append({k:d.get(k) for k in ('id','name','created','status','parent_id')})
            except (ValueError, OSError):
                continue
        handler.json(200, sorted(rows, key=lambda d:d['created'], reverse=True))
    elif match := re.fullmatch('/api/studio/projects/('+ID+')', path):
        try:
            handler.json(200, public(load(match[1])))
        except ValueError as exc:
            handler.json(404, {'error': str(exc)})
    elif match := re.fullmatch('/studio-assets/('+ID+')/(preview.jpg|original\.(?:png|jpg|mp4))', path):
        handler.media(ASSETS/match[1]/match[2], mimetypes.guess_type(match[2])[0])
    elif match := re.fullmatch('/studio-media/('+ID+')/(export.mp4|preview.mp4|contact.jpg|timing.json)', path):
        handler.media(STORE/match[1]/'render'/match[2], mimetypes.guess_type(match[2])[0] or 'application/json')
    else:
        return False
    return True


def upload(handler, length):
    if not 0 < length <= MAX_ASSET:
        raise ValueError('Choose an image or video smaller than 20 MB.')
    role = handler.headers.get('X-Role', 'reference')
    if role not in ('reference', 'style', 'overlay'):
        raise ValueError('Choose reference, style board, or overlay for the asset.')
    if shutil.disk_usage(STORE).free < length + 300*1024*1024:
        raise ValueError('Not enough disk space for this upload.')
    aid = uuid.uuid4().hex
    folder = ASSETS/aid
    folder.mkdir()
    name = Path(unquote(handler.headers.get('X-Filename', 'Creative reference'))).name[:180]
    try:
        handler.connection.settimeout(120)
        raw = folder/'upload'
        with raw.open('wb') as out:
            remaining = length
            while remaining:
                chunk = handler.rfile.read(min(remaining, 1024*1024))
                if not chunk:
                    raise ValueError('Upload was interrupted.')
                out.write(chunk)
                remaining -= len(chunk)
        try:
            with Image.open(raw) as im:
                if im.width*im.height > 30_000_000:
                    raise ValueError('Use an image under 30 megapixels.')
                im.load()
                im = ImageOps.exif_transpose(im)
                im.thumbnail((2400, 2400))
                im.convert('RGBA').save(folder/'original.png')
                preview = im.convert('RGB')
                preview.thumbnail((960, 720))
                kind, original = 'image', folder/'original.png'
        except (Image.UnidentifiedImageError, OSError):
            info = probe(raw)
            if max(info['width'], info['height']) > 4096:
                raise ValueError('Reference videos must be 4K or smaller.')
            original = folder/'original.mp4'
            raw.replace(original)
            preview = Image.new('RGB', (960, 540), '#11151d')
            for i in range(4):
                shot = folder/('sample-%s.jpg'%i)
                run(['ffmpeg','-y','-v','error','-ss',str((i+.5)*info['duration']/4),'-i',str(original),
                     '-frames:v','1','-vf','scale=480:270:force_original_aspect_ratio=decrease',str(shot)])
                with Image.open(shot) as frame:
                    preview.paste(frame, ((i%2)*480, (i//2)*270))
            kind = 'video'
        sheet = Image.new('RGB', (960, preview.height+42), '#11151d')
        sheet.paste(preview, (0,42))
        ImageDraw.Draw(sheet).text((12,12), role.upper()+' | '+aid, fill='white')
        sheet.save(folder/'preview.jpg', quality=85)
        raw.unlink(missing_ok=True)
        data = {'id':aid,'name':name,'role':role,'kind':kind,'path':str(original),
                'preview_path':str(folder/'preview.jpg'),'url':'/studio-assets/'+aid+'/preview.jpg'}
        (folder/'asset.json').write_text(json.dumps(data, indent=2))
        return public_asset(data)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


def post(handler):
    path = urlparse(handler.path).path
    if not path.startswith('/api/studio/'):
        return False
    try:
        length = int(handler.headers.get('Content-Length', '0'))
        if path=='/api/studio/voice':
            handler.json(202,studio_inputs.upload_voice(handler,length))
            return True
        if path == '/api/studio/assets':
            handler.json(200, upload(handler, length))
            return True
        if not 0 < length <= 24000:
            raise ValueError('Invalid request size.')
        body = json.loads(handler.rfile.read(length))
        if not isinstance(body, dict):
            raise ValueError('Expected a JSON object.')
        if path.startswith('/api/studio/fish-mcp/'):
            import studio_fish_mcp
            if path == '/api/studio/fish-mcp/connect':
                port = handler.server.server_address[1]
                handler.json(200, studio_fish_mcp.start_login('http://127.0.0.1:%d/api/studio/fish-mcp/callback' % port))
            elif path == '/api/studio/fish-mcp/verify':
                handler.json(200, studio_fish_mcp.verify())
            elif path == '/api/studio/fish-mcp/disconnect':
                handler.json(200, studio_fish_mcp.disconnect())
            elif path == '/api/studio/fish-mcp/voices':
                from studio_mcp_voice import search_voices
                query, own = body.get('query', ''), body.get('own', False)
                if not isinstance(query,str) or len(query)>120 or not isinstance(own,bool):
                    raise ValueError('Use a short voice search.')
                handler.json(200, search_voices(query=query,own=own))
            elif path == '/api/studio/fish-mcp/narrator':
                from studio_mcp_voice import set_voice
                set_voice(body.get('voice_id'))
                handler.json(200, studio_inputs.capabilities())
            else:
                handler.json(404, {'error': 'Fish Audio connection action not found.'})
            return True
        if path=='/api/studio/provider':
            handler.json(200,studio_inputs.configure(body))
            return True
        if path == '/api/studio/plan':
            script, direction = body.get('script', ''), body.get('direction', '')
            if not isinstance(script, str) or not 1 <= len(script.strip()) <= 6000:
                raise ValueError('Add a script of 1 to 6,000 characters.')
            if not isinstance(direction, str) or len(direction) > 2000:
                raise ValueError('Keep creative direction under 2,000 characters.')
            voice=studio_inputs.validate_voice(body.get('voice'),script)
            ids = body.get('assets', [])
            if not isinstance(ids, list) or len(ids) > 6 or any(not isinstance(i, str) for i in ids):
                raise ValueError('Use up to six creative assets.')
            assets = [asset(i) for i in dict.fromkeys(ids)]
            parent_id = body.get('parent_id')
            previous = load(parent_id).get('plan') if parent_id else None
            pid = uuid.uuid4().hex
            data = {'id':pid, 'name':script.strip()[:64], 'script':script.strip(), 'direction':direction.strip(),
                    'created':time.time(), 'parent_id':parent_id, 'assets':assets, 'voice':voice,'plan':None, 'review':None,
                    'result':None, 'status':'planning', 'stage':'Queued for creative direction', 'error':None}
            with LOCK:
                pending = sum(json.loads(p.read_text()).get('status') in ('planning','rendering') for p in STORE.glob('*/project.json'))
                if pending >= 3:
                    handler.json(409, {'error':'Three creations are already queued. Wait for one to finish.'})
                    return True
                save(data)
            threading.Thread(target=plan_worker, args=(pid,previous), daemon=True).start()
            handler.json(202, {'id':pid})
        elif match := re.fullmatch('/api/studio/projects/('+ID+')/quote',path):
            from studio_mcp_voice import quote
            data = load(match[1])
            if data['status'] != 'ready':
                raise ValueError('Finish creative direction before reviewing generation cost.')
            voice = studio_inputs.validate_voice(data.get('voice'),data['script'])
            if voice['provider'] != 'fish-mcp' or voice['mode'] != 'ai':
                raise ValueError('Account credit quotes apply to the Fish MCP narrator.')
            validate_plan(data['plan'],data['script'],data['assets'])
            quoted = quote(voice_units(data['plan']),data['plan']['identity'],voice['voice_id'],voice['model'])
            with LOCK:
                if load(data['id'])['status'] != 'ready':
                    raise ValueError('This direction changed while checking its cost. Reload the project.')
                update(data['id'],narration_quote=quoted)
            handler.json(200,quoted)
        elif match := re.fullmatch('/api/studio/projects/('+ID+')/render',path):
            with LOCK:
                data = load(match[1])
                if data['status'] != 'ready':
                    handler.json(409, {'error':'This direction has already been submitted or is not ready.'})
                    return True
                if data.get('voice',{}).get('provider') == 'fish-mcp' and data['voice'].get('mode') == 'ai':
                    quoted = data.get('narration_quote')
                    if (not isinstance(quoted,dict) or not isinstance(body.get('quote_id'),str)
                            or body['quote_id'] != quoted.get('quote_id')):
                        raise ValueError('Review the Fish account credit quote before generating this video.')
                    created = quoted.get('created_at')
                    if (isinstance(created,bool) or not isinstance(created,(int,float))
                            or not 0 <= time.time()-created <= 900):
                        raise ValueError('The Fish quote expired. Review the current generation cost again.')
                    if quoted.get('has_sufficient_balance') is not True:
                        raise ValueError('The connected Fish account does not have enough credits for this generation.')
                if shutil.disk_usage(STORE).free < 800*1024*1024:
                    raise ValueError('At least 800 MB of disk space is needed to render.')
                data.update(status='rendering',stage='Queued for generation',approved_at=time.time())
                save(data)
            threading.Thread(target=render_worker,args=(data['id'],),daemon=True).start()
            handler.json(202,{'id':data['id']})
        else:
            handler.json(404, {'error':'Studio action not found.'})
    except (ValueError, OSError, RuntimeError) as exc:
        handler.close_connection = True
        handler.json(400, {'error':str(exc)[-1200:]})
    return True
