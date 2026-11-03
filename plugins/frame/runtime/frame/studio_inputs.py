"""Recorded voice ingestion and local-only provider settings."""
import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
VOICES = ROOT/'studio-jobs'/'voices'
VOICES.mkdir(parents=True, exist_ok=True)
SETTINGS = Path.home()/'.config'/'frame-studio'/'fish.json'
LOCK = threading.RLock()
AUDIO_WORKER = threading.Semaphore(1)
ID = r'[a-f0-9]{32}'


def load_settings():
    if SETTINGS.is_file():
        try:
            saved = json.loads(SETTINGS.read_text())
            if not isinstance(saved,dict):
                return
            for key, env in [('api_key','FISH_AUDIO_API_KEY'),('voice_id','FISH_AUDIO_VOICE_ID')]:
                if isinstance(saved.get(key),str) and saved[key] and not os.environ.get(env):
                    os.environ[env] = saved[key]
        except (ValueError, OSError):
            pass


load_settings()


def capabilities():
    from studio_fish import capabilities as fish_capabilities
    from studio_fish_mcp import status as fish_mcp_status
    fish = fish_capabilities()
    from studio_mcp_voice import capabilities as mcp_narration
    return {'recording':True, 'edge':True, 'fish':{**fish, 'configured':fish['api_key_configured']},
            'fish_mcp':{**fish_mcp_status(), 'narration':mcp_narration()}}


