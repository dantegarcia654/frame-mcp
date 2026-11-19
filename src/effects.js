// Draws effect clips for frame_view and the render.
// 1. ffmpeg extracts the picture under the effect (its source track, placed and graded exactly as in the edit) and, for
//    effects that need it, the same picture's person cutout — through the same graph builder the render uses.
// 2. Headless Chrome opens the service's own /fx-render.html, which runs ui/effects.js — the file the window previews
//    with — on every frame and posts each drawn frame back. Same code, same pixels.
// Frames are cached under a key of everything that affects them (source clips, cutout, settings, the effect code), so a
// change can never ship an old frame, and an unchanged effect is never drawn twice.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EFFECTS, trackAt, placeRect, mapBox, effectTime } from '../ui/effects.js';
import { buildGraph, fxFrames, fxFile } from './render.js';
import { end } from './project.js';
import { findChrome } from './text.js';
import { BASE, mkdirp, uid, round, run } from './util.js';

const EFFECTS_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'effects.js');
const sha = (x) => crypto.createHash('sha1').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, 12);
let code = { mtime: -1, hash: '' };
/** Hash of ui/effects.js as it is on disk now: changing how an effect draws invalidates every frame drawn by the old code. */
function effectCode() {
  const m = Math.max(fs.statSync(EFFECTS_JS).mtimeMs, fs.statSync(path.join(path.dirname(EFFECTS_JS), 'live-graphics.js')).mtimeMs);
  if (m !== code.mtime) code = { mtime: m, hash: sha(fs.readFileSync(EFFECTS_JS, 'utf8') + fs.readFileSync(path.join(path.dirname(EFFECTS_JS), 'live-graphics.js'), 'utf8') + fs.readFileSync(path.join(path.dirname(EFFECTS_JS), 'official-brand-assets.js'), 'utf8')) };
  return code.hash;
}

/**
 * Export view: every live graphic layer drawn into ONE full-frame overlay, so the cache holds one PNG per output frame
 * instead of one per layer per frame (a fully live reel has hundreds of layers; per-layer frames ran to ~1 GB).
 * Only used when every live layer sits above all footage, so the stacking order is exactly the timeline's.
 * Returns a view of p (never saved): live clips replaced by one synthetic `live_stack` clip. The layers keep their own
 * clip-local time, opacity and fades, and are drawn by the same drawNodes the window previews with.
 */
export function liveStack(p) {
  const live = p.clips.filter((c) => c.effect?.type === 'live_graphic');
  if (live.length < 2) return p;
  const order = (t) => (t[0] === 'T' ? 1000 : 0) + Number(t.slice(1));
  const lo = Math.min(...live.map((c) => order(c.track)));
  if (p.clips.some((c) => c.kind !== 'audio' && c.kind !== 'text' && c.effect?.type !== 'live_graphic' && order(c.track) >= lo)) return p;
  const sorted = [...live].sort((a, b) => order(a.track) - order(b.track) || a.start - b.start);
  const total = Math.max(...p.clips.map(end));
  const top = sorted.at(-1).track;
  const layers = sorted.map((c) => ({ s: c.start, e: end(c), i: c.in || 0, o: c.opacity ?? 1, fi: c.fadeIn || 0, fo: c.fadeOut || 0, nodes: c.effect.params.nodes }));
  p.fx ||= {};
  const stack = { id: 'live_stack', kind: 'effect', track: top, start: 0, in: 0, out: total, speed: 1, effect: { type: 'live_stack', params: { layers } } };
  return { ...p, clips: [...p.clips.filter((c) => c.effect?.type !== 'live_graphic'), stack] };
}

/** Footage clips on the effect's source track that overlap it. */
export function sourceClips(p, c) {
  return p.clips.filter((x) => x.track === (c.source || 'V1') && (x.kind === 'video' || x.kind === 'image') && end(x) > c.start + 1e-4 && x.start < end(c) - 1e-4);
}
const needsCutout = (c) => EFFECTS[c.effect.type]?.needs === 'cutout';

