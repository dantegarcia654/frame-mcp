"""Intent-directed speech beats, with exact copy and measured scene timing."""
import math
import re


def obj(properties):
    return {'type': 'object', 'additionalProperties': False, 'properties': properties,
            'required': list(properties)}


ROLES = ('hook', 'setup', 'contrast', 'payoff', 'invitation', 'explanation')
TONES = ('neutral', 'warm', 'confident', 'curious', 'excited', 'serious', 'reassuring')
BEAT = obj({'text': {'type': 'string'}, 'role': {'type': 'string', 'enum': list(ROLES)},
            'tone': {'type': 'string', 'enum': list(TONES)},
            'emphasis': {'type': 'array', 'items': {'type': 'string'}},
            'pace': {'type': 'number'}, 'pause_after_ms': {'type': 'integer'},
            'pitch_hz': {'type': 'integer'}, 'volume_db': {'type': 'number'},
            'reason': {'type': 'string'}})
DELIVERY = obj({**{key: {'type': 'string'} for key in ('intent', 'persona', 'arc', 'reference_note')},
                'beats': {'type': 'array', 'items': BEAT}})


def normalize(value):
    return ' '.join(value.split())


def _groups(delivery, scenes):
    beats, offset, groups = delivery['beats'], 0, []
    for scene in scenes:
        target, group = normalize(scene['narration']), []
        while offset < len(beats):
            group.append(offset)
            offset += 1
            phrase = normalize(' '.join(beats[i]['text'] for i in group))
            if phrase == target:
                break
            if not target.startswith(phrase + ' '):
                raise ValueError('Delivery beats must partition each scene without crossing scene boundaries.')
        if not group or normalize(' '.join(beats[i]['text'] for i in group)) != target:
            raise ValueError('Every scene needs complete delivery beats.')
        groups.append(group)
    if offset != len(beats):
        raise ValueError('Delivery contains unused beats.')
    return groups


def validate_delivery(delivery, scenes, script):
    if not isinstance(delivery, dict) or set(delivery) != set(DELIVERY['properties']):
        raise ValueError('The vocal delivery plan is incomplete.')
    for key in ('intent', 'persona', 'arc', 'reference_note'):
        if not isinstance(delivery[key], str) or len(delivery[key]) > 1500 or (key != 'reference_note' and not delivery[key].strip()):
            raise ValueError('Invalid delivery ' + key)
    beats = delivery['beats']
    if not isinstance(beats, list) or not 1 <= len(beats) <= 24:
        raise ValueError('Use between 1 and 24 complete speech beats.')
    for beat in beats:
        if not isinstance(beat, dict) or set(beat) != set(BEAT['properties']):
            raise ValueError('A delivery beat is incomplete.')
        for key in ('text', 'reason'):
            if not isinstance(beat[key], str) or not beat[key].strip() or len(beat[key]) > 1500:
                raise ValueError('Invalid delivery beat ' + key)
        if beat['role'] not in ROLES or beat['tone'] not in TONES:
            raise ValueError('Unsupported delivery role or tone.')
        for key, low, high in [('pace', .8, 1.2), ('pause_after_ms', 0, 800),
                               ('pitch_hz', -25, 25), ('volume_db', -3, 3)]:
            value = beat[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
                raise ValueError('Invalid delivery ' + key)
            if key in ('pause_after_ms', 'pitch_hz') and not isinstance(value, int):
                raise ValueError('Delivery ' + key + ' must be an integer.')
        emphasis = beat['emphasis']
        if not isinstance(emphasis, list) or len(emphasis) > 3:
            raise ValueError('Choose at most three exact emphasis phrases per beat.')
        occupied = []
        for phrase in emphasis:
            if not isinstance(phrase, str) or not phrase.strip() or len(phrase) > 140:
                raise ValueError('Invalid emphasis phrase.')
            matches = list(re.finditer(r'(?<!\w)' + re.escape(phrase) + r'(?!\w)', beat['text']))
            if len(matches) != 1:
                raise ValueError('Emphasis must name one unambiguous exact phrase in its beat.')
            span = matches[0].span()
            if any(span[0] < end and span[1] > start for start, end in occupied):
                raise ValueError('Emphasis phrases cannot overlap.')
            occupied.append(span)
    if normalize(' '.join(beat['text'] for beat in beats)) != normalize(script):
        raise ValueError('The delivery plan changed the narration.')
    _groups(delivery, scenes)
    return delivery


def voice_units(plan):
    """Generate complete thought phrases, never isolated word fragments."""
    if 'delivery' not in plan:
        return [dict(scene) for scene in plan['scenes']]
    delivery, scenes = plan['delivery'], plan['scenes']
    units = []
    for scene_index, group in enumerate(_groups(delivery, scenes)):
        for beat_index in group:
            beat = delivery['beats'][beat_index]
            units.append({**scenes[scene_index], 'narration': beat['text'],
                          'delivery': beat, 'scene_index': scene_index})
    return units


def collapse_timeline(timeline, plan):
    """Keep synthesis samples/word times intact; group beats into graphics scenes."""
    if 'delivery' not in plan:
        return timeline
    groups = _groups(plan['delivery'], plan['scenes'])
    units = timeline['scenes']
    if len(units) != len(plan['delivery']['beats']):
        raise ValueError('Narration timing is missing delivery beats.')
    fps = timeline.get('fps')
    if isinstance(fps, bool) or not isinstance(fps, int) or fps <= 0:
        raise ValueError('Delivery timing needs a positive integer frame rate.')
    frame = 0
    for unit in units:
        if any(isinstance(unit[key], bool) or not isinstance(unit[key], int)
               for key in ('start_frame', 'end_frame')):
            raise ValueError('Delivery timing needs integer frame indices.')
        if unit['start_frame'] != frame or unit['end_frame'] <= frame:
            raise ValueError('Delivery timing must have contiguous frames.')
        for key in ('start', 'end'):
            value = unit[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not math.isclose(value, unit[key + '_frame'] / fps, abs_tol=1e-7):
                raise ValueError('Delivery seconds must match the measured frame timing.')
        frame = unit['end_frame']
    if isinstance(timeline['frames'], bool) or not isinstance(timeline['frames'], int) or frame != timeline['frames']:
        raise ValueError('Delivery timing does not cover the complete audio.')
    duration = timeline['duration']
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not math.isclose(duration, frame / fps, abs_tol=1e-7):
        raise ValueError('Delivery duration must match the measured frame timing.')
    merged = []
    for scene_index, (scene, indices) in enumerate(zip(plan['scenes'], groups)):
        parts = [units[i] for i in indices]
        merged.append({**parts[0], 'scene': scene_index, 'narration': scene['narration'],
                       'end': parts[-1]['end'], 'end_frame': parts[-1]['end_frame'],
                       'duration': parts[-1]['end'] - parts[0]['start'],
                       'speech_duration': sum(part.get('speech_duration', 0) for part in parts),
                       'words': [word for part in parts for word in part.get('words', [])],
                       'voice_beats': parts})
        for key in ('requested_delivery', 'applied_delivery', 'rate', 'pitch', 'volume'):
            merged[-1].pop(key, None)
    return {**timeline, 'scenes': merged, 'delivery': plan['delivery']}
