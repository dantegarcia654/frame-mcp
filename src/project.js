// The timeline model and every operation that can change it.
// Claude (via MCP) and the human (via the UI) both go through applyOp, so the timeline has one source of truth.
import { validateMove, moveAt } from '../ui/clip-move.js';
import { uid, round, clamp, tc } from './util.js';
import { findPauses } from './media.js';
import { EFFECTS, effectParams } from '../ui/effects.js';

export const ASPECTS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350], '4:3': [1440, 1080] };
const EPS = 0.001;

export function newProject({ name = 'Untitled', aspect = '9:16', fps = 30 } = {}) {
  let wh = ASPECTS[aspect];
  if (!wh) { const m = String(aspect).match(/^(\d+)x(\d+)$/); if (!m) throw new Error(`Unknown aspect "${aspect}". Use 9:16, 16:9, 1:1, 4:5, 4:3 or WIDTHxHEIGHT.`); wh = [Number(m[1]), Number(m[2])]; }
  return {
    id: uid('p_'), name, width: wh[0] - (wh[0] % 2), height: wh[1] - (wh[1] % 2), fps, createdAt: Date.now(), updatedAt: Date.now(), version: 0,
    assets: {}, tracks: ['V2', 'V1', 'T1', 'A1', 'A2'], clips: [], markers: [], feed: [], steps: [], renders: [],
    status: { state: 'idle', label: 'Waiting for Claude' }, paused: false, plan: null,
  };
}

export const dur = (c) => (c.out - c.in) / (c.speed || 1);
export const end = (c) => c.start + dur(c);
export const projectDuration = (p) => p.clips.reduce((m, c) => Math.max(m, end(c)), 0);
export const trackClips = (p, t) => p.clips.filter((c) => c.track === t).sort((a, b) => a.start - b.start);
const trackEnd = (p, t) => trackClips(p, t).reduce((m, c) => Math.max(m, end(c)), 0);
const getClip = (p, id) => { const c = p.clips.find((c) => c.id === id); if (!c) throw new Error(`No clip "${id}". Current clips: ${p.clips.map((c) => c.id).join(', ') || 'none'}`); return c; };
const label = (p, c) => c.kind === 'text' ? `"${c.text.content.slice(0, 28)}"` : c.kind === 'effect' ? (c.label || `${EFFECTS[c.effect.type]?.label || c.effect.type} effect`) : (c.label || p.assets[c.asset]?.name || c.id);

function ensureTrack(p, t) {
  if (!/^[VTA]\d+$/.test(t)) throw new Error(`Track "${t}" is not valid. Use V1..Vn (video/images), T1..Tn (text), A1..An (audio).`);
  if (p.tracks.includes(t)) return;
  p.tracks.push(t);
  const rank = (x) => (x[0] === 'V' ? 0 : x[0] === 'T' ? 1 : 2) * 1000 + (x[0] === 'V' ? -1 : 1) * Number(x.slice(1));
  p.tracks.sort((a, b) => rank(a) - rank(b));
}
function checkKindTrack(kind, t) {
  const want = kind === 'text' ? 'T' : kind === 'audio' ? 'A' : 'V'; // effects are picture layers: V tracks
  if (t[0] !== want) throw new Error(`A ${kind} clip belongs on a ${want} track, not ${t}.`);
}

const CLIP_PROPS = ['start', 'in', 'out', 'track', 'speed', 'volume', 'muted', 'fit', 'scale', 'x', 'y', 'opacity', 'fadeIn', 'fadeOut', 'label'];
const TEXT_DEFAULT = { content: '', size: 0.055, color: '#ffffff', stroke: '#000000', strokeWidth: 0.14, bg: null, weight: 800, x: 0.5, y: 0.72, maxWidth: 0.84, uppercase: false, font: 'Helvetica Neue, Helvetica, Arial, sans-serif' };
const TEXT_KEYS = Object.keys(TEXT_DEFAULT);
// Everything update_clip can change. Anything else is rejected instead of silently ignored, so a "✓" always means it happened.
const UPDATE_KEYS = [...CLIP_PROPS, 'duration', 'grade', 'key', 'text', 'style', 'params', 'source', 'move'];
const OP_META = ['op', 'id', 'why', 'agent', 'ripple'];

function setProps(p, c, a) {
  for (const k of CLIP_PROPS) if (a[k] !== undefined && a[k] !== null) c[k] = a[k];
  if (a.duration != null && (c.kind === 'text' || c.kind === 'image' || c.kind === 'effect')) { c.in = 0; c.out = Number(a.duration); }
  if (c.kind === 'effect') {
    if (a.params) c.effect.params = effectParams(c.effect.type, a.params, c.effect.params);
    if (EFFECTS[c.effect.type].params.plate) { // an effect that reveals the set behind the person needs a real shot of it
      const id = c.effect.params.plate, pl = p.assets[id];
      if (!id) throw new Error(`${c.effect.type} needs params.plate: the asset id of a shot of the empty set from the same locked camera angle (film about 3 s with nobody in frame and import it). Frame never invents the background behind the person. Nothing was changed.`);
      if (!pl || !['image', 'video'].includes(pl.kind)) throw new Error(`${c.effect.type}.plate "${id}" is not an image or video asset in this project. Assets: ${Object.keys(p.assets).join(', ') || 'none'}. Nothing was changed.`);
    }
    if (a.source) c.source = a.source;
    if (!/^V\d+$/.test(c.source)) throw new Error(`An effect reads a video track (V1, V2…), not "${c.source}".`);
    if (c.source === (a.track || c.track)) throw new Error(`An effect cannot sit on the track it reads (${c.source}). Put it on a track above, e.g. V${Number(c.source.slice(1)) + 1}.`);
  }
  if (a.move !== undefined) { // keyframed position (ui/clip-move.js): footage and stills only
    if (a.move && !['video', 'image'].includes(c.kind)) throw new Error(`move applies to video and image clips, not ${c.kind}. Nothing was changed.`);
    const m = validateMove(a.move); if (m) c.move = m; else delete c.move;
  }
  if (a.grade !== undefined) c.grade = a.grade ? { ...(c.grade || {}), ...a.grade } : undefined;
  if (a.key !== undefined) c.key = a.key ? { color: '#00ff00', similarity: 0.3, blend: 0.08, ...(c.key || {}), ...a.key } : undefined;
  if (c.kind === 'text') {
    if (a.text != null) c.text.content = String(a.text);
    if (a.style) for (const k of TEXT_KEYS) if (a.style[k] !== undefined && k !== 'content') c.text[k] = a.style[k];
  }
  for (const k of ['start', 'in', 'out', 'speed', 'volume', 'scale', 'x', 'y', 'opacity', 'fadeIn', 'fadeOut']) if (c[k] != null) { c[k] = Number(c[k]); if (!Number.isFinite(c[k])) throw new Error(`"${k}" must be a number.`); }
  const asset = p.assets[c.asset];
  if (asset && c.kind !== 'image') {
    c.in = clamp(c.in, 0, asset.duration); c.out = clamp(c.out, 0, asset.duration);
  }
  c.speed = clamp(c.speed || 1, 0.25, 4);
  if (c.out - c.in < 0.03) throw new Error(`Clip ${c.id} would be shorter than one frame (in ${c.in}, out ${c.out}).`);
  c.start = Math.max(0, round(c.start)); c.in = round(c.in); c.out = round(c.out);
  ensureTrack(p, c.track); checkKindTrack(c.kind, c.track);
}

