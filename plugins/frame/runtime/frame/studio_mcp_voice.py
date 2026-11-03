"""Quoted Fish account narration over the authenticated MCP connection.

MCP uses web-plan credits, not the developer API's free model. Every generation
requires its exact approved quote, then a fresh free quote for all complete units.
"""
import difflib
import hashlib
import ipaddress
import json
import math
import os
import re
import secrets
import socket
import stat
import threading
import time
import uuid
import wave
from pathlib import Path
from urllib.parse import urlparse

import requests
import studio_fish_mcp as mcp
from studio_fish import _fish_controls

SETTINGS = Path.home()/'.config/frame-studio/fish-mcp-voice.json'
MODELS = {'drama-3', 's2.1-pro'}
DEFAULT_MODEL = 'drama-3'
PROVIDER = 'Fish Audio MCP'
QUOTE_TTL = 900
MAX_AUDIO_BYTES = 64*1024*1024
# This exact CDN is present in the authenticated get_voice/search_voices results.
# Additional hosts must be verified before being allowed, never inferred from URLs.
AUDIO_HOSTS = {'platform.r2.fish.audio'}
LOCK = threading.RLock()


def _write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise RuntimeError('The Fish output path must not be a symbolic link.')
    temporary = path.with_name('.'+path.name+'-'+secrets.token_hex(8)+'.tmp')
    fd = os.open(str(temporary), os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(data, output, indent=2, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _voice_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value):
        raise ValueError('Choose a Fish voice returned by the voice library.')
    return value


def _model(value):
    if not isinstance(value, str) or value not in MODELS:
        raise ValueError('Choose drama-3 or s2.1-pro for the Fish account connection.')
    return value


def _settings():
    path = Path(SETTINGS)
    if not path.exists():
        return {'selected_voice': None, 'model': DEFAULT_MODEL}
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError('The selected Fish voice settings are not a private owned file.')
    path.chmod(0o600)
    try:
        data = json.loads(path.read_text())
        voice = data['selected_voice']
        if not isinstance(voice, dict) or not isinstance(voice.get('name'), str) or not 1 <= len(voice['name']) <= 200:
            raise ValueError()
        return {'selected_voice': {'id': _voice_id(voice['id']), 'name': voice['name']},
                'model': _model(data.get('model', DEFAULT_MODEL))}
    except (KeyError, TypeError, ValueError):
        raise ValueError('Select a Fish voice again; its saved settings could not be read.') from None


def capabilities():
    try:
        selected = _settings()
    except (ValueError, OSError):
        selected = {'selected_voice': None, 'model': DEFAULT_MODEL}
    connection = mcp.status()
    names = {tool.get('name') for tool in connection.get('tools', []) if isinstance(tool, dict)}
    return {**selected, 'default_voice_configured': bool(selected['selected_voice']),
            'ready': bool(connection.get('connected') and selected['selected_voice'] and 'text_to_speech' in names)}


def _data(result):
    if not isinstance(result, dict) or result.get('isError'):
        raise RuntimeError('Fish could not complete this request. No automatic retry was made.')
    data = result.get('structuredContent')
    if not isinstance(data, dict):
        blocks = result.get('content', [])
        texts = [block.get('text') for block in blocks if isinstance(block, dict) and block.get('type') == 'text']
        if len(texts) != 1 or not isinstance(texts[0], str) or len(texts[0]) > 2*1024*1024:
            raise RuntimeError('Fish returned an unsupported result format.')
        try:
            data = json.loads(texts[0])
        except ValueError:
            raise RuntimeError('Fish returned an unsupported result format.') from None
    if not isinstance(data, dict):
        raise RuntimeError('Fish returned an unsupported result format.')
    return data


def _public_voice(data):
    if not isinstance(data, dict):
        raise RuntimeError('Fish returned invalid voice details.')
    voice_id = _voice_id(data.get('id'))
    name = data.get('title')
    if not isinstance(name, str) or not name.strip() or len(name) > 200:
        raise RuntimeError('Fish returned invalid voice details.')
    value = {'id': voice_id, 'name': name.strip(),
             'description': str(data.get('description', ''))[:1500]}
    for key in ('languages', 'tags'):
        value[key] = [item[:100] for item in data.get(key, [])[:30] if isinstance(item, str)] if isinstance(data.get(key), list) else []
    sample = data.get('sample_audio')
    if not sample and isinstance(data.get('sample'), dict):
        sample = data['sample'].get('audio')
    try:
        value['sample_audio'] = _audio_url(sample)
    except (ValueError, TypeError):
        value['sample_audio'] = None
    return value


def set_voice(voice_id):
    voice_id = _voice_id(voice_id)
    data = _data(mcp.call_tool('get_voice', {'voice_id': voice_id}))
    voice = _public_voice(data)
    if voice['id'] != voice_id or data.get('state') != 'trained':
        raise ValueError('Choose a trained Fish voice that is ready to speak.')
    with LOCK:
        _write(SETTINGS, {'selected_voice': {'id': voice_id, 'name': voice['name']}, 'model': DEFAULT_MODEL})
    return capabilities()


def search_voices(query='', own=False):
    if not isinstance(query, str) or len(query) > 200 or not isinstance(own, bool):
        raise ValueError('Use a voice search of at most 200 characters.')
    args = {'language': 'en', 'self': own, 'page_size': 10, 'page': 1, 'sort_by': 'task_count'}
    if query.strip():
        args['query'] = query.strip()
    data = _data(mcp.call_tool('search_voices', args))
    if not isinstance(data.get('voices'), list) or len(data['voices']) > 20:
        raise RuntimeError('Fish returned an invalid voice list.')
    return {'voices': [_public_voice(item) for item in data['voices']], 'has_next': data.get('has_next') is True}


def _compile(scenes, identity, voice_id, model):
    voice_id, model = _voice_id(voice_id), _model(model)
    if not isinstance(scenes, list) or not 1 <= len(scenes) <= 24:
        raise ValueError('Use between one and twenty-four complete narration units.')
    units = []
    for index, scene in enumerate(scenes):
        if not isinstance(scene, dict) or not isinstance(scene.get('narration'), str) or not scene['narration'].strip():
            raise ValueError('Every narration unit needs its exact script text.')
        control = _fish_controls(scene, identity, model)
        text = control['text']
        warnings = list(control['warnings'])
        pace_tag = None
        if model == 'drama-3':
            pace_tag = 'fast' if control['speed'] > 1.035 else 'slow' if control['speed'] < .965 else None
            if pace_tag:
                prefix = '['+control['tone']+'] '
                text = prefix+'<'+pace_tag+'>'+text[len(prefix):]+'</'+pace_tag+'>'
        if control['speed'] != 1:
            warnings.append('Fish MCP has no numeric speech-rate parameter. Pace is a qualitative acting cue, not an exact speed ratio.' if model == 'drama-3' else 'Fish MCP does not expose numeric speech-rate control; the requested speed ratio was not applied.')
        if control['volume_db']:
            warnings.append('Fish MCP does not expose numeric volume control; the requested dB change was not applied.')
        if len(text) > 2000:
            raise ValueError('Keep each Fish narration unit under 2,000 characters; split the script at a sentence boundary.')
        payload = {'text': text, 'voice_id': voice_id, 'model': model, 'dry_run': False}
        units.append({'index': index, 'payload': payload, 'bytes': len(text.encode('utf-8')),
            'narration': scene['narration'], 'requested_delivery': control['requested'],
            'pause_after_ms': control['pause_ms'], 'warnings': warnings,
            'applied_delivery': {'provider': 'fish_mcp', 'model': model, 'voice_id': voice_id,
                'tone_cue': control['tone'], 'compiled_text': text,
                'emphasis_spans': control['emphasis_spans'],
                'emphasis_method': 'paired_tags' if model == 'drama-3' else 'prefix_cues',
                'pace_mode': 'qualitative' if model == 'drama-3' else 'unsupported', 'pace_tag': pace_tag,
                'speed': None, 'pitch_hz': None, 'volume_db': None,
                'pitch_control': 'unsupported', 'volume_control': 'unsupported',
                'requested_pause_after_ms': control['pause_ms']}})
    return units


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise RuntimeError('Fish returned an invalid '+label+'.')
    return value


def _quote_units(units, voice_id, model):
    quoted, balances, sufficient = [], [], True
    for unit in units:
        data = _data(mcp.call_tool('text_to_speech', {**unit['payload'], 'dry_run': True}))
        if (data.get('dry_run') is not True or data.get('credits_charged') != 0
                or data.get('text_bytes') != unit['bytes'] or data.get('model') != model
                or not isinstance(data.get('voice'), dict) or data['voice'].get('id') != voice_id):
            raise RuntimeError('Fish returned a quote that did not match the planned narration.')
        cost = _number(data.get('estimated_credits'), 'credit estimate')
        balance = _number(data.get('balance'), 'credit balance')
        balances.append(balance)
        sufficient = sufficient and data.get('has_sufficient_balance') is True
        quoted.append({**unit, 'credits': cost,
            'base_credits': _number(data.get('base_credits'), 'base estimate'),
            'pvc_surcharge_credits': _number(data.get('pvc_surcharge_credits'), 'voice surcharge')})
        if quoted[-1]['base_credits']+quoted[-1]['pvc_surcharge_credits'] != cost:
            raise RuntimeError('Fish returned inconsistent credit estimates.')
    total = sum(unit['credits'] for unit in quoted)
    return {'quote_id': uuid.uuid4().hex, 'request_sha256': _digest(units), 'voice_id': voice_id,
        'model': model, 'total_credits': total, 'total_bytes': sum(unit['bytes'] for unit in units),
        'units': quoted, 'created_at': time.time(), 'available_credits': min(balances),
        'has_sufficient_balance': bool(sufficient and min(balances) >= total),
        'billing': 'Fish web-plan credits; this is not the developer API free model.'}


def quote(scenes, identity, voice_id, model=DEFAULT_MODEL):
    return _quote_units(_compile(scenes, identity, voice_id, model), voice_id, model)


def _approved(expected, units, voice_id, model):
    if not isinstance(expected, dict) or not re.fullmatch(r'[a-f0-9]{32}', str(expected.get('quote_id', ''))):
        raise ValueError('Review and approve a Fish credit quote before generating narration.')
    created = expected.get('created_at')
    if isinstance(created, bool) or not isinstance(created, (int, float)) or not math.isfinite(created) or not 0 <= time.time()-created <= QUOTE_TTL:
        raise ValueError('The Fish quote expired. Review a fresh quote before generating.')
    if (expected.get('request_sha256') != _digest(units) or expected.get('voice_id') != voice_id
            or expected.get('model') != model or expected.get('total_bytes') != sum(unit['bytes'] for unit in units)):
        raise ValueError('The script, delivery, model or voice changed. Review a new Fish quote.')
    quoted = expected.get('units')
    if not isinstance(quoted, list) or len(quoted) != len(units):
        raise ValueError('The approved Fish quote is incomplete.')
    for unit, old in zip(units, quoted):
        if not isinstance(old, dict) or any(old.get(key) != value for key, value in unit.items()):
            raise ValueError('The approved Fish quote does not match these narration units.')
    total = sum(_number(unit.get('credits'), 'approved unit cost') for unit in quoted)
    if total != expected.get('total_credits') or expected.get('has_sufficient_balance') is not True:
        raise ValueError('The approved Fish quote is invalid or exceeds the available balance.')


def _audio_url(value):
    if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 32 for c in value):
        raise ValueError('Fish returned an invalid audio link.')
    try:
        parsed = urlparse(value)
        valid = (parsed.scheme == 'https' and parsed.hostname in AUDIO_HOSTS and parsed.port in (None, 443)
            and not parsed.username and not parsed.password and not parsed.fragment and bool(parsed.path))
    except ValueError:
        valid = False
    if not valid:
        raise ValueError('Fish returned an audio link outside its verified audio CDN.')
    return value


