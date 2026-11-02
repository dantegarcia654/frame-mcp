"""Fish Audio narration and per-request cloning, without publishing a voice model.

Protocol verified against Fish's official docs on 2026-10-31:
https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
https://docs.fish.audio/features/text-to-speech#direct-api-messagepack
https://docs.fish.audio/features/voice-cloning

The default prototype model is explicitly s2.1-pro-free. Account/model availability
is enforced by Fish; this adapter never retries using a paid or different model.
"""
import hashlib
import difflib
import json
import math
import os
import re
import time
import wave
from pathlib import Path

import msgpack
import requests

ENDPOINT = 'https://api.fish.audio/v1/tts'
DEFAULT_MODEL = 's2.1-pro-free'
MODELS = {'s2-pro', 's2.1-pro', 's2.1-pro-free', 'drama-3'}
PROVIDER = 'Fish Audio'
MAX_AUDIO_BYTES = 64 * 1024 * 1024
MAX_REFERENCE_BYTES = 24 * 1024 * 1024


def _settings():
    return {'key': os.environ.get('FISH_AUDIO_API_KEY', '').strip(),
            'voice': os.environ.get('FISH_AUDIO_VOICE_ID', '').strip(),
            'model': os.environ.get('FISH_AUDIO_MODEL', DEFAULT_MODEL).strip()}


def capabilities():
    """Configuration readiness only; no remote calls, account claims, or secrets."""
    cfg = _settings()
    model_ok = cfg['model'] in MODELS
    ready = bool(cfg['key']) and model_ok
    missing = []
    if not cfg['key']:
        missing.append('FISH_AUDIO_API_KEY')
    if not cfg['voice']:
        missing.append('FISH_AUDIO_VOICE_ID')
    if not model_ok:
        missing.append('valid FISH_AUDIO_MODEL')
    return {'provider': PROVIDER, 'model': cfg['model'] if model_ok else None,
            'api_key_configured': bool(cfg['key']), 'default_voice_configured': bool(cfg['voice']),
            'ai_narrator_ready': ready and bool(cfg['voice']), 'clone_ready': ready,
            'missing': missing}


def _reference(reference):
    if not isinstance(reference, dict):
        raise ValueError('Choose your own uploaded voice sample and its transcript.')
    path_value = reference.get('path')
    transcript = reference.get('transcript', reference.get('text', ''))
    if not isinstance(path_value, (str, Path)) or not Path(path_value).is_file():
        raise ValueError('The selected voice sample is missing. Upload it again.')
    path = Path(path_value)
    if not 0 < path.stat().st_size <= MAX_REFERENCE_BYTES:
        raise ValueError('Use a voice sample smaller than 24 MB.')
    if not isinstance(transcript, str) or not 1 <= len(transcript.strip()) <= 6000:
        raise ValueError('A transcript of your voice sample is required for cloning.')
    return {'audio': path.read_bytes(), 'text': transcript.strip()}


def _payload(scene, identity, cfg, reference):
    narration = scene.get('narration')
    if not isinstance(narration, str) or not narration.strip():
        raise ValueError('Every scene needs narration.')
    pace = identity.get('pace', 1)
    energy = scene.get('energy', .5)
    if isinstance(pace, bool) or not isinstance(pace, (int, float)) or not math.isfinite(pace) or not .8 <= pace <= 1.2:
        raise ValueError('Voice pace must be between 0.8 and 1.2.')
    if isinstance(energy, bool) or not isinstance(energy, (int, float)) or not math.isfinite(energy) or not 0 <= energy <= 1:
        raise ValueError('Scene energy must be between zero and one.')
    controls=_fish_controls(scene,identity,cfg['model'])
    payload = {'text': controls['text'], 'format': 'mp3', 'sample_rate': 44100,
               'mp3_bitrate': 192, 'latency': 'normal', 'normalize': True,
               'prosody': {'speed': controls['speed'], 'volume': controls['volume_db']},
               'temperature': .7, 'top_p': .7, 'chunk_length': 300}
    if reference is not None:
        payload['references'] = [reference]
    else:
        payload['reference_id'] = cfg['voice']
    return payload


