"""Neural narration with measured boundaries; never substitutes a system voice.

Uses edge-tts's public Communicate interface. Text is sent to Microsoft Edge's
online speech service. The installed voice inventory is verified at runtime.
"""
import asyncio
import json
import math
import re
import subprocess
import unicodedata
import wave
from pathlib import Path

import numpy as np

VOICE_MAP = {
    'warm': 'en-US-GuyNeural', 'confident': 'en-US-GuyNeural',
    'energetic': 'en-US-GuyNeural', 'calm': 'en-US-GuyNeural',
}
PROVIDER = 'Microsoft Edge neural TTS'


def _controls(scene, identity):
    """Native Edge controls; a delivery unit remains one complete TTS request."""
    requested = scene.get('delivery')
    if requested is None:
        speed = max(.75, min(1.3, float(identity.get('pace',1))+(float(scene.get('energy',.5))-.5)*.12))
        return {'rate':'%+d%%'%round((speed-1)*100),'pitch':'+0Hz','volume':'+0%',
                'pause_ms':160 if identity.get('motion')=='punchy' else 280,'requested':None}
    if not isinstance(requested,dict) or requested.get('text') != scene['narration']:
        raise ValueError('Delivery text must preserve the narration exactly.')
    controls={}
    for key,default,low,high in [('pace',1,.8,1.2),('pause_after_ms',0,0,800),
                                ('pitch_hz',0,-25,25),('volume_db',0,-3,3)]:
        value=requested.get(key,default)
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high:
            raise ValueError('Invalid delivery control: '+key)
        controls[key]=value
    emphasis=requested.get('emphasis',[])
    if not isinstance(emphasis,list) or any(not isinstance(p,str) or not p or p not in scene['narration'] for p in emphasis):
        raise ValueError('Emphasis must refer to exact words in the delivery unit.')
    return {'rate':'%+d%%'%round((controls['pace']-1)*100),
            'pitch':'%+dHz'%round(controls['pitch_hz']),
            'volume':'%+d%%'%round((10**(controls['volume_db']/20)-1)*100),
            'pause_ms':controls['pause_after_ms'],'requested':dict(requested)}


def _tokens(text):
    value=unicodedata.normalize('NFKC',str(text)).casefold().replace('’',"'")
    return re.findall(r'[^\W_]+',value.replace("'",''))