def _download(url, path):
    url = _audio_url(url)
    host = urlparse(url).hostname
    try:
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(row[4][0]).is_global for row in addresses):
            raise ValueError('Fish audio did not resolve to a public network address.')
    except (OSError, ValueError):
        raise RuntimeError('Fish audio did not resolve to a permitted public address.') from None
    path = Path(path)
    partial = path.with_suffix('.partial')
    try:
        # A new clean session never inherits MCP Authorization or proxy credentials.
        with requests.Session() as session:
            session.trust_env = False
            with session.get(url, stream=True, timeout=(10, 45), allow_redirects=False) as response:
                if response.status_code != 200:
                    raise RuntimeError('Fish audio download was refused. The speech request was not repeated.')
                ctype = response.headers.get('Content-Type', '').lower()
                if not (ctype.startswith('audio/') or ctype.startswith('application/octet-stream')):
                    raise RuntimeError('Fish returned a non-audio download.')
                advertised = response.headers.get('Content-Length')
                if advertised and (not advertised.isdigit() or not 0 < int(advertised) <= MAX_AUDIO_BYTES):
                    raise RuntimeError('Fish audio download exceeded the size limit.')
                deadline, size = time.monotonic()+180, 0
                with partial.open('wb') as output:
                    for chunk in response.iter_content(chunk_size=65536):
                        if time.monotonic() > deadline:
                            raise RuntimeError('Fish audio download timed out.')
                        if not chunk:
                            continue
                        size += len(chunk)
                        if size > MAX_AUDIO_BYTES:
                            raise RuntimeError('Fish audio download exceeded the size limit.')
                        output.write(chunk)
                if size < 64 or (advertised and int(advertised) != size):
                    raise RuntimeError('Fish audio download was incomplete.')
        partial.replace(path)
    except requests.RequestException:
        raise RuntimeError('Fish audio download was interrupted. The speech request was not repeated.') from None
    finally:
        partial.unlink(missing_ok=True)
    return path


