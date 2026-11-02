"""Reusable, identity-driven motion composition with real neural narration."""
import json
import io
import copy
import math
import re
import subprocess
import unicodedata
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

from studio_voice import synthesize_narration
from studio_delivery import voice_units, collapse_timeline
from voice_graphics import compile_policy, motion_time, accent_strength

WIDTH, HEIGHT, FPS = 1080, 1920, 30
FONT_BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
FONT_NORMAL = '/System/Library/Fonts/Supplemental/Arial.ttf'
FALLBACK = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'


@lru_cache(maxsize=80)
def font(size, bold=False):
    path = FONT_BOLD if bold else FONT_NORMAL
    return ImageFont.truetype(path if Path(path).exists() else FALLBACK, int(size))


def color(value):
    if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
        raise ValueError('Studio colors must be six-digit hex colors.')
    return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))


def mix(a, b, amount):
    return tuple(round(x * (1 - amount) + y * amount) for x, y in zip(a, b))


def ease(t):
    t = max(0, min(1, t))
    return 1 - (1 - t) ** 3


def wrap(text, selected_font, width):
    """Word wrap, splitting long tokens rather than clipping the frame."""
    # Arial does not include every Unicode fraction. Keep the same value in a
    # portable visible form instead of silently drawing a missing-glyph square.
    text = unicodedata.normalize('NFKC', text).replace('\u2044', '/')
    lines, current = [], ''
    for word in text.split():
        candidate = (current + ' ' + word).strip()
        if selected_font.getlength(candidate) <= width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ''
        while selected_font.getlength(word) > width:
            split = max(1, int(len(word) * width / selected_font.getlength(word)))
            while split > 1 and selected_font.getlength(word[:split]) > width:
                split -= 1
            lines.append(word[:split])
            word = word[split:]
        current = word
    if current:
        lines.append(current)
    return lines


@lru_cache(maxsize=128)
def fit_text(text, width, size, max_lines=3, bold=False, spacing=1.13, max_height=None):
    # Font size falls before line count is limited; no silent text truncation.
    while True:
        selected = font(size, bold)
        lines = wrap(text, selected, width)
        fits = len(lines) <= max_lines and (max_height is None or len(lines)*size*spacing <= max_height)
        if fits or size <= 22:
            break
        size -= 2
    return selected, lines, size


def block(draw, text, x, y, width, size, ink, max_lines=3, bold=False, spacing=1.13, align='left', max_height=None):
    selected, lines, size = fit_text(text,width,size,max_lines,bold,spacing,max_height)
    for line in lines:
        left = x if align == 'left' else x + (width - selected.getlength(line)) / 2
        draw.text((left, y), line, font=selected, fill=ink)
        y += size * spacing
    return y


@lru_cache(maxsize=12)
def background(bg, accent, style):
    # Low-frequency light field gives the whole film one continuous visual space.
    y, x = np.mgrid[0:HEIGHT, 0:WIDTH]
    glow = np.exp(-(((x - 850) / 780) ** 2 + ((y - 900) / 900) ** 2))
    strength = .08 if style == 'editorial' else .14
    a = np.array(bg, dtype=float)
    b = np.array(accent, dtype=float)
    pixels = a + (b - a) * glow[..., None] * strength
    return Image.fromarray(np.uint8(np.clip(pixels, 0, 255)))


