"""Research-informed rendering constraints, after model direction and word alignment.

Canonical source; identical installed copy in Motion Lab V2/src. Numerical values
are Frame design defaults, not experimentally established perceptual thresholds.
This module never chooses meaning, labels, emotions, palette, or narration.
"""
import math

VERSION = 'voice-graphics-1.0'
POLICY_PROMPT = '''
Voice-to-graphics research policy: choose the important idea from the script and
creative direction before selecting a motion cue. Treat semantic importance and
motion energy separately. A quiet crucial phrase can use strong scale, isolation,
weight and a stable hold with little movement. Selective signaling is preferable
to accenting every word. Match the strongest visual cue to the selected spoken
word using actual alignment, not estimated reading order. Fast speech calls for
fewer competing animated elements, not automatically more frantic graphics.
Pauses provide space to settle and hold the existing idea; never fill every gap
with movement. Pitch, loudness and tempo are context-dependent delivery clues,
not reliable emotion, personality or color classifiers. Do not assign hue, shape
or meaning from them mechanically. Keep diagrams tied to actual message meaning.
Research supports selective visual signaling and prosodic representation; exact
easing, thresholds, palette and animation magnitudes are adjustable design choices.
Only describe the engine capabilities already specified, not arbitrary new effects.
'''


def _number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _clamp(value, low, high):
    return min(high, max(low, value))


def compile_policy(words, start, end, energy, motion, anchor_indices, importance=.7, fps=30):
    """Compile seconds-based word observations into bounded visual controls.

Words remain in original index order. Missing endpoints never become measured
silence. Anchors are supplied by the model/user adapter, never inferred by RMS.
"""
    if not all(_number(v) for v in (start, end, energy, importance, fps)) or end <= start or fps <= 0:
        raise ValueError('Visual delivery needs finite bounds, energy, importance and positive fps.')
    energy, importance = _clamp(energy, 0, 1), _clamp(importance, 0, 1)
    normalized, warnings = [], []
    previous_start = start
    for index, word in enumerate(words):
        onset, offset = word.get('start'), word.get('end')
        valid = _number(onset) and start <= onset < end and onset >= previous_start
        if valid:
            previous_start = onset
        else:
            onset = None
            warnings.append('Missing or invalid word onset at index %d; no cue inferred.' % index)
        valid_end = valid and _number(offset) and onset < offset <= end
        if not valid_end:
            offset = None
        normalized.append({'text': word.get('text', ''), 'start': onset, 'end': offset,
                           'word_index': index})
    holds = []
    def hold(a, b):
        if _number(a) and _number(b) and b-a >= .24:
            holds.append({'start': a, 'end': b})
    if normalized:
        hold(start, normalized[0]['start'])
        for left, right in zip(normalized, normalized[1:]):
            hold(left['end'], right['start'])
        hold(normalized[-1]['end'], end)
    complete = bool(normalized) and all(w['start'] is not None and w['end'] is not None for w in normalized)
    overlap = any(left['end'] is not None and right['start'] is not None
                  and left['end'] > right['start']+1e-8
                  for left, right in zip(normalized, normalized[1:]))
    if overlap:
        warnings.append('Overlapping word boundaries; silence and pace inference disabled.')
        complete = False
    if not complete:
        # An unknown/overlapping interval could occupy an apparent gap elsewhere.
        # Conservative degradation is preferable to calling speech a pause.
        holds = []
    wps = None
    if complete:
        first, last = normalized[0]['start'], normalized[-1]['end']
        silent = sum(max(0, min(last, h['end'])-max(first, h['start'])) for h in holds)
        span = last-first-silent
        if span > 0:
            wps = len(normalized)/span
    if not complete:
        warnings.append('Incomplete word boundaries; pace unavailable and unknown gaps are not silence.')
    # Per-word density, not volume or a guessed emotional label, bounds pacing.
    base_entrance = .48-.16*energy
    entrance = _clamp(base_entrance*(2.6/wps if wps else 1), .18, .60)
    slots = 3 if wps is not None and wps >= 3.5 else 5
    motion_factor = {'restrained': .45, 'settle': .45, 'flowing': .8, 'flow': .8,
                     'punchy': 1., 'punch': 1.}.get(motion, .65)
    accents = []
    for index in sorted(set(i for i in anchor_indices if isinstance(i, int) and not isinstance(i, bool))):
        if not 0 <= index < len(normalized) or normalized[index]['start'] is None:
            warnings.append('Unaligned semantic anchor skipped: %s' % index)
            continue
        word = normalized[index]
        frame = math.ceil(word['start']*fps-1e-8)
        peak = frame/fps
        if peak >= end or (word['end'] is not None and peak >= word['end']):
            warnings.append('Semantic anchor has no visible frame: %s' % index)
            continue
        accents.append({'word_index': index, 'start': word['start'],
                        'end': min(end, max(word['end'] or peak, peak+.22)),
                        'peak': peak, 'peak_frame': frame})
    return {'version': VERSION, 'source': 'aligned word boundaries plus model/user semantic anchors',
            'timing_limit': 'ASR/service boundaries are estimates; speech gaps may contain breaths or noise. No acoustic silence or pitch detector is used.',
            'start': start, 'end': end, 'fps': fps, 'words': normalized,
            'speaking_wps': round(wps, 3) if wps is not None else None,
            'entrance_seconds': round(entrance, 4),
            'motion_amplitude': round((.12+.88*energy)*motion_factor, 4),
            'motion_slots': slots, 'importance': importance, 'energy': energy,
            'accents': accents, 'holds': holds, 'settle_seconds': .12,
            'warnings': warnings,
            'evidence': ['pataca-2022', 'bosker-peeters-2021', 'mautone-mayer-2001', 'morett-2020'],
            'threshold_status': 'Tunable Frame defaults; not universal perceptual thresholds.'}


def motion_time(policy, absolute_time):
    """Monotonic decorative clock; ease to rest in aligned speech gaps, then hold."""
    t = _clamp(absolute_time, policy['start'], policy['end'])
    elapsed = t-policy['start']
    ramp = policy.get('settle_seconds', .12)
    for gap in policy.get('holds', []):
        x = _clamp(t-gap['start'], 0, gap['end']-gap['start'])
        r = min(ramp, gap['end']-gap['start'])
        advanced = x-x*x/(2*r) if x < r else r/2
        elapsed -= x-advanced
    return max(0., elapsed)


def accent_strength(policy, absolute_time):
    """Single onset apex, then a short decay; strength independent of loudness."""
    strength = 0.
    for cue in policy.get('accents', []):
        if cue['peak']-1e-8 <= absolute_time < cue['end']:
            duration = max(1/policy['fps'], cue['end']-cue['peak'])
            strength = max(strength, (1-_clamp((absolute_time-cue['peak'])/duration, 0, 1))**2)
    return strength
