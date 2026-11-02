"""Footage analysis and deterministic rendering. All times refer to the original."""
import json
import math
import re
import subprocess
import threading
from pathlib import Path

TRANSCRIBE_LOCK = threading.Lock()
MODEL = None


def run(args, timeout=1200):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-1600:])
    return result.stdout


def probe(path, enforce_limit=True):
    data = json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams',
                           '-of', 'json', str(path)]))
    video = next((s for s in data['streams'] if s['codec_type'] == 'video'), None)
    if not video:
        raise ValueError('Please upload a video file.')
    total = float(data['format'].get('duration', video.get('duration', 0)))
    if not math.isfinite(total) or total <= 0 or (enforce_limit and total > 300.1):
        raise ValueError('Use a video between 0 and 300 seconds long.')
    return {'duration': total, 'audio': any(s['codec_type'] == 'audio' for s in data['streams']),
            'width': video['width'], 'height': video['height']}


def detect_silence(path):
    result = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(path), '-af',
                             'silencedetect=noise=-34dB:d=0.55', '-f', 'null', '-'],
                            capture_output=True, text=True, timeout=600)
    if result.returncode:
        raise RuntimeError(result.stderr[-1200:])
    start, regions = None, []
    for line in result.stderr.splitlines():
        a = re.search(r'silence_start: ([0-9.]+)', line)
        b = re.search(r'silence_end: ([0-9.]+)', line)
        if a:
            start = float(a.group(1))
        if b and start is not None:
            regions.append([max(0, start), float(b.group(1))])
            start = None
    return regions


def transcribe(path):
    global MODEL
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError('Speech understanding needs faster-whisper. Run: python3 -m pip install -r requirements.txt') from exc
    with TRANSCRIBE_LOCK:
        if MODEL is None:
            # The existing cached English model avoids an unexpected model download.
            MODEL = WhisperModel('small.en', device='cpu', compute_type='int8',
                                 cpu_threads=4, local_files_only=True)
        segments, info = MODEL.transcribe(str(path), word_timestamps=True,
                                           vad_filter=True, beam_size=3)
        return [{'start': round(s.start, 3), 'end': round(s.end, 3), 'text': s.text.strip(),
                 'words': [{'start': round(w.start, 3), 'end': round(w.end, 3), 'text': w.word}
                           for w in (s.words or [])]} for s in segments]


