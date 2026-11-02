"""Ground motion in a supplied full-script recording, preserving its timing.

Analysis reports acoustic observations, not personality or emotional diagnoses.
Audio conversion changes only sample format/channel layout/rate; it never applies
normalization, compression, silence removal, pitch shifting, or time stretching.
"""
import hashlib
import json
import math
import re
import subprocess
import unicodedata
import uuid
import wave
from pathlib import Path

import numpy as np

from editor import transcribe

SAMPLE_RATE = 48000
MAX_SECONDS = 300


def _hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _run(command):
    result = subprocess.run(command, capture_output=True, timeout=180)
    if result.returncode:
        raise ValueError('Could not read this recording. Upload a playable audio or video file with a voice track.')
    return result.stdout


def _pcm(path):
    try:
        with wave.open(str(path), 'rb') as source:
            if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, SAMPLE_RATE):
                raise ValueError('Recording must first be analyzed as 48 kHz mono PCM audio.')
            data = source.readframes(source.getnframes())
    except (wave.Error, EOFError) as exc:
        raise ValueError('The analyzed recording is not a valid PCM WAV file. Upload it again.') from exc
    return data


def _db(value):
    # -120 represents the measurable floor, avoiding JSON Infinity for silence.
    return round(20 * math.log10(max(float(value), 1e-6)), 2)


def _delivery(data, words):
    samples = np.frombuffer(data, dtype='<i2').astype(np.float64) / 32768
    duration = len(samples) / SAMPLE_RATE
    window_size = SAMPLE_RATE // 10
    levels = [math.sqrt(float(np.mean(samples[i:i + window_size] ** 2)))
              for i in range(0, len(samples), window_size)]
    pauses = [{'start': round(a['end'], 3), 'end': round(b['start'], 3),
               'duration': round(b['start'] - a['end'], 3)}
              for a, b in zip(words, words[1:]) if b['start'] - a['end'] >= .2]
    span = words[-1]['end'] - words[0]['start'] if words else 0
    return {'word_count': len(words), 'recording_seconds': round(duration, 4),
        'speech_span_seconds': round(span, 4),
        'words_per_minute_overall': round(len(words) / duration * 60, 1),
        'words_per_minute_speech_span': round(len(words) / span * 60, 1) if span else 0,
        'leading_seconds': round(words[0]['start'], 3) if words else duration,
        'trailing_seconds': round(max(0, duration - words[-1]['end']), 3) if words else duration,
        'pauses_over_200ms': pauses,
        'rms_dbfs': _db(math.sqrt(float(np.mean(samples ** 2)))),
        'peak_dbfs': _db(np.max(np.abs(samples))),
        'window_rms_p10_dbfs': _db(np.percentile(levels, 10)),
        'window_rms_p90_dbfs': _db(np.percentile(levels, 90)),
        'measurement': 'Unweighted mono PCM; 100 ms RMS windows including pauses. Word timings are ASR estimates.'}


def _validate_words(words, duration):
    if not isinstance(words, list) or not words:
        raise ValueError('No spoken words were found. Upload a clear full-script recording, not a short voice sample or silence.')
    clean = []
    previous_start = 0
    for item in words:
        text = str(item.get('text', '')).strip()
        start, end = float(item.get('start', -1)), float(item.get('end', -1))
        if (not text or not all(math.isfinite(v) for v in (start, end))
                or start < 0 or end < start or start < previous_start or end > duration + .05):
            raise ValueError('The recording has unreliable word timestamps. Please retry transcription or upload a clearer take.')
        clean.append({'text': text, 'start': start, 'end': min(duration, end)})
        previous_start = start
    return clean


