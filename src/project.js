// The timeline model and every operation that can change it.
// Claude (via MCP) and the human (via the UI) both go through applyOp, so the timeline has one source of truth.
import { uid, round, clamp, tc } from './util.js';
import { findPauses } from './media.js';

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
const label = (p, c) => c.kind === 'text' ? `"${c.text.content.slice(0, 28)}"` : (c.label || p.assets[c.asset]?.name || c.id);

function ensureTrack(p, t) {
  if (!/^[VTA]\d+$/.test(t)) throw new Error(`Track "${t}" is not valid. Use V1..Vn (video/images), T1..Tn (text), A1..An (audio).`);
  if (p.tracks.includes(t)) return;
  p.tracks.push(t);
  const rank = (x) => (x[0] === 'V' ? 0 : x[0] === 'T' ? 1 : 2) * 1000 + (x[0] === 'V' ? -1 : 1) * Number(x.slice(1));
  p.tracks.sort((a, b) => rank(a) - rank(b));
}
function checkKindTrack(kind, t) {
  const want = kind === 'text' ? 'T' : kind === 'audio' ? 'A' : 'V';
  if (t[0] !== want) throw new Error(`A ${kind} clip belongs on a ${want} track, not ${t}.`);
}

const CLIP_PROPS = ['start', 'in', 'out', 'track', 'speed', 'volume', 'muted', 'fit', 'scale', 'x', 'y', 'opacity', 'fadeIn', 'fadeOut', 'label'];
const TEXT_DEFAULT = { content: '', size: 0.055, color: '#ffffff', stroke: '#000000', strokeWidth: 0.14, bg: null, weight: 800, x: 0.5, y: 0.72, maxWidth: 0.84, uppercase: false, font: 'Helvetica Neue, Helvetica, Arial, sans-serif' };
const TEXT_KEYS = Object.keys(TEXT_DEFAULT);
// Everything update_clip can change. Anything else is rejected instead of silently ignored, so a "✓" always means it happened.
const UPDATE_KEYS = [...CLIP_PROPS, 'duration', 'grade', 'key', 'text', 'style'];
const OP_META = ['op', 'id', 'why', 'agent', 'ripple'];