/** Why the footage under c has no usable cutout for the frames c shows, or null when it has one. */
function coverageProblem(p, c) {
  const src = sourceClips(p, c);
  if (!src.length) return `there is no footage on ${c.source} under it`;
  for (const x of src) {
    const a = p.assets[x.asset];
    if (x.kind !== 'video') return `${a?.name || x.asset} is a still image; cutouts are made for video`;
    if (!a.cutout) return `it needs a cutout of ${a.name} (${a.id}) — call frame_cutout {asset: "${a.id}"}`;
    const lo = Math.max(x.in, x.in + (c.start - x.start) * x.speed), hi = Math.min(x.out, x.in + (end(c) - x.start) * x.speed);
    if (lo < a.cutout.from - 0.05 || hi > a.cutout.to + 0.05) return `the cutout of ${a.id} covers source ${a.cutout.from}–${a.cutout.to}s but this effect shows ${round(lo, 2)}–${round(hi, 2)}s — call frame_cutout {asset: "${a.id}", from: ${round(Math.min(lo, a.cutout.from), 2)}, to: ${round(Math.max(hi, a.cutout.to), 2)}}`;
  }
  return null;
}
/** Effects that need the cutout always get it; effects that can use one (uses: 'cutout') get it when the footage has one. */
const usesCutout = (p, c) => needsCutout(c) || (EFFECTS[c.effect.type]?.uses === 'cutout' && !coverageProblem(p, c));
/** Whether the effect reads the cutout's pixels (some only need its face and person boxes). */
const readsMatte = (p, c) => usesCutout(p, c) && EFFECTS[c.effect.type]?.matte !== false;

function keys(p, c) {
  const cut = usesCutout(p, c);
  const src = sourceClips(p, c).map((x) => ({ a: x.asset, k: x.kind, s: x.start, i: x.in, o: x.out, sp: x.speed, fit: x.fit, sc: x.scale, x: x.x, y: x.y, reframe: x.reframe, g: x.grade, ky: x.key, cut: cut ? p.assets[x.asset]?.cutout?.version : undefined }));
  const srcKey = sha([p.width, p.height, p.fps, c.start, fxFrames(c, p.fps), src, c.effect.params?.plate || null]);
  const fxKey = sha([srcKey, c.effect, c.in, c.out, effectCode()]);
  return { srcKey, fxKey };
}

/** What is wrong with drawing this effect right now, or null. */
export function effectProblem(p, c) {
  if (!EFFECTS[c.effect?.type]) return `effect "${c.effect?.type}" does not exist`;
  if (EFFECTS[c.effect.type].params.plate) {
    const pl = p.assets[c.effect.params.plate];
    if (!c.effect.params.plate) return `it needs plate: the asset id of a shot of the empty set from the same locked camera angle (film about 3 s with nobody in frame, import it, then update_clip {id: "${c.id}", params: {plate: "a2"}}). Frame never invents the background behind the person`;
    if (!pl || !['image', 'video'].includes(pl.kind)) return `its plate "${c.effect.params.plate}" is not an image or video asset in this project`;
  }
  return needsCutout(c) ? coverageProblem(p, c) : null;
}

/** For frame i of effect c: the source clip under it and the source second showing. */
function sourceAt(p, c, i) {
  const t = c.start + i / p.fps;
  const x = sourceClips(p, c).find((s) => t >= s.start - 1e-4 && t < end(s) - 1e-4);
  return x ? { clip: x, s: x.in + (t - x.start) * x.speed } : null;
}

async function ffmpegSeq(g, out, frames, matte) {
  const filters = [...g.filters]; let label = g.vOut;
  // A cutout frame is written white with the person in its alpha channel, so the drawing page can mask with it
  // directly (one composite) instead of converting brightness to alpha pixel by pixel.
  if (matte) { filters.push(`[${label}]format=gray,split[ma][mb];[ma]lut=c0=255[mw];[mw][mb]alphamerge,format=ya8[gm]`); label = 'gm'; }
  const args = ['-hide_banner', '-v', 'error', '-y'];
  for (const i of g.inputs) args.push(...i);
  args.push('-filter_complex', filters.join(';'), '-map', `[${label}]`, '-frames:v', String(frames), '-start_number', '0');
  if (!matte) args.push('-q:v', '2');
  args.push(out);
  await run('ffmpeg', args, { timeout: 600000 });
}