def _fish_controls(scene, identity, model):
    """Compile exact narration spans to controls this selected Fish model supports."""
    narration=scene['narration']
    old_tones={'warm':'relaxed','calm':'calm','confident':'confident','energetic':'excited'}
    tone=old_tones.get(identity.get('voice'),'confident')
    requested=scene.get('delivery')
    if requested is None:
        speed=round(max(.75,min(1.3,float(identity.get('pace',1))+(float(scene.get('energy',.5))-.5)*.12)),3)
        return {'text':'['+tone+'] '+narration,'speed':speed,'volume_db':0,
                'pause_ms':160 if identity.get('motion')=='punchy' else 280,
                'requested':None,'tone':tone,'emphasis_spans':[],'warnings':[]}
    if not isinstance(requested,dict) or requested.get('text')!=narration:
        raise ValueError('Delivery text must preserve the narration exactly.')
    values={}
    for key,default,low,high in [('pace',1,.8,1.2),('pause_after_ms',0,0,800),
                                ('pitch_hz',0,-25,25),('volume_db',0,-3,3)]:
        value=requested.get(key,default)
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high:
            raise ValueError('Invalid delivery control: '+key)
        values[key]=value
    tone=requested.get('tone') or tone
    if not isinstance(tone,str) or not re.fullmatch(r'[^\[\]<>\r\n]{1,120}',tone):
        raise ValueError('Use a short plain-language delivery tone without markup.')
    phrases=requested.get('emphasis',[])
    if not isinstance(phrases,list) or any(not isinstance(p,str) or not p or p not in narration for p in phrases):
        raise ValueError('Emphasis must refer to exact words in the delivery unit.')
    positions=[]
    for phrase in dict.fromkeys(phrases):
        cursor=0
        while True:
            start=narration.find(phrase,cursor)
            if start<0:break
            positions.append((start,start+len(phrase)))
            cursor=start+len(phrase)
    merged=[]
    for start,end in sorted(positions):
        if merged and start<merged[-1][1]:
            merged[-1]=(merged[-1][0],max(end,merged[-1][1]))
        else:merged.append((start,end))
    pieces=['['+tone+'] '];cursor=0
    for start,end in merged:
        pieces.append(narration[cursor:start])
        if model=='drama-3':
            pieces.extend(['<emphasis>',narration[start:end],'</emphasis>'])
        else:
            pieces.extend(['[emphasis] ',narration[start:end]])
            if re.search(r'\w',narration[end:]):pieces.append(' ['+tone+']')
        cursor=end
    pieces.append(narration[cursor:])
    warnings=[]
    if values['pitch_hz']:
        warnings.append('Fish Audio does not expose numeric pitch control. The requested %s Hz pitch change was not applied; the selected voice identity is preserved.'%values['pitch_hz'])
    if merged and model!='drama-3':
        warnings.append('Fish S2 emphasis is a natural-language cue placed before the selected phrase; exact stress boundaries are not guaranteed. The intended tone resumes after the phrase.')
    return {'text':''.join(pieces),'speed':values['pace'],'volume_db':values['volume_db'],
            'pause_ms':values['pause_after_ms'],'requested':dict(requested),'tone':tone,
            'emphasis_spans':[{'start_char':a,'end_char':b,'text':narration[a:b]} for a,b in merged],
            'warnings':warnings}


def _write_json(path, data):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, indent=2))
    temp.replace(path)