function setProps(p, c, a) {
  for (const k of CLIP_PROPS) if (a[k] !== undefined && a[k] !== null) c[k] = a[k];
  if (a.duration != null && (c.kind === 'text' || c.kind === 'image')) { c.in = 0; c.out = Number(a.duration); }
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
const isMag = (p, c) => p.magnetic !== false && c.kind !== 'text' && (p.magneticTracks || ['V1']).includes(c.track);
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
      if ((a.text != null || a.style) && c.kind !== 'text') throw new Error(`${label(p, c)} is a ${c.kind} clip; text and style only apply to text clips. Nothing was changed.`);
      if (a.style) { const bad = Object.keys(a.style).filter((k) => !TEXT_KEYS.includes(k) || k === 'content'); if (bad.length) throw new Error(`Unknown text style ${bad.map((k) => `"${k}"`).join(', ')}. Text style keys: ${TEXT_KEYS.filter((k) => k !== 'content').join(', ')}. Nothing was changed.`); }
      if (a.duration != null && !['text', 'image'].includes(c.kind)) throw new Error(`duration applies to text and image clips; for ${c.kind} change in/out or use trim_clip. Nothing was changed.`);
      const before = { start: c.start, in: c.in, out: c.out, track: c.track, dur: dur(c) };
      const backup = JSON.stringify(c);
      try { if (a.track && a.track !== c.track) { ensureTrack(p, a.track); checkKindTrack(c.kind, a.track); } setProps(p, c, a); }
      catch (e) { Object.assign(c, JSON.parse(backup)); throw e; }
      const parts = [];
      // Ripple when the clip is on, or has just left, a magnetic track. Only magnetic tracks are repacked: moving a clip
      // from V1 to V2 must close the hole on V1 without packing the free-form V2.
      const magTrack = (t) => p.magnetic !== false && c.kind !== 'text' && (p.magneticTracks || ['V1']).includes(t);
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
      if (c.kind === 'text') {
        if (was.text.content !== c.text.content) parts.push(`text "${was.text.content.slice(0, 24)}" → "${c.text.content.slice(0, 24)}"`);
        for (const k of TEXT_KEYS) if (k !== 'content' && show(was.text[k]) !== show(c.text[k])) parts.push(`${k} ${show(was.text[k])} → ${show(c.text[k])}`);
      }
      return { text: `${label(p, c)} · ${parts.join(' · ') || 'no change'}`, clipIds: [c.id], t: c.start };
    }
    case 'replace_source': {
      // Put different footage in a clip's slot: start, duration, track and effects stay; only the source changes.
      const c = getClip(p, a.id);
      if (c.kind === 'text') throw new Error('replace_source works on footage clips, not text.');
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
      if (c.kind === 'text' || c.kind === 'image') throw new Error(`slip_clip works on video and audio clips; ${label(p, c)} is ${c.kind}. Nothing was changed.`);
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
      const c = getClip(p, a.id); if (c.kind === 'text') throw new Error(`${op} works on footage clips; use update_clip with duration for text.`);
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
    case 'set_project': {
      if (a.name) p.name = a.name;
      if (a.aspect) { const np = newProject({ aspect: a.aspect }); p.width = np.width; p.height = np.height; }
      if (a.fps) p.fps = clamp(Number(a.fps), 12, 60);
      if (a.magnetic !== undefined) { p.magnetic = !!a.magnetic; if (p.magnetic) for (const t of p.magneticTracks || ['V1']) repack(p, t); }
      return { text: `Project: ${p.name} · ${p.width}×${p.height} · ${p.fps} fps`, clipIds: [], t: null };
    }
    default:
      throw new Error(`Unknown op "${op}". Ops: add_clip, keep_ranges, replace_source, trim_clip, extend_clip, add_text, add_captions, style_text, update_clip, split_clip, delete_clip, cut_range, remove_silences, close_gaps, clear_track, add_marker, delete_marker, set_project.`);
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
  for (const a of assets) lines.push(`  ${a.id} · ${a.kind} · ${a.name}${a.duration ? ` · ${a.duration}s` : ''}${a.width ? ` · ${a.width}×${a.height}` : ''}${a.transcript ? ' · transcript ✓' : ''}${a.loudness ? ` · ${a.loudness.lufs} LUFS` : ''}`);
  for (const t of p.tracks) {
    const cs = trackClips(p, t); if (!cs.length) continue;
    lines.push(`${t}:`);
    for (const c of cs) {
      const fx = [c.speed !== 1 && `speed ${c.speed}`, c.volume !== 1 && c.volume != null && `vol ${c.volume}`, c.muted && 'muted', c.scale && c.scale !== 1 && `scale ${c.scale}`, (c.x || c.y) && `pos ${c.x},${c.y}`, c.fit === 'contain' && 'contain', c.opacity != null && c.opacity !== 1 && `opacity ${c.opacity}`, c.fadeIn && `fadeIn ${c.fadeIn}`, c.fadeOut && `fadeOut ${c.fadeOut}`, c.grade && `grade ${JSON.stringify(c.grade)}`, c.key && `key ${c.key.color}`].filter(Boolean).join(' · ');
      lines.push(c.kind === 'text'
        ? `  ${c.id} · ${round(c.start, 2)}–${round(end(c), 2)}s · "${c.text.content}"`
        : `  ${c.id} · ${round(c.start, 2)}–${round(end(c), 2)}s · ${c.asset} src ${c.in}–${c.out}${p.assets[c.asset]?.duration && c.kind !== 'image' ? ` (footage left: ${round(c.in, 1)}s before, ${round(p.assets[c.asset].duration - c.out, 1)}s after)` : ''}${c.label ? ` · ${c.label}` : ''}${fx ? ` · ${fx}` : ''}`);
    }
  }
  if (p.markers.length) lines.push('Markers: ' + p.markers.map((m) => `${m.id}@${m.t}s ${m.label}`).join(' | '));
  return lines.join('\n');
}