def analyze_recording(path, folder, stage=lambda message: None):
    """Analyze one recording without editing its speech, pauses, pace, or pitch."""
    path, folder = Path(path).resolve(), Path(folder).resolve()
    if not path.is_file():
        raise ValueError('The voice recording is missing. Upload it again.')
    folder.mkdir(parents=True, exist_ok=True)
    stage('Checking your recorded voice')
    source_hash = _hash(path)
    cached = folder / 'recording-analysis.json'
    normalized = folder / 'recording.wav'
    if cached.exists():
        try:
            result = json.loads(cached.read_text())
            cached_audio = Path(result.get('path', ''))
            if (result.get('source_sha256') == source_hash
                    and cached_audio.parent == folder and cached_audio.is_file()
                    and result.get('normalized_sha256') == _hash(cached_audio)):
                return result
        except (OSError, ValueError, KeyError):
            pass
    info = json.loads(_run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))
    audio = next((stream for stream in info.get('streams', []) if stream.get('codec_type') == 'audio'), None)
    if not audio:
        raise ValueError('This file has no voice track. Upload an audio recording or a video with sound.')
    # Browser MediaRecorder emits streaming WebM without a duration header. Its
    # decoded sample count is authoritative; a missing header is not empty audio.
    raw_duration = audio.get('duration', info.get('format', {}).get('duration'))
    duration_hint = None if raw_duration in (None, '', 'N/A', '0', 0) else float(raw_duration)
    if duration_hint is not None and (not math.isfinite(duration_hint)
            or duration_hint <= 0 or duration_hint > MAX_SECONDS):
        raise ValueError('Use a voice recording between 0 and 300 seconds long.')
    # Never replace the upload, even if a caller chose recording.wav as its name.
    if normalized == path:
        normalized = folder / 'recording-pcm.wav'
    temporary = folder / ('.recording-decoding-' + uuid.uuid4().hex + '.wav')
    # Decode at most one second beyond the limit, so unknown/misleading metadata
    # cannot create an unbounded PCM file or in-memory sample array.
    _run(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-t', str(MAX_SECONDS + 1), '-map', '0:a:0', '-vn',
          '-ac', '1', '-ar', str(SAMPLE_RATE), '-c:a', 'pcm_s16le', str(temporary)])
    data = _pcm(temporary)
    duration = len(data) / (2 * SAMPLE_RATE)
    if not 0 < duration <= MAX_SECONDS:
        raise ValueError('Use a voice recording between 0 and 300 seconds long.')
    temporary.replace(normalized)
    stage('Listening to your recording and locating each spoken word')
    segments = transcribe(normalized)
    words = _validate_words([word for segment in segments for word in segment.get('words', [])], duration)
    stage('Measuring your pace, pauses, and vocal level changes')
    delivery = _delivery(data, words)
    if delivery['peak_dbfs'] <= -60:
        raise ValueError('This recording is too quiet to reliably align. Upload a clearer take.')
    warnings = ['Word timings are estimates from local English speech recognition. Review the transcript before generating.',
                'Recorded speech, pauses, speed, and pitch are preserved; acoustic measurements do not establish emotion or identity.']
    if delivery['peak_dbfs'] >= -.1:
        warnings.append('The recording reaches full scale and may contain clipped audio; it has not been repaired or compressed.')
    if _hash(path) != source_hash:
        raise RuntimeError('The uploaded recording changed during analysis. Please upload it again.')
    result = {'path': str(normalized), 'duration': duration,
        'transcript': ' '.join(w['text'] for w in words), 'words': words, 'segments': segments,
        'delivery': delivery, 'warnings': warnings, 'source_path': str(path),
        'source_sha256': source_hash, 'normalized_sha256': _hash(normalized),
        'pcm_sha256': hashlib.sha256(data).hexdigest()}
    cached.write_text(json.dumps(result, indent=2))
    return result


def _tokens(text):
    text = unicodedata.normalize('NFKC', str(text)).casefold().replace('’', "'")
    # Apostrophe spelling is equivalent; other punctuation separates tokens.
    return re.findall(r'[^\W_]+', text.replace("'", ''))


# Shared by planner validation; keep one normalization rule for both stages.
normalized_tokens = _tokens