def storyboard(path, folder, total):
    from PIL import Image, ImageDraw
    count = min(12, max(1, math.ceil(total / 2)))
    times = [min(total - .04, (i + .5) * total / count) for i in range(count)]
    sheet = Image.new('RGB', (4 * 320, math.ceil(count / 4) * 208), '#11151c')
    draw = ImageDraw.Draw(sheet)
    for i, t in enumerate(times):
        frame = folder / ('frame-%02d.jpg' % i)
        run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', str(max(0, t)), '-i', str(path),
             '-frames:v', '1', '-vf', 'scale=320:180:force_original_aspect_ratio=decrease', str(frame)])
        with Image.open(frame) as im:
            x, y = (i % 4) * 320, (i // 4) * 208
            sheet.paste(im, (x + (320 - im.width) // 2, y + (180 - im.height) // 2))
            draw.text((x + 10, y + 185), 'SOURCE %.2fs' % t, fill='white')
    dest = folder / 'storyboard.jpg'
    sheet.save(dest, quality=85)
    return [round(t, 2) for t in times]


def analyze(folder, stage):
    cache = folder / 'analysis.json'
    if cache.exists():
        return json.loads(cache.read_text())
    inp = folder / 'input.mp4'
    stage('Checking your video')
    info = probe(inp)
    stage('Sampling the footage')
    info['frame_times'] = storyboard(inp, folder, info['duration'])
    info['transcript'], info['silences'], info['warnings'] = [], [], []
    if info['audio']:
        stage('Listening and transcribing — first pass may take a minute')
        try:
            info['transcript'] = transcribe(inp)
        except Exception as exc:
            info['warnings'].append('Transcription unavailable: ' + str(exc)[-350:])
        stage('Measuring the pauses')
        info['silences'] = detect_silence(inp)
    else:
        info['warnings'].append('This clip has no audio track. Decisions use sampled frames and timestamps.')
    cache.write_text(json.dumps(info))
    return info


def validate_segments(segments, total):
    if not isinstance(segments, list) or not 1 <= len(segments) <= 48:
        raise ValueError('The edit must keep between 1 and 48 sections.')
    clean = []
    for segment in segments:
        a, b = segment['start'], segment['end']
        if isinstance(a, bool) or isinstance(b, bool):
            raise ValueError('Invalid cut times.')
        a, b = float(a), float(b)
        if not all(math.isfinite(v) for v in (a, b)) or a < 0 or b > total + .08 or b - a < .12:
            raise ValueError('A planned cut falls outside the footage or is too short.')
        clean.append([round(a, 4), round(min(b, total), 4)])
    # Reordering is allowed, accidental repeated footage is not.
    ordered = sorted(clean)
    if any(b > c + .01 for (_, b), (c, _) in zip(ordered, ordered[1:])):
        raise ValueError('The planned sections overlap. Ask for a clearer cut.')
    return clean


def trim_pauses(keep, regions):
    result = []
    for start, end in keep:
        cursor = start
        for a, b in regions:
            if b - a < .8:
                continue
            a, b = max(start, a + .18), min(end, b - .20)
            if b - a < .32 or b <= cursor:
                continue
            if a - cursor >= .12:
                result.append([cursor, a])
            cursor = max(cursor, b)
        if end - cursor >= .12:
            result.append([cursor, end])
    if not result:
        raise ValueError('Removing every pause would leave no usable footage. Try a different request.')
    if len(result) > 48:
        raise ValueError('That creates more than 48 cuts. Please choose a shorter section first.')
    return result


def render(source, folder, keep, audio, stage):
    parts = []
    for i, (a, b) in enumerate(keep):
        stage('Rendering section %s of %s' % (i + 1, len(keep)))
        dest = folder / ('part%03d.mp4' % i)
        cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-ss', str(a), '-i', str(source),
               '-t', str(b - a), '-map', '0:v:0', '-map', '0:a:0?', '-vf',
               'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1', '-c:v', 'libx264', '-preset', 'veryfast',
               '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '30', '-threads', '4']
        if audio:
            cmd += ['-af', 'asetpts=PTS-STARTPTS', '-c:a', 'aac', '-ar', '48000', '-ac', '2']
        run(cmd + ['-movflags', '+faststart', str(dest)])
        parts.append(dest)
    listing = folder / 'clips.txt'
    listing.write_text(''.join("file '%s'\n" % p.name for p in parts))
    output = folder / 'edited.mp4'
    run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(listing),
         '-c', 'copy', '-movflags', '+faststart', str(output)])
    # Concat can shift video by AAC encoder priming (typically 1,024 samples).
    # Normalize the common stream origin so preview time zero and export time zero agree.
    streams = json.loads(run(['ffprobe','-v','error','-show_entries','stream=codec_type,start_time',
                              '-of','json',str(output)]))['streams']
    video_start = float(next(s for s in streams if s['codec_type']=='video').get('start_time',0))
    if abs(video_start)>1e-6:
        normalized=folder/'normalized.mp4'
        run(['ffmpeg','-y','-loglevel','error','-itsoffset',str(-video_start),'-i',str(output),
             '-map','0','-c','copy','-avoid_negative_ts','disabled','-movflags','+faststart',str(normalized)])
        normalized.replace(output)
    stage('Checking the exported video')
    measured = probe(output, enforce_limit=False)['duration']
    if abs(measured - sum(b - a for a, b in keep)) > max(.35, .06 * len(keep)):
        raise RuntimeError('Export length did not match the planned cut. Original footage is safe.')
    # Intermediate renders can be recreated from the saved plan.
    for p in parts:
        p.unlink()
    return measured


def render_timeline(source, folder, keep, audio, stage, positions=None):
    """Frame-aligned timeline, one encode: no accumulated AAC priming per cut."""
    fps = 30
    count = len(keep)
    expected_frames = sum(round(b*fps)-round(a*fps) for a,b in keep)
    duration = expected_frames/fps
    video_outputs = ''.join('[vs%d]' % i for i in range(count))
    filters = ['[0:v:0]fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,split=%d%s' % (count,video_outputs)]
    if audio:
        filters.append('[0:a:0]asplit=%d%s' % (count,''.join('[as%d]' % i for i in range(count))))
    if positions is None:positions=[(0,0)]*count
    if len(positions)!=count:raise ValueError('One position is required for each clip.')
    for i,(a,b) in enumerate(keep):
        x,y=positions[i]
        if not all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) and abs(v)<=.5 for v in (x,y)):
            raise ValueError('Invalid clip position.')
        shift=(',pad=iw*3:ih*3:iw:ih:color=black,crop=iw/3:ih/3:iw/3*(1-%.9f):ih/3*(1-%.9f)'%(x,y)) if x or y else ''
        filters.append('[vs%d]trim=start_frame=%d:end_frame=%d,setpts=PTS-STARTPTS%s[v%d]' % (i,round(a*fps),round(b*fps),shift,i))
        if audio:
            filters.append('[as%d]atrim=start=%.9f:end=%.9f,asetpts=PTS-STARTPTS,apad=pad_dur=0.05,atrim=duration=%.9f[a%d]' % (i,a,b,b-a,i))
    inputs = ''.join('[v%d][a%d]' % (i,i) if audio else '[v%d]' % i for i in range(count))
    filters.append('%sconcat=n=%d:v=1:a=%d[vout]%s' % (inputs,count,int(audio),'[aout]' if audio else ''))
    script = folder/'timeline-filter.txt'
    script.write_text(';\n'.join(filters))
    stage('Rendering timeline in one synchronized encode')
    cmd=['ffmpeg','-y','-hide_banner','-loglevel','error','-i',str(source),'-filter_complex_threads','2',
         '-filter_complex',script.read_text(),'-map','[vout]']
    if audio:cmd+=['-map','[aout]','-c:a','aac','-ar','48000','-ac','2']
    cmd+=['-c:v','libx264','-preset','veryfast','-crf','21','-pix_fmt','yuv420p','-r','30','-threads','4',
          '-t','%.9f'%duration,'-movflags','+faststart',str(folder/'edited.mp4')]
    run(cmd)
    measured=probe(folder/'edited.mp4',enforce_limit=False)['duration']
    if abs(measured-duration) > .05:
        raise RuntimeError('Export does not match timeline within 50 ms.')
    return measured
