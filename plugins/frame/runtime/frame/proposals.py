"""Create a reviewable, grounded proposal without rendering any media."""
import math
from editor import trim_pauses, validate_segments


def words_in(analysis, start, end):
    return [w for s in analysis['transcript'] for w in s.get('words', [])
            if w['end'] > start + .025 and w['start'] < end - .025]


def quote(analysis, start, end):
    return ''.join(w['text'] for w in words_in(analysis, start, end)).strip()


def validate_thoughts(raw, analysis):
    total = analysis['duration']
    if not isinstance(raw,list) or len(raw)>250:
        raise ValueError('The thought map is invalid.')
    thoughts, ids, previous = [], set(), 0
    for t in raw:
        a, b = float(t['start']), float(t['end'])
        if not all(math.isfinite(v) for v in (a, b)) or not 0 <= a < b <= total + .04 or a < previous - .025:
            raise ValueError('Thought boundaries are invalid or overlap. Please ask Katana to reconsider.')
        if not isinstance(t['id'], str) or not t['id'] or t['id'] in ids:
            raise ValueError('The thought map has duplicate or missing IDs.')
        if not isinstance(t['complete'],bool) or not isinstance(t['summary'],str) or not t['summary'].strip():
            raise ValueError('A thought needs a summary and an honest completeness flag.')
        if any(dep not in ids for dep in t['depends_on']):
            raise ValueError('A thought refers to missing context.')
        words = words_in(analysis, a, b)
        if not words or words[0]['start'] < a - .04 or words[-1]['end'] > b + .04:
            raise ValueError('A thought boundary splits a spoken word. Please ask Katana to reconsider.')
        thoughts.append({**t, 'start': a, 'end': b, 'text': ''.join(w['text'] for w in words).strip()})
        ids.add(t['id'])
        previous = b
    all_words = [w for s in analysis['transcript'] for w in s.get('words', []) if w['end']-w['start'] > .025]
    for w in all_words:
        if not any(t['start'] <= w['start']+.04 and t['end'] >= w['end']-.04 for t in thoughts):
            raise ValueError('Katana left words out of the thought map. Please ask it to reconsider.')
    return thoughts


def difference(baseline, keep):
    """Source intervals in baseline that are absent from keep, preserving baseline order."""
    result = []
    for a, b in baseline:
        cursor = a
        for c, d in sorted(keep):
            if d <= cursor or c >= b:
                continue
            if c > cursor + .025:
                result.append([cursor, min(c, b)])
            cursor = max(cursor, d)
            if cursor >= b:
                break
        if b > cursor + .025:
            result.append([cursor, b])
    return result


def reason_for(start, end, reasons, fallback):
    matching = [r.get('reason','').strip() for r in reasons
                if min(end,r['end'])-max(start,r['start']) > .025 and r.get('reason','').strip()]
    return ' '.join(dict.fromkeys(matching)) if matching else fallback


def build_proposal(decision, analysis, baseline):
    total = analysis['duration']
    keep = validate_segments(decision['segments'], total)
    mode = decision['boundary_mode']
    thoughts = validate_thoughts(decision['thoughts'], analysis) if analysis['transcript'] else []
    warnings = list(analysis['warnings'])
    if mode == 'complete_thoughts':
        if not thoughts:
            raise ValueError('There is no usable transcript to recognize thoughts. Give exact timestamps or a visual direction.')
        expanded = []
        for a, b in keep:
            touched = [t for t in thoughts if words_in(analysis, max(a, t['start']), min(b, t['end']))
                       and min(b, t['end']) > max(a, t['start'])]
            if touched:
                first, last = thoughts.index(touched[0]), thoughts.index(touched[-1])
                previous_end = thoughts[first-1]['end'] if first else 0
                next_start = thoughts[last+1]['start'] if last+1 < len(thoughts) else total
                a = min(a, max(previous_end, touched[0]['start']-.06))
                b = max(b, min(next_start, touched[-1]['end']+.10))
            # Merge sections whose thought expansion overlaps in the same source order.
            if expanded and a >= expanded[-1][0] and a <= expanded[-1][1]+.01:
                expanded[-1][1] = max(expanded[-1][1], b)
            else:
                expanded.append([a, b])
        keep = validate_segments([{'start': a, 'end': b} for a, b in expanded], total)
        selected_ids = {t['id'] for t in thoughts if any(a <= t['start']+.04 and b >= t['end']-.04 for a,b in keep)}
        for t in thoughts:
            if t['id'] in selected_ids and any(dep not in selected_ids for dep in t['depends_on']):
                raise ValueError('That selection loses a thought’s necessary setup. Ask Katana to include its context.')
    elif mode == 'exact':
        warnings.append('Exact timing requested. This selection may split a spoken thought; listen to the joins before approving.')
    elif mode == 'visual':
        warnings.append('Visual boundaries are based on sampled frames; review the exact slice before approving.')
    else:
        raise ValueError('Unknown thought boundary mode.')
    if decision['remove_pauses']:
        if not analysis['audio']:
            raise ValueError('This clip has no audio track to measure pauses.')
        safe = [r for r in analysis['silences'] if not words_in(analysis, r[0]+.18, r[1]-.20)]
        keep = trim_pauses(keep, safe)
    for t in thoughts:
        spoken = words_in(analysis,t['start'],t['end'])
        t['selected'] = all(any(a <= w['start']+.04 and b >= w['end']-.04 for a,b in keep) for w in spoken)
        if t['selected'] and not t['complete']:
            warnings.append('The source contains an unfinished thought: ' + t['summary'])
    cuts = []
    for a, b in difference(baseline, keep):
        text = quote(analysis, a, b)
        fallback = ('This interval contains measured dead air; the proposed cut keeps breathing room.'
                    if not text and decision['remove_pauses'] else
                    'This source interval is outside the proposed selection. Review whether its context is needed.')
        cuts.append({'start': a, 'end': b, 'reason': reason_for(a,b,decision['cuts'],fallback),
                     'text': text, 'thought_ids': [t['id'] for t in thoughts
                         if t['start'] < b-.025 and t['end'] > a+.025]})
    sections = [{'start': a, 'end': b, 'text': quote(analysis, a,b),
                 'reason': reason_for(a,b,decision['segments'],'Keep this section as part of the proposed sequence.')}
                for a,b in keep]
    changed = len(keep) != len(baseline) or any(abs(a-c)>.025 or abs(b-d)>.025
                                               for (a,b),(c,d) in zip(keep,baseline))
    return {'segments': keep, 'cuts': cuts, 'sections': sections, 'thoughts': thoughts,
            'boundary_mode': mode, 'warnings': list(dict.fromkeys(warnings)),
            'estimated_duration': round(sum(b-a for a,b in keep),2),
            'removed_duration': round(sum(b-a for a,b in difference(baseline,keep)),2),
            'changed': changed}