/** Magnetic timeline: clips on the base track (V1) stay packed, trims ripple, nothing leaves a hole. set_project {magnetic:false} turns it off. */
const isMag = (p, c) => p.magnetic !== false && c.kind !== 'text' && c.kind !== 'effect' && (p.magneticTracks || ['V1']).includes(c.track);
function repack(p, track) { let t = 0; for (const c of trackClips(p, track)) { c.start = round(t); t += dur(c); } }
function rippleAfter(p, c, edge, delta) {
  if (Math.abs(delta) < EPS) return;
  for (const o of p.clips) if (o !== c && o.start >= edge - EPS) o.start = Math.max(0, round(o.start + delta));
  for (const m of p.markers) if (m.t >= edge - EPS) m.t = Math.max(0, round(m.t + delta));
}

function addClip(p, a) {
  const asset = p.assets[a.asset];
  if (!asset) throw new Error(`No asset "${a.asset}". Import it first with frame_import. Assets: ${Object.keys(p.assets).join(', ') || 'none'}`);
  const track = a.track || (asset.kind === 'audio' ? 'A1' : 'V1');
  ensureTrack(p, track);
  const c = { id: uid('c_'), kind: asset.kind, asset: asset.id, track, start: 0, in: 0, out: asset.kind === 'image' ? 3 : asset.duration, speed: 1, volume: 1 };
  if (asset.kind !== 'audio') Object.assign(c, { fit: 'cover', scale: 1, x: 0, y: 0, opacity: 1 });
  const start = a.start === undefined || a.start === null || a.start === 'append' ? trackEnd(p, track) : a.start;
  setProps(p, c, { ...a, start, track });
  p.clips.push(c);
  return c;
}

function splitAt(p, c, t) {
  if (t <= c.start + EPS || t >= end(c) - EPS) return null;
  const src = round(c.in + (t - c.start) * (c.speed || 1));
  const b = JSON.parse(JSON.stringify(c));
  b.id = uid('c_'); b.start = round(t); b.in = src; delete b.fadeIn;
  if (c.move) { const d = t - c.start, at0 = moveAt(c, d); b.move = [{ t: 0, x: at0.x, y: at0.y }, ...c.move.filter((f) => f.t > d).map((f) => ({ ...f, t: round(f.t - d) }))]; } // the right half keeps moving from where it was
  c.out = src; delete c.fadeOut;
  p.clips.push(b);
  return b;
}

function cutRange(p, from, to, tracks, ripple) {
  const touched = [];
  for (const t of tracks) {
    for (const c of trackClips(p, t)) {
      if (end(c) <= from + EPS || c.start >= to - EPS) continue;
      splitAt(p, c, from);
    }
    for (const c of trackClips(p, t)) {
      if (end(c) <= from + EPS || c.start >= to - EPS) continue;
      const tail = splitAt(p, c, to);
      if (c.start >= from - EPS) { p.clips.splice(p.clips.indexOf(c), 1); touched.push(c.id); }
      if (tail) touched.push(tail.id);
    }
    if (ripple) for (const c of p.clips) if (c.track === t && c.start >= to - EPS) c.start = round(c.start - (to - from));
  }
  if (ripple) for (const m of p.markers) if (m.t >= to) m.t = round(m.t - (to - from));
  return touched;
}