def _request(folder, payload, cfg, scene_index):
    """One submission only. Ambiguous failures cannot silently spend again."""
    folder.mkdir(parents=True, exist_ok=True)
    audio = folder/'fish.mp3'
    receipt = folder/'fish-receipt.json'
    packed = msgpack.packb(payload, use_bin_type=True)
    fingerprint = hashlib.sha256(packed+cfg['model'].encode()).hexdigest()
    if receipt.is_file():
        old = json.loads(receipt.read_text())
        if old.get('request_sha256') != fingerprint:
            raise RuntimeError('This generation folder belongs to different narration. Create a new version.')
        if old.get('status') == 'received' and audio.is_file():
            if hashlib.sha256(audio.read_bytes()).hexdigest() == old.get('audio_sha256'):
                return audio
        raise RuntimeError('A Fish request was already submitted here. Check its recorded outcome before starting a new version; it was not submitted again.')
    record = {'scene': scene_index, 'model': cfg['model'], 'request_sha256': fingerprint,
              'status': 'submitted', 'submitted_at': time.time(),
              'voice_mode': 'instant_clone' if 'references' in payload else 'configured_narrator'}
    _write_json(receipt, record)
    headers = {'Authorization': 'Bearer '+cfg['key'], 'Content-Type': 'application/msgpack',
               'model': cfg['model']}
    temporary = folder/'fish.partial'
    try:
        # Disable redirects so credentials cannot be forwarded outside this endpoint.
        with requests.post(ENDPOINT, headers=headers, data=packed, stream=True,
                           timeout=(15, 180), allow_redirects=False) as response:
            if response.status_code != 200:
                record.update(status='rejected', http_status=response.status_code)
                _write_json(receipt, record)
                errors = {401:'Fish Audio rejected the API key. Update the saved credentials.',
                          402:'Fish Audio requires account credit or a supported plan for this request.',
                          403:'Fish Audio denied this voice or model for the current account.',
                          404:'The configured Fish voice or model was not found.',
                          429:'Fish Audio is rate-limiting this account. Wait before making a new generation.'}
                raise RuntimeError(errors.get(response.status_code,
                    'Fish Audio rejected this generation (HTTP %s). No alternate model or voice was used.'%response.status_code))
            content_type = response.headers.get('Content-Type', '').lower()
            if 'json' in content_type or 'text/' in content_type:
                raise RuntimeError('Fish Audio returned a non-audio response. No video was published.')
            deadline = time.monotonic()+240
            size = 0
            with temporary.open('wb') as output:
                for chunk in response.iter_content(chunk_size=65536):
                    if time.monotonic() > deadline:
                        raise RuntimeError('Fish Audio response took too long; the request may have completed remotely. Check usage before retrying.')
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > MAX_AUDIO_BYTES:
                        raise RuntimeError('Fish Audio returned more audio than this generation allows.')
                    output.write(chunk)
            if size < 64:
                raise RuntimeError('Fish Audio returned empty or incomplete audio.')
        temporary.replace(audio)
        record.update(status='received', audio_bytes=size,
                      audio_sha256=hashlib.sha256(audio.read_bytes()).hexdigest())
        _write_json(receipt, record)
        return audio
    except requests.RequestException:
        record.update(status='unknown', error='Network request interrupted; remote outcome unknown.')
        _write_json(receipt, record)
        raise RuntimeError('The Fish Audio connection was interrupted. The request may have completed remotely; check usage before starting a new version. No automatic retry was made.') from None
    except Exception:
        if record.get('status') == 'submitted':
            record.update(status='unknown', error='Audio response was incomplete or invalid.')
            _write_json(receipt, record)
        raise
    finally:
        temporary.unlink(missing_ok=True)