def configure(body):
    key, voice = body.get('api_key',''), body.get('voice_id','')
    if not isinstance(key,str) or not isinstance(voice,str) or len(key)>1024 or len(voice)>160:
        raise ValueError('Invalid Fish Audio settings.')
    key, voice = key.strip(), voice.strip()
    if any(c.isspace() for c in key) or any(c.isspace() for c in voice):
        raise ValueError('Paste only the API key and voice ID, without spaces.')
    with LOCK:
        key = key or os.environ.get('FISH_AUDIO_API_KEY','')
        if not key:
            raise ValueError('Enter your Fish Audio API key in this local settings form.')
        SETTINGS.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        temporary = SETTINGS.with_suffix('.tmp')
        fd = os.open(str(temporary),os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as out:
            json.dump({'api_key':key,'voice_id':voice},out)
        temporary.replace(SETTINGS)
        os.environ['FISH_AUDIO_API_KEY'] = key
        if voice:
            os.environ['FISH_AUDIO_VOICE_ID'] = voice
        else:
            os.environ.pop('FISH_AUDIO_VOICE_ID',None)
    return capabilities()


def read_voice(vid):
    if not isinstance(vid,str) or not re.fullmatch(ID,vid):
        raise ValueError('Select a recorded voice first.')
    with LOCK:
        try:
            return json.loads((VOICES/vid/'voice.json').read_text())
        except FileNotFoundError as exc:
            raise ValueError('The recording was not found. Record or upload it again.') from exc


def save_voice(data):
    with LOCK:
        temporary = VOICES/data['id']/'voice.tmp'
        temporary.write_text(json.dumps(data,indent=2))
        temporary.replace(temporary.with_name('voice.json'))


def public_voice(data):
    keys = ('id','name','purpose','status','stage','url','transcript','duration','delivery','warnings','error','consent')
    return {k:data.get(k) for k in keys}


def recover_voices():
    for path in VOICES.glob('*/voice.json'):
        try:
            data = json.loads(path.read_text())
            if data['status']=='analyzing':
                data.update(status='failed',error='Recording analysis was interrupted. Please upload it again.')
                save_voice(data)
        except (ValueError,OSError,KeyError):
            continue


def analyze_worker(vid):
    data = read_voice(vid)
    try:
        with AUDIO_WORKER:
            from studio_recording import analyze_recording
            def stage(text):
                data['stage']=text
                save_voice(data)
            result=analyze_recording(Path(data['original_path']),VOICES/vid/'analysis',stage)
            minimum,maximum=(5,120) if data['purpose']=='clone' else (1,300)
            if not minimum<=result['duration']<=maximum:
                raise ValueError('Use a recording between %s and %s seconds.'%(minimum,maximum))
            data.update(result)
            data.update(status='ready',stage='Voice ready',error=None)
            save_voice(data)
    except Exception as exc:
        data.update(status='failed',stage='Analysis failed',error=str(exc)[-1000:])
        save_voice(data)


def upload_voice(handler,length):
    purpose=parse_qs(urlparse(handler.path).query).get('purpose',['recording'])[0]
    if purpose not in ('recording','clone'):
        raise ValueError('Choose full narration or a voice sample.')
    consent=handler.headers.get('X-Voice-Consent')=='true'
    if purpose=='clone' and not consent:
        raise ValueError('Confirm that this is your voice or you have permission to clone it.')
    if not 0<length<=20*1024*1024:
        raise ValueError('Use an audio recording smaller than 20 MB.')
    if shutil.disk_usage(VOICES).free < length+400*1024*1024:
        raise ValueError('Not enough disk space for recording analysis.')
    with LOCK:
        active=sum(json.loads(p.read_text()).get('status')=='analyzing' for p in VOICES.glob('*/voice.json'))
        if active>=3:
            raise ValueError('Three recordings are being analyzed. Wait for one to finish.')
        vid=uuid.uuid4().hex
        folder=VOICES/vid
        folder.mkdir()
        name=Path(unquote(handler.headers.get('X-Filename','Your recording'))).name[:180]
        source=folder/'original.audio'
        try:
            handler.connection.settimeout(120)
            with source.open('wb') as out:
                remaining=length
                while remaining:
                    chunk=handler.rfile.read(min(remaining,1024*1024))
                    if not chunk:
                        raise ValueError('The voice upload was interrupted.')
                    out.write(chunk)
                    remaining-=len(chunk)
            data={'id':vid,'name':name,'purpose':purpose,'consent':consent,'created':time.time(),
                  'status':'analyzing','stage':'Checking your recording','original_path':str(source),
                  'url':'/studio-voice/'+vid+'/recording.wav','error':None}
            save_voice(data)
        except Exception:
            shutil.rmtree(folder,ignore_errors=True)
            raise
    threading.Thread(target=analyze_worker,args=(vid,),daemon=True).start()
    return public_voice(data)


def validate_voice(value,script=None):
    if value is None:
        return {'mode':'ai','provider':'edge','recording_id':None}
    if not isinstance(value,dict) or value.get('mode') not in ('recording','clone','ai'):
        raise ValueError('Choose how your video should be voiced.')
    mode,provider=value['mode'],value.get('provider','edge')
    if provider not in ('fish','edge','fish-mcp'):
        raise ValueError('Unsupported narration provider.')
    if provider == 'fish-mcp' and mode == 'ai':
        from studio_mcp_voice import capabilities as mcp_narration
        cap = mcp_narration()
        if not cap.get('ready'):
            raise ValueError('Sign in with Fish Audio and choose a narrator before planning.')
        selected = cap.get('selected_voice') or {}
        voice_id = value.get('voice_id') or selected.get('id')
        if not isinstance(voice_id, str) or not re.fullmatch(ID, voice_id):
            raise ValueError('Choose a valid Fish account narrator.')
        model = value.get('model', 'drama-3')
        if model not in ('drama-3', 's2.1-pro'):
            raise ValueError('Choose a supported Fish account speech model.')
        name = selected.get('name') if selected.get('id') == voice_id else value.get('voice_name', 'Fish narrator')
        return {'mode':'ai','provider':'fish-mcp','recording_id':None,'voice_id':voice_id,
                'voice_name':str(name or 'Fish narrator')[:160], 'model':model}
    if provider == 'fish-mcp' and mode == 'clone':
        raise ValueError('Voice samples use the developer API connection. For an existing Fish account voice, choose AI narrator.')
    if mode in ('recording','clone'):
        recording=read_voice(value.get('recording_id'))
        if recording['status']!='ready' or recording['purpose']!=mode:
            raise ValueError('Finish analyzing the matching recording before planning.')
        if mode=='clone' and not recording.get('consent'):
            raise ValueError('Voice cloning requires permission for the supplied sample.')
        if mode=='recording' and script is not None:
            from studio_recording import normalized_tokens
            if normalized_tokens(script)!=normalized_tokens(recording['transcript']):
                raise ValueError('For your original recording, use its transcript so the video follows your actual words. Choose Clone to read a different script.')
    if mode=='clone' or (mode=='ai' and provider=='fish'):
        cap=capabilities()['fish']
        if not cap['configured']:
            raise ValueError('Connect Fish Audio in voice settings before using this voice.')
        if not cap['clone_ready']:
            raise ValueError('The configured Fish Audio model is unavailable. Check your provider settings.')
        if mode=='ai' and not cap['default_voice_configured']:
            raise ValueError('Choose a Fish Audio narrator voice ID in voice settings.')
    return {'mode':mode,'provider':'fish' if mode=='clone' else provider,
            'recording_id':value.get('recording_id') if mode!='ai' else None}


def voice_context(voice):
    if voice['mode']=='ai':
        context = {'mode':'ai','provider':voice['provider']}
        if voice['provider']=='fish-mcp':
            context.update(model=voice['model'],voice_name=voice.get('voice_name'),
                           delivery_controls='Native emotion and paired emphasis tags; pace is qualitative; no numeric pitch or volume control.')
        return context
    data=read_voice(voice['recording_id'])
    return {'mode':voice['mode'],'sample_duration':data['duration'],
            'observed_delivery':data['delivery'],'warnings':data.get('warnings',[]),
            'timing_locked':voice['mode']=='recording'}