// ───────────────────────── cue words: say an effect's name and the effect starts there
const norm = (w) => String(w).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
const stem = (t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
function lev(a, b) { if (Math.abs(a.length - b.length) > 1) return 2; const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }
/** Whisper spells words its own way ("Rackfocus", "clone rows"): match on stems, allowing one typo in words of 4+ letters. */
const sameWord = (a, b) => a === b || stem(a) === stem(b) || (a.length >= 4 && b.length >= 4 && lev(stem(a), stem(b)) <= 1);
/**
 * Find cue phrases in the words of a track. cues: [{say, effect, params?}]. Returns accepted matches in time order:
 * longer phrases win over shorter ones at the same place, and each effect is taken once (its first mention) unless repeat.
 */
export function findCues(words, cues, { repeat = false } = {}) {
  const toks = []; for (const w of words) for (const t of norm(w.text)) toks.push({ t, start: w.start, end: w.end });
  // Whisper sometimes glues two words into one ("rackfocus"): also try each pair of tokens joined.
  const hits = [];
  for (const cue of cues) {
    const ph = norm(cue.say); if (!ph.length) continue;
    for (let i = 0; i < toks.length; i++) {
      if (ph.every((p, k) => toks[i + k] && sameWord(toks[i + k].t, p))) hits.push({ ...cue, i, n: ph.length, start: toks[i].start, end: toks[i + ph.length - 1].end, heard: toks.slice(i, i + ph.length).map((x) => x.t).join(' ') });
      else if (ph.length === 2 && sameWord(toks[i].t, ph.join(''))) hits.push({ ...cue, i, n: 1, start: toks[i].start, end: toks[i].end, heard: toks[i].t });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.n - a.n);
  const used = new Set(), seen = new Set(), out = [];
  for (const h of hits) {
    if ([...Array(h.n).keys()].some((k) => used.has(h.i + k))) continue;
    if (!repeat && seen.has(h.effect)) continue;
    for (let k = 0; k < h.n; k++) used.add(h.i + k); seen.add(h.effect); out.push(h);
  }
  return { matches: out, tokens: toks, used };
}

/** Map transcript words through the cuts on a track, so captions follow the edit. */
export function timelineWords(p, track) {
  const words = [];
  let prev = null, run = 0;
  for (const c of trackClips(p, track)) {
    // Clips that continue the same source without a jump (a shot split in two) count as one run for phrasing.
    if (!(prev && prev.asset === c.asset && Math.abs(prev.out - c.in) < 0.02 && Math.abs(end(prev) - c.start) < 0.02)) run++;
    prev = c;
    const tr = p.assets[c.asset]?.transcript;
    if (!tr) continue;
    for (const w of tr.words) {
      const mid = (w.start + w.end) / 2;
      if (mid < c.in || mid >= c.out) continue;
      const s = c.start + (Math.max(w.start, c.in) - c.in) / c.speed, e = c.start + (Math.min(w.end, c.out) - c.in) / c.speed;
      words.push({ text: w.text, start: round(s, 2), end: round(Math.max(e, s + 0.05), 2), clip: run });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

function groupWords(words, { max_words = 3, max_chars = 18, max_gap = 0.5 } = {}) {
  const out = []; let cur = null;
  for (const w of words) {
    const len = cur ? cur.text.length + 1 + w.text.length : 0;
    if (!cur || cur.n >= max_words || len > max_chars || w.start - cur.end > max_gap || w.clip !== cur.clip || /[.!?,;:]$/.test(cur.text)) {
      cur = { text: w.text, start: w.start, end: w.end, n: 1, clip: w.clip }; out.push(cur);
    } else { cur.text += ' ' + w.text; cur.end = w.end; cur.n++; }
  }
  // Hold each caption until the next one starts when the gap is tiny, so captions don't flicker.
  out.forEach((ph, i) => { const nx = out[i + 1]; if (nx && nx.start - ph.end < 0.25) ph.end = nx.start; });
  return out;
}

/**
 * Apply one operation. Returns { text, clipIds, t } describing what actually changed.
 * ctx.loadEnv(assetId) returns the measured audio envelope for an asset.
 */
export function applyOp(p, a, ctx = {}) {
  const op = a.op;
  switch (op) {
    case 'add_clip': {
      const c = addClip(p, a);
      return { text: `Placed ${label(p, c)} on ${c.track} at ${tc(c.start)} · source ${tc(c.in)}–${tc(c.out)} (${round(dur(c), 2)}s)`, clipIds: [c.id], t: c.start };
    }
    case 'keep_ranges': {
      if (!Array.isArray(a.ranges) || !a.ranges.length) throw new Error('keep_ranges needs ranges: [{in, out, label?}]');
      const ids = []; let first = null;
      for (const r of a.ranges) { const c = addClip(p, { asset: a.asset, track: a.track, in: r.in, out: r.out, label: r.label, start: 'append' }); ids.push(c.id); first ??= c.start; }
      const total = a.ranges.reduce((s, r) => s + (r.out - r.in), 0);
      return { text: `Kept ${a.ranges.length} range${a.ranges.length > 1 ? 's' : ''} of ${p.assets[a.asset].name} (${round(total, 1)}s) on ${a.track || 'V1'}`, clipIds: ids, t: first };
    }
    case 'add_text': {
      if (!a.text) throw new Error('add_text needs text.');
      const track = a.track || 'T1'; ensureTrack(p, track);
      const c = { id: uid('c_'), kind: 'text', track, start: 0, in: 0, out: 2, speed: 1, opacity: 1, text: { ...TEXT_DEFAULT } };
      setProps(p, c, { duration: 2, ...a, start: a.start ?? trackEnd(p, track), track });
      p.clips.push(c);
      return { text: `Text ${label(p, c)} on ${c.track} at ${tc(c.start)} for ${round(dur(c), 2)}s`, clipIds: [c.id], t: c.start };
    }
    case 'patch_graphic': {
      const c = getClip(p, a.id);
      if (c.effect?.type !== 'live_graphic') throw new Error('Select a live graphic layer first.');
      if (!a.patch || typeof a.patch !== 'object' || Array.isArray(a.patch)) throw new Error('patch must be an object.');
      if (Object.keys(a.patch).some(k => ['id','kind'].includes(k))) throw new Error('Node identity and kind cannot be patched.');
      const nodes = c.effect.params.nodes.map(n => n.id === a.node_id ? { ...n, ...a.patch } : n);
      if (!nodes.some(n => n.id === a.node_id)) throw new Error(`No graphic node "${a.node_id}".`);
      c.effect.params = effectParams('live_graphic', { nodes }, c.effect.params);
      return { text: `Revised graphic ${a.node_id}: ${Object.keys(a.patch).join(', ')} (live; no encoding)`, clipIds: [c.id], t: Math.max(c.start, c.start + (nodes.find(n=>n.id===a.node_id).at || 0)) };
    }
    case 'add_effect': {
      const type = a.effect || a.type;
      if (!EFFECTS[type] || EFFECTS[type].hidden) throw new Error(`add_effect needs effect: one of ${Object.keys(EFFECTS).join(', ')}. frame_effects lists what each does and its settings.`);
      if (a.start == null) throw new Error('add_effect needs start (timeline seconds).');
      const fps = p.fps || 30, snap = (t) => Math.round(Number(t) * fps) / fps; // effects sit on whole frames, so every frame of the effect lines up with a frame of the footage
      const track = a.track || 'V2'; ensureTrack(p, track);
      const c = { id: uid('c_'), kind: 'effect', track, start: 0, in: 0, out: 1.5, speed: 1, opacity: 1, source: a.source || 'V1', effect: { type, params: effectParams(type, a.params) } };
      setProps(p, c, { ...a, start: snap(a.start), duration: Math.max(1 / fps, snap(a.duration ?? 1.5)), track, params: undefined, source: undefined });
      p.clips.push(c);
      const needs = EFFECTS[type].needs === 'cutout' ? ' · needs a cutout of the footage under it' : '';
      return { text: `Effect ${label(p, c)} on ${c.track} at ${tc(c.start)} for ${round(dur(c), 2)}s, reading ${c.source}${needs}`, clipIds: [c.id], t: c.start };
    }
    case 'add_effects_at_words': {
      // The recipe for an effects reel: the person names each effect as it happens; each name starts that effect.
      const src = a.source_track || a.source || 'V1', words = timelineWords(p, src);
      if (!words.length) throw new Error(`No transcript on the clips of ${src}. Run frame_transcribe on the footage first (it starts by itself at import).`);
      const only = a.only ? new Set(a.only) : null;
      for (const id of only || []) if (!EFFECTS[id]) throw new Error(`No effect "${id}". Effects: ${Object.keys(EFFECTS).join(', ')}.`);
      const cues = a.cues || Object.entries(EFFECTS).filter(([id]) => !only || only.has(id)).flatMap(([id, fx]) => (fx.say || []).map((say) => ({ say, effect: id })));
      const { matches, tokens, used } = findCues(words, cues, { repeat: a.repeat });
      // Stop words (e.g. the first word of the call to action) end the effect before them, unless they are part of a cue.
      const stops = (a.stop || []).flatMap((w) => norm(w)).filter(Boolean);
      const stopTimes = tokens.filter((x, i) => !used.has(i) && stops.some((s) => sameWord(x.t, s))).map((x) => x.start);
      const fps = p.fps || 30, max = Number(a.max ?? 3), min = Number(a.min ?? 0.6), lead = Number(a.lead ?? 0), trackEndT = trackEnd(p, src);
      const placed = [], failed = [], ids = [];
      matches.forEach((m, k) => {
        const start = Math.max(0, m.start - lead), next = Math.min(matches[k + 1]?.start ?? trackEndT, ...stopTimes.filter((t) => t > m.start + 0.05));
        const duration = Math.max(min, Math.min(max, next - start, trackEndT - start));
        try {
          const r = applyOp(p, { op: 'add_effect', effect: m.effect, start, duration, track: a.track, source: src, params: { ...(a.params?.[m.effect] || {}), ...(m.params || {}) } }, ctx);
          ids.push(...r.clipIds); placed.push(`${m.effect} at ${tc(start)} for ${round(duration, 2)}s (heard "${m.heard}")`);
        } catch (e) { failed.push(`${m.effect} (heard "${m.heard}" at ${tc(m.start)}): ${e.message}`); }
      });
      const missing = [...new Set(cues.map((c) => c.effect))].filter((e) => !matches.some((m) => m.effect === e));
      return { text: `Effects from the words on ${src}: placed ${placed.length}${placed.length ? ' — ' + placed.join('; ') : ''}${failed.length ? `. NOT placed: ${failed.join('; ')}` : ''}${missing.length ? `. Not said (no cue heard): ${missing.join(', ')}` : ''}`, clipIds: ids, t: matches[0]?.start ?? null };
    }
    case 'add_agent_swarm': {
      // The agents that made the edit, drawn over the video. Who placed which effect comes from the edit history (the
      // feed: every op records its agent and the clips it made), so each tag on screen stands for a real edit.
      const src = a.source_track || a.source || 'V1', track = a.track || 'V3';
      // The op that created each clip (its first entry in the feed) and any later edits to it.
      const by = new Map(), entry = new Map(), later = new Map();
      for (const e of p.feed || []) if (e.kind === 'op') for (const id of e.clipIds || []) {
        if (!entry.has(id)) { entry.set(id, e); if (e.agent) by.set(id, String(e.agent)); } else (later.get(id) || later.set(id, []).get(id)).push(e);
      }
      const fxClips = p.clips.filter((c) => c.kind === 'effect' && c.effect?.type !== 'agent_swarm' && (c.source || 'V1') === src).sort((x, y) => x.start - y.start);
      if (!fxClips.length) throw new Error(`No effect clips read ${src}, so there are no agents to show. Place effects first (add_effects_at_words or add_effect), giving each op an agent label.`);
      const endT = trackEnd(p, src); if (!(endT > 0)) throw new Error(`${src} is empty.`);
      p.clips = p.clips.filter((c) => !(c.kind === 'effect' && c.effect?.type === 'agent_swarm')); // one swarm, rebuilt from the current edit
      // Each agent's log: the steps Frame actually recorded for the clip it made, in the order they happened.
      const fps = p.fps || 30, two = (n) => String(n).padStart(2, '0');
      const clock = (ms) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0').slice(0, 2)}`; };
      const jobs = fxClips.map((c) => {
        const e = entry.get(c.id), fx = EFFECTS[c.effect.type], log = [];
        const heard = e?.text?.match(new RegExp(`${c.effect.type} at \\S+ for [\\d.]+s \\(heard "([^"]+)"\\)`))?.[1];
        if (heard) log.push({ k: 'heard', s: `heard "${heard}"` });
        log.push({ k: 'placed', s: `placed ${c.effect.type} ${round(dur(c), 2)}s` });
        if (fx.needs === 'cutout' || fx.uses === 'cutout') {
          const v1 = p.clips.find((x) => x.track === src && x.kind !== 'effect' && x.start <= c.start + 1e-6 && end(x) > c.start), cut = v1 && p.assets[v1.asset]?.cutout;
          if (cut) log.push({ k: fx.matte === false ? 'face' : 'matte', s: `reads ${cut.engine === 'vision' ? 'Apple Vision' : cut.engine} ${fx.matte === false ? 'face box' : 'cutout'}` });
        }
        log.push({ k: 'frames', s: `${Math.round(dur(c) * fps)} frames` });
        for (const x of later.get(c.id) || []) if (x.op === 'update_clip') { const what = String(x.text || '').split(' · ').slice(1).join(' · ').replace(/\s*\[.*$/, ''); if (what) log.push({ k: 'edit', s: `edited ${what}`.slice(0, 40) }); }
        return { agent: by.get(c.id) || 'Claude', effect: c.effect.type, start: round(c.start, 3), end: round(end(c), 3), params: c.effect.params, op: e?.op || '', clock: e?.ts ? clock(e.ts) : '', log };
      });
      const r = applyOp(p, { op: 'add_effect', effect: 'agent_swarm', start: 0, duration: endT, track, source: src, params: { ...(a.params || {}), jobs } }, ctx);
      const unnamed = fxClips.filter((c) => !by.has(c.id)).length, names = [...new Set(jobs.map((j) => j.agent))];
      return { text: `Agent swarm on ${track} for ${round(endT, 2)}s: ${names.length} agent(s) from the edit history — ${jobs.map((j) => `${j.agent} → ${j.effect} at ${tc(j.start)}`).join('; ')}${unnamed ? `. ${unnamed} effect(s) had no agent in the history and show as "Claude"` : ''}. Rebuild it with add_agent_swarm after changing the effects.`, clipIds: r.clipIds, t: 0 };
    }
    case 'add_captions': {
      const track = a.track || 'T1'; ensureTrack(p, track);
      let phrases = a.phrases;
      if (!phrases) {
        const src = a.source_track || 'V1';
        const words = timelineWords(p, src);
        if (!words.length) throw new Error(`No transcript on the clips of ${src}. Run frame_transcribe on the asset first, or pass phrases: [{text,start,end}].`);
        phrases = groupWords(words, a);
      }
      if (a.replace !== false) p.clips = p.clips.filter((c) => !(c.track === track && c.caption));
      const ids = [];
      for (const ph of phrases) {
        const c = { id: uid('c_'), kind: 'text', track, start: 0, in: 0, out: 1, speed: 1, opacity: 1, caption: true, text: { ...TEXT_DEFAULT } };
        setProps(p, c, { text: ph.text, style: a.style, start: ph.start, duration: Math.max(0.12, ph.end - ph.start), track });
        p.clips.push(c); ids.push(c.id);
      }
      return { text: `Captions: ${ids.length} phrases on ${track}, timed to the words that survived the cut`, clipIds: ids, t: phrases[0]?.start };
    }
    case 'update_clip': {
      const c = getClip(p, a.id);
      const unknown = Object.keys(a).filter((k) => !UPDATE_KEYS.includes(k) && !OP_META.includes(k));
      if (unknown.length) throw new Error(`update_clip does not change ${unknown.map((k) => `"${k}"`).join(', ')}${unknown.includes('asset') ? ' — to put different footage in this slot use replace_source {id, asset, in}' : ''}. It changes: ${UPDATE_KEYS.join(', ')}. Nothing was changed.`);
      if ((a.params || a.source) && c.kind !== 'effect') throw new Error(`${label(p, c)} is a ${c.kind} clip; params and source only apply to effect clips. Nothing was changed.`);
      if ((a.text != null || a.style) && c.kind !== 'text') throw new Error(`${label(p, c)} is a ${c.kind} clip; text and style only apply to text clips. Nothing was changed.`);
      if (a.style) { const bad = Object.keys(a.style).filter((k) => !TEXT_KEYS.includes(k) || k === 'content'); if (bad.length) throw new Error(`Unknown text style ${bad.map((k) => `"${k}"`).join(', ')}. Text style keys: ${TEXT_KEYS.filter((k) => k !== 'content').join(', ')}. Nothing was changed.`); }
      if (a.duration != null && !['text', 'image', 'effect'].includes(c.kind)) throw new Error(`duration applies to text, image and effect clips; for ${c.kind} change in/out or use trim_clip. Nothing was changed.`);
      const before = { start: c.start, in: c.in, out: c.out, track: c.track, dur: dur(c) };
      const backup = JSON.stringify(c);
      try { if (a.track && a.track !== c.track) { ensureTrack(p, a.track); checkKindTrack(c.kind, a.track); } setProps(p, c, a); }
      catch (e) { Object.assign(c, JSON.parse(backup)); throw e; }
      const parts = [];
      // Ripple when the clip is on, or has just left, a magnetic track. Only magnetic tracks are repacked: moving a clip
      // from V1 to V2 must close the hole on V1 without packing the free-form V2.
      const magTrack = (t) => p.magnetic !== false && c.kind !== 'text' && c.kind !== 'effect' && (p.magneticTracks || ['V1']).includes(t);
      if (a.ripple !== false && (magTrack(c.track) || magTrack(before.track))) {
        const delta = round(dur(c) - before.dur);
        if (c.track === before.track && Math.abs(delta) >= EPS) { // trim / extend / speed change: the left edge stays, everything after follows
          c.start = before.start; rippleAfter(p, c, before.start + before.dur, delta);
          parts.push(`rippled ${delta > 0 ? '+' : ''}${delta}s`);
        } else if (c.start !== before.start || c.track !== before.track) { // moved: it drops where it was released, the rest close up
          if (magTrack(c.track)) repack(p, c.track);
          if (before.track !== c.track && magTrack(before.track)) { repack(p, before.track); parts.push(`closed the gap on ${before.track}`); }
          else parts.push('rippled into place');
        }
      }
      if (c.track !== before.track) parts.push(`moved to ${c.track}`);
      if (c.start !== before.start) parts.push(`start ${tc(before.start)} → ${tc(c.start)}`);
      if (c.in !== before.in) parts.push(`in ${tc(before.in)} → ${tc(c.in)}`);
      if (c.out !== before.out) parts.push(`out ${tc(before.out)} → ${tc(c.out)}`);
      // Read back what is now stored and report the differences — never echo the request.
      const was = JSON.parse(backup), show = (v) => (v === undefined || v === null ? 'none' : typeof v === 'object' ? JSON.stringify(v) : String(v));
      for (const k of ['speed', 'volume', 'muted', 'fit', 'scale', 'x', 'y', 'opacity', 'fadeIn', 'fadeOut', 'label']) if (show(was[k]) !== show(c[k])) parts.push(`${k} ${show(was[k])} → ${show(c[k])}`);
      if (show(was.grade) !== show(c.grade)) parts.push(c.grade ? `grade ${Object.entries(c.grade).map(([k, v]) => `${k} ${v}`).join(', ')}` : 'grade removed');
      if (show(was.key) !== show(c.key)) parts.push(c.key ? `keyed out ${c.key.color} (similarity ${c.key.similarity}, blend ${c.key.blend})` : 'key removed');
      if (c.kind === 'effect') {
        for (const k of Object.keys(c.effect.params)) if (show(was.effect.params[k]) !== show(c.effect.params[k])) parts.push(`${k} ${show(was.effect.params[k])} → ${show(c.effect.params[k])}`);
        if (was.source !== c.source) parts.push(`reads ${was.source} → ${c.source}`);
      }
      if (c.kind === 'text') {
        if (was.text.content !== c.text.content) parts.push(`text "${was.text.content.slice(0, 24)}" → "${c.text.content.slice(0, 24)}"`);
        for (const k of TEXT_KEYS) if (k !== 'content' && show(was.text[k]) !== show(c.text[k])) parts.push(`${k} ${show(was.text[k])} → ${show(c.text[k])}`);
      }
      return { text: `${label(p, c)} · ${parts.join(' · ') || 'no change'}`, clipIds: [c.id], t: c.start };
    }
    case 'replace_source': {
      // Put different footage in a clip's slot: start, duration, track and effects stay; only the source changes.
      const c = getClip(p, a.id);
      if (c.kind === 'text' || c.kind === 'effect') throw new Error(`replace_source works on footage clips, not ${c.kind}.`);
      const asset = p.assets[a.asset]; if (!asset) throw new Error(`No asset "${a.asset}". Assets: ${Object.keys(p.assets).join(', ') || 'none'}`);
      const kindOk = c.kind === 'audio' ? asset.kind === 'audio' || asset.hasAudio : ['video', 'image'].includes(asset.kind);
      if (!kindOk) throw new Error(`${asset.name} is ${asset.kind}; a ${c.kind} clip needs ${c.kind === 'audio' ? 'audio' : 'video or an image'}. Nothing was changed.`);
      const was = { asset: c.asset, in: c.in, out: c.out, kind: c.kind }, d = dur(c), sp = c.speed || 1;
      const newKind = c.kind === 'audio' ? 'audio' : asset.kind;
      let srcIn = newKind === 'image' ? 0 : Number(a.in ?? 0), srcOut = newKind === 'image' ? d : (a.out != null ? Number(a.out) : srcIn + d * sp);
      if (!Number.isFinite(srcIn) || !Number.isFinite(srcOut)) throw new Error('in and out must be numbers.');
      if (a.out != null && newKind !== 'image' && Math.abs((srcOut - srcIn) / sp - d) > 1 / p.fps) throw new Error(`in ${srcIn}–out ${srcOut} is ${round((srcOut - srcIn) / sp, 3)}s at speed ${sp}, but the slot is ${round(d, 3)}s. replace_source keeps the slot length; give only in, or change the length with trim_clip/update_clip. Nothing was changed.`);
      if (newKind !== 'image' && (srcIn < 0 || srcOut > asset.duration + EPS)) throw new Error(`${asset.name} is ${asset.duration}s; the slot needs ${round(d * sp, 3)}s of source from ${srcIn}s, ending at ${round(srcOut, 3)}s. Pick in ≤ ${round(Math.max(0, asset.duration - d * sp), 3)}. Nothing was changed.`);
      c.asset = asset.id; c.kind = newKind; c.in = round(srcIn); c.out = round(srcOut);
      if (newKind === 'image') { c.speed = 1; }
      if (a.label !== undefined) c.label = a.label;
      return { text: `${label(p, c)} · source ${was.asset} ${tc(was.in)}–${tc(was.out)} → ${c.asset} ${tc(c.in)}–${tc(c.out)} · start ${tc(c.start)} and length ${round(d, 3)}s unchanged`, clipIds: [c.id], t: c.start };
    }
    case 'slip_clip': {
      // Slip: the clip keeps its place and its length on the timeline; a different moment of the recording plays inside it.
      const c = getClip(p, a.id);
      if (c.kind === 'text' || c.kind === 'image' || c.kind === 'effect') throw new Error(`slip_clip works on video and audio clips; ${label(p, c)} is ${c.kind}. Nothing was changed.`);
      if (a.by == null && a.in == null) throw new Error('slip_clip needs by (source seconds; + plays a later moment) or in (the new source in-point).');
      const asset = p.assets[c.asset], len = round(c.out - c.in), want = a.in != null ? Number(a.in) : c.in + Number(a.by);
      if (!Number.isFinite(want)) throw new Error('by and in must be numbers.');
      const to = round(clamp(want, 0, Math.max(0, asset.duration - len)));
      if (Math.abs(to - c.in) < EPS) return { text: `${label(p, c)} — no more footage ${want < c.in ? 'before' : 'after'} this range (source ${tc(c.in)}–${tc(c.out)} of ${tc(asset.duration)}), nothing changed`, clipIds: [c.id], t: c.start };
      const was = { in: c.in, out: c.out }; c.in = to; c.out = round(to + len);
      const stopped = Math.abs(to - want) >= EPS ? ` (stopped at the ${want < to ? 'start' : 'end'} of the footage)` : '';
      return { text: `${label(p, c)} · slipped ${to - was.in > 0 ? '+' : ''}${round(to - was.in)}s${stopped} · source ${tc(was.in)}–${tc(was.out)} → ${tc(c.in)}–${tc(c.out)} · start ${tc(c.start)} and length ${round(dur(c), 3)}s unchanged`, clipIds: [c.id], t: c.start };
    }
    case 'trim_clip': case 'extend_clip': {
      const c = getClip(p, a.id); if (c.kind === 'text' || c.kind === 'effect') throw new Error(`${op} works on footage clips; use update_clip with duration for ${c.kind} clips.`);
      const asset = p.assets[c.asset], edge = a.edge || 'end';
      if (!['start', 'end'].includes(edge)) throw new Error('edge must be "start" or "end".');
      const sp = c.speed || 1, ext = op === 'extend_clip';
      const room = edge === 'end' ? (asset.kind === 'image' ? Infinity : asset.duration - c.out) : c.in; // source seconds still available
      if (a.by == null && !(ext && (a.all || a.to_end))) throw new Error(`${op} needs by: seconds${ext ? ' (or all: true to take every second of footage that is left)' : ''}.`);
      let src = ext ? (a.by == null ? room : Math.min(room, Number(a.by) * sp)) : Math.min(Number(a.by) * sp, (c.out - c.in) - 0.1);
      if (src < 0.01) return { text: `${label(p, c)} — no more source footage ${edge === 'end' ? 'after' : 'before'} this clip (${edge === 'end' ? `out ${tc(c.out)} of ${tc(asset.duration)}` : `in ${tc(c.in)}`}), nothing changed`, clipIds: [c.id], t: c.start };
      const props = { id: c.id };
      if (edge === 'end') props.out = round(c.out + (ext ? src : -src)); else props.in = round(c.in + (ext ? -src : src));
      const r = applyOp(p, { op: 'update_clip', ...props, ripple: a.ripple }, ctx);
      return { text: `${ext ? 'Extended' : 'Trimmed'} ${edge} of ${label(p, c)} by ${round(src / sp, 2)}s using ${ext ? 'the rest of the source footage' : 'the clip itself'} · ${r.text.split(' · ').slice(1).join(' · ')}`, clipIds: [c.id], t: c.start };
    }
    case 'split_clip': {
      const c = getClip(p, a.id);
      const b = splitAt(p, c, Number(a.at));
      if (!b) throw new Error(`Split point ${a.at}s is not inside clip ${c.id} (${c.start}–${round(end(c))}s on the timeline).`);
      return { text: `Split ${label(p, c)} at ${tc(a.at)}`, clipIds: [c.id, b.id], t: Number(a.at) };
    }
    case 'delete_clip': {
      const ids = a.ids || [a.id]; const names = []; let closed = false;
      for (const id of ids) {
        const c = getClip(p, id); names.push(label(p, c));
        p.clips.splice(p.clips.indexOf(c), 1);
        const rip = a.ripple ?? (isMag(p, c) ? true : false);
        if (rip) { closed = true; const tracks = rip === 'track' ? [c.track] : p.tracks; const d = dur(c); for (const o of p.clips) if (tracks.includes(o.track) && o.start >= c.start + d - EPS) o.start = round(o.start - d); }
      }
      return { text: `Removed ${names.join(', ')}${closed ? ' and closed the gap' : ''}`, clipIds: [], t: null };
    }
    case 'cut_range': {
      const from = Number(a.from), to = Number(a.to);
      if (!(to > from)) throw new Error('cut_range needs from < to (timeline seconds).');
      const tracks = a.tracks || (a.track ? [a.track] : p.tracks);
      const ids = cutRange(p, from, to, tracks, a.ripple !== false);
      return { text: `Cut ${tc(from)}–${tc(to)} (${round(to - from, 2)}s)${a.ripple !== false ? ', gap closed' : ''}`, clipIds: ids.filter((id) => p.clips.some((c) => c.id === id)), t: from };
    }
    case 'remove_silences': {
      // style sets sensible defaults so a caller only has to say how tight it wants the edit.
      const STYLES = { natural: { min: 0.6, keep: 0.28 }, tight: { min: 0.4, keep: 0.16 }, aggressive: { min: 0.25, keep: 0.1 } };
      const st = STYLES[a.style || 'tight'];
      if (!st) throw new Error(`style must be one of ${Object.keys(STYLES).join(', ')}.`);
      const track = a.track || 'V1', minS = Number(a.min_silence ?? st.min);
      const keep = Number(a.keep ?? (a.pad != null ? a.pad * 2 : st.keep)); // air left in total at each cut
      const before = keep * 0.55, after = keep * 0.45; // a little more tail after a word than lead-in before the next
      const ranges = [], skipped = [], info = [];
      for (const c of trackClips(p, track)) {
        const env = ctx.loadEnv?.(c.asset); if (!env) { skipped.push(label(p, c)); continue; }
        const r = findPauses(env, { threshold_db: a.threshold_db, min_silence: minS, from: c.in, to: c.out });
        info.push(`${label(p, c)}: noise floor ${r.floor_db} dB, speech ${r.speech_db} dB, threshold ${r.threshold_db} dB`);
        for (const s of r.pauses) {
          // At the very head/tail of a clip there is no word on that side to protect, so no air is kept there.
          const si = s.start <= c.in + 0.05 ? c.in : s.start + before, so = s.end >= c.out - 0.05 ? c.out : s.end - after;
          const a0 = Math.max(si, c.in), b0 = Math.min(so, c.out);
          if (b0 - a0 < 0.1) continue;
          ranges.push([c.start + (a0 - c.in) / c.speed, c.start + (b0 - c.in) / c.speed]);
        }
      }
      const note = `${skipped.length ? ` (no audio measurement for ${skipped.join(', ')} — skipped)` : ''}`;
      if (!ranges.length) return { text: `No pauses ≥ ${minS}s found on ${track}${info.length ? ` — ${info.join('; ')}` : ''}${note}`, clipIds: [], t: null };
      ranges.sort((x, y) => y[0] - x[0]);
      const total = ranges.reduce((n, [f, t]) => n + (t - f), 0);
      if (a.dry_run) return { text: `DRY RUN — would remove ${ranges.length} pauses (${round(total, 2)}s) on ${track}: ${ranges.slice().reverse().slice(0, 30).map(([f, t]) => `${round(f, 2)}–${round(t, 2)}`).join(', ')}${ranges.length > 30 ? ' …' : ''}. ${info.join('; ')}. Nothing changed.`, clipIds: [], t: null };
      for (const [f, t] of ranges) cutRange(p, f, t, p.tracks, true);
      return { text: `Cut ${ranges.length} pauses on ${track} (${round(total, 2)}s removed, ${a.style || 'tight'}: pauses ≥ ${minS}s, ${round(keep, 2)}s of air kept). ${info.join('; ')}${note}`, clipIds: trackClips(p, track).map((c) => c.id), t: 0, cuts: ranges.length };
    }
    case 'style_text': {
      const track = a.track || 'T1';
      const cs = trackClips(p, track).filter((c) => c.kind === 'text' && (a.captions_only === false || c.caption || a.all));
      if (!cs.length) throw new Error(`No caption clips on ${track}. Pass all: true to restyle every text clip on the track.`);
      for (const c of cs) setProps(p, c, { style: a.style });
      return { text: `Restyled ${cs.length} captions on ${track}: ${Object.entries(a.style || {}).map(([k, v]) => `${k} ${v}`).join(', ')}`, clipIds: cs.map((c) => c.id), t: cs[0].start };
    }
    case 'close_gaps': {
      const track = a.track || 'V1'; let t = 0;
      for (const c of trackClips(p, track)) { c.start = round(t); t += dur(c); }
      return { text: `Closed gaps on ${track}`, clipIds: trackClips(p, track).map((c) => c.id), t: 0 };
    }
    case 'clear_track': {
      const n = p.clips.filter((c) => c.track === a.track).length;
      p.clips = p.clips.filter((c) => c.track !== a.track);
      return { text: `Cleared ${n} clips from ${a.track}`, clipIds: [], t: null };
    }
    case 'add_marker': {
      const m = { id: uid('m_'), t: round(Number(a.t)), label: a.label || '' };
      p.markers.push(m);
      return { text: `Marker at ${tc(m.t)}${m.label ? ` — ${m.label}` : ''}`, clipIds: [], t: m.t };
    }
    case 'delete_marker': {
      p.markers = p.markers.filter((m) => m.id !== a.id);
      return { text: 'Marker removed', clipIds: [], t: null };
    }
    case 'name_track': {
      if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > 64) throw new Error('Track name must be 1–64 characters.');
      ensureTrack(p, a.track); p.trackLabels ||= {}; p.trackLabels[a.track] = a.name.trim();
      return { text: `${a.track}: ${p.trackLabels[a.track]}`, clipIds: [], t: null };
    }
    case 'set_project': {
      if (a.name) p.name = a.name;
      if (a.aspect) { const np = newProject({ aspect: a.aspect }); p.width = np.width; p.height = np.height; }
      if (a.fps) p.fps = clamp(Number(a.fps), 12, 60);
      if (a.magnetic !== undefined) { p.magnetic = !!a.magnetic; if (p.magnetic) for (const t of p.magneticTracks || ['V1']) repack(p, t); }
      return { text: `Project: ${p.name} · ${p.width}×${p.height} · ${p.fps} fps`, clipIds: [], t: null };
    }
    default:
      throw new Error(`Unknown op "${op}". Ops: add_clip, keep_ranges, replace_source, trim_clip, extend_clip, add_text, add_effect, add_effects_at_words, add_agent_swarm, add_captions, style_text, update_clip, split_clip, delete_clip, cut_range, remove_silences, close_gaps, clear_track, add_marker, delete_marker, set_project.`);
  }
}

/** Gaps and overlaps on the magnetic tracks, where clips should butt end to end. Reported after every edit batch. */
export function timelineIssues(p) {
  const out = [], tol = 0.005;
  for (const t of p.magneticTracks || ['V1']) {
    const cs = trackClips(p, t); if (!cs.length) continue;
    if (cs[0].start > tol) out.push(`${t}: ${round(cs[0].start, 3)}s of black before the first clip`);
    for (let i = 1; i < cs.length; i++) {
      const g = round(cs[i].start - end(cs[i - 1]), 3);
      if (g > tol) out.push(`${t}: ${g}s gap at ${tc(end(cs[i - 1]))} between ${label(p, cs[i - 1])} and ${label(p, cs[i])}`);
      else if (g < -tol) out.push(`${t}: ${-g}s overlap at ${tc(cs[i].start)} between ${label(p, cs[i - 1])} and ${label(p, cs[i])}`);
    }
  }
  return out;
}

/** Compact timeline description for Claude. */
export function describe(p) {
  const lines = [`Project "${p.name}" (${p.id}) · ${p.width}×${p.height} @ ${p.fps} fps · duration ${round(projectDuration(p), 2)}s · version ${p.version}`];
  const assets = Object.values(p.assets);
  lines.push(assets.length ? 'Assets:' : 'Assets: none yet');
  for (const a of assets) lines.push(`  ${a.id} · ${a.kind} · ${a.name}${a.duration ? ` · ${a.duration}s` : ''}${a.width ? ` · ${a.width}×${a.height}` : ''}${a.transcript ? ' · transcript ✓' : ''}${a.cutout ? ` · cutout ✓ (source ${a.cutout.from}–${a.cutout.to}s)` : ''}${a.loudness ? ` · ${a.loudness.lufs} LUFS` : ''}`);
  for (const t of p.tracks) {
    const cs = trackClips(p, t); if (!cs.length) continue;
    lines.push(`${t}:`);
    for (const c of cs) {
      const fx = [c.speed !== 1 && `speed ${c.speed}`, c.volume !== 1 && c.volume != null && `vol ${c.volume}`, c.muted && 'muted', c.scale && c.scale !== 1 && `scale ${c.scale}`, (c.x || c.y) && `pos ${c.x},${c.y}`, c.fit === 'contain' && 'contain', c.opacity != null && c.opacity !== 1 && `opacity ${c.opacity}`, c.fadeIn && `fadeIn ${c.fadeIn}`, c.fadeOut && `fadeOut ${c.fadeOut}`, c.grade && `grade ${JSON.stringify(c.grade)}`, c.key && `key ${c.key.color}`].filter(Boolean).join(' · ');
      if (c.kind === 'effect') { lines.push(`  ${c.id} · ${round(c.start, 2)}–${round(end(c), 2)}s · effect ${c.effect.type} reading ${c.source} · ${JSON.stringify(c.effect.params)}${c.opacity != null && c.opacity !== 1 ? ` · opacity ${c.opacity}` : ''}${c.fadeIn ? ` · fadeIn ${c.fadeIn}` : ''}${c.fadeOut ? ` · fadeOut ${c.fadeOut}` : ''}`); continue; }
      lines.push(c.kind === 'text'
        ? `  ${c.id} · ${round(c.start, 2)}–${round(end(c), 2)}s · "${c.text.content}"`
        : `  ${c.id} · ${round(c.start, 2)}–${round(end(c), 2)}s · ${c.asset} src ${c.in}–${c.out}${p.assets[c.asset]?.duration && c.kind !== 'image' ? ` (footage left: ${round(c.in, 1)}s before, ${round(p.assets[c.asset].duration - c.out, 1)}s after)` : ''}${c.label ? ` · ${c.label}` : ''}${fx ? ` · ${fx}` : ''}`);
    }
  }
  if (p.markers.length) lines.push('Markers: ' + p.markers.map((m) => `${m.id}@${m.t}s ${m.label}`).join(' | '));
  return lines.join('\n');
}