def diagram(draw, scene, identity, elapsed, progress, bg, fg, accent, policy=None):
    """All forms are decorative, never invented statistical or factual graphics."""
    energy = scene['energy']
    tempo = .35 + energy * .9
    motion = identity['motion']
    amplitude = {'restrained': .35, 'flowing': .8, 'punchy': 1.0}[motion]
    if policy:
        amplitude = policy['motion_amplitude']
    phase = elapsed * tempo
    entrance = policy['entrance_seconds'] if policy else (.32 if motion == 'punchy' else .65)
    appear = ease(elapsed / entrance)
    slots = policy['motion_slots'] if policy else 7
    cx, cy = 540, 1000
    quiet = mix(bg, fg, .18)
    light = mix(bg, accent, .45)
    kind = scene['visual']
    if kind == 'orbit':
        for radius in (145, 245, 335):
            draw.ellipse((cx-radius, cy-radius, cx+radius, cy+radius), outline=quiet, width=2)
        radius = 95 * appear
        draw.rounded_rectangle((cx-radius, cy-radius, cx+radius, cy+radius), radius=28, fill=accent)
        for i, radius in enumerate((145, 245, 335)):
            theta = (phase if i < slots else 0) * amplitude * (.5 + i*.13) + i*2.15
            x, y = cx+math.cos(theta)*radius, cy+math.sin(theta)*radius
            r = (20+i*9)*appear
            draw.line((cx, cy, x, y), fill=quiet, width=2)
            draw.ellipse((x-r, y-r, x+r, y+r), fill=fg if i % 2 else accent)
        draw.line((cx-35,cy,cx+35,cy), fill=bg, width=8)
        draw.line((cx,cy-35,cx,cy+35), fill=bg, width=8)
    elif kind == 'bars':
        # A rhythmic abstract signal, deliberately without axis labels or values.
        for i in range(7):
            # Retain the composition; quieter bars stop moving instead of disappearing.
            local_phase = phase if i < slots else 0
            height = (130 + 270*(.5+.5*math.sin(i*.7+local_phase*amplitude)))*appear
            x = 196+i*103
            draw.rounded_rectangle((x, cy-height/2, x+65, cy+height/2), radius=25,
                                  fill=accent if i in (2,3,4) else quiet)
        draw.line((168, 1325, 912, 1325), fill=quiet, width=2)
    elif kind == 'steps':
        for i in range(3):
            reveal = ease((elapsed-i*min(.17,entrance*.3))/entrance)
            x, y = 170+i*230, 1090-i*100+(1-reveal)*90
            draw.rounded_rectangle((x, y, x+220, y+150), radius=24,
                                  fill=mix(bg, accent, .15+.35*i), outline=accent, width=2)
            draw.line((x+55,y+76,x+165,y+76), fill=fg, width=5)
            if i < 2:
                draw.line((x+220,y+60,x+245,y-15), fill=quiet, width=3)
        draw.ellipse((790,770,818,798), fill=fg)
    elif kind == 'comparison':
        for i in (0,1):
            x = 155+i*405
            draw.rounded_rectangle((x, 790, x+365, 1215), radius=38, outline=quiet, width=3)
            if i == 0:
                for j in range(5):
                    dx = math.sin(j*4+(phase if j < slots else 0)*.3*amplitude)*65
                    y = 860+j*62
                    draw.rounded_rectangle((x+85+dx,y,x+215+dx,y+22), radius=8, fill=light)
            else:
                for j in range(3):
                    y = 870+j*100
                    draw.rounded_rectangle((x+65,y,x+300,y+55), radius=16, fill=accent)
        draw.line((520, 1320, 560, 1320), fill=fg, width=4)
    elif kind == 'wave':
        for layer in range(3):
            points = []
            for x in range(120, 961, 4):
                envelope = math.sin((x-120)/840*math.pi)
                local_phase = phase if layer < slots else 0
                y = cy + math.sin((x-120)/95-local_phase*amplitude*2+layer*.65)*envelope*(120+layer*45)*appear
                points.append((x,y))
            draw.line(points, fill=accent if layer==1 else mix(bg,fg,.3+layer*.2), width=7 if layer==1 else 3)
        draw.ellipse((520,1280,560,1320), fill=accent)
    else:
        # A sculptural focal object whose scale responds to scene energy.
        pulse = math.sin(phase*amplitude)*12
        r = (205+pulse)*appear
        for extra in (60, 110):
            draw.ellipse((cx-r-extra,cy-r-extra,cx+r+extra,cy+r+extra), outline=quiet, width=2)
        draw.rounded_rectangle((cx-r,cy-r,cx+r,cy+r), radius=int(r*.35), fill=accent)
        r2 = r*.5
        draw.ellipse((cx-r2,cy-r2,cx+r2,cy+r2), fill=bg)
        draw.ellipse((cx-22,cy-22,cx+22,cy+22), fill=fg)