def _accent_pcm(data, words, phrases):
    """Measured phrase gain accents. This is not semantic model emphasis."""
    if not phrases:
        return data,[],[]
    tokens,indices=[],[]
    for index,word in enumerate(words):
        parts=_tokens(word.get('text',''))
        tokens.extend(parts);indices.extend([index]*len(parts))
    ranges=[];warnings=[]
    for phrase in dict.fromkeys(phrases):
        target=_tokens(phrase)
        found=False
        for i in range(len(tokens)-len(target)+1):
            if target and tokens[i:i+len(target)]==target:
                a,b=words[indices[i]]['start'],words[indices[i+len(target)-1]]['end']
                if math.isfinite(a) and math.isfinite(b) and b>a:
                    ranges.append({'phrase':phrase,'start':a,'end':b,'gain_db':1.5})
                    found=True
        if not found:
            warnings.append('The requested emphasis on "%s" could not be aligned to reliable word boundaries; no word gain was applied to it.'%phrase)
    if not ranges:
        return data,[],warnings
    samples=np.frombuffer(data,dtype='<i2').astype(np.float64)
    envelope=np.ones(len(samples),dtype=np.float64)
    boost=10**(1.5/20)-1
    applied=[]
    for item in ranges:
        a=max(0,round(item['start']*48000));b=min(len(samples),round(item['end']*48000))
        if b<=a:continue
        gain=np.ones(b-a)
        ramp=min(720,(b-a)//2)
        if ramp:
            rise=.5-.5*np.cos(np.linspace(0,math.pi,ramp))
            gain[:ramp]=rise;gain[-ramp:]=rise[::-1]
        envelope[a:b]=np.maximum(envelope[a:b],1+boost*gain)
        applied.append(item)
    gained=samples*envelope
    peak=float(np.max(np.abs(gained))) if len(gained) else 0
    headroom_gain=min(1,32760/peak) if peak else 1
    gained*=headroom_gain
    for item in applied:item['unit_headroom_gain_db']=round(20*math.log10(headroom_gain),4)
    if applied:
        warnings.append('Selected phrases use a smooth +1.5 dB gain accent at measured word boundaries. This changes loudness, not the voice model’s semantic stress or acting.')
    return np.rint(gained).astype('<i2').tobytes(),applied,warnings


def run(command):
    result = subprocess.run(command, capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError('Audio processing failed: ' + result.stderr.decode(errors='replace')[-500:])


async def _generate(scenes, identity, folder, stage):
    try:
        import edge_tts
    except ImportError as exc:
        raise RuntimeError('Install requirements.txt to enable neural narration (edge-tts).') from exc
    voice = VOICE_MAP.get(identity.get('voice'), VOICE_MAP['warm'])
    try:
        inventory = await asyncio.wait_for(edge_tts.list_voices(), timeout=20)
        if voice not in {v['ShortName'] for v in inventory}:
            raise RuntimeError('The selected neural voice is unavailable. Please retry later.')
    except Exception as exc:
        raise RuntimeError('Cannot reach the neural voice service. Your brief is saved; retry when online.') from exc
    results = []
    for i, scene in enumerate(scenes):
        stage('Recording narration · scene %d of %d' % (i + 1, len(scenes)))
        controls = _controls(scene,identity)
        rate = controls['rate']
        raw = folder / ('voice-%02d.mp3' % i)
        metadata = folder / ('voice-%02d.jsonl' % i)
        try:
            for attempt in range(3):
                request = edge_tts.Communicate(scene['narration'], voice, rate=rate,
                    pitch=controls['pitch'], volume=controls['volume'],
                    boundary='WordBoundary', connect_timeout=15, receive_timeout=45)
                try:
                    await asyncio.wait_for(request.save(str(raw), str(metadata)), timeout=100)
                    break
                except edge_tts.exceptions.NoAudioReceived:
                    # This service can return an empty stream transiently. Retry
                    # only this unit, never completed units or another provider.
                    if attempt == 2:
                        raise
                    stage('Voice service returned no audio · retrying unit %d (%d of 3)'%(i+1,attempt+2))
                    await asyncio.sleep(attempt+1)
        except Exception as exc:
            raise RuntimeError('Neural narration failed for scene %d. No substitute voice was used; retry this generation.' % (i + 1)) from exc
        words = []
        if metadata.exists():
            for line in metadata.read_text().splitlines():
                item = json.loads(line)
                if item.get('type') == 'WordBoundary':
                    words.append({'text': item['text'], 'start': item['offset'] / 1e7,
                                  'end': (item['offset'] + item['duration']) / 1e7})
        results.append({'raw': raw, 'words': words, 'rate': rate, 'controls':controls})
    return voice, results


def synthesize_narration(folder, scenes, identity, stage=lambda message: None, fps=30):
    """Returns frame-aligned scene intervals and a single lossless 48kHz WAV.

    Every scene starts on its exact video frame; measured speech is never stretched
    to a guessed duration. A short pause and frame-rounding silence follow it.
    """
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    if not isinstance(fps,int) or fps<=0 or 48000%fps:
        raise ValueError('Narration needs a frame rate dividing 48 kHz.')
    # Validate all units before the first request, so a later invalid unit cannot
    # leave an avoidable half-generated performance.
    for scene in scenes:_controls(scene,identity)
    voice, generated = asyncio.run(_generate(scenes, identity, folder, stage))
    intervals, frame_cursor, warnings = [], 0, []
    combined = folder / 'narration.wav'
    with wave.open(str(combined), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48000)
        for i, item in enumerate(generated):
            pcm = folder / ('voice-%02d.wav' % i)
            run(['ffmpeg', '-v', 'error', '-y', '-i', str(item['raw']), '-ar', '48000', '-ac', '1',
                 '-c:a', 'pcm_s16le', str(pcm)])
            with wave.open(str(pcm), 'rb') as source:
                samples = source.getnframes()
                data = source.readframes(samples)
            controls=item.get('controls') or _controls(scenes[i],identity)
            requested=controls['requested']
            accents=[]
            if requested is not None:
                data,accents,accent_warnings=_accent_pcm(data,item['words'],requested.get('emphasis',[]))
                warnings.extend(accent_warnings)
                if requested.get('tone'):
                    warnings.append('The built-in narrator applies planned rate, pitch, volume and pauses. Tone labels guide those controls; this engine does not expose native emotion acting tags.')
            pause_samples=round(controls['pause_ms']*48)
            frames = max(1 if requested is not None else fps, math.ceil((samples+pause_samples)/(48000//fps)))
            target_samples = frames * (48000 // fps)
            output.writeframes(data + b'\0' * ((target_samples - samples) * 2))
            start, end = frame_cursor / fps, (frame_cursor + frames) / fps
            words = [{**w, 'start': start + w['start'], 'end': min(end, start + w['end'])}
                     for w in item['words']]
            intervals.append({'scene': i, 'start': start, 'end': end, 'start_frame': frame_cursor,
                'end_frame': frame_cursor + frames, 'speech_duration': samples / 48000,
                'narration': scenes[i]['narration'], 'words': words, 'rate': item['rate'],
                'requested_delivery':requested,
                'applied_delivery':{'provider':'edge','voice':voice,'rate':controls['rate'],
                    'pitch':controls['pitch'],'volume':controls['volume'],
                    'appended_silence_ms':(target_samples-samples)/48,
                    'requested_pause_after_ms':controls['pause_ms'],
                    'pause_note':'Silence appended after the complete generated audio, which retains its natural trailing silence; extra frame rounding is below one frame.',
                    'emphasis_method':'measured_word_gain' if accents else 'none',
                    'gain_accents':[dict(a,start=start+a['start'],end=start+a['end']) for a in accents],
                    'tone_acting':'unsupported'}})
            frame_cursor += frames
    return {'provider': PROVIDER, 'voice': voice, 'audio': str(combined),
            'duration': frame_cursor / fps, 'frames': frame_cursor, 'fps': fps, 'scenes': intervals,
            'warnings':list(dict.fromkeys(warnings))}
