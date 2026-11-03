"""Bounded, normalized review markup saved with source-anchored section notes."""
import copy
import math
import uuid
import quick_timeline as timeline


def validate(items):
    if not isinstance(items, list) or not 1 <= len(items) <= 24:
        raise ValueError('Add 1–24 drawing, box or text annotations.')
    result, points = [], 0
    def unit(value):
        value = timeline.number(value)
        if not 0 <= value <= 1:
            raise ValueError('Keep markup inside the video picture.')
        return round(value, 4)
    for item in items:
        if not isinstance(item, dict):
            raise ValueError('Invalid markup item.')
        kind = item.get('kind')
        if kind == 'draw' and set(item) == {'kind', 'points'}:
            path = item['points']
            if not isinstance(path, list) or not 2 <= len(path) <= 500:
                raise ValueError('Draw a stroke with at least two points.')
            clean = []
            for point in path:
                if not isinstance(point, list) or len(point) != 2:
                    raise ValueError('Invalid drawing point.')
                clean.append([unit(v) for v in point])
            points += len(clean)
            result.append({'kind': kind, 'points': clean})
        elif kind in ('box', 'text') and set(item) == ({'kind','x','y','width','height'} if kind == 'box' else {'kind','x','y','text'}):
            clean = {'kind': kind, 'x': unit(item['x']), 'y': unit(item['y'])}
            if kind == 'box':
                clean.update(width=unit(item['width']), height=unit(item['height']))
                if not clean['width'] or not clean['height'] or clean['x']+clean['width'] > 1.0001 or clean['y']+clean['height'] > 1.0001:
                    raise ValueError('Draw a box inside the video picture.')
            else:
                text = item['text']
                if not isinstance(text, str) or not 1 <= len(text.strip()) <= 200:
                    raise ValueError('Use 1–200 characters in a text annotation.')
                clean['text'] = text.strip()
            result.append(clean)
        else:
            raise ValueError('Unsupported markup item or fields.')
    if points > 500:
        raise ValueError('Save this drawing before adding more strokes (500 points maximum).')
    return result


def prepare(doc, body):
    """Validate everything before adding an automatically created section."""
    items = validate(body.get('annotations'))
    anchor = body.get('source_time_ms')
    if type(anchor) is not int:
        raise ValueError('Choose an original-source timestamp in milliseconds.')
    moment = anchor / 1000
    clip = next((c for c in doc['clips'] if c['start'] <= moment < c['end']), None)
    if not clip:
        raise ValueError('Annotate a frame inside a retained clip.')
    sid = body.get('section_id')
    candidates = [p for p in doc['pins'] if p.get('end') is not None and p['start'] <= moment < p['end']]
    pin = next((p for p in candidates if p['id'] == sid), None) if sid else next(iter(candidates), None)
    if sid and pin is None:
        raise ValueError('The annotation frame must be inside its selected section.')
    if pin is None:
        if len(doc['pins']) >= 200:
            raise ValueError('Maximum 200 sections. Select an existing section.')
        start = max(clip['start'], math.floor(moment * 30) / 30)
        end = min(clip['end'], start + 1)
        pin = {'id': uuid.uuid4().hex, 'time': start, 'start': start, 'end': end,
               'clip_id': clip.get('origin_id', clip['id']), 'instruction': '',
               'source_start_ms': round(start*1000), 'source_end_ms': round(end*1000)}
        doc['pins'].append(pin)
    return pin, anchor, copy.deepcopy(items)