/** The plate (an empty-set shot) for effect c, placed exactly like the footage under c, as one still. */
async function extractPlate(p, c, dir) {
  const out = path.join(dir, 'plate.jpg'), plate = p.assets[c.effect.params.plate];
  if (fs.existsSync(out)) return out;
  const tpl = sourceClips(p, c).find((x) => x.start <= c.start + 1e-4) || sourceClips(p, c)[0];
  const mid = plate.kind === 'image' ? 0 : round(Math.max(0, plate.duration / 2 - 0.5 / p.fps), 4);
  const reframe = tpl.reframe && { ...tpl.reframe, offset: tpl.reframe.offset + c.start - tpl.start };
  const clip = { ...tpl, reframe, id: 'plate', asset: plate.id, kind: plate.kind, start: c.start, in: mid, out: round(mid + 1 / p.fps + 1e-3, 4), speed: 1, muted: true, opacity: 1, fadeIn: undefined, fadeOut: undefined, key: undefined };
  await ffmpegSeq(buildGraph({ ...p, clips: [clip] }, { window: [c.start], still: true, rasters: {}, effects: {}, assetPath: (a) => a.path }), out, 1, false);
  return out;
}

/** The picture (and cutout) under effect c for the frames in `indices`, written to dir as b_NNNNN.jpg / m_NNNNN.png. */
async function extractInputs(p, c, indices, dir, matteFile) {
  if (EFFECTS[c.effect.type].input === false) return null;
  const cut = readsMatte(p, c);
  const want = indices.filter((i) => !fs.existsSync(path.join(dir, `b_${fxFile(i, 'jpg')}`)) || (cut && !fs.existsSync(path.join(dir, `m_${fxFile(i, 'png')}`))));
  const plate = c.effect.params?.plate ? extractPlate(p, c, dir) : null;
  if (!want.length) return plate;
  const N = fxFrames(c, p.fps), src = sourceClips(p, c);
  const pSrc = { ...p, clips: src.map((x) => ({ ...x, muted: true })) };
  const assetPath = (a) => a.path;
  // The cutout runs through the same placement as the picture: the clip's asset is swapped for its matte video.
  const assets = { ...p.assets };
  const mClips = cut ? src.map((x) => {
    const a = p.assets[x.asset], id = `matte:${a.id}`;
    assets[id] = { id, kind: 'video', path: matteFile(a), width: a.width, height: a.height, hasAudio: false };
    return { ...x, asset: id, in: round(x.in - a.cutout.from, 4), out: round(x.out - a.cutout.from, 4), grade: undefined, key: undefined, muted: true };
  }) : null;
  const pM = mClips && { ...p, assets, clips: mClips };
  if (want.length > 3) { // a run of frames: one ffmpeg pass each for the picture and the cutout, side by side
    const win = [c.start, c.start + N / p.fps];
    const tmp = mkdirp(path.join(dir, `seq_${uid()}`));
    await Promise.all([
      ffmpegSeq(buildGraph(pSrc, { window: win, rasters: {}, effects: {}, assetPath, noAudio: true }), path.join(tmp, 'b_%05d.jpg'), N, false),
      pM && ffmpegSeq(buildGraph(pM, { window: win, rasters: {}, effects: {}, assetPath, noAudio: true }), path.join(tmp, 'm_%05d.png'), N, true),
    ]);
    for (const f of fs.readdirSync(tmp)) fs.renameSync(path.join(tmp, f), path.join(dir, f));
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    await Promise.all(want.map(async (i) => {
      const t = c.start + i / p.fps;
      await Promise.all([
        ffmpegSeq(buildGraph(pSrc, { window: [t], still: true, rasters: {}, effects: {}, assetPath }), path.join(dir, `b_${fxFile(i, 'jpg')}`), 1, false),
        pM && ffmpegSeq(buildGraph(pM, { window: [t], still: true, rasters: {}, effects: {}, assetPath }), path.join(dir, `m_${fxFile(i, 'png')}`), 1, true),
      ]);
    }));
  }
  return plate;
}

/** Run fns with at most n at a time. */
async function pool(n, fns) { const out = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, fns.length) }, async () => { while (i < fns.length) { const k = i++; out[k] = await fns[k](); } })); return out; }

// ───────────────────────── headless drawing jobs (served by the daemon: /api/fxjob/…)
const jobs = new Map();
export const getJob = (id) => jobs.get(id);

