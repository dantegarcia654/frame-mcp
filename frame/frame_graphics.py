"""Studio narration to model-directed Motion Lab graphics, with an isolated worker.

Only trusted Python renders the model's validated scene-graph data. This adapter
never synthesizes, retranscribes, stretches, normalizes, or mixes narration.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import selectors
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MOTION_SOURCE = ROOT / 'motion'
FPS = 30


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False))
    temporary.replace(path)


def _number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('Invalid ' + label + '.')
    return value


def _tokens(value):
    return re.findall(r"[\w]+(?:['’][\w]+)*", value.casefold())


def validate_narration(narration, plan):
    """Validate a complete, immutable audio checkpoint before direction/rendering.

    Returns metadata; does not change either input or perform network requests.
    Source scene boundaries and raw word timestamps remain untouched.
    """
    if not isinstance(narration, dict) or not isinstance(plan, dict):
        raise ValueError('A saved narration and creative plan are required.')
    frames = narration.get('frames')
    if narration.get('fps') != FPS or isinstance(frames, bool) or not isinstance(frames, int):
        raise ValueError('Narration needs whole frames at 30 fps.')
    if not FPS <= frames <= 60 * FPS:
        raise ValueError('This Frame experience supports videos from 1 to 60 seconds. Use a shorter script.')
    audio = narration.get('audio')
    if not isinstance(audio, str) or not audio or not Path(audio).is_file():
        raise ValueError('The saved narration audio is missing. It was not generated again.')
    audio = Path(audio).resolve()
    digest = sha256(audio)
    expected = narration.get('audio_sha256') or narration.get('narration_sha256')
    if expected is not None and expected != digest:
        raise ValueError('The saved narration changed. It was not generated again.')
    try:
        with wave.open(str(audio), 'rb') as source:
            rate, channels, width, samples = (source.getframerate(), source.getnchannels(),
                                             source.getsampwidth(), source.getnframes())
            if (rate, channels, width) != (48000, 1, 2):
                raise ValueError('Narration must already be 48 kHz mono 16-bit PCM.')
            if samples != frames * (48000 // FPS):
                raise ValueError('Narration samples and video frames do not match; no audio was altered.')
    except (wave.Error, EOFError) as exc:
        raise ValueError('The saved narration WAV is invalid.') from exc
    if abs(_number(narration.get('duration', frames / FPS), 'narration duration') - frames / FPS) > 1e-6:
        raise ValueError('Narration duration and frame count do not match.')
    scenes = narration.get('scenes')
    planned = plan.get('scenes')
    if not isinstance(scenes, list) or not scenes or not isinstance(planned, list) or not planned:
        raise ValueError('Narration and creative direction need complete scenes.')
    expected_text = ' '.join(str(s.get('narration', '')) for s in planned)
    actual_text = ' '.join(str(s.get('narration', '')) for s in scenes)
    if not _tokens(expected_text) or _tokens(actual_text) != _tokens(expected_text):
        raise ValueError('The saved narration does not match this creative plan.')
    cursor, previous_word, warnings = 0, -1.0, []
    for index, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            raise ValueError('Invalid narration scene.')
        start, end = scene.get('start_frame'), scene.get('end_frame')
        if any(isinstance(v, bool) or not isinstance(v, int) for v in (start, end)):
            raise ValueError('Narration scene boundaries must be whole frames.')
        if start != cursor or not start < end <= frames:
            raise ValueError('Narration scenes must cover the entire video in order.')
        cursor = end
        text, words = scene.get('narration'), scene.get('words')
        if not isinstance(text, str) or not text.strip() or not isinstance(words, list) or not words:
            raise ValueError('Every narration scene needs text and measured words.')
        for word in words:
            if not isinstance(word, dict) or not isinstance(word.get('text'), str) or not word['text'].strip():
                raise ValueError('An aligned word is missing its text.')
            a, b = _number(word.get('start'), 'word start'), _number(word.get('end'), 'word end')
            if not start / FPS - 1e-6 <= a < end / FPS or not a <= b <= end / FPS + 1e-6:
                raise ValueError('Aligned words must stay inside their narration scene.')
            if a < previous_word - 1e-6:
                raise ValueError('Aligned words must remain in spoken order.')
            previous_word = a
        if _tokens(' '.join(w['text'] for w in words)) != _tokens(text):
            warnings.append('Scene %d: measured captions differ from the script. Review the spoken words before publishing.' % (index + 1))
    if cursor != frames:
        raise ValueError('Narration does not reach the final frame.')
    return {'audio': str(audio), 'audio_sha256': digest, 'frames': frames, 'fps': FPS,
            'samples': samples, 'duration': frames / FPS, 'warnings': warnings}


def _chunks(scene):
    """Split only long caption scenes, retaining every word and source timestamp."""
    if len(scene['narration']) <= 180 and len(scene['words']) <= 24:
        return [copy.deepcopy(scene)]
    groups, current = [], []
    for word in scene['words']:
        candidate = current + [word]
        if current and (len(' '.join(w['text'] for w in candidate)) > 150 or len(candidate) > 18):
            groups.append(current)
            current = []
        current.append(copy.deepcopy(word))
    if current:
        groups.append(current)
    out, cursor = [], scene['start_frame']
    for index, words in enumerate(groups):
        end = scene['end_frame'] if index == len(groups) - 1 else math.floor(groups[index + 1][0]['start'] * FPS + 1e-8)
        if end - cursor < 9:
            raise ValueError('This narration is too dense for readable graphics. Use shorter sentences.')
        text = ' '.join(w['text'] for w in words)
        if len(text) > 180:
            raise ValueError('A narration word is too long for the graphic layout.')
        out.append({'narration': text, 'start_frame': cursor, 'end_frame': end, 'words': words})
        cursor = end
    return out


def build_spec(narration, plan):
    validated = validate_narration(narration, plan)
    scenes = []
    for source_index, source in enumerate(narration['scenes']):
        for chunk in _chunks(source):
            start, end = chunk['start_frame'], chunk['end_frame']
            if end - start < 9:
                raise ValueError('A spoken scene is shorter than the minimum readable graphic beat.')
            words = [{'text': w['text'].strip(),
                      'frame': max(start, min(end - 1, math.ceil(w['start'] * FPS - 1e-8))),
                      'raw_start': w['start'], 'raw_end': w['end']} for w in chunk['words']]
            scenes.append({'id': 'beat-%02d' % (len(scenes) + 1),
                           'source_scene': source_index, 'text': chunk['narration'],
                           'style': 'generated', 'emphasis': '', 'light': False,
                           'start_frame': start, 'end_frame': end, 'words': words})
    if len(scenes) > 16:
        raise ValueError('This Frame experience supports up to 16 visual beats. Use a shorter script.')
    # The reusable product identity is dark ink, warm paper, and signal red.
    return {'schema': 1, 'fps': FPS, 'frames': validated['frames'], 'format': 'portrait',
            'accent': '#ff281c', 'paper': '#eeeeda', 'ink': '#101112', 'seed': 7,
            'energy': 1.0, 'sfx': 0, 'bed': 0,
            'voice_provider': str(narration.get('provider', 'Saved narration')),
            'scenes': scenes}


def render_graphics(folder, narration, plan, idea, feedback='', previous=None, stage=lambda _: None):
    """Render model-directed graphics around an existing immutable narration.

    The worker is a separate Python process because Motion Lab's modules have
    intentionally generic names shared by other local prototypes.
    """
    if not isinstance(idea, str) or len(idea) > 2000:
        raise ValueError('Keep the idea under 2,000 characters.')
    if not isinstance(feedback, str) or len(feedback) > 2000:
        raise ValueError('Keep visual feedback under 2,000 characters.')
    if previous is not None and not isinstance(previous, dict):
        raise ValueError('The previous graphic direction is invalid.')
    validated = validate_narration(narration, plan)
    spec = build_spec(narration, plan)
    folder = Path(folder).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / 'narration.wav'
    if destination.exists() and sha256(destination) != validated['audio_sha256']:
        raise ValueError('This render folder already contains a different narration.')
    if Path(validated['audio']) != destination:
        shutil.copyfile(validated['audio'], destination)
    request = {'narration': {**copy.deepcopy(narration), 'audio': str(destination),
                             'audio_sha256': validated['audio_sha256']},
               'plan': copy.deepcopy(plan), 'idea': idea, 'feedback': feedback,
               'previous': copy.deepcopy(previous), 'spec': spec,
               'source_audio_sha256': validated['audio_sha256'], 'motion_source': str(MOTION_SOURCE)}
    write_json(folder / 'graphics-request.json', request)
    stage('Directing graphics around your saved narration')
    command = [sys.executable, str(ROOT / 'frame_graphics_worker.py'), str(folder / 'graphics-request.json')]
    with (folder / 'graphics-worker.log').open('w') as errors:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=errors, text=True, bufsize=1)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline, failure = time.monotonic() + 1200, None
        try:
            while True:
                if time.monotonic() > deadline:
                    raise RuntimeError('Graphic generation timed out. Your narration is saved; retry this version.')
                if not selector.select(timeout=1):
                    if process.poll() is not None:
                        break
                    continue
                line = process.stdout.readline()
                if not line:
                    break
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get('stage'):
                    stage(str(event['stage'])[:240])
                if event.get('error'):
                    failure = str(event['error'])[:1200]
            if process.wait(timeout=5):
                raise RuntimeError(failure or 'Graphic generation failed. Your narration and earlier videos are saved.')
        except BaseException:
            process.kill()
            process.wait()
            raise
        finally:
            selector.close()
            process.stdout.close()
    result = json.loads((folder / 'graphics-result.json').read_text())
    if sha256(destination) != validated['audio_sha256']:
        raise RuntimeError('Narration preservation check failed.')
    if result.get('narration_sha256') != validated['audio_sha256']:
        raise RuntimeError('Graphic result belongs to different narration.')
    if result.get('export_sha256') != sha256(folder / 'export.mp4'):
        raise RuntimeError('The rendered export changed after verification.')
    return result