def prepare_recorded_narration(folder, scenes, identity, recording, stage=lambda message: None, fps=30):
    """Use the original recording as one continuous, sample-preserved soundtrack.

    Scene narration must cover every recognized word in order. Visual boundaries
    land in inter-scene pauses when available and are quantized to video frames.
    No internal silence is added or removed and no speech is regenerated.
    """
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    if not isinstance(fps, int) or fps <= 0 or SAMPLE_RATE % fps:
        raise ValueError('Recording composition needs an integer frame rate dividing 48 kHz.')
    path = Path(recording.get('path', ''))
    if not path.is_file():
        raise ValueError('The analyzed voice recording is missing. Upload it again.')
    data = _pcm(path)
    if recording.get('pcm_sha256') and hashlib.sha256(data).hexdigest() != recording['pcm_sha256']:
        raise ValueError('The analyzed recording has changed. Upload it again before generating.')
    samples = len(data) // 2
    duration = samples / SAMPLE_RATE
    if not 0 < duration <= MAX_SECONDS:
        raise ValueError('Use a voice recording between 0 and 300 seconds long.')
    words = _validate_words(recording.get('words'), duration)
    if not isinstance(scenes, list) or not scenes:
        raise ValueError('The recorded video needs at least one planned scene.')
    transcript_tokens, token_words = [], []
    for index, word in enumerate(words):
        tokens = _tokens(word['text'])
        transcript_tokens.extend(tokens)
        token_words.extend([index] * len(tokens))
    if not transcript_tokens:
        raise ValueError('No readable spoken words were found in the recording.')
    position, scene_word_ranges = 0, []
    for index, scene in enumerate(scenes):
        expected = _tokens(scene.get('narration', ''))
        actual = transcript_tokens[position:position + len(expected)]
        if not expected or expected != actual:
            raise ValueError('Scene %d does not match your recorded words. Keep the reviewed transcript unchanged, or record the revised script. No audio was cut or regenerated.' % (index + 1))
        start, end = token_words[position], token_words[position + len(expected) - 1] + 1
        if scene_word_ranges and start < scene_word_ranges[-1][1]:
            raise ValueError('A scene boundary splits a spoken word. Regenerate the scene plan using complete words.')
        scene_word_ranges.append((start, end))
        position += len(expected)
    if position != len(transcript_tokens):
        raise ValueError('The scene plan leaves out part of your recording. Use the complete reviewed transcript so every spoken word is preserved.')
    total_frames = math.ceil(samples / (SAMPLE_RATE // fps))
    boundaries = [0]
    for (_, end), (start, _) in zip(scene_word_ranges, scene_word_ranges[1:]):
        previous_end, next_start = words[end - 1]['end'], words[start]['start']
        anchor = (previous_end + next_start) / 2 if next_start >= previous_end else next_start
        frame = round(anchor * fps)
        if not boundaries[-1] < frame < total_frames:
            raise ValueError('Two planned scenes are too short to align to this recording. Combine them into one scene.')
        boundaries.append(frame)
    boundaries.append(total_frames)
    stage('Aligning motion to your original recorded delivery')
    target_samples = total_frames * (SAMPLE_RATE // fps)
    output = folder / 'narration.wav'
    if output.resolve() == path.resolve():
        output = folder / 'narration-recorded.wav'
    with wave.open(str(output), 'wb') as destination:
        destination.setnchannels(1)
        destination.setsampwidth(2)
        destination.setframerate(SAMPLE_RATE)
        destination.writeframes(data + b'\0' * ((target_samples - samples) * 2))
    intervals = []
    for index, ((start_word, end_word), first, last) in enumerate(zip(scene_word_ranges, boundaries, boundaries[1:])):
        intervals.append({'scene': index, 'start': first / fps, 'end': last / fps,
            'start_frame': first, 'end_frame': last,
            'speech_duration': words[end_word - 1]['end'] - words[start_word]['start'],
            'narration': scenes[index]['narration'], 'words': words[start_word:end_word],
            'rate': 'original', 'alignment': 'Recorded word timestamps; visual boundaries rounded to nearest frame'})
    return {'provider': 'Original recorded voice', 'voice': 'Your recording', 'audio': str(output),
        'duration': total_frames / fps, 'source_duration': duration, 'frames': total_frames, 'fps': fps,
        'scenes': intervals, 'source_pcm_sha256': hashlib.sha256(data).hexdigest(),
        'end_padding_samples': target_samples - samples,
        'warnings': recording.get('warnings', [])}