/** Answer the requests the drawing page makes. Returns true when handled. */
export async function handleJobRequest(req, res, parts, readBody) {
  const job = jobs.get(parts[0] === 'fxin' ? parts[1] : parts[2]);
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'fxjob') { if (!job) return send(404, { error: 'no such job' }), true; return send(200, job.spec), true; }
  if (req.method === 'GET' && parts[0] === 'fxin') {
    const fr = job && job.files[parts[2]];
    if (!fr || !fs.existsSync(fr)) return res.writeHead(404).end(), true;
    res.writeHead(200, { 'Content-Type': fr.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' }); fs.createReadStream(fr).pipe(res); return true;
  }
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'fxjob' && job) {
    const body = await readBody(req, 80e6);
    if (parts[3] === 'frame') {
      const want = job.out[parts[4]]; if (!want) return send(400, { error: 'unexpected frame' }), true;
      fs.writeFileSync(want, body); job.received.add(parts[4]); job.onFrame?.(job.received.size, Object.keys(job.out).length);
      return send(200, { ok: true }), true;
    }
    if (parts[3] === 'done') { job.finish(null); return send(200, { ok: true }), true; }
    if (parts[3] === 'error') { job.finish(new Error(body.toString().slice(0, 800))); return send(200, { ok: true }), true; }
  }
  return false;
}