def synthesize_mcp(folder, scenes, identity, stage=lambda message: None, voice_id=None,
                   model=DEFAULT_MODEL, expected_quote=None, fps=30):
    units = _compile(scenes, identity, voice_id, model)
    _approved(expected_quote, units, voice_id, model)
    if isinstance(fps, bool) or not isinstance(fps, int) or fps <= 0 or 48000 % fps:
        raise ValueError('The narration frame rate must divide 48,000 samples per second.')
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    receipt_path = folder/'mcp-narration-receipt.json'
    request_hash = _digest(units)
    if receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
        if receipt.get('request_sha256') != request_hash or len(receipt.get('units', [])) != len(units):
            raise RuntimeError('This output folder belongs to different Fish narration. Create a new version.')
        # A crash can occur after saving the response but before the receipt update.
        # A matching durable response proves that this unit must not be submitted again.
        for index, (record, unit) in enumerate(zip(receipt['units'], units)):
            saved = folder/('mcp-unit-%02d'%index)/'provider-result.json'
            if record.get('status') in ('submitted', 'unknown', 'received') and saved.is_file():
                envelope = json.loads(saved.read_text())
                if envelope.get('request_sha256') != _digest(unit['payload']) or 'response' not in envelope:
                    raise RuntimeError('The saved Fish response does not match this narration unit.')
                record['status'] = 'received'
        if any(item.get('status') in ('submitted', 'unknown') for item in receipt['units']):
            raise RuntimeError('A previous Fish request has an unconfirmed outcome. It was not submitted again; check Fish usage before creating a new version.')
        if any(item.get('status') not in ('planned', 'received', 'complete') for item in receipt['units']):
            raise RuntimeError('The saved Fish generation receipt is invalid.')
    else:
        receipt = {'request_sha256': request_hash, 'quote_id': expected_quote['quote_id'],
            'voice_id': voice_id, 'model': model,
            'units': [{'index': i, 'status': 'planned'} for i in range(len(units))]}
        _write(receipt_path, receipt)
    stage('Checking Fish narration credits')
    current_quote = _quote_units(units, voice_id, model)
    if (current_quote['total_credits'] > expected_quote['total_credits']
            or any(new['credits'] > old['credits'] for new, old in zip(current_quote['units'], expected_quote['units']))):
        raise RuntimeError('Fish credit pricing increased. Review a new quote before generating; no speech was submitted.')
    remaining_credits = sum(unit['credits'] for unit, record in zip(current_quote['units'], receipt['units'])
                            if record['status'] == 'planned')
    if current_quote['available_credits'] < remaining_credits:
        raise RuntimeError('The Fish balance no longer covers all narration units. No speech was submitted.')
    receipt['verified_quote'] = current_quote
    _write(receipt_path, receipt)
    from studio_recording import analyze_recording, normalized_tokens
    intervals, warnings, cursor = [], [], 0
    combined, temporary = folder/'narration.wav', folder/'narration.partial.wav'
    try:
        with wave.open(str(temporary), 'wb') as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(48000)
            for index, unit in enumerate(units):
                unit_folder = folder/('mcp-unit-%02d'%index)
                unit_folder.mkdir(exist_ok=True)
                audio = unit_folder/'fish.mp3'
                saved_result = unit_folder/'provider-result.json'
                record = receipt['units'][index]
                if record['status'] == 'complete':
                    if not audio.is_file() or hashlib.sha256(audio.read_bytes()).hexdigest() != record.get('audio_sha256'):
                        raise RuntimeError('Saved Fish audio is missing or changed. It was not generated again.')
                elif record['status'] == 'planned':
                    stage('Generating Fish narration · unit %d of %d'%(index+1, len(units)))
                    record.update(status='submitted', submitted_at=time.time())
                    _write(receipt_path, receipt)
                    try:
                        response = mcp.call_tool('text_to_speech', unit['payload'])
                        _write(saved_result, {'request_sha256': _digest(unit['payload']), 'response': response})
                        record.update(status='received', received_at=time.time())
                        _write(receipt_path, receipt)
                    except Exception:
                        record.update(status='unknown', error='Speech request outcome did not complete locally. No automatic retry.')
                        _write(receipt_path, receipt)
                        raise RuntimeError('Fish narration outcome is unconfirmed. The request was not retried; check Fish history and credits before creating a new version.') from None
                if record['status'] == 'received':
                    try:
                        envelope = json.loads(saved_result.read_text())
                        if envelope.get('request_sha256') != _digest(unit['payload']):
                            raise ValueError('Saved result mismatch.')
                        result = _data(envelope['response'])
                        # Fail closed if the live server returns a new result shape.
                        url = _audio_url(result.get('audio_url'))
                        record['audio_url'] = url
                        _download(url, audio)
                        record.update(status='complete', audio_sha256=hashlib.sha256(audio.read_bytes()).hexdigest(),
                                      audio_bytes=audio.stat().st_size, completed_at=time.time())
                        if 'credits_charged' in result:
                            record['credits_charged'] = _number(result['credits_charged'], 'charged credits')
                        _write(receipt_path, receipt)
                    except Exception:
                        record.update(status='received', error='Provider response saved; audio parsing or download did not complete. Do not resubmit speech.')
                        _write(receipt_path, receipt)
                        raise RuntimeError('Fish returned a saved response, but its audio could not be prepared. The response is preserved for recovery; speech was not submitted again.') from None
                if record.get('credits_charged', 0) > current_quote['units'][index]['credits']:
                    raise RuntimeError('Fish reported a charge above the approved unit quote. Its audio was saved; no further narration units were submitted.')
                stage('Measuring Fish narration · unit %d of %d'%(index+1, len(units)))
                info = analyze_recording(audio, unit_folder/'alignment', lambda _text: None)
                with wave.open(str(info['path']), 'rb') as source:
                    if source.getframerate() != 48000 or source.getnchannels() != 1 or source.getsampwidth() != 2:
                        raise RuntimeError('Fish narration did not normalize to 48 kHz mono PCM.')
                    count = source.getnframes()
                    pcm = source.readframes(count)
                if not count:
                    raise RuntimeError('Fish narration contains no audio samples.')
                duration = count/48000
                frames = max(1, math.ceil((count+round(unit['pause_after_ms']*48))/(48000//fps)))
                padded = frames*(48000//fps)
                output.writeframes(pcm+b'\0'*((padded-count)*2))
                start, end = cursor/fps, (cursor+frames)/fps
                words = []
                for word in info.get('words', []):
                    a, b = max(0, float(word['start'])), min(duration, float(word['end']))
                    if math.isfinite(a) and math.isfinite(b) and b > a:
                        words.append({'text': word.get('text', word.get('word', '')).strip(), 'start': start+a, 'end': start+b})
                if not words:
                    raise RuntimeError('Generated Fish narration could not be aligned to spoken words.')
                heard = normalized_tokens(info.get('transcript', ''))
                if heard and difflib.SequenceMatcher(None, normalized_tokens(unit['narration']), heard).ratio() < .65:
                    warnings.append('Unit %d: recognized speech differs substantially from the script. Review the narration before publishing.'%(index+1))
                warnings.extend(unit['warnings'])
                warnings.extend(warning for warning in info.get('warnings', []) if not warning.startswith('Recorded speech, pauses'))
                intervals.append({'scene': index, 'start': start, 'end': end, 'start_frame': cursor,
                    'end_frame': cursor+frames, 'speech_duration': duration, 'narration': unit['narration'],
                    'words': words, 'requested_delivery': unit['requested_delivery'],
                    'applied_delivery': {**unit['applied_delivery'], 'appended_silence_ms': (padded-count)/48,
                        'pause_note': 'Silence follows complete generated audio; natural trailing silence remains and frame rounding adds less than one frame.'}})
                cursor += frames
        temporary.replace(combined)
    finally:
        temporary.unlink(missing_ok=True)
    result = {'provider': PROVIDER, 'model': model, 'voice': voice_id, 'voice_id': voice_id,
        'audio': str(combined), 'duration': cursor/fps, 'frames': cursor, 'fps': fps, 'scenes': intervals,
        'audio_sha256': hashlib.sha256(combined.read_bytes()).hexdigest(), 'request_sha256': request_hash,
        'warnings': list(dict.fromkeys(warnings)), 'quote_id': expected_quote['quote_id'],
        'quoted_credits': current_quote['total_credits'],
        'credits_charged': sum(item['credits_charged'] for item in receipt['units'])
            if all('credits_charged' in item for item in receipt['units']) else None}
    _write(folder/'mcp-narration.json', result)
    return result