def synthesize_fish(folder, scenes, identity, stage=lambda message: None, reference=None, fps=30):
    """Generate each scene once, align actual speech locally, and join measured PCM.

reference is the caller-authorized uploaded sample dict {path, transcript}. It
is sent inline; no persistent voice-training/model endpoint is ever called.
Each generation keeps one speaker while identity and scene energy shape delivery.
"""
    cfg = _settings()
    if not cfg['key']:
        raise RuntimeError('Connect Fish Audio with FISH_AUDIO_API_KEY to generate narration.')
    if cfg['model'] not in MODELS:
        raise RuntimeError('Choose a supported FISH_AUDIO_MODEL. No fallback model was used.')
    if reference is None and not cfg['voice']:
        raise RuntimeError('Set FISH_AUDIO_VOICE_ID to your selected narrator, or supply your own voice sample.')
    if not isinstance(scenes, list) or not 1 <= len(scenes) <= 24:
        raise ValueError('Use between one and twenty-four narration units.')
    if not isinstance(fps, int) or fps <= 0 or 48000 % fps:
        raise ValueError('The narration frame rate must evenly divide 48,000 samples per second.')
    ref = _reference(reference) if reference is not None else None
    payloads = [_payload(scene, identity, cfg, ref) for scene in scenes]
    controls = [_fish_controls(scene,identity,cfg['model']) for scene in scenes]
    # Import after configuration checks: missing settings never load the ASR model.
    from studio_recording import analyze_recording, normalized_tokens
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    intervals, warnings, frame_cursor = [], [], 0
    combined = folder/'narration.wav'
    temporary = folder/'narration.partial.wav'
    try:
        with wave.open(str(temporary), 'wb') as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(48000)
            for i, (scene, payload, control) in enumerate(zip(scenes, payloads, controls)):
                stage('Generating Fish narration · scene %d of %d'%(i+1,len(scenes)))
                scene_folder = folder/('fish-scene-%02d'%i)
                generated = _request(scene_folder, payload, cfg, i)
                stage('Aligning Fish narration · scene %d of %d'%(i+1,len(scenes)))
                info = analyze_recording(generated, scene_folder/'alignment',
                    lambda _message: stage('Measuring generated speech · scene %d of %d'%(i+1,len(scenes))))
                expected=normalized_tokens(scene['narration'])
                heard=normalized_tokens(info.get('transcript',''))
                if heard and difflib.SequenceMatcher(None,expected,heard).ratio()<.65:
                    warnings.append('Scene %d: recognized speech differs substantially from the script. Listen before publishing; recognition can also misread names and numbers.'%(i+1))
                with wave.open(str(info['path']), 'rb') as audio:
                    if audio.getframerate() != 48000 or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
                        raise RuntimeError('Fish narration normalization did not produce 48 kHz mono PCM.')
                    count = audio.getnframes()
                    pcm = audio.readframes(count)
                duration = count/48000
                pause_samples=round(control['pause_ms']*48)
                frames = max(1 if control['requested'] is not None else fps,
                             math.ceil((count+pause_samples)/(48000//fps)))
                padded = frames*(48000//fps)
                output.writeframes(pcm+b'\0'*((padded-count)*2))
                start, end = frame_cursor/fps, (frame_cursor+frames)/fps
                words = []
                for word in info.get('words', []):
                    a, b = max(0,float(word['start'])), min(duration,float(word['end']))
                    if math.isfinite(a) and math.isfinite(b) and b > a:
                        words.append({'text':word.get('text',word.get('word','')).strip(),
                                      'start':start+a, 'end':start+b})
                if not words:
                    raise RuntimeError('Generated narration could not be aligned to speech. Review the audio before retrying.')
                for warning in info.get('warnings', []):
                    if warning.startswith('Word timings'):
                        warning = 'Caption timings are estimates from local English speech recognition. Review the generated voice and captions.'
                    if warning.startswith('Recorded speech, pauses'):
                        continue
                    warnings.append(warning)
                warnings.extend(control['warnings'])
                intervals.append({'scene':i,'start':start,'end':end,'start_frame':frame_cursor,
                                  'end_frame':frame_cursor+frames,'speech_duration':duration,
                                  'narration':scene['narration'],'words':words,
                                  'rate':payload['prosody']['speed'], 'delivery':payload['text'].split(']',1)[0]+']',
                                  'requested_delivery':control['requested'],
                                  'applied_delivery':{'provider':'fish','model':cfg['model'],
                                      'tone_cue':control['tone'],'speed':control['speed'],'volume_db':control['volume_db'],
                                      'pitch_hz':None,'pitch_control':'unsupported',
                                      'compiled_text':control['text'],'emphasis_spans':control['emphasis_spans'],
                                      'emphasis_method':'paired_tags' if cfg['model']=='drama-3' else 'prefix_cues',
                                      'requested_pause_after_ms':control['pause_ms'],
                                      'appended_silence_ms':(padded-count)/48,
                                      'pause_note':'Silence appended after complete generated audio; natural trailing silence remains and frame rounding adds less than one frame.'}})
                frame_cursor += frames
        temporary.replace(combined)
    finally:
        temporary.unlink(missing_ok=True)
    result = {'provider':PROVIDER, 'model':cfg['model'],
              'voice':'Your voice · instant clone' if ref is not None else 'Configured Fish narrator',
              'voice_mode':'clone' if ref is not None else 'ai', 'audio':str(combined),
              'duration':frame_cursor/fps,'frames':frame_cursor,'fps':fps,'scenes':intervals,
              'warnings':list(dict.fromkeys(warnings))}
    _write_json(folder/'fish-narration.json', result)
    return result