async function drawOne(chrome, spec, files, out, onFrame) {
  const id = uid('fx'), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-fx-'));
  const n = Object.keys(out).length, timeoutMs = 30000 + n * 1500;
  let proc;
  try {
    await new Promise((resolve, reject) => {
      const job = { spec, files, out, received: new Set(), onFrame, finish: (e) => { clearTimeout(timer); jobs.delete(id); e ? reject(e) : resolve(); } };
      jobs.set(id, job);
      const timer = setTimeout(() => job.finish(new Error(`headless Chrome drew ${job.received.size} of ${n} effect frames in ${Math.round(timeoutMs / 1000)}s and then stopped`)), timeoutMs);
      // A throwaway profile, so this never touches the user's own browser profile or sessions.
      proc = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--user-data-dir=${profile}`, `${BASE}/fx-render.html?job=${id}`], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; proc.stderr.on('data', (d) => { err = (err + d).slice(-1200); });
      proc.on('error', (e) => job.finish(new Error('could not start headless Chrome: ' + e.message)));
      proc.on('exit', (code) => { if (jobs.has(id)) job.finish(new Error(`headless Chrome quit (${code}) after drawing ${job.received.size} of ${n} effect frames${err.trim() ? `: ${err.trim().split('\n').slice(-3).join(' | ')}` : ''}`)); });
    });
    const missing = Object.entries(out).filter(([, f]) => !fs.existsSync(f));
    if (missing.length) throw new Error(`${missing.length} effect frames were not drawn`);
  } finally {
    try { proc?.kill(process.env.FRAME_AGENT_CDP ? 'SIGTERM' : 'SIGKILL'); } catch {}
    setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => {}), 1500);
  }
}

/** Draw frames across several headless Chromes at once (each its own process), dealt round-robin so heavy and light effects mix. */
async function drawInChrome(spec, files, out, onFrame, workers) {
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chrome, Chromium, Edge or Brave found to draw effects (set FRAME_CHROME to one).');
  const k = Math.max(1, Math.min(workers || Number(process.env.FRAME_FX_WORKERS) || Math.max(1, Math.min(6, os.cpus().length - 2)), Math.ceil(spec.frames.length / 12)));
  const groups = Array.from({ length: k }, () => []);
  spec.frames.forEach((f, i) => groups[i % k].push(f));
  let done = 0; const total = spec.frames.length;
  await Promise.all(groups.map((frames) => drawOne(chrome, { ...spec, frames }, files, Object.fromEntries(frames.map((f) => [f.key, out[f.key]])), () => onFrame?.(++done, total))));
  return k;
}

/**
 * Make sure effect frames exist. want: [{ clip, indices }] (indices = which frames of that effect).
 * ctx: { cacheDir: () => project cache folder, matteFile(asset), trackOf(asset) → track JSON, onProgress(done, total) }
 * Returns { drawn: { clipId: {dir, ext} }, problems: [text] } — an effect with a problem is left out, never drawn wrong.
 */
export async function ensureEffects(p, want, ctx) {
  const drawn = {}, problems = [], frames = [], files = {}, out = {}, work = [], clips = {};
  const t0 = Date.now();
  p.fx ||= {};
  for (const { clip: c, indices } of want) {
    const problem = effectProblem(p, c);
    if (problem) { problems.push(`${EFFECTS[c.effect.type]?.label || c.effect.type} (${c.id}) at ${round(c.start, 2)}s was left out: ${problem}.`); continue; }
    const { srcKey, fxKey } = keys(p, c), ext = EFFECTS[c.effect.type].opaque ? 'jpg' : 'png';
    const dir = mkdirp(path.join(ctx.cacheDir(), `fx_${c.id}_${fxKey}`)), srcDir = mkdirp(path.join(ctx.cacheDir(), `fxsrc_${c.id}_${srcKey}`));
    // Drop this clip's frames from before a change, so the cache only holds what the timeline can still show.
    if (p.fx[c.id] && p.fx[c.id].key !== fxKey) fs.rm(p.fx[c.id].dir, { recursive: true, force: true }, () => {});
    if (p.fx[c.id] && p.fx[c.id].srcDir && p.fx[c.id].srcDir !== srcDir) fs.rm(p.fx[c.id].srcDir, { recursive: true, force: true }, () => {});
    p.fx[c.id] = { key: fxKey, dir, srcDir, ext };
    const todo = indices.filter((i) => !fs.existsSync(path.join(dir, fxFile(i, ext))));
    drawn[c.id] = { dir, ext };
    if (todo.length) work.push({ c, todo, dir, srcDir, ext });
  }
  // The pictures under all effects are extracted side by side (three effects at a time, picture and cutout together).
  await pool(3, work.map((w) => async () => {
    try { w.plate = await extractInputs(p, w.c, w.todo, w.srcDir, ctx.matteFile); }
    catch (e) { w.failed = true; problems.push(`${EFFECTS[w.c.effect.type].label} (${w.c.id}) was left out: could not extract the picture under it: ${e.message.slice(-300)}`); delete drawn[w.c.id]; }
  }));
  const t1 = Date.now();
  for (const { c, todo, dir, srcDir, ext, plate, failed } of work) {
    if (failed) continue;
    const cut = usesCutout(p, c);
    if (plate) files[`pl${c.id}`] = plate;
    for (const i of todo) {
      const at = sourceAt(p, c, i), a = at && p.assets[at.clip.asset];
      let face = null, person = null;
      if (at && a?.cutout && cut) {
        const tr = trackAt(ctx.trackOf(a), at.s), r = placeRect(a.width, a.height, at.clip, p.width, p.height, c.start + i / p.fps - at.clip.start);
        face = mapBox(tr.face, r); person = mapBox(tr.person, r);
      }
      const key = `${c.id}_${i}`, { t, d } = effectTime(c, c.start + i / p.fps);
      if (EFFECTS[c.effect.type].input !== false) files[`b${key}`] = path.join(srcDir, `b_${fxFile(i, 'jpg')}`);
      if (readsMatte(p, c)) files[`m${key}`] = path.join(srcDir, `m_${fxFile(i, 'png')}`);
      out[key] = path.join(dir, fxFile(i, ext));
      clips[c.id] ||= { id: c.id, effect: c.effect, in: c.in, out: c.out, start: c.start };
      frames.push({ key, clip: c.id, t: round(t, 5), d, ext, base: EFFECTS[c.effect.type].input === false ? null : `b${key}`, matte: readsMatte(p, c) ? `m${key}` : null, plate: plate ? `pl${c.id}` : null, face, person });
    }
  }
  let workers = 0;
  if (frames.length) {
    try { workers = await drawInChrome({ W: p.width, H: p.height, clips, frames }, files, out, ctx.onProgress, ctx.workers); }
    catch (e) { for (const id of new Set(frames.map((f) => f.clip))) { delete drawn[id]; problems.push(`${EFFECTS[p.clips.find((x) => x.id === id)?.effect.type]?.label || id} (${id}) was left out: ${e.message}`); } }
  }
  // Remove cached frames of effects that are no longer on the timeline.
  for (const id of Object.keys(p.fx)) if (!p.clips.some((x) => x.id === id)) { for (const d of [p.fx[id].dir, p.fx[id].srcDir]) if (d) fs.rm(d, { recursive: true, force: true }, () => {}); delete p.fx[id]; }
  return { drawn, problems, count: frames.length, workers, seconds: { extract: round((t1 - t0) / 1000, 1), draw: round((Date.now() - t1) / 1000, 1) } };
}