class AssetSource:
    """An optional uploaded overlay, contained without distorting its aspect ratio."""
    def __init__(self, asset):
        self.asset, self.pipe, self.image = asset, None, None
        path = Path(asset['path'])
        if not path.is_file():
            raise ValueError('The selected overlay asset is missing.')
        if asset['kind'] == 'image':
            with Image.open(path) as image:
                self.image = ImageOps.contain(image.convert('RGBA'), (816, 650))
        else:
            self.pipe = subprocess.Popen(['ffmpeg','-v','error','-stream_loop','-1','-i',str(path),
                '-vf','scale=816:650:force_original_aspect_ratio=decrease,pad=816:650:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba',
                '-r',str(FPS),'-an','-f','rawvideo','-pix_fmt','rgba','pipe:1'],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def frame(self):
        if self.image is not None:
            return self.image
        size = 816*650*4
        buf = bytearray()
        while len(buf) < size:
            piece = self.pipe.stdout.read(size-len(buf))
            if not piece:
                raise RuntimeError('Could not decode the selected overlay video.')
            buf.extend(piece)
        return Image.frombytes('RGBA', (816,650), bytes(buf))

    def close(self):
        if self.pipe:
            self.pipe.terminate()
            try:
                self.pipe.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.pipe.kill()
                self.pipe.wait()
            self.pipe.stdout.close()


def _speech_tokens(text):
    value = unicodedata.normalize('NFKC', str(text)).casefold().replace('’', "'")
    return re.findall(r'[^\W_]+', value.replace("'", ''))


def _word_tokens(words):
    tokens, indices = [], []
    for index, word in enumerate(words):
        parts = _speech_tokens(word.get('text', ''))
        tokens.extend(parts)
        indices.extend([index] * len(parts))
    return tokens, indices


def _anchors_for_beat(beat, words, offset, notes):
    """Align only within this beat, so a repeated phrase cannot jump occurrences."""
    tokens, indices = _word_tokens(words)
    expected = _speech_tokens(beat.get('text', ''))
    if tokens != expected:
        notes.append('Emphasis skipped: measured words do not fully match this delivery beat.')
        return [], []
    anchors, highlighted = [], []
    for phrase in beat.get('emphasis', []):
        target = _speech_tokens(phrase)
        hits = [i for i in range(len(tokens)-len(target)+1)
                if target and tokens[i:i+len(target)] == target]
        if len(hits) != 1:
            notes.append('Emphasis skipped: the phrase is absent or ambiguous within its beat.')
            continue
        first = hits[0]
        selected = sorted(set(indices[first:first+len(target)]))
        anchors.append(offset+selected[0])
        highlighted.extend(offset+i for i in selected)
    return anchors, highlighted


def _anchors_from_partition(beats, words, notes):
    tokens, indices = _word_tokens(words)
    expected = _speech_tokens(' '.join(beat['text'] for beat in beats))
    anchors, highlighted = [], []
    if tokens != expected:
        notes.append('Emphasis skipped: recorded words do not fully match the delivery plan.')
        return anchors, highlighted
    cursor = 0
    for beat in beats:
        count = len(_speech_tokens(beat['text']))
        selected = indices[cursor:cursor+count]
        if selected:
            first, last = selected[0], selected[-1]+1
            # A provider token can span punctuation or compounds. A boundary
            # inside that token has no reliable beat-specific occurrence.
            crosses = ((cursor and indices[cursor-1] == first) or
                       (cursor+count < len(indices) and indices[cursor+count] == last-1))
            if crosses:
                notes.append('Emphasis skipped: a delivery boundary splits a timed token.')
            else:
                a, h = _anchors_for_beat(beat, words[first:last], first, notes)
                anchors.extend(a); highlighted.extend(h)
        cursor += count
    return anchors, highlighted


def compile_studio_policies(plan, timeline):
    """Add graphics metadata to a copy, preserving every narration sample and timestamp."""
    out = copy.deepcopy(timeline)
    if len(plan['scenes']) != len(out['scenes']):
        raise ValueError('Visual delivery needs one timed interval per planned scene.')
    units = voice_units(plan) if 'delivery' in plan else []
    grouped = {}
    for unit in units:
        grouped.setdefault(unit['scene_index'], []).append(unit['delivery'])
    for index, (scene, interval) in enumerate(zip(plan['scenes'], out['scenes'])):
        words = interval.get('words', [])
        anchors, highlighted, notes = [], [], []
        beats = grouped.get(index, [])
        parts = interval.get('voice_beats', [])
        parts_match_plan = (len(parts) == len(beats) and all(
            _word_tokens(part.get('words', []))[0] == _speech_tokens(beat['text'])
            for part, beat in zip(parts, beats)))
        if parts and (not beats or parts_match_plan):
            # Collapsed synthesis retains exact beat boundaries and measured word groups.
            if [w for part in parts for w in part.get('words', [])] != words:
                notes.append('Emphasis skipped: saved voice beat words differ from scene timing.')
            else:
                offset = 0
                for beat_index, part in enumerate(parts):
                    beat = beats[beat_index] if beat_index < len(beats) else part.get('requested_delivery')
                    part_words = part.get('words', [])
                    if beat:
                        a, h = _anchors_for_beat(beat, part_words, offset, notes)
                        anchors.extend(a); highlighted.extend(h)
                    offset += len(part_words)
        elif beats:
            # Recordings and visual revisions may partition the same exact copy
            # differently. Current model direction supersedes old synthesis tags.
            anchors, highlighted = _anchors_from_partition(beats, words, notes)
        policy = compile_policy(words, interval['start'], interval['end'], scene['energy'],
                                plan['identity']['motion'], sorted(set(anchors)),
                                importance=.9 if anchors else .5, fps=timeline.get('fps', FPS))
        # Do not display a delayed highlight for a token with no rendered frame
        # inside its known speech window (for example a sub-frame ASR token).
        visible_highlights = []
        for word_index in sorted(set(highlighted)):
            observed = policy['words'][word_index]
            onset, offset = observed['start'], observed['end']
            peak = math.ceil(onset*policy['fps']-1e-8)/policy['fps'] if onset is not None else None
            if peak is not None and peak < interval['end'] and (offset is None or peak < offset):
                visible_highlights.append(word_index)
        policy['emphasis_word_indices'] = visible_highlights
        policy['alignment_notes'] = notes
        policy['anchor_source'] = 'Model-selected exact delivery phrases; measured word times.'
        interval['visual_delivery'] = policy
    return out


def draw_delivery_caption(draw, words, active, absolute_time, policy, fg, accent):
    """Stable caption geometry with selective emphasis at the spoken occurrence."""
    first = (active//5)*5
    group = words[first:first+5]
    caption = ' '.join(w['text'] for w in group)
    selected_font, lines, size = fit_text(caption, 900, 48, 2, False, 1.13, 110)
    emphasized = set(policy.get('emphasis_word_indices', []))
    strength = accent_strength(policy, absolute_time)
    # The ordinary renderer remains the fallback for long split tokens: never
    # misattribute a highlight after wrapping has changed token boundaries.
    if [part for line in lines for part in line.split()] != [w['text'] for w in group]:
        block(draw, caption, 90, 1670, 900, 48, fg, max_lines=2, align='center', max_height=110)
        return
    index, y = first, 1670
    for line in lines:
        x = 90+(900-selected_font.getlength(line))/2
        for text in line.split():
            word = words[index]
            onset = policy['words'][index]['start']
            marked = index in emphasized and onset is not None and onset <= absolute_time
            width = selected_font.getlength(text)
            draw.text((x, y), text, font=selected_font, fill=accent if marked else fg)
            if marked:
                baseline = y+selected_font.getbbox(text)[3]+4
                draw.line((x, baseline, x+width, baseline), fill=accent,
                          width=3+round(3*strength))
            x += width+selected_font.getlength(' ')
            index += 1
        y += size*1.13


def render_frame(scene, identity, interval, absolute_time, index, total, asset_image=None):
    bg, fg, accent = [color(identity[key]) for key in ('background','foreground','accent')]
    image = background(bg, accent, identity['style']).copy()
    draw = ImageDraw.Draw(image)
    elapsed = absolute_time-interval['start']
    progress = elapsed/(interval['end']-interval['start'])
    policy = interval.get('visual_delivery')
    entrance = policy['entrance_seconds'] if policy else (.35 if identity['motion']=='punchy' else .65)
    intro = ease(elapsed/entrance)
    offset = int((1-intro)*55)
    if identity['style']=='editorial':
        for x in range(70,WIDTH,60):
            for y in range(160,1720,60):
                draw.ellipse((x,y,x+2,y+2),fill=mix(bg,fg,.15))
    block(draw, identity['name'].upper(), 88, 128, 770, 30, mix(bg,fg,.72), max_lines=2, bold=True)
    draw.line((88,215,992,215),fill=mix(bg,fg,.2),width=2)
    headline_size = 156
    headline = scene['headline'].upper() if identity['style']=='kinetic' else scene['headline']
    _, lines, fitted_size = fit_text(headline,905,headline_size,3,True,1.04,330)
    headline_offset = min(offset,max(0,330-len(lines)*fitted_size*1.04))
    bottom = block(draw, headline, 86, 290+headline_offset, 905, headline_size, fg,
                   max_lines=3, bold=True, spacing=1.04,max_height=330)
    draw.rounded_rectangle((90,bottom+33,205,bottom+41),radius=4,fill=accent)
    if asset_image is not None:
        scale = .96+.04*intro
        overlay = asset_image.resize((max(1,round(asset_image.width*scale)), max(1,round(asset_image.height*scale))),Image.Resampling.LANCZOS)
        image.paste(overlay, ((WIDTH-overlay.width)//2, 1000-overlay.height//2+offset), overlay)
    else:
        motion_elapsed = motion_time(policy, absolute_time) if policy else elapsed
        diagram(draw,scene,identity,motion_elapsed,progress,bg,fg,accent,policy)
    block(draw,scene['support'],90,1430,900,46,mix(bg,fg,.78),max_lines=3,spacing=1.3,max_height=180)
    # Real speech boundaries, grouped into short readable caption phrases.
    words = interval.get('words',[])
    # Hold a phrase through natural gaps between words instead of flickering.
    timed_words = policy['words'] if policy else words
    active = next((i for i in range(len(timed_words)-1,-1,-1)
                   if timed_words[i].get('start') is not None and timed_words[i]['start']<=absolute_time),None)
    if not policy and words and absolute_time > words[-1]['end']+.18:
        active=None
    if active is not None:
        if policy:
            draw_delivery_caption(draw,words,active,absolute_time,policy,fg,accent)
        else:
            group = words[(active//5)*5:(active//5+1)*5]
            caption = ' '.join(w['text'] for w in group)
            block(draw,caption,90,1670,900,48,fg,max_lines=2,align='center',max_height=110)
    draw.line((90,1790,990,1790),fill=mix(bg,fg,.15),width=3)
    draw.line((90,1790,90+900*min(1,progress),1790),fill=accent,width=4)
    draw.text((90,1820),'%02d / %02d'%(index+1,total),font=font(23,True),fill=mix(bg,fg,.5))
    return image


def render_studio(folder, plan, assets, stage=lambda message: None, narration=None):
    folder = Path(folder)
    folder.mkdir(parents=True,exist_ok=True)
    scenes, identity = plan['scenes'], plan['identity']
    timeline = narration if narration is not None else collapse_timeline(
        synthesize_narration(folder,voice_units(plan),identity,stage,FPS),plan)
    timeline = compile_studio_policies(plan, timeline)
    timeline['identity'] = identity
    (folder/'timing.json').write_text(json.dumps(timeline,indent=2))
    (folder/'creative-plan.json').write_text(json.dumps(plan,indent=2))
    overlays = {a['id']:a for a in assets if a.get('role')=='overlay'}
    final = folder/'export.mp4'
    temporary = folder/'rendering.mp4'
    command = ['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{WIDTH}x{HEIGHT}',
        '-r',str(FPS),'-i','pipe:0','-i',timeline['audio'],'-map','0:v:0','-map','1:a:0',
        '-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p',
        '-c:a','aac','-b:a','192k','-movflags','+faststart','-t',str(timeline['duration']),str(temporary)]
    error_log=folder/'render-error.log'
    with error_log.open('wb') as errors:
        process=subprocess.Popen(command,stdin=subprocess.PIPE,stderr=errors)
        try:
            for i,(scene,interval) in enumerate(zip(scenes,timeline['scenes'])):
                stage('Compositing · scene %d of %d'%(i+1,len(scenes)))
                selected=scene.get('asset_id')
                if selected and selected not in overlays:
                    raise ValueError('Scene references an asset that was not marked for use in the video.')
                source=AssetSource(overlays[selected]) if selected else None
                try:
                    for frame in range(interval['start_frame'],interval['end_frame']):
                        image=render_frame(scene,identity,interval,frame/FPS,i,len(scenes),source.frame() if source else None)
                        process.stdin.write(image.tobytes())
                finally:
                    if source: source.close()
            process.stdin.close()
            if process.wait(timeout=180):
                raise RuntimeError('Video encoding failed: '+error_log.read_text()[-500:])
        except Exception:
            if process.poll() is None:
                process.kill()
                process.wait()
            raise
    stage('Checking the export and preparing playback')
    verify=subprocess.run(['ffmpeg','-v','error','-i',str(temporary),'-f','null','-'],capture_output=True,timeout=180)
    if verify.returncode or verify.stderr:
        raise RuntimeError('Export verification failed; no completed video was published.')
    temporary.replace(final)
    preview=folder/'preview.mp4'
    result=subprocess.run(['ffmpeg','-v','error','-y','-i',str(final),'-vf','scale=540:960',
        '-c:v','libx264','-preset','veryfast','-crf','23','-c:a','copy','-movflags','+faststart',str(preview)],
        capture_output=True,timeout=180)
    if result.returncode:
        raise RuntimeError('Preview encoding failed.')
    # Inspectable contact sheet comes from the encoded deliverable, not drawings
    # before encoding. This catches corruption, dimensions, and compositing errors.
    samples=[]
    for interval in timeline['scenes']:
        midpoint=(interval['start']+interval['end'])/2
        extracted=subprocess.run(['ffmpeg','-v','error','-ss',str(midpoint),'-i',str(final),
            '-frames:v','1','-vf','scale=540:960','-f','image2pipe','-c:v','mjpeg','pipe:1'],
            capture_output=True,timeout=30)
        if extracted.returncode:
            raise RuntimeError('Could not inspect an encoded scene.')
        with Image.open(io.BytesIO(extracted.stdout)) as thumb:samples.append(thumb.convert('RGB'))
    columns=min(4,len(samples))
    sheet=Image.new('RGB',(columns*540,math.ceil(len(samples)/columns)*960),(15,18,24))
    for i,sample in enumerate(samples):sheet.paste(sample,((i%columns)*540,(i//columns)*960))
    sheet.save(folder/'contact.jpg',quality=92)
    return {'duration':timeline['duration'],'frames':timeline['frames'],'fps':FPS,
        'voice_provider':timeline['provider'],'voice':timeline['voice'],'warnings':timeline.get('warnings',[]),
        'export':str(final),'preview':str(preview),'timing':str(folder/'timing.json'),'contact':str(folder/'contact.jpg')}
