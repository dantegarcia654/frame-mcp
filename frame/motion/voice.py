"""Neural narration with measured boundaries; never substitutes a system voice.

Uses edge-tts's public Communicate interface. Text is sent to Microsoft Edge's
online speech service. The installed voice inventory is verified at runtime.
"""
import asyncio
import json
import math
import subprocess
import wave
import numpy as np
from pathlib import Path

VOICE_MAP = {
    'warm': 'en-US-AriaNeural', 'confident': 'en-US-GuyNeural',
    'energetic': 'en-US-JennyNeural', 'calm': 'en-US-AriaNeural',
}
PROVIDER = 'Microsoft Edge neural TTS'


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
        pace = float(identity.get('pace', 1))
        # Identity fixes the speaker. The emotional arc gently shapes delivery.
        energy = float(scene.get('energy', .5))
        delivery = max(.75, min(1.3, pace + (energy - .5) * .12))
        rate = '%+d%%' % round((delivery - 1) * 100)
        raw = folder / ('voice-%02d.mp3' % i)
        metadata = folder / ('voice-%02d.jsonl' % i)
        checkpoint=folder/('voice-%02d-request.json'%i)
        signature={'text':scene['narration'],'voice':voice,'rate':rate}
        cached=(checkpoint.exists() and json.loads(checkpoint.read_text())==signature and raw.exists() and raw.stat().st_size>512 and metadata.exists() and metadata.stat().st_size>0)
        if not cached:
            for attempt in range(3):
                try:
                    request=edge_tts.Communicate(scene['narration'],voice,rate=rate,boundary='WordBoundary',connect_timeout=15,receive_timeout=45)
                    await asyncio.wait_for(request.save(str(raw),str(metadata)),timeout=100)
                    checkpoint.write_text(json.dumps(signature));break
                except Exception as exc:
                    if attempt==2:raise RuntimeError('Neural narration failed for scene %d after three attempts. Earlier phrases are saved; retry this job.'%(i+1)) from exc
                    stage('Retrying narration for scene %d'%(i+1))
                    await asyncio.sleep(1+attempt)
        words = []
        if metadata.exists():
            for line in metadata.read_text().splitlines():
                item = json.loads(line)
                if item.get('type') == 'WordBoundary':
                    words.append({'text': item['text'], 'start': item['offset'] / 1e7,
                                  'end': (item['offset'] + item['duration']) / 1e7})
        results.append({'raw': raw, 'words': words, 'rate': rate})
    return voice, results


def synthesize_narration(folder, scenes, identity, stage=lambda message: None, fps=30):
    """Returns frame-aligned scene intervals and a single lossless 48kHz WAV.

    Every scene starts on its exact video frame; measured speech is never stretched
    to a guessed duration. A short pause and frame-rounding silence follow it.
    """
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    voice, generated = asyncio.run(_generate(scenes, identity, folder, stage))
    intervals, frame_cursor = [], 0
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
            # Trim only trailing generated silence; retain an 80ms safety tail.
            signal=np.frombuffer(data,dtype='<i2')
            audible=np.flatnonzero(np.abs(signal.astype(np.int32))>104)
            if len(audible):
                samples=min(samples,int(audible[-1])+1+3840)
                data=data[:samples*2]
            pause = .10 if identity.get('motion') == 'punchy' else .28
            frames = max(30, math.ceil((samples / 48000 + pause) * fps))
            target_samples = frames * (48000 // fps)
            output.writeframes(data + b'\0' * ((target_samples - samples) * 2))
            start, end = frame_cursor / fps, (frame_cursor + frames) / fps
            words = [{**w, 'start': start + w['start'], 'end': min(end, start + w['end'])}
                     for w in item['words']]
            intervals.append({'scene': i, 'start': start, 'end': end, 'start_frame': frame_cursor,
                'end_frame': frame_cursor + frames, 'speech_duration': samples / 48000,
                'narration': scenes[i]['narration'], 'words': words, 'rate': item['rate']})
            frame_cursor += frames
    return {'provider': PROVIDER, 'voice': voice, 'audio': str(combined),
            'duration': frame_cursor / fps, 'frames': frame_cursor, 'fps': fps, 'scenes': intervals}
