import { createPromptRunner } from './prompt-jobs.js';
import { applyRevision, revertRevision } from './revisions.js';
// The Frame daemon: one local process that owns projects, serves the live UI and executes every tool call.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION, PORT, HOME, BASE, sleep, uid, round, mkdirp, run, tc } from './util.js';
import * as media from './media.js';
import * as packs from './packs.js';
import { newProject, applyOp, describe, projectDuration, timelineWords, end, timelineIssues } from './project.js';
import { buildGraph, ffmpegArgs, runFfmpeg, fxIndex, fxFrames } from './render.js';
import { makeCutout, cutoutEngine } from './cutout.js';
import { ensureEffects, handleJobRequest, effectProblem, sourceClips, liveStack } from './effects.js';
import { EFFECTS, describeEffects } from '../ui/effects.js';
import { TOOLS, INSTRUCTIONS } from './tools.js';
import { TEMPLATES, DIRECTOR_RULES, SWARM, resolveTemplate, cast, windowsFor, bestWindow, windowClip, filmstrip } from './swarm.js';
import { decisionsConfig, PACKS, MODEL, THRESHOLD, MAX_SECONDS, makeDecisionProxy, proxyCommand, ask, normaliseQuestions, answerText, sheetLine, sheetSummary, ranked } from './decide.js';
import { drawTextsHeadless } from './text.js';
import { textKey } from '../ui/text-draw.js';
import { speechCutoffs, cutoffLines, deadAir, deadAirLines } from './speechcheck.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACE = Number(process.env.FRAME_PACE ?? 140);
const promptRunner = createPromptRunner({ publish: (p) => emitPromptUpdate(p) });   // ported from the Codex live prototype
const projects = new Map();
const history = new Map();
const clients = new Set();
let currentId = null;
let lastCallAt = 0;

// ───────────────────────── storage
const pdir = (id) => mkdirp(path.join(HOME, 'projects', id));
const cacheFile = (p, name) => path.join(mkdirp(path.join(pdir(p.id), 'cache')), name);
// Atomic: write a temp file, then rename over project.json. A full disk then fails the save, never empties the project.
function save(p) {
  p.updatedAt = Date.now(); const f = path.join(pdir(p.id), 'project.json'), tmp = `${f}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(p)); fs.renameSync(tmp, f); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} console.error(`Frame could not save ${p.id}: ${e.message}`); p.saveError = e.code || e.message; }
}
function load(id) {
  if (projects.has(id)) return projects.get(id);
  const file = path.join(HOME, 'projects', id, 'project.json');
  if (!fs.existsSync(file)) return null;
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.status = { state: 'idle', label: 'Idle' }; p.inbox ||= []; p.rasters ||= {};
  projects.set(id, p); setImmediate(() => ensureProxies(p)); return p;
}
/** Backfill light preview proxies for big footage, one at a time in the background (never blocks the user). Renders still use the originals. */
let proxyChain = Promise.resolve();
function ensureProxies(p) {
  for (const a of Object.values(p.assets || {})) {
    if (a.kind !== 'video' || a.proxy || !a.path || Math.max(a.width || 0, a.height || 0) <= 1280 || !fs.existsSync(a.path)) continue;
    const out = cacheFile(p, `${a.id}.proxy.mp4`);
    proxyChain = proxyChain.then(async () => {
      try { a.busy = 'making preview proxy'; emit(p); await media.makeProxy(a.path, out); a.proxy = true; } catch {}
      delete a.busy; save(p); emit(p);
    });
  }
}
function listProjects() {
  const dir = mkdirp(path.join(HOME, 'projects'));
  return fs.readdirSync(dir).map((id) => { try { const p = load(id); return p && { id, name: p.name, updatedAt: p.updatedAt, duration: round(projectDuration(p), 1), clips: p.clips.length }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}
function setCurrent(id) { currentId = id; fs.writeFileSync(path.join(mkdirp(HOME), 'state.json'), JSON.stringify({ current: id })); }
function current(id) {
  const p = id ? load(id) : currentId ? load(currentId) : null;
  if (id && !p) throw new Error(`No project "${id}". Call frame_start to create one, or frame_start with action "list".`);
  if (!p) throw new Error('No Frame project is open yet. Call frame_start first.');
  if (p.id !== currentId) setCurrent(p.id);
  return p;
}
const assetPath = (p) => (a) => a.path;
const loadEnv = (p) => (assetId) => { const f = cacheFile(p, `${assetId}.env.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const matteFile = (p) => (a) => cacheFile(p, `${a.id}.matte.mp4`);
const tracks = new Map(); // cutout tracks, read once per cutout version
const trackOf = (p) => (a) => { const k = `${p.id}/${a.id}/${a.cutout?.version}`; if (!tracks.has(k)) tracks.set(k, JSON.parse(fs.readFileSync(cacheFile(p, `${a.id}.track.json`), 'utf8'))); return tracks.get(k); };

/**
 * Draw the effect frames needed for the timeline window [t0, t1] (or the single frames at `times`).
 * Returns { drawn, problems } for buildGraph's o.effects; an effect that cannot be drawn is reported, never shipped stale.
 */
async function drawEffects(p, { window: win, times, view } = {}) {
  const want = [], src = view || p; // view: an export view of p (liveStack); p is what gets saved
  for (const c of src.clips.filter((x) => x.kind === 'effect')) {
    let idx = [];
    if (times) idx = [...new Set(times.filter((t) => t >= c.start - 1e-4 && t < end(c) - 1e-4).map((t) => fxIndex(c, t, p.fps)))];
    else { const [t0, t1] = win; if (end(c) <= t0 || c.start >= t1) continue; const a = fxIndex(c, Math.max(t0, c.start), p.fps), b = fxIndex(c, Math.min(t1, end(c)) - 1e-6, p.fps); for (let i = a; i <= b; i++) idx.push(i); }
    if (idx.length) want.push({ clip: c, indices: idx });
  }
  if (!want.length) return { drawn: {}, problems: [] };
  const total = want.reduce((n, w) => n + w.indices.length, 0);
  const prev = p.status; p.status = { state: 'active', label: `Drawing ${total} effect frame${total === 1 ? '' : 's'}` }; emit(p);
  let last = 0;
  try {
    return await ensureEffects(src, want, { cacheDir: () => path.dirname(cacheFile(p, 'x')), matteFile: matteFile(p), trackOf: trackOf(p), onProgress: (n, of) => { if (Date.now() - last > 400) { last = Date.now(); p.status = { state: 'active', label: `Drawing effect frames ${n}/${of}` }; emit(p); } } });
  } finally { p.status = prev; save(p); }
}

// ───────────────────────── live updates
function publicProject(p) {
  const assets = {};
  for (const a of Object.values(p.assets)) assets[a.id] = { ...a, transcript: a.transcript ? { engine: a.transcript.engine, words: a.transcript.words.length } : undefined };
  return { ...p, assets, inbox: undefined, pending: (p.inbox || []).length, duration: projectDuration(p) };
}
function emit(p, extra) {
  if (p) { p.version++; save(p); }
  const msg = `data: ${JSON.stringify({ type: 'state', project: p && p.id === currentId ? publicProject(p) : currentId ? publicProject(load(currentId)) : null, projects: listProjects(), lastCallAt, ...extra })}\n\n`;
  for (const c of clients) c.write(msg);
}
// Prompt phases carry no timeline changes. Send their small state separately.
function emitPromptUpdate(p) {
  if (p.id !== currentId) return;
  sendProjectDelta(p, { promptJobs: p.promptJobs });
}

function sendProjectDelta(p, delta) {
  if (p.id !== currentId) return;
  const msg = `data: ${JSON.stringify({ type: 'project_delta', id: p.id, lastCallAt, ...delta })}\n\n`;
  for (const c of clients) c.write(msg);
}

function emitClipChanges(p, ids, feedEntries, revisions, focuses = []) {
  p.version++;
  save(p);
  sendProjectDelta(p, {
    version: p.version, clips: p.clips.filter(c => ids.has(c.id)),
    feedEntries, revisions, focuses, promptJobs: p.promptJobs
  });
}

// ───────────────────────── generating: live progress from outside generators (renderers, compositors, AI jobs)
// They POST {job_id, name, done, total} and, every few frames, a JPEG of what they just composited. The bin shows a
// "Generating…" tile with the percentage and that frame; clicking it opens a live view. Nothing here is persisted.
const genJobs = new Map();     // job_id → { job_id, project_id, name, kind, done, total, note, status, startedAt, updatedAt, previewV }
const genPreview = new Map();  // job_id → latest preview JPEG
let genEmitAt = 0, genTimer = null;
function emitGen(force) {
  const send = () => { genTimer = null; genEmitAt = Date.now(); const msg = `data: ${JSON.stringify({ type: 'generating', jobs: [...genJobs.values()] })}\n\n`; for (const c of clients) c.write(msg); };
  if (force) { if (genTimer) clearTimeout(genTimer); return send(); }
  if (!genTimer) genTimer = setTimeout(send, Math.max(0, 200 - (Date.now() - genEmitAt)));
}
function genUpdate(b) {
  const id = String(b.job_id || '').slice(0, 80); if (!id) throw new Error('job_id is required');
  const now = Date.now(), j = genJobs.get(id) || { job_id: id, startedAt: now, previewV: 0 };
  Object.assign(j, {
    project_id: b.project_id ?? j.project_id ?? currentId, name: String(b.name ?? j.name ?? id).slice(0, 120), kind: b.kind || j.kind || 'video',
    done: Number(b.done ?? j.done ?? 0), total: Number(b.total ?? j.total ?? 0), note: b.note != null ? String(b.note).slice(0, 200) : j.note,
    status: ['done', 'failed'].includes(b.status) ? b.status : 'running', updatedAt: now,
  });
  genJobs.set(id, j);
  if (j.status === 'running') { emitGen(); return j; }
  emitGen(true); // show the final state once (100 % or failed), then the tile goes
  setTimeout(() => { if (genJobs.get(id)?.updatedAt === now) { genJobs.delete(id); genPreview.delete(id); emitGen(true); } }, j.status === 'failed' ? 5000 : 1500);
  if (j.status === 'done' && b.path && b.auto_import && j.project_id && load(j.project_id)) callTool('frame_import', { project_id: j.project_id, paths: [String(b.path)], prepare: false }).catch(() => {});
  return j;
}

function feed(p, e) {
  const entry = { id: uid('f_'), ts: Date.now(), actor: 'claude', kind: 'note', ...e };
  p.feed.push(entry); if (p.feed.length > 800) p.feed.splice(0, p.feed.length - 800);
  return entry;
}
function snapshot(p) {
  const h = history.get(p.id) || { undo: [], redo: [] }; history.set(p.id, h);
  h.undo.push(JSON.stringify({ clips: p.clips, markers: p.markers, tracks: p.tracks, trackLabels: p.trackLabels, width: p.width, height: p.height, fps: p.fps }));
  if (h.undo.length > 100) h.undo.shift();
  h.redo = [];
}
function timeTravel(p, dir) {
  const h = history.get(p.id); const from = dir === 'undo' ? h?.undo : h?.redo, to = dir === 'undo' ? h?.redo : h?.undo;
  if (!from?.length) return false;
  to.push(JSON.stringify({ clips: p.clips, markers: p.markers, tracks: p.tracks, trackLabels: p.trackLabels, width: p.width, height: p.height, fps: p.fps }));
  Object.assign(p, JSON.parse(from.pop()));
  return true;
}

function openBrowser(url) {
  if (process.env.FRAME_NO_OPEN) return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}
async function ensureWindow() {
  if (clients.size) return true;
  openBrowser(BASE);
  for (let i = 0; i < 30 && !clients.size; i++) await sleep(100);
  return clients.size > 0;
}

// ───────────────────────── tool results
const text = (t) => ({ type: 'text', text: t });
/** Everything the human did in the Frame window since Claude last looked. Appended to every tool result. */
function userInput(p) {
  if (!p) return '';
  const items = p.inbox.splice(0); if (items.length) save(p);
  let s = '';
  if (items.length) s += `\n\n━━ FROM THE USER, VIA THE FRAME WINDOW (newest last) — act on this before continuing your plan ━━\n${items.map((i) => `• [${i.kind}] ${i.text}`).join('\n')}`;
  if (p.paused) s += `\n\n⏸ THE USER HAS PAUSED YOU. Do not make further edits or renders. Call frame_wait to wait for their instruction, or ask them in chat.`;
  return s;
}

function assetSummary(p, a) {
  const bits = [`${a.id} · ${a.kind} · "${a.name}"`];
  if (a.duration) bits.push(`${a.duration}s`);
  if (a.width) bits.push(`${a.width}×${a.height} @ ${a.fps} fps`);
  if (a.loudness) bits.push(`${a.loudness.lufs} LUFS, peak ${a.loudness.true_peak_db} dBFS`);
  let s = bits.join(' · ');
  const env = loadEnv(p)(a.id);
  if (env) {
    const r = media.findPauses(env, { min_silence: 0.4 }), sil = r.pauses;
    const tot = sil.reduce((n, x) => n + (x.end - x.start), 0);
    s += `\n    silences ≥0.4s (measured, adaptive threshold ${r.threshold_db} dB over a ${r.floor_db} dB noise floor): ${sil.length}, ${round(tot, 1)}s total${sil.length ? ' → ' + sil.slice(0, 40).map((x) => `${round(x.start, 2)}–${round(x.end, 2)}`).join(', ') + (sil.length > 40 ? ' …' : '') : ''}${sil.length ? '\n    → to remove them, call frame_cut_silence (one call; do not hand-cut)' : ''}`;
  }
  if (a.scenes?.length) s += `\n    scene changes at: ${a.scenes.slice(0, 60).join(', ')}`;
  if (a.transcript) s += `\n    transcript: ${a.transcript.words.length} words (${a.transcript.engine})`;
  return s;
}

function transcriptLines(words) {
  const lines = []; let cur = null;
  for (const w of words) {
    if (!cur || w.start - cur.end > 0.45 || cur.n >= 14) { cur = { start: w.start, end: w.end, text: w.text, n: 1 }; lines.push(cur); }
    else { cur.text += ' ' + w.text; cur.end = w.end; cur.n++; }
  }
  return lines.map((l) => `[${l.start.toFixed(2)}–${l.end.toFixed(2)}] ${l.text}`).join('\n');
}

async function importOne(p, file, opts) {
  file = path.resolve(file.replace(/^~(?=[\\/])/, os.homedir()));
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const existing = Object.values(p.assets).find((a) => a.path === file);
  if (existing) return existing;
  const info = await media.probe(file);
  let n = Object.keys(p.assets).length + 1; while (p.assets['a' + n]) n++;
  const a = { id: 'a' + n, path: file, name: path.basename(file), ...info, busy: 'reading' };
  p.assets[a.id] = a;
  feed(p, { kind: 'op', op: 'import', actor: opts.actor || 'claude', text: `Imported ${a.name}${a.duration ? ` · ${a.duration}s` : ''}${a.width ? ` · ${a.width}×${a.height}` : ''}`, why: opts.why });
  emit(p);
  try {
    a.thumbs = await media.makeThumbs(file, a, cacheFile(p, `${a.id}.thumbs.jpg`)); a.busy = 'listening'; emit(p);
    if (a.hasAudio || a.kind === 'audio') {
      const env = await media.audioEnvelope(file);
      fs.writeFileSync(cacheFile(p, `${a.id}.env.json`), JSON.stringify({ rate: env.rate, peaks: env.peaks, rms: env.rms.map((v) => round(v, 4)) }));
      a.hasEnv = true; a.loudness = await media.loudness(file);
    }
    if (opts.scenes && a.kind === 'video') { a.busy = 'finding scene changes'; emit(p); a.scenes = await media.sceneCuts(file); }
    // Big footage the browser can already play gets its light preview copy in the background (it only smooths playback);
    // footage the browser cannot play at all needs the copy before it can be previewed, so that one is waited for.
    const playable = ['h264', 'hevc', 'vp9', 'av1'].includes(a.vcodec) && !/\.(mkv|avi|mts|mxf)$/i.test(file);
    if (a.needsProxy && playable) setImmediate(() => ensureProxies(p));
    else if (a.needsProxy) { a.busy = 'making preview proxy'; emit(p); await media.makeProxy(file, cacheFile(p, `${a.id}.proxy.mp4`)); a.proxy = true; }
  } finally { delete a.busy; emit(p); }
  return a;
}

// ───────────────────────── background preparation
// The person cutout and the transcript start right after import and run alongside everything else, so by the time
// effects or captions are placed they are usually done. Every tool that needs one waits for it instead of starting
// it again. Each is a visible process step with the exact command.
const pending = new Map(); // `${project}/${asset}/cutout|transcript` -> Promise
const pendingOf = (p, as, kind) => pending.get(`${p.id}/${as.id}/${kind}`);
function track(p, as, kind, job) {
  const key = `${p.id}/${as.id}/${kind}`; pending.set(key, job);
  job.then(() => {}, () => {}).finally(() => { if (pending.get(key) === job) pending.delete(key); });
  return job;
}
function cutoutRange(p, as, a = {}) {
  const used = p.clips.filter((c) => c.asset === as.id && c.kind === 'video');
  let from = a.from != null ? Number(a.from) : used.length ? Math.min(...used.map((c) => c.in)) - 0.5 : 0;
  let to = a.to != null ? Number(a.to) : used.length ? Math.max(...used.map((c) => c.out)) + 0.5 : as.duration;
  return { from: Math.max(0, round(from, 3)), to: Math.min(as.duration, round(to, 3)) };
}
function startCutout(p, as, { from, to, quality = 'balanced', why, auto }) {
  return track(p, as, 'cutout', (async () => {
    const eng = await cutoutEngine();
    if (!eng.id) throw new Error(`Frame cannot cut out a person on this machine: ${eng.reason}.`);
    const step = { id: uid('s_'), startedAt: Date.now(), title: `Cutout: person in ${as.name} (source ${tc(from)}–${tc(to)})${auto ? ' — started at import' : ''}`, tool: eng.label, status: 'running', note: 'Runs on this machine, in parallel chunks. White in the matte = person. Every frame is segmented; nothing is uploaded.' };
    p.steps.push(step); feed(p, { kind: 'step', text: `Started: ${step.title}`, stepId: step.id, why });
    as.cutting = '0%'; emit(p);
    let r, last = 0;
    try {
      r = await makeCutout(as, { from, to, quality, matteOut: matteFile(p)(as) + '.new.mp4', trackOut: cacheFile(p, `${as.id}.track.new.json`), onProgress: (k) => { as.cutting = `${Math.round(k * 100)}%`; if (Date.now() - last > 500) { last = Date.now(); emit(p); } } });
    } catch (e) {
      delete as.cutting; step.status = 'failed'; step.endedAt = Date.now(); feed(p, { kind: 'step', text: `Failed: ${step.title}`, why: String(e.message).slice(-300), stepId: step.id }); emit(p);
      throw e;
    }
    fs.renameSync(matteFile(p)(as) + '.new.mp4', matteFile(p)(as)); fs.renameSync(cacheFile(p, `${as.id}.track.new.json`), cacheFile(p, `${as.id}.track.json`));
    const { command, ...meta } = r; as.cutout = meta; delete as.cutting;
    Object.assign(step, { status: 'done', endedAt: Date.now(), code: command });
    feed(p, { kind: 'step', text: `Finished: ${step.title} · person in ${r.withPerson}/${r.frames} frames · face in ${r.withFace}/${r.frames} · ${r.seconds}s in ${r.chunks} parallel chunk${r.chunks === 1 ? '' : 's'}`, stepId: step.id });
    feed(p, { kind: 'op', op: 'cutout', text: `Cutout ready for ${as.name}: ${r.frames} frames, person found in ${r.withPerson}, face in ${r.withFace}`, why }); emit(p);
    return r;
  })());
}
function startTranscript(p, as, { model, language, engine, why } = {}) {
  return track(p, as, 'transcript', (async () => {
    const eng = await media.transcriber();
    const label = engine === 'whisper' || model || eng?.id !== 'apple' ? `Whisper ${model || 'base.en'}` : 'Apple on-device speech';
    as.transcribing = true; feed(p, { kind: 'op', op: 'transcribe', text: `Transcribing ${as.name} with ${label} on this machine…`, why }); emit(p);
    try {
      const tr = await media.transcribe(as.path, { model, language, engine, duration: as.duration });
      if (!tr) throw new Error('No transcription engine on this machine (needs macOS 26 with swiftc, or Whisper).');
      const env = loadEnv(p)(as.id);
      const al = env ? media.alignWordsToSpeech(tr.words, env) : { words: tr.words, moved: 0 };
      as.transcript = { engine: tr.engine, words: al.words, realigned: al.moved, seconds: tr.seconds, spelled: tr.spelled };
      feed(p, { kind: 'op', op: 'transcript', text: `Transcript ready: ${tr.words.length} words with word-level timing in ${tr.seconds}s (${tr.engine})${tr.spelled ? ` · ${tr.spelled} name(s) fixed from spellings.json` : ''}${al.moved ? ` · ${al.moved} word(s) placed inside silence were moved onto the measured speech` : ''}${tr.note ? ` · ${tr.note}` : ''}` });
      return as.transcript;
    } finally { delete as.transcribing; emit(p); }
  })());
}
/**
 * The decision sheet: label clips with gemini-decision-1 in the background, all in parallel, as one visible step.
 * add() starts a clip at once (so labels land while later files are still importing); finish() resolves when all are done.
 * Answers are stored on the asset as decisions {model, pack, status, answers, tokens, ms} and are always shown as guesses.
 */
function labelBatch(p, { pack = 'general', why, auto } = {}) {
  const cfg = decisionsConfig(); if (!cfg.on) return null;
  const P = PACKS[pack]; if (!P) throw new Error(`Unknown decision pack "${pack}". Packs: ${Object.keys(PACKS).join(', ')}.`);
  const list = [], jobs = []; let step = null; const t0 = Date.now();
  const body = { model: MODEL, input: [{ type: 'video', data: '<base64 decision proxy>', mime_type: 'video/mp4' }], questions: P.questions };
  return {
    cfg, pack,
    add(as) {
      if (!step) {
        step = { id: uid('s_'), startedAt: Date.now(), title: `Label clips with ${MODEL} (pack "${pack}")${auto ? ' — started at import' : ''}`, tool: 'Gemini Decisions API', status: 'running',
          note: `Uploads a 360 px, 2 fps copy of each clip to Google (key from ${cfg.source}). The answers are the model's guesses, not measurements. Below ${THRESHOLD * 100}% confidence a clip is marked REVIEW.`,
          code: `${proxyCommand}\nPOST ${cfg.endpoint}\n${JSON.stringify(body, null, 2)}` };
        p.steps.push(step); feed(p, { kind: 'step', text: `Started: ${step.title}`, stepId: step.id, why });
      }
      list.push(as);
      as.decisions = { model: MODEL, pack, status: 'pending' }; emit(p);
      jobs.push(track(p, as, 'decisions', (async () => {
        try {
          const px = await makeDecisionProxy(as.path, cacheFile(p, `${as.id}.decide.mp4`));
          const r = await ask(cfg, px, P.questions);
          as.decisions = { model: MODEL, pack, status: 'done', at: Date.now(), answers: r.answers, tokens: r.tokens, ms: r.ms };
        } catch (e) { as.decisions = { model: MODEL, pack, status: 'failed', at: Date.now(), error: String(e.message).slice(0, 300) }; throw e; }
        finally { emit(p); }
      })()));
    },
    finish() {
      if (!step) return Promise.resolve();
      return Promise.allSettled(jobs).then(() => {
        const done = list.filter((as) => as.decisions?.status === 'done'), failed = list.filter((as) => as.decisions?.status === 'failed');
        const review = done.filter((as) => sheetSummary(as.decisions).review), tokens = done.reduce((n, as) => n + (as.decisions.tokens || 0), 0);
        Object.assign(step, { status: done.length ? 'done' : 'failed', endedAt: Date.now() });
        feed(p, { kind: 'step', stepId: step.id, text: `${done.length ? 'Finished' : 'Failed'}: ${step.title} · ${list.length} clip${list.length === 1 ? '' : 's'} in ${round((Date.now() - t0) / 1000, 1)}s · ${done.length - review.length} confident, ${review.length} to review${failed.length ? `, ${failed.length} failed: ${failed[0].decisions.error}` : ''}${tokens ? ` · ${tokens} tokens` : ''}` });
        emit(p);
      });
    },
  };
}
/** The sheet as text for tool results. Only assets that have been labeled (or are being labeled) appear. */
function decisionSheet(p, ids) {
  const list = (ids || Object.keys(p.assets)).map((id) => p.assets[id]).filter((as) => as?.decisions);
  if (!list.length) return '';
  const packs = [...new Set(list.map((as) => as.decisions.pack))];
  const head = `Decision sheet — ${MODEL} guesses, NOT measurements (pack ${packs.map((k) => `"${k}": ${PACKS[k]?.about || ''}`).join(' / ')}). Trust a role at ${THRESHOLD * 100}% or more; frame_view the REVIEW clips yourself. hook and steady are 0–2.`;
  return `${head}\n${list.map((as) => `  ${as.id} ${as.name}: ${sheetLine(as.decisions)}`).join('\n')}`;
}
// ───────────────────────── the swarm (frame_swarm)
const pct = (x) => `${Math.round(x * 100)}%`;
const resultText = (r) => r.map((c) => c.text || '').join('\n');
/** Run Caster → Scouts → Trimmer live on V1. Returns the text for the tool result (the Director brief included). */
async function swarmRun(p, a) {
  const cfg = decisionsConfig(); if (!cfg.on) throw new Error(`frame_swarm needs the decision sheet, which is off: ${cfg.reason}.`);
  const tpl = resolveTemplate(a, PACKS, p.decisionPack);
  const videos = Object.values(p.assets).filter((as) => as.kind === 'video' && as.duration <= MAX_SECONDS);
  if (!videos.length) throw new Error('No video clips (up to 10 minutes long) to build from. Import footage first.');
  if (p.clips.some((c) => c.track === 'V1') && !a.replace) throw new Error('V1 already has clips. Pass replace: true to clear V1 and build the swarm cut there, or start a new project.');
  const t0 = Date.now(), sec = () => round((Date.now() - t0) / 1000, 1);
  // 1. labels for the template's pack (reuses labels already made with it)
  await awaitPrep(p, videos.map((as) => as.id), ['decisions']);
  const need = videos.filter((as) => !(as.decisions?.status === 'done' && as.decisions.pack === tpl.pack));
  if (need.length) { const b = labelBatch(p, { pack: tpl.pack, why: `The "${tpl.name}" template reads "${tpl.pack}" labels` }); need.forEach((as) => b.add(as)); await b.finish(); p.decisionPack = tpl.pack; }
  const labeled = videos.filter((as) => as.decisions?.status === 'done');
  if (!labeled.length) throw new Error(`No clip could be labeled: ${videos[0].decisions?.error || 'unknown error'}.`);
  const tLabels = sec();
  const prevStatus = p.status; p.status = { state: 'active', label: 'Swarm is editing' }; emit(p);
  try {
    // 2. Caster: the rough cut, at once
    const c = cast(tpl.slots, labeled);
    const placed = c.filter((s) => s.pick);
    feed(p, { kind: 'plan', agent: 'Swarm', text: `Swarm on the "${tpl.name}" template (${tpl.slots.length} slots). Caster lays a rough cut from the decision sheet; Scouts ask ${MODEL} about every ${SWARM.win}s window of each slot's candidate clips; Trimmer swaps in the best window as each slot's answers land. Caster and Trimmer are rules over the model's answers. Then the Director (you, the agent) takes over.` });
    const ops = [...(a.replace ? [{ op: 'clear_track', track: 'V1', why: 'Clear V1 for the swarm cut' }] : []),
      ...placed.map((s) => ({ op: 'add_clip', asset: s.pick.asset, track: 'V1', in: s.pick.in, out: +(s.pick.in + Math.min(s.seconds, p.assets[s.pick.asset].duration)).toFixed(2), muted: a.muted !== false, label: s.id, why: `${s.id}: ${p.assets[s.pick.asset].name} is labeled ${s.role.replace(/_/g, ' ')} (${pct(s.pick.p)}, model guess)` }))];
    const castTxt = resultText(await handlers.frame_edit({ project_id: p.id, agent: 'Caster', summary: 'Rough cut from the decision sheet: the best-labeled clip for each slot', ops }));
    const ids = [...castTxt.matchAll(/^\d+\. ✓ Placed .*\[(c_[a-z0-9]+)\]/gm)].map((m) => m[1]);
    if (ids.length !== placed.length) throw new Error(`The Caster placed ${ids.length} of ${placed.length} clips:\n${castTxt.split('\n\n')[0]}`);
    const tFirst = sec();
    p.swarm = { template: tpl.name, pack: tpl.pack, at: Date.now(), slots: c.map((s) => ({ id: s.id, role: s.role, seconds: s.seconds, about: s.about, cands: s.cands.map((x) => ({ asset: x.as.id, p: +x.p.toFixed(3) })), clip: s.pick ? ids[placed.indexOf(s)] : null, asset: s.pick?.asset || null, in: s.pick?.in ?? null, by: s.pick ? 'Caster' : null })) };
    save(p);
    // 3. Scouts + 4. Trimmer
    let wins = windowsFor(c.filter((s) => s.pick));
    const skipped = Math.max(0, wins.length - SWARM.maxWindows); if (skipped) wins = wins.slice(0, SWARM.maxWindows);
    const pending = new Map(c.map((s) => [s.id, wins.filter((w) => w.slots.includes(s)).length]));
    const answers = new Map(), used = [], trims = [];
    let trimChain = Promise.resolve(), tokens = 0, failed = 0, lastErr = '';
    const trim = (s) => {
      const best = bestWindow(answers.get(s.id) || [], used); const slot = p.swarm.slots.find((x) => x.id === s.id);
      if (!best || !slot.clip) return;
      const len = Math.min(s.seconds, best.as.duration);
      const inPt = +Math.max(0, Math.min(best.as.duration - len, (best.from + best.to) / 2 - len / 2)).toFixed(2);
      used.push({ asset: best.as.id, in: inPt, out: inPt + len });
      trimChain = trimChain.then(async () => {
        if (p.paused || !p.clips.some((x) => x.id === slot.clip)) return;
        await handlers.frame_edit({ project_id: p.id, agent: `Trimmer · ${s.id}`, ops: [{ op: 'replace_source', id: slot.clip, asset: best.as.id, in: inPt, why: `${s.id}: ${best.as.name} ${best.from}–${best.to}s rated highest (P ${pct(best.p)}, model guess)` }] });
        Object.assign(slot, { asset: best.as.id, in: inPt, by: 'Trimmer', p: +best.p.toFixed(3) }); trims.push(s.id);
      });
    };
    const tScout = Date.now();
    const roleText = (s) => s.about;
    await Promise.all(wins.map(async (w, i) => {
      let r = null;
      if (!p.paused) {
        try {
          const file = await windowClip(cacheFile(p, `${w.as.id}.decide.mp4`), w.from, w.to, cacheFile(p, `swarm_${w.as.id}_${w.from}.mp4`));
          const qs = { camera_junk: { type: 'noul', instructions: 'Is this mostly unusable camera junk: pocket, floor, ceiling, heavy blur, or the camera being picked up or set down?' } };
          w.slots.forEach((s) => (qs[`shows_${s.id}`] = { type: 'noul', instructions: `Does this part of the clip clearly show this: ${roleText(s)}` }));
          r = await ask(cfg, file, qs); tokens += r.tokens || 0; fs.rm(file, { force: true }, () => {});
        } catch (e) { failed++; lastErr = e.message; }
      }
      for (const s of w.slots) {
        if (r) (answers.get(s.id) || answers.set(s.id, []).get(s.id)).push({ as: w.as, from: w.from, to: w.to, p: r.answers[`shows_${s.id}`]?.noul ?? 0, junk: r.answers.camera_junk?.noul ?? 0 });
        pending.set(s.id, pending.get(s.id) - 1);
        if (pending.get(s.id) === 0) trim(s);
      }
    }));
    const tScoutDone = round((Date.now() - tScout) / 1000, 1);
    await trimChain; save(p);
    const tDone = sec();
    feed(p, { kind: 'step', agent: 'Swarm', text: `Swarm cut ready: rough cut ${tFirst}s after start${tLabels > 0.5 ? ` (labels ${tLabels}s)` : ''}, ${trims.length}/${placed.length} slots trimmed by ${tDone}s · ${wins.length} windows asked in ${tScoutDone}s${failed ? `, ${failed} failed (${lastErr})` : ''} · ${tokens} tokens. Next: the Director.` });
    // the Director brief
    const prof = p.profile ? loadProfile(p.profile) : null;
    const rows = p.swarm.slots.map((s, i) => `  ${i + 1}. ${s.id} (${s.seconds}s) — ${s.about}\n     now: ${s.asset ? `${s.asset} ${p.assets[s.asset].name} from ${s.in}s (${s.by}${s.p != null ? `, P ${pct(s.p)}` : ''})` : 'EMPTY: no clip is labeled for this role'} · candidates: ${s.cands.map((x) => `${x.asset} ${pct(x.p)}`).join(', ') || 'none'}`);
    return `Swarm built the "${tpl.name}" cut on V1, live: rough cut ${tFirst}s after start${tLabels > 0.5 ? ` (of which labeling took ${tLabels}s)` : ''}; ${trims.length}/${placed.length} slots trimmed by ${tDone}s. ${wins.length} windows asked in ${tScoutDone}s, ${tokens} tokens${failed ? `; ${failed} requests failed: ${lastErr}` : ''}${skipped ? `; ${skipped} windows over the ${SWARM.maxWindows}-window cap were not asked` : ''}.
The swarm knows WHAT each shot shows; it does not know which moment is best. Model answers are guesses, P = the model's probability.

${rows.join('\n')}

NOW YOU ARE THE DIRECTOR. This is where the taste comes from (on the test shoot, this pass moved 6/13 → 9/13 shots onto the clips the editor chose):
1. frame_swarm {action: "strips"} returns a 1-frame-per-second filmstrip of the candidate clips.
2. For each slot, choose the clip and start second where the slot's moment is at its best.
3. Apply all picks in one call: frame_swarm {action: "direct", picks: [{slot, asset, start, why}]}. Keep a pick that is already right by leaving it out.
Rules:
${DIRECTOR_RULES.map((r) => `- ${r}`).join('\n')}${prof ? profileBlock(prof) : ''}`;
  } finally { p.status = prevStatus?.state === 'rendering' ? prevStatus : { state: 'active', label: 'Claude is editing' }; emit(p); }
}
/** Filmstrips of the swarm's candidate clips (or the given assets), as images for the Director. */
async function swarmStrips(p, a) {
  const ids = a.assets?.length ? a.assets : p.swarm ? [...new Set(p.swarm.slots.flatMap((s) => [s.asset, ...s.cands.map((x) => x.asset)]).filter(Boolean))] : Object.values(p.assets).filter((x) => x.kind === 'video').map((x) => x.id);
  const list = ids.map((id) => p.assets[id]).filter((as) => as?.kind === 'video').slice(0, 16);
  if (!list.length) throw new Error('No video clips to show.');
  const made = await Promise.all(list.map(async (as) => { const out = cacheFile(p, `${as.id}.strip.jpg`); const r = await filmstrip(as.path, as.duration, out); return { as, out, ...r }; }));
  feed(p, { kind: 'look', agent: 'Director', text: `Looking at ${made.length} clip${made.length === 1 ? '' : 's'} at one frame per second`, why: a.why }); emit(p);
  const content = [text(`Filmstrips: frames run left to right, then down, ${made[0].cols} per row. Frame n is at second n × step (step is 1 s unless noted). The role guess is ${MODEL}'s.`)];
  for (const m of made) {
    const r = ranked(m.as.decisions?.answers?.role).slice(0, 2).map(([k, v]) => `${k} ${pct(v)}`).join(', ');
    content.push(text(`${m.as.id} · ${m.as.name} · ${m.as.duration}s · ${m.frames} frames${m.step > 1 ? `, step ${m.step}s` : ''}${r ? ` · role guess: ${r}` : ''}`), { type: 'image', data: fs.readFileSync(m.out).toString('base64'), mimeType: 'image/jpeg' });
  }
  if (ids.length > list.length) content.push(text(`(${ids.length - list.length} more clips not shown: pass assets to see them.)`));
  return content;
}
/** Apply the Director's picks: one replace_source per slot, live, with the Director's reason. */
async function swarmDirect(p, a) {
  if (!p.swarm) throw new Error('No swarm cut in this project. Run frame_swarm first.');
  if (!Array.isArray(a.picks) || !a.picks.length) throw new Error('direct needs picks: [{slot, asset, start, why}].');
  const ops = [], notes = [];
  for (const k of a.picks) {
    const s = p.swarm.slots.find((x) => x.id === k.slot); if (!s) { notes.push(`✗ no slot "${k.slot}"`); continue; }
    const as = p.assets[k.asset]; if (!as || as.kind !== 'video') { notes.push(`✗ ${k.slot}: no video asset "${k.asset}"`); continue; }
    if (!s.clip || !p.clips.some((c) => c.id === s.clip)) { notes.push(`✗ ${k.slot}: its clip is no longer on the timeline`); continue; }
    const len = Math.min(s.seconds, as.duration), start = +Math.max(0, Math.min(as.duration - len, Number(k.start) || 0)).toFixed(2);
    if (start !== Number(k.start)) notes.push(`${k.slot}: start moved to ${start}s so the ${len}s shot fits in ${as.name}`);
    ops.push({ op: 'replace_source', id: s.clip, asset: as.id, in: start, agent: 'Director', why: `${k.slot}: ${k.why || 'Director pick'}` });
    Object.assign(s, { asset: as.id, in: start, by: 'Director', p: null });
  }
  if (!ops.length) throw new Error(`No pick could be applied:\n${notes.join('\n')}`);
  const r = resultText(await handlers.frame_edit({ project_id: p.id, agent: 'Director', summary: a.summary || `Director pass: ${ops.length} shot${ops.length === 1 ? '' : 's'} re-picked for the best moment and angle flow`, ops }));
  save(p);
  return `${r}${notes.length ? `\n\nNotes:\n${notes.join('\n')}` : ''}`;
}
/** Wait for background cutouts/transcripts of the given assets. Returns what was waited for, for the tool result. */
async function awaitPrep(p, assetIds, kinds = ['cutout']) {
  const waited = [];
  for (const id of new Set(assetIds)) for (const k of kinds) {
    const as = p.assets[id], job = as && pendingOf(p, as, k); if (!job) continue;
    const t0 = Date.now(); try { await job; } catch {}
    waited.push(`waited ${round((Date.now() - t0) / 1000, 1)}s for the background ${k} of ${id}`);
  }
  return waited;
}
/** Assets under effect clips that use a cutout. */
const effectAssets = (p) => p.clips.filter((c) => c.kind === 'effect' && (EFFECTS[c.effect.type]?.needs === 'cutout' || EFFECTS[c.effect.type]?.uses === 'cutout')).flatMap((c) => sourceClips(p, c).map((x) => x.asset));

async function renderStill(p, t, maxDim = 720, effects = {}) {
  const out = cacheFile(p, `look_${uid()}.jpg`);
  const g = buildGraph(p, { window: [t], still: true, rasters: p.rasters, effects, assetPath: assetPath(p), scale: Math.min(1, maxDim / Math.max(p.width, p.height)) });
  await run('ffmpeg', ffmpegArgs(g, out, { still: true }).filter((x) => x !== '-nostats'));
  return { file: out, warnings: g.warnings };
}

export const textHash = (p, c) => textKey(c, p.width, p.height);
const staleTexts = (p) => p.clips.filter((c) => c.kind === 'text' && p.rasters[c.id]?.hash !== textHash(p, c));

/** Keep a drawn caption. hash is the key of the text it was drawn from, so a later restyle can never reuse it. */
function storeRaster(p, c, png, x, y, hash, by) {
  const file = cacheFile(p, `text_${c.id}_${uid()}.png`);
  fs.writeFileSync(file, png);
  const old = p.rasters[c.id]?.file; if (old) fs.rm(old, { force: true }, () => {});
  p.rasters[c.id] = { file, x, y, hash, by };
  for (const k of Object.keys(p.rasters)) if (!p.clips.some((x) => x.id === k)) { fs.rm(p.rasters[k].file, { force: true }, () => {}); delete p.rasters[k]; }
}

/** Give the window a moment to draw changed captions (it does so on every update). */
async function waitRasters(p, ms = 4000) {
  const t0 = Date.now();
  while (staleTexts(p).length && clients.size && Date.now() - t0 < ms) await sleep(120);
  return staleTexts(p);
}

/**
 * Make sure every caption is drawn from its current text and style before anything is composited.
 * The window draws captions when it is open; whatever is still missing or stale is drawn by headless Chrome
 * running the same ui/text-draw.js. Returns { missing, reason } — missing captions are never composited stale.
 */
async function ensureRasters(p, waitMs = 1500) {
  if (!staleTexts(p).length) return { missing: [] };
  await waitRasters(p, waitMs);
  const todo = staleTexts(p); if (!todo.length) return { missing: [] };
  try {
    const jobs = todo.map((c) => ({ id: c.id, clip: JSON.parse(JSON.stringify(c)), W: p.width, H: p.height, hash: textHash(p, c) }));
    const out = await drawTextsHeadless(jobs);
    for (const j of jobs) { const c = p.clips.find((x) => x.id === j.id); const r = out[j.id]; if (c && r) storeRaster(p, c, r.png, r.x, r.y, j.hash, 'service'); }
    save(p);
  } catch (e) { return { missing: staleTexts(p), reason: e.message }; }
  const missing = staleTexts(p);
  return { missing, reason: missing.length ? 'the text changed while it was being drawn; try again' : undefined };
}

// ───────────────────────── style profiles
// One shared folder of plain-text profiles, outside any single Frame install (FRAME_HOME), so every AI and every copy of
// Frame reads the same rules.
const PROFILE_DIR = process.env.FRAME_PROFILES || path.join(os.homedir(), '.frame', 'profiles');
function loadProfile(name) {
  const n = String(name || 'default').replace(/[^\w.-]+/g, '').replace(/^\.+/, '');
  const f = path.join(PROFILE_DIR, `${n}.md`);
  if (!n || !fs.existsSync(f)) return null;
  const real = fs.realpathSync(f);
  return { name: n, file: real, text: fs.readFileSync(real, 'utf8').trim() };
}
const profileBlock = (pr) => pr ? `\n\n━━ STYLE PROFILE "${pr.name}" (${pr.file}) — the user's rules and the mistakes already fixed. Follow it before showing any cut. ━━\n${pr.text}\n━━ end of profile ━━` : '';

// ───────────────────────── outputs the user keeps
// Approve & save: copy a finished render out of Frame's data folder to where the user keeps finished work. Never overwrites.
const APPROVED_DIR = process.env.FRAME_APPROVED_DIR || path.join(os.homedir(), 'Movies', 'Frame', 'Approved');
function approveRender(p, id) {
  const r = (id && p.renders.find((x) => x.id === id)) || p.renders.filter((x) => x.status === 'done').at(-1);
  if (!r?.file || r.status !== 'done' || !fs.existsSync(r.file)) return { error: 'Render the project first, then approve it.' };
  mkdirp(APPROVED_DIR);
  const base = p.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'frame';
  for (let n = 1; n < 10000; n++) {
    const dest = path.join(APPROVED_DIR, `${base}_v${n}${path.extname(r.file) || '.mp4'}`);
    try { fs.copyFileSync(r.file, dest, fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code === 'EEXIST') continue; return { error: `Could not save the approved copy: ${e.message}` }; }
    feed(p, { actor: 'user', kind: 'op', op: 'approve', text: `Approved ${r.id}: saved a copy to ${dest}` }); emit(p);
    if (process.platform === 'darwin' && !process.env.FRAME_NO_OPEN) spawn('open', ['-R', dest]);
    return { ok: true, file: dest };
  }
  return { error: `Too many approved versions of "${base}" in ${APPROVED_DIR}.` };
}

// Save to Frame library: send a clip's source range to Frame Inbox (a separate local app) as reusable footage.
// If Frame Inbox is not installed or not running, this says so and changes nothing.
const INBOX_DIR = process.env.FRAME_INBOX_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'FrameInbox');
const INBOX_URL = process.env.FRAME_INBOX_URL || 'http://127.0.0.1:4875';
async function saveClipToLibrary(p, id, wanted) {
  const c = p.clips.find((x) => x.id === id), a = c && p.assets[c.asset];
  if (!c || !a || !['video', 'audio'].includes(c.kind) || !a.path) return { error: 'Select a video or audio clip to save.' };
  const tokenFile = path.join(INBOX_DIR, 'data', 'access-token');
  if (!fs.existsSync(tokenFile)) return { error: `Frame Inbox is not installed (no ${tokenFile}). Nothing was saved.` };
  const label = String(wanted || c.label || a.name || 'cut').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const out = path.join(os.tmpdir(), `frame-save-${uid('')}.mp4`);
  feed(p, { actor: 'user', kind: 'op', op: 'save_clip', text: `Saving "${label}" (source ${tc(c.in)}–${tc(c.out)}) to your Frame library…`, clipIds: [c.id] }); emit(p);
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(c.in), '-to', String(c.out), '-i', a.path, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]);
    const q = `name=${encodeURIComponent(`${label}_${c.id}.mp4`)}&role=${encodeURIComponent(`saved_cut:${label}`)}`;
    let res;
    try { res = await fetch(`${INBOX_URL}/api/upload?${q}`, { method: 'POST', headers: { 'x-frame-token': fs.readFileSync(tokenFile, 'utf8').trim(), 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(out), signal: AbortSignal.timeout(120000) }); }
    catch (e) { throw new Error(`Frame Inbox is not running at ${INBOX_URL} (${e.cause?.code || e.message})`); }
    let j; try { j = await res.json(); } catch { j = { error: `Frame Inbox answered HTTP ${res.status}` }; }
    if (!res.ok || j.error) throw new Error(j.error || `Frame Inbox answered HTTP ${res.status}`);
    feed(p, { actor: 'user', kind: 'op', op: 'save_clip', text: `Saved "${label}" to your Frame library${j.duplicate ? ' (it was already there)' : ''}.`, clipIds: [c.id] }); emit(p);
    return { ok: true, label, duplicate: !!j.duplicate };
  } catch (e) {
    feed(p, { actor: 'user', kind: 'op', op: 'save_clip', text: `Could not save "${label}": ${e.message}. Nothing was saved.`, clipIds: [c.id] }); emit(p);
    return { error: `Could not save: ${e.message}` };
  } finally { fs.rmSync(out, { force: true }); }
}

// ───────────────────────── tools
const handlers = {
  async frame_start(a) {
    if (a.action === 'list') { const l = listProjects(); return [text(l.length ? l.map((x) => `${x.id} · "${x.name}" · ${x.duration}s · ${x.clips} clips · ${new Date(x.updatedAt).toLocaleString()}`).join('\n') : 'No projects yet.')]; }
    const wantProfile = a.profile || (a.project_id ? current(a.project_id).profile : null);
    const prof = loadProfile(wantProfile);
    if (a.profile && !prof) throw new Error(`No style profile "${a.profile}" in ${PROFILE_DIR}. frame_profile {action:"list"} names the saved ones.`);
    let p;
    if (a.project_id) { p = current(a.project_id); }
    else { p = newProject({ name: a.name || 'Untitled edit', aspect: a.aspect || '9:16', fps: a.fps || 30 }); p.inbox = []; p.rasters = {}; projects.set(p.id, p); }
    setCurrent(p.id);
    if (prof && p.profile !== prof.name) { p.profile = prof.name; feed(p, { actor: 'frame', kind: 'system', text: `Style profile "${prof.name}" applies to this edit` }); }
    if (a.plan) { p.plan = a.plan; feed(p, { kind: 'plan', text: a.plan }); }
    else if (!a.project_id) feed(p, { kind: 'system', actor: 'frame', text: `Session opened · ${p.width}×${p.height} @ ${p.fps} fps` });
    emit(p);
    const shown = await ensureWindow();
    return [text(`Frame is live at ${BASE} ${shown ? '(window is open and connected)' : '(could not confirm a window is open — tell the user to open that URL; if you have a browser/preview pane tool, open it there)'}.\n\n${describe(p)}\n\nThe user is watching. Narrate with frame_note, make every change through frame_edit, and check each tool result for user input.${prof ? profileBlock(prof) : `\n\nNo style profile found (${PROFILE_DIR}/${String(wantProfile || 'default')}.md).`}`)];
  },

  async frame_import(a) {
    const p = current(a.project_id);
    let files = [];
    for (const f of a.paths || []) {
      const abs = path.resolve(String(f).replace(/^~(?=[\\/])/, os.homedir()));
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) files.push(...fs.readdirSync(abs).filter((n) => media.kindFromExt(n)).sort().map((n) => path.join(abs, n)));
      else files.push(abs);
    }
    if (!files.length) throw new Error('frame_import needs paths: absolute paths to video, audio or image files (or a folder of them).');
    const out = [], prep = [];
    if (a.decide_pack && !PACKS[a.decide_pack]) throw new Error(`Unknown decide_pack "${a.decide_pack}". Packs: ${Object.keys(PACKS).join(', ')}.`);
    if (a.decide_pack) p.decisionPack = a.decide_pack;
    const pack = p.decisionPack || 'general';
    const batch = a.decide !== false ? labelBatch(p, { pack, auto: true, why: 'Started at import so clips can be picked by reading the sheet instead of looking at each one' }) : null;
    const labeled = [], tooLong = [];
    for (const f of files) {
      try {
        const as = await importOne(p, f, a); out.push(assetSummary(p, as));
        if (batch && as.kind === 'video' && !pendingOf(p, as, 'decisions') && !(as.decisions?.status === 'done' && as.decisions.pack === pack)) {
          if (as.duration > MAX_SECONDS) tooLong.push(as.id); else { batch.add(as); labeled.push(as.id); }
        }
        // prepare (default on for video up to 3 minutes): start the person cutout and the transcript in the background now.
        if (a.prepare !== false && as.kind === 'video' && as.duration <= 180) {
          if (!as.cutout && !pendingOf(p, as, 'cutout') && (await cutoutEngine()).id) { startCutout(p, as, { from: 0, to: as.duration, auto: true, why: 'Started at import so effects are ready when they are placed' }).catch(() => {}); prep.push(`person cutout of ${as.id} (${Math.round(as.duration * (as.fps || 30))} frames)`); }
        }
        // The transcript is prepared for any length when the fast on-device engine is here (8.7 min ≈ 5 s), else up to 3 minutes.
        if (a.prepare !== false && as.hasAudio && (as.kind === 'video' || as.kind === 'audio') && !as.transcript && !pendingOf(p, as, 'transcript')) {
          const eng = await media.transcriber();
          if (eng && (eng.id === 'apple' || as.duration <= 180)) { startTranscript(p, as, { why: 'Started at import so words are ready for captions and cues' }).catch(() => {}); prep.push(`transcript of ${as.id} (${eng.label})`); }
        }
      } catch (e) { out.push(`✗ ${f}: ${e.message}`); }
    }
    let sheet = '';
    if (batch && labeled.length) {
      const t0 = Date.now(), all = batch.finish();
      await Promise.race([all, sleep(Number(a.decide_wait_s ?? 12) * 1000)]);
      const waiting = labeled.filter((id) => p.assets[id].decisions?.status === 'pending');
      sheet = `\n\n${decisionSheet(p, labeled)}\n  (labels took ${round((Date.now() - t0) / 1000, 1)}s after the last import${waiting.length ? `; still labeling ${waiting.join(', ')}: frame_state shows them when done` : ''})`;
    }
    if (tooLong.length) sheet += `\n\nNot labeled (longer than ${MAX_SECONDS}s): ${tooLong.join(', ')}. Ask about a range with frame_decide {assets, from, to, questions}.`;
    if (!batch && (a.decide === true || a.decide_pack)) sheet += `\n\nClip labels are off: ${decisionsConfig().reason}.`;
    return [text(`Imported into "${p.name}":\n` + out.map((s) => '  ' + s).join('\n') + (prep.length ? `\n\nPreparing in the background: ${prep.join(', ')}. frame_cutout, frame_transcribe, effects and captions wait for them automatically; carry on editing.` : '') + sheet)];
  },

  async frame_transcribe(a) {
    const p = current(a.project_id); const asset = p.assets[a.asset];
    if (!asset) throw new Error(`No asset "${a.asset}".`);
    if (a.words) {
      asset.transcript = { engine: a.source || 'supplied by Claude', words: a.words.map((w) => ({ text: String(w.text).trim(), start: round(Number(w.start), 2), end: round(Number(w.end), 2) })) };
      feed(p, { kind: 'op', op: 'transcript', text: `Transcript attached to ${asset.name}: ${asset.transcript.words.length} words` }); emit(p);
      return [text(`Stored ${asset.transcript.words.length} words on ${asset.id}.`)];
    }
    const waited = await awaitPrep(p, [asset.id], ['transcript']);
    if (asset.transcript && !a.force) return [text(`${waited.length ? `(${waited[0]})\n` : ''}Transcript of ${asset.id} (${asset.transcript.engine}), source seconds:\n${transcriptLines(asset.transcript.words)}`)];
    if (!(await media.transcriber())) return [text(`No transcription engine on this machine, so Frame cannot transcribe by itself. Options: (1) on macOS 26+, install the Xcode command line tools (\`xcode-select --install\`) for Apple's on-device speech; anywhere, \`pip install -U openai-whisper\`; then call again, or (2) get word timings any other way and call frame_transcribe with words: [{text,start,end}].`)];
    await startTranscript(p, asset, { model: a.model, language: a.language, engine: a.engine, why: a.why });
    const t = asset.transcript;
    return [text(`Transcript of ${asset.id} (${t.engine}, ${t.seconds}s${t.spelled ? `, ${t.spelled} name(s) fixed from spellings.json` : ''}), source seconds. Speech engines mishear names — check before using as captions, and add lasting fixes to ${path.join(HOME, 'spellings.json')} as {"heard": "Correct"}.\n${transcriptLines(t.words)}`)];
  },

  async frame_note(a) {
    const p = current(a.project_id);
    feed(p, { kind: ['thinking', 'decision', 'plan', 'question', 'note'].includes(a.kind) ? a.kind : 'note', text: String(a.text || '').slice(0, 2000), agent: a.agent });
    if (a.kind === 'plan') p.plan = a.text;
    emit(p);
    return [text('Shown in Frame.')];
  },

  async frame_check_speech(a) {
    const p = current(a.project_id);
    const list = speechCutoffs(p, loadEnv(p));
    const air = deadAirLines(deadAir(p, loadEnv(p)), tc);
    if (!list.length) return [text(`No speech is cut off: every V1 cut lands in measured silence.${air.length ? `\n${air.join('\n')}` : ''}`)];
    const lines = cutoffLines(list, tc).join('\n');
    if (!a.fix) return [text(`${list.length} cut(s) clip speech:\n${lines}\nCall again with fix: true to extend the fixable ones (ripples the whole timeline).`)];
    const ops = list.filter((x) => x.fix).map((x) => ({ op: 'extend_clip', id: x.id, edge: x.edge, by: x.by, why: `"${x.word}" was cut off at the ${x.edge}` }));
    if (!ops.length) return [text(`Nothing auto-fixable:\n${lines}`)];
    const r = await handlers.frame_edit({ project_id: p.id, summary: `Let every word finish: ${ops.length} speech cut-off(s) fixed`, agent: 'Cutter', ops });
    const left = speechCutoffs(p, loadEnv(p));
    return [...r, text(left.length ? `Still flagged:\n${cutoffLines(left, tc).join('\n')}` : 'Re-checked: no speech is cut off now.')];
  },

  async frame_prompt(a) { const p=current(a.project_id);if(p.paused)throw new Error('Frame is paused. Resume before starting a prompt.');const job=promptRunner.queue(p,a);return [text(JSON.stringify({job_id:job.id,cursor:job.cursor,status:job.status}))]; },
  async frame_prompt_jobs(a) {const p=current(a.project_id);return [text(JSON.stringify(p.promptJobs||[]))];},
  async frame_revisions(a) {
    const p=current(a.project_id);
    if(a.action==='revert'){const rs=revertRevision(p,a.revision_id,{loadEnv:loadEnv(p),beforeApply:()=>snapshot(p)},{type:'agent',name:a.agent||'Agent'});for(const r of rs)feed(p,{kind:'op',op:'revert_revision',revisionId:r.revision?.id,text:r.text,clipIds:r.clipIds,t:r.t,agent:a.agent});emit(p);return [text('Revision reverted through the shared editor.')];}
    return [text(JSON.stringify((p.revisions||[]).slice(-Math.min(a.limit||20,100))))];
  },

  async frame_edit(a) {
    const p = current(a.project_id);
    if (!Array.isArray(a.ops) || !a.ops.length) throw new Error('frame_edit needs ops: [{op: "...", ...}].');
    if (p.paused) return [text('Not applied.')];
    if (a.ops.some((o) => ['add_captions', 'add_effects_at_words'].includes(o.op))) { // these read the transcript: wait for one still being made
      const tracks = new Set(a.ops.map((o) => o.source_track || o.source || 'V1'));
      await awaitPrep(p, p.clips.filter((c) => tracks.has(c.track) && c.asset).map((c) => c.asset), ['transcript']);
    }
    snapshot(p);
    const fast = a.fast === true, focuses = new Map(), touched = new Set();
    const feedEntries = [], revisions = [];
    const clipDelta = fast && a.ops.every(op => op.op === 'patch_graphic' ||
      (op.op === 'update_clip' && op.params && Object.keys(op).every(k=>['op','id','params','agent','why','ripple'].includes(k))));
    if (a.summary) { feedEntries.push(feed(p, { kind: 'decision', text: a.summary, agent: a.agent })); if (!fast) { emit(p); if (PACE > 0) await sleep(PACE); } }
    const results = [];
    for (let i = 0; i < a.ops.length; i++) {
      const op = a.ops[i];
      if (p.paused) { results.push(`${i + 1}. ⏸ not applied — the user paused`); continue; }
      try {
        const r = applyRevision(p, op, { loadEnv: loadEnv(p) }, { type: 'agent', name: op.agent || a.agent || 'Agent' });
        const message = clipDelta && op.params?.nodes ? `Revised layers in ${p.clips.find(c=>c.id===op.id)?.label || op.id}` : r.text;
        feedEntries.push(feed(p, { revisionId: r.revision?.id, kind: 'op', op: op.op, text: message, why: op.why, clipIds: r.clipIds, t: r.t, agent: op.agent || a.agent }));
        if (r.revision) revisions.push(r.revision);
        for (const id of r.clipIds || []) touched.add(id);
        results.push(`${i + 1}. ✓ ${message}${r.clipIds?.length && r.clipIds.length <= 6 ? ` [${r.clipIds.join(', ')}]` : ''}`);
        const focus = { clipIds: r.clipIds, t: Number.isFinite(a.preview_at) ? a.preview_at : r.t, agent: op.agent || a.agent || 'Claude', canvas: Number.isFinite(a.preview_at) };
        if (fast) focuses.set(focus.agent, focus); else emit(p, { focus });
        if (!fast && PACE > 0 && i < a.ops.length - 1) await sleep(PACE);
      } catch (e) { results.push(`${i + 1}. ✗ ${op.op}: ${e.message}`); }
    }
    if (clipDelta) emitClipChanges(p, touched, feedEntries, revisions, [...focuses.values()]);
    else if (fast) emit(p, { focuses: [...focuses.values()] });
    if (!fast && clients.size) await waitRasters(p, 1500);
    const issues = timelineIssues(p);
    return [text(`${results.join('\n')}${issues.length ? '\n\n' + issues.map((x) => '⚠ ' + x).join('\n') : ''}\n\n${describe(p)}`)];
  },

  async frame_cut_silence(a) {
    const { why: w, project_id, ...args } = a;
    return handlers.frame_edit({ project_id, summary: a.dry_run ? 'Checking which pauses can be cut' : `Cutting dead air (${a.style || 'tight'})`, ops: [{ op: 'remove_silences', why: w || 'Remove dead air', ...args }] });
  },

  async frame_pack(a) {
    const act = a.action || 'list';
    if (act === 'list' || act === 'show') {
      const all = a.pack ? [packs.getPack(a.pack)].filter(Boolean) : packs.listPacks();
      if (a.pack && !all.length) throw new Error(`No audio pack "${a.pack}". Packs: ${packs.listPacks().map((p) => p.id).join(', ') || 'none yet'}`);
      return [text(all.length ? all.map(packs.describePack).join('\n\n') : 'No audio packs saved yet. Save sounds you use with frame_pack {action:"save", name, items:[{path, name, kind, desc}]}.')];
    }
    if (act === 'save') {
      const r = await packs.savePack(a);
      return [text(`Saved ${r.saved.length} item${r.saved.length === 1 ? '' : 's'} to pack "${r.pack.name}" (${r.pack.id}); it now has ${r.pack.items.length}. Files live in ${path.join(HOME, 'packs', r.pack.id)} and show in Frame's Audio packs panel.\n\n${packs.describePack(r.pack)}`)];
    }
    if (act === 'use') {
      const p = current(a.project_id); const pk = packs.getPack(a.pack); if (!pk) throw new Error(`No audio pack "${a.pack}". Packs: ${packs.listPacks().map((x) => x.id).join(', ') || 'none yet'}`);
      const ids = a.items?.length ? a.items : pk.items.map((i) => i.id); const out = [];
      for (const id of ids) { const as = await importOne(p, packs.packFile(pk, id), { why: a.why || `From audio pack "${pk.name}"` }); as.pack = { pack: pk.id, item: id }; out.push(assetSummary(p, as)); }
      emit(p); return [text(`Imported ${out.length} from pack "${pk.name}":\n  ${out.join('\n  ')}`)];
    }
    throw new Error('frame_pack action must be "list", "show", "save" or "use".');
  },

  async frame_step(a) {
    const p = current(a.project_id);
    let s = a.id && p.steps.find((x) => x.id === a.id);
    if (!s) { s = { id: a.id || uid('s_'), startedAt: Date.now() }; p.steps.push(s); }
    for (const k of ['title', 'tool', 'code', 'note']) if (a[k] != null) s[k] = String(a[k]).slice(0, 20000);
    s.status = a.status || s.status || 'running';
    if (s.status !== 'running') s.endedAt = Date.now();
    feed(p, { kind: 'step', text: `${s.status === 'running' ? 'Started' : s.status === 'failed' ? 'Failed' : 'Finished'}: ${s.title || 'process'}${s.tool ? ` (${s.tool})` : ''}`, why: a.note, stepId: s.id });
    emit(p);
    const out = [];
    if (s.status === 'done') for (const f of a.outputs || []) { try { const as = await importOne(p, f, { why: `Output of “${s.title}”` }); (s.outputs ||= []).push(as.id); out.push(assetSummary(p, as)); } catch (e) { out.push(`✗ ${f}: ${e.message}`); } }
    emit(p);
    return [text(`Step ${s.id} is ${s.status} and visible in Frame's Process panel.${out.length ? '\nOutputs imported:\n  ' + out.join('\n  ') : ''}`)];
  },

  async frame_camera_move(a) {
    const p = current(a.project_id);
    const src = p.assets[a.asset]; if (!src || src.kind !== 'image') throw new Error(`frame_camera_move needs an image asset (got "${a.asset}"). Import a still first.`);
    const move = a.move || 'push_in', seconds = Math.min(12, Math.max(1, Number(a.seconds) || 4)), strength = Math.min(2, Math.max(0.2, Number(a.strength) || 1));
    const out = cacheFile(p, `cam_${uid()}.mp4`), depth = cacheFile(p, `depth_${uid()}.png`);
    const script = fileURLToPath(new URL('../scripts/camera_move.py', import.meta.url));
    const args = [script, src.path, out, '--move', move, '--seconds', String(seconds), '--strength', String(strength), '--size', `${p.width}x${p.height}`, '--fps', String(p.fps), '--depth-out', depth];
    const code = `python3 ${args.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}`;
    const step = { id: uid('s_'), startedAt: Date.now(), title: `Camera move: ${move} on ${src.name}`, tool: 'Depth-Anything-V2-Small + OpenCV', code, status: 'running', note: 'Depth-based 2.5D parallax. Not a true 3D world; edges revealed behind objects are stretched, not invented.' };
    p.steps.push(step); feed(p, { kind: 'step', text: `Started: ${step.title}`, stepId: step.id, why: a.why }); emit(p);
    try { await run('python3', args, { timeout: 600000 }); }
    catch (e) { step.status = 'failed'; step.endedAt = Date.now(); feed(p, { kind: 'step', text: `Failed: ${step.title}`, why: String(e.message).slice(-300), stepId: step.id }); emit(p); throw new Error(`Camera move failed: ${String(e.message).slice(-400)}. Needs python3 with torch, transformers, opencv-python, pillow (first run downloads the depth model).`); }
    step.status = 'done'; step.endedAt = Date.now();
    const asset = await importOne(p, out, { why: `Camera move (${move}) from ${src.name}` });
    (step.outputs ||= []).push(asset.id);
    const dm = await importOne(p, depth, { why: 'Depth map used for the move' }).catch(() => null);
    if (dm) step.outputs.push(dm.id);
    feed(p, { kind: 'step', text: `Finished: ${step.title}`, stepId: step.id }); emit(p);
    let msg = `Rendered ${seconds}s ${move} (strength ${strength}) → ${assetSummary(p, asset)}${dm ? `\nDepth map: ${assetSummary(p, dm)}` : ''}`;
    if (a.place !== false) {
      snapshot(p);
      const r = applyOp(p, { op: 'add_clip', asset: asset.id, track: a.track, start: a.start }, { loadEnv: loadEnv(p) });
      feed(p, { kind: 'op', op: 'add_clip', text: r.text, why: a.why || `Camera move on ${src.name}`, clipIds: r.clipIds, t: r.t }); emit(p, { focus: { clipIds: r.clipIds, t: r.t } });
      msg += `\n✓ ${r.text} [${r.clipIds.join(', ')}]`;
    }
    return [text(msg)];
  },

  async frame_cutout(a) {
    const p = current(a.project_id);
    const as = p.assets[a.asset];
    if (!as) throw new Error(`No asset "${a.asset}". Assets: ${Object.keys(p.assets).join(', ') || 'none'}`);
    if (as.kind !== 'video') throw new Error(`${as.name} is ${as.kind}; frame_cutout works on video footage.`);
    const { from, to } = cutoutRange(p, as, a);
    if (!(to - from >= 0.1)) throw new Error(`from ${from} – to ${to} is not a range of ${as.name} (${as.duration}s long).`);
    const waited = await awaitPrep(p, [as.id], ['cutout']);
    const quality = ['fast', 'balanced', 'accurate'].includes(a.quality) ? a.quality : as.cutout?.quality || 'balanced';
    const ready = (c) => c && c.from <= from + 1e-3 && c.to >= to - 1e-3 && c.quality === quality;
    let r = as.cutout;
    if (!ready(r) || a.force) r = await startCutout(p, as, { from, to, quality, why: a.why });
    else if (!waited.length) return [text(`${as.id} already has a cutout covering source ${r.from}–${r.to}s (${r.engine}, ${r.quality}). Pass force: true to make it again.`)];
    const facePart = `face found in ${r.withFace}/${r.frames}`;
    const warn = r.withPerson < r.frames * 0.9 ? `\n⚠ No person was found in ${r.frames - r.withPerson} of ${r.frames} frames; effects that need the cutout show nothing of the person on those frames.` : '';
    return [text(`${waited.length ? `(${waited.join('; ')})\n` : ''}Cut out the person in ${as.id} (${as.name}), source ${r.from}–${r.to}s: ${r.frames} frames at ${r.fps} fps, ${r.width}×${r.height}, in ${r.seconds}s with ${r.engineLabel} (${r.quality}, ${r.chunks} parallel chunk${r.chunks === 1 ? '' : 's'}).\nMeasured on the matte: person in ${r.withPerson}/${r.frames} frames, on average ${Math.round(r.cover * 100)}% of the picture; ${facePart}.${warn}\nEffects marked [needs a cutout] can now be used on this footage (frame_effects lists them).`)];
  },

  async frame_effects(a) {
    const p = (() => { try { return current(a.project_id); } catch { return null; } })();
    let s = `Effect clips are layers on a V track above the footage they read (V1 unless source is set). Add one with frame_edit {op:"add_effect", effect, start, duration, params?, track?, source?}; change settings with update_clip {id, params:{…}}; opacity, fadeIn and fadeOut work as on any clip. Every effect is drawn by ui/effects.js — the same code in the window preview, frame_view and the render.\n\n${describeEffects()}`;
    if (p) {
      const vids = Object.values(p.assets).filter((x) => x.kind === 'video');
      if (vids.length) s += `\n\nCutouts in this project: ${vids.map((x) => `${x.id} ${x.cutout ? `✓ source ${x.cutout.from}–${x.cutout.to}s` : x.cutting ? `… ${x.cutting} (background)` : '✗ none (frame_cutout)'}`).join(' · ')}`;
      const fx = p.clips.filter((c) => c.kind === 'effect');
      for (const c of fx) { const pr = effectProblem(p, c); if (pr) s += `\n⚠ ${c.id} (${c.effect.type}): ${pr}${sourceClips(p, c).some((x) => pendingOf(p, p.assets[x.asset], 'cutout')) ? ' (a cutout is being made in the background right now; it is waited for automatically)' : ''}`; }
      const busy = vids.filter((x) => x.cutting); if (busy.length) s += `\nCutouts running in the background: ${busy.map((x) => `${x.id} ${x.cutting}`).join(', ')}`;
    }
    return [text(s)];
  },

  async frame_view(a) {
    const p = current(a.project_id); const content = [];
    if (a.asset) {
      const asset = p.assets[a.asset]; if (!asset) throw new Error(`No asset "${a.asset}".`);
      const times = (a.times || [0]).slice(0, 8);
      for (const t of times) {
        const out = cacheFile(p, `src_${uid()}.jpg`);
        await run('ffmpeg', ['-v', 'error', '-y', ...(asset.kind === 'image' ? [] : ['-ss', String(t)]), '-i', asset.path, '-frames:v', '1', '-vf', 'scale=-2:540', '-q:v', '5', out]);
        content.push(text(`Source ${asset.id} at ${t}s:`), { type: 'image', data: fs.readFileSync(out).toString('base64'), mimeType: 'image/jpeg' });
        fs.unlinkSync(out);
      }
      feed(p, { kind: 'look', text: `Looked at ${asset.name} at ${times.map((t) => tc(t)).join(', ')}`, why: a.why });
      emit(p); return content;
    }
    const times = (a.times || [a.t ?? 0]).slice(0, 6).map((t) => Math.round(Number(t) * p.fps) / p.fps); // whole frames, so effects line up with the footage
    const { missing, reason } = await ensureRasters(p);
    const waited = await awaitPrep(p, effectAssets(p));
    if (waited.length) content.push(text(`(${waited.join('; ')})`));
    const pv = liveStack(p), fx = await drawEffects(p, { times, view: pv });
    for (const t of times) {
      const r = await renderStill(pv, Number(t), 720, fx.drawn);
      const name = path.basename(r.file);
      content.push(text(`Composited frame at ${t}s (rendered by the same ffmpeg graph as the final export):`), { type: 'image', data: fs.readFileSync(r.file).toString('base64'), mimeType: 'image/jpeg' });
      feed(p, { kind: 'look', text: `Checked the composited frame at ${tc(Number(t))}`, why: a.why, img: `/cache/${p.id}/${name}`, t: Number(t) });
      emit(p, { focus: { t: Number(t), agent: 'Claude' } });
    }
    if (missing.length) content.push(text(`⚠ ${missing.length} text clip(s) are NOT in these frames (${missing.map((c) => `"${c.text.content.slice(0, 20)}"`).join(', ')}): ${reason}.`));
    for (const pr of fx.problems) content.push(text(`⚠ Effect not in these frames: ${pr}`));
    return content;
  },

  async frame_profile(a) {
    if (a.action === 'list') { const l = fs.existsSync(PROFILE_DIR) ? fs.readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : []; return [text(l.length ? `Profiles in ${PROFILE_DIR}: ${l.join(', ')}` : `No profiles in ${PROFILE_DIR}.`)]; }
    let name = a.name; if (!name) { try { name = current(a.project_id).profile; } catch {} }
    const pr = loadProfile(name); if (!pr) throw new Error(`No style profile "${name || 'default'}" in ${PROFILE_DIR}.`);
    return [text(profileBlock(pr).trim())];
  },

  async frame_state(a) {
    const p = current(a.project_id);
    let s = describe(p);
    if (p.profile) s += `\n\nStyle profile: "${p.profile}" applies (frame_profile shows it).`;
    const sheet = decisionSheet(p); if (sheet) s += `\n\n${sheet}`;
    if (a.include_transcript) for (const as of Object.values(p.assets)) if (as.transcript) s += `\n\nTranscript ${as.id} (source seconds):\n${transcriptLines(as.transcript.words)}`;
    if (a.include_timeline_words) { const w = timelineWords(p, a.track || 'V1'); s += `\n\nWords as they now fall on the timeline (${a.track || 'V1'}):\n${transcriptLines(w)}`; }
    const rn = p.renders.at(-1); if (rn) s += `\n\nLast render: ${rn.status}${rn.file ? ' · ' + rn.file : ''}${rn.progress != null && rn.status === 'rendering' ? ` · ${Math.round(rn.progress * 100)}%` : ''}`;
    return [text(s)];
  },

  async frame_decide(a) {
    const p = current(a.project_id);
    const cfg = decisionsConfig(); if (!cfg.on) throw new Error(`frame_decide is off: ${cfg.reason}.`);
    const ids = a.assets?.length ? a.assets : Object.values(p.assets).filter((x) => x.kind === 'video').map((x) => x.id);
    if (!ids.length) throw new Error('No video clips to ask about. Import footage first.');
    const list = ids.map((id) => { const as = p.assets[id]; if (!as) throw new Error(`No asset "${id}".`); if (as.kind !== 'video') throw new Error(`${id} is ${as.kind}: frame_decide reads video clips only.`); return as; });
    // Re-label with a pack (for clips imported before labels existed, or to switch packs).
    if (a.pack && !a.questions) {
      const batch = labelBatch(p, { pack: a.pack, why: a.why });
      for (const as of list) { if (as.duration > MAX_SECONDS) throw new Error(`${as.id} is ${as.duration}s; packs label clips up to ${MAX_SECONDS}s. Ask about a range with from/to and questions instead.`); batch.add(as); }
      await batch.finish(); p.decisionPack = a.pack; save(p);
      return [text(decisionSheet(p, ids))];
    }
    const qs = normaliseQuestions(a.questions);
    const from = a.from != null ? Math.max(0, Number(a.from)) : null, to = a.to != null ? Number(a.to) : null;
    for (const as of list) {
      const span = (to ?? as.duration) - (from ?? 0);
      if (!(span > 0)) throw new Error(`from/to give an empty range for ${as.id} (${as.duration}s long).`);
      if (span > MAX_SECONDS) throw new Error(`${as.id}: ${round(span, 1)}s is too long to ask about in one go; pass from/to (source seconds) for a range of at most ${MAX_SECONDS}s.`);
    }
    const range = from != null || to != null ? ` (source ${from ?? 0}–${to ?? 'end'}s)` : '';
    feed(p, { kind: 'look', text: `Asked ${MODEL} ${Object.keys(qs).length} question${Object.keys(qs).length === 1 ? '' : 's'} about ${list.length} clip${list.length === 1 ? '' : 's'}${range}: ${Object.keys(qs).join(', ')}`, why: a.why }); emit(p);
    const t0 = Date.now();
    const res = await Promise.all(list.map(async (as) => {
      try {
        const name = from != null || to != null ? `${as.id}.decide.${round(from ?? 0, 2)}-${round(to ?? as.duration, 2)}.mp4` : `${as.id}.decide.mp4`;
        const px = await makeDecisionProxy(as.path, cacheFile(p, name), { from: from ?? 0, to: to ?? undefined });
        return { as, ...(await ask(cfg, px, qs)) };
      } catch (e) { return { as, error: e.message }; }
    }));
    const tokens = res.reduce((n, r) => n + (r.tokens || 0), 0);
    const lines = res.map((r) => r.error ? `  ${r.as.id} ${r.as.name}: failed: ${r.error}` : `  ${r.as.id} ${r.as.name} (${round(r.ms / 1000, 1)}s):\n${Object.entries(qs).map(([k, q]) => { const an = r.answers[k]; return `      ${k}: ${answerText(q, an)}${an?.confidence != null && an.confidence < THRESHOLD ? ` (unsure: confidence ${Math.round(an.confidence * 100)}%)` : ''}`; }).join('\n')}`);
    return [text(`${MODEL} answers — the model's guesses, NOT measurements${range}. ${list.length} clip${list.length === 1 ? '' : 's'} in ${round((Date.now() - t0) / 1000, 1)}s${tokens ? `, ${tokens} tokens` : ''}. Where it is unsure, look with frame_view.\n${lines.join('\n')}`)];
  },

  async frame_swarm(a) {
    const p = current(a.project_id);
    const act = a.action || 'run';
    if (act === 'strips') return swarmStrips(p, a);
    if (act === 'direct') return [text(await swarmDirect(p, a))];
    if (act !== 'run') throw new Error('action must be "run", "strips" or "direct".');
    return [text(await swarmRun(p, a))];
  },

  async frame_wait(a) {
    const p = current(a.project_id);
    const until = Date.now() + Math.min(Number(a.timeout_s || 45), 50) * 1000;
    p.status = { state: 'waiting', label: 'Claude is waiting for you' }; emit(p);
    const wasPaused = p.paused;
    while (Date.now() < until && !p.inbox.length && p.paused === wasPaused) await sleep(250);
    return [text(p.inbox.length || p.paused !== wasPaused ? 'The user responded.' : 'No user input yet. Call frame_wait again to keep waiting, or continue if you were not paused.')];
  },

  async frame_history(a) {
    const p = current(a.project_id);
    const ok = timeTravel(p, a.action === 'redo' ? 'redo' : 'undo');
    if (ok) feed(p, { kind: 'op', op: a.action, text: a.action === 'redo' ? 'Redo' : 'Undo — timeline restored to the previous state', why: a.why });
    emit(p);
    return [text(`${ok ? 'Done.' : 'Nothing to ' + (a.action || 'undo') + '.'}\n\n${describe(p)}`)];
  },

  async frame_render(a) {
    const p = current(a.project_id);
    if (p.paused) return [text('Not rendered.')];
    const D = projectDuration(p); if (!D) throw new Error('The timeline is empty — nothing to render.');
    const { missing, reason } = await ensureRasters(p, 3000);
    if (missing.length && !a.allow_missing_text) throw new Error(`Not rendered: ${missing.length} text clip(s) could not be drawn from their current text and style (${missing.map((c) => `"${c.text.content.slice(0, 20)}"`).join(', ')}): ${reason}. Fix that and render again, or pass allow_missing_text: true to render without them.`);
    // Refuse before drawing anything when an effect cannot be drawn; then draw, and refuse if drawing itself failed.
    const refuse = (list) => { throw new Error(`Not rendered: ${list.join(' ')} Fix that and render again, or pass allow_missing_effects: true to render without them.`); };
    const waited = await awaitPrep(p, effectAssets(p));
    const known = p.clips.filter((c) => c.kind === 'effect').map((c) => [c, effectProblem(p, c)]).filter(([, pr]) => pr).map(([c, pr]) => `${EFFECTS[c.effect.type]?.label || c.effect.type} (${c.id}) at ${round(c.start, 2)}s was left out: ${pr}.`);
    if (known.length && !a.allow_missing_effects) refuse(known);
    const pv = liveStack(p), fx = await drawEffects(p, { window: [0, D], view: pv });
    if (fx.problems.length && !a.allow_missing_effects) refuse(fx.problems);
    const quality = a.quality === 'draft' ? 'draft' : 'final';
    const n = p.renders.length + 1;
    const safe = p.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'frame';
    const videos = ['Movies', 'Videos'].map((d) => path.join(os.homedir(), d)).find((d) => fs.existsSync(d)); // macOS, Windows
    const outDir = mkdirp(a.output_dir ? path.resolve(a.output_dir.replace(/^~(?=[\\/])/, os.homedir())) : path.join(videos || os.homedir(), 'Frame'));
    const file = path.join(outDir, `${safe}_v${n}${quality === 'draft' ? '_draft' : ''}.mp4`);
    const g = buildGraph(pv, { rasters: p.rasters, effects: fx.drawn, assetPath: assetPath(p), scale: quality === 'draft' ? 0.5 : 1, loudnorm: a.loudnorm !== false });
    const r = { id: 'r' + n, status: 'rendering', progress: 0, file, quality, startedAt: Date.now(), timelineVersion: p.version };
    p.renders.push(r); p.status = { state: 'rendering', label: 'Rendering' };
    feed(p, { actor: 'frame', kind: 'render', text: `Rendering ${quality} MP4 · ${round(D, 2)}s · ${g.inputs.length} inputs through ffmpeg`, why: a.why, renderId: r.id }); emit(p);
    let lastEmit = 0;
    try {
      await runFfmpeg(ffmpegArgs(g, file, { quality }), D, (pr) => { r.progress = pr; if (Date.now() - lastEmit > 300) { lastEmit = Date.now(); emit(p); } });
      const info = await media.probe(file); const loud = await media.loudness(file);
      Object.assign(r, { status: 'done', progress: 1, endedAt: Date.now(), duration: info.duration, width: info.width, height: info.height, bytes: fs.statSync(file).size, loudness: loud });
      p.status = { state: 'done', label: 'Render complete' };
      feed(p, { actor: 'frame', kind: 'render', text: `Render complete · ${info.width}×${info.height} · ${info.duration}s · ${(r.bytes / 1e6).toFixed(1)} MB${loud ? ` · ${loud.lufs} LUFS` : ''} · took ${round((r.endedAt - r.startedAt) / 1000, 1)}s`, renderId: r.id, done: true });
      emit(p, { rendered: r.id });
      return [text(`Rendered: ${file}\nMeasured: ${info.width}×${info.height}, ${info.duration}s, ${(r.bytes / 1e6).toFixed(1)} MB${loud ? `, ${loud.lufs} LUFS integrated, true peak ${loud.true_peak_db} dBFS` : ''}.${fx.count ? `\nDrew ${fx.count} new effect frame(s) with ui/effects.js in headless Chrome.` : ''}${[...g.warnings, ...cutoffLines(speechCutoffs(p, loadEnv(p)), tc), ...deadAirLines(deadAir(p, loadEnv(p)), tc), ...(missing.length ? [`${missing.length} text clip(s) left out of this render on request (allow_missing_text): ${reason}`] : []), ...fx.problems].map((w) => '\n⚠ ' + w).join('')}\nThe user can play it in the Frame window. Use frame_view to check frames yourself.`)];
    } catch (e) {
      Object.assign(r, { status: 'failed', error: e.message }); p.status = { state: 'idle', label: 'Render failed' };
      feed(p, { actor: 'frame', kind: 'render', text: 'Render failed: ' + e.message.slice(-300), renderId: r.id }); emit(p);
      throw e;
    }
  },
};

const MUTATING = new Set(['frame_pack', 'frame_import', 'frame_edit', 'frame_cut_silence', 'frame_render', 'frame_step', 'frame_transcribe', 'frame_camera_move', 'frame_cutout']);
let chain = Promise.resolve();
async function callTool(name, args) {
  const h = handlers[name];
  if (!h) return { content: [text(`Unknown tool ${name}`)], isError: true };
  const exec = async () => {
    lastCallAt = Date.now();
    let p = null;
    try { p = args.project_id ? load(args.project_id) : currentId ? load(currentId) : null; } catch {}
    if (p && name !== 'frame_wait' && p.status.state !== 'rendering') p.status = p.paused ? { state: 'paused', label: 'Paused by you' } : { state: 'active', label: 'Claude is editing' };
    try {
      const content = await h(args || {});
      p = currentId ? load(currentId) : p;
      if (p && p.status.state === 'waiting') p.status = { state: 'active', label: 'Claude is editing' };
      const extra = userInput(p);
      if (extra) content.push(text(extra.trim()));
      return { content };
    } catch (e) {
      p = currentId ? load(currentId) : p;
      return { content: [text(`Error: ${e.message}${userInput(p)}`)], isError: true };
    }
  };
  // frame_wait must not block the queue (the user may act through the UI meanwhile; other sessions may call).
  if (name === 'frame_wait') return exec();
  const r = chain.then(exec); chain = r.catch(() => {}); return r;
}

// ───────────────────────── UI actions (the human's hands)
async function uiAction(b) {
  const p = b.project ? load(b.project) : currentId ? load(currentId) : null;
  if (b.action === 'open') { if (load(b.id)) { setCurrent(b.id); emit(null); } return { ok: true }; }
  if (!p) return { error: 'no project' };
  const say = (kind, t) => { p.inbox.push({ id: uid('i_'), ts: Date.now(), kind, text: t }); };
  const uiAuthor=b.test_context==='automated-ui-check'?{type:'agent',name:'Codex UI check',method:b.surface==='canvas'?'Canvas controls (automated check)':'Inspector / timeline (automated check)'}:{type:'human',name:'You',method:b.surface==='canvas'?'Canvas controls':'Inspector / timeline'};
  switch (b.action) {
    case 'prompt': {if(p.paused)return {error:'Frame is paused.'};const job=promptRunner.queue(p,{prompt:b.text,clip_id:b.clip,playhead:b.t});feed(p,{actor:'user',kind:'user',text:b.text,t:b.t});emit(p);return {ok:true,job_id:job.id};}
    case 'claim_prompt': return promptRunner.claim(p,b.id,b.client);
    case 'prompt_fail': promptRunner.fail(p,b.id,b.message||'Canvas control could not apply this change.');return {ok:true};
    case 'message': { const t = String(b.text || '').trim().slice(0, 4000); if (!t) break; feed(p, { actor: 'user', kind: 'user', text: t, t: b.t }); say('message', b.t != null ? `${t}  (playhead at ${round(b.t, 2)}s${b.clip ? `, selected clip ${b.clip}` : ''})` : t); break; }
    case 'pause': for(const job of p.promptJobs||[])if(['routing','ready','executing'].includes(job.status)){job.status='cancelled';job.phase='Stopped by you';} p.paused = true; p.status = { state: 'paused', label: 'Paused by you' }; feed(p, { actor: 'user', kind: 'user', text: 'Paused Claude' }); say('control', 'User pressed PAUSE.'); break;
    case 'resume': p.paused = false; p.status = { state: 'active', label: 'Resumed' }; feed(p, { actor: 'user', kind: 'user', text: 'Resumed Claude' }); say('control', 'User pressed RESUME — continue.'); break;
    case 'ops': {
      const promptJob=promptRunner.validate(p,b);
      const author=promptJob?{type:'agent',name:promptJob.cursor,method:'Live canvas control'}:uiAuthor;
      snapshot(p);
      for (const op of b.ops || []) {
        try {
          const r = applyRevision(p, op, { loadEnv: loadEnv(p) }, author);
          const entry = feed(p, { revisionId:r.revision?.id, actor: promptJob?'frame':'user', agent:promptJob?.cursor, kind: 'op', op: op.op, text: r.text, clipIds: r.clipIds, t: r.t });
          if (promptJob) {
            promptRunner.done(p,promptJob,r.revision);
            emitClipChanges(p, new Set(r.clipIds), [entry], r.revision ? [r.revision] : []);
            return { ok:true };
          }
          say('manual edit', `${r.text}${r.clipIds?.length === 1 ? ` [${r.clipIds[0]}]` : ''}`);
        }
        catch (e) {if(promptJob)promptRunner.fail(p,promptJob.id,e.message);emit(p);return {error:e.message};}
      }
      break;
    }
    case 'revert_revision': { const results=revertRevision(p,b.id,{loadEnv:loadEnv(p),beforeApply:()=>snapshot(p)},uiAuthor); for(const r of results)feed(p,{actor:'user',kind:'op',op:'revert_revision',revisionId:r.revision?.id,text:r.text,clipIds:r.clipIds,t:r.t}); break; }
    case 'undo': case 'redo': if (timeTravel(p, b.action)) { feed(p, { actor: 'user', kind: 'op', op: b.action, text: b.action === 'undo' ? 'Undo' : 'Redo' }); say('manual edit', `User pressed ${b.action}; re-read the timeline with frame_state.`); } break;
    case 'render': callTool('frame_render', { project_id: p.id, quality: b.quality, why: 'Requested from the Frame window' }); say('control', `User started a ${b.quality || 'final'} render from the Frame window.`); return { ok: true };
    case 'reveal': { const r = p.renders.find((x) => x.id === b.id); if (r?.file && fs.existsSync(r.file)) { if (process.platform === 'darwin') spawn('open', ['-R', r.file]); else if (process.platform === 'win32') spawn('explorer', [`/select,"${r.file}"`], { windowsVerbatimArguments: true }); else openBrowser(path.dirname(r.file)); } return { ok: true }; }
    case 'approve': return approveRender(p, b.id);
    case 'cutout': callTool('frame_cutout', { project_id: p.id, asset: b.asset, force: !!p.assets[b.asset]?.cutout, why: 'Requested from the Frame window' }); say('control', `User started a person cutout of ${b.asset} from the Frame window.`); return { ok: true };
    case 'save_clip': return saveClipToLibrary(p, b.id, b.label);
    case 'pack_use': { try { const pk = packs.getPack(b.pack); const as = await importOne(p, packs.packFile(pk, b.item), { actor: 'user', why: `From audio pack "${pk.name}"` }); as.pack = { pack: pk.id, item: b.item }; say('manual edit', `User added ${pk.name} / ${b.item} from the audio pack`); } catch (e) { return { error: e.message }; } break; }
    case 'import': { for (const f of b.paths || []) { try { await importOne(p, f, { actor: 'user' }); say('manual edit', `User imported ${f}`); } catch (e) { return { error: e.message }; } } break; }
  }
  emit(p);
  return { ok: true };
}

// ───────────────────────── HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.json': 'application/json', '.webp': 'image/webp', '.gif': 'image/gif', '.flac': 'audio/flac', '.ogg': 'audio/ogg' };
function sendFile(req, res, file, cache = 'no-cache') {
  let st; try { st = fs.statSync(file); } catch { res.writeHead(404).end('not found'); return; }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0, endB = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${endB}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': endB - start + 1, 'Cache-Control': cache });
    fs.createReadStream(file, { start, end: endB }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': cache });
    fs.createReadStream(file).pipe(res);
  }
}
const body = (req, limit = 30e6) => new Promise((resolve, reject) => { const ch = []; let n = 0; req.on('data', (d) => { n += d.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else ch.push(d); }); req.on('end', () => resolve(Buffer.concat(ch))); req.on('error', reject); });
const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

export function startDaemon() {
  mkdirp(HOME);
  try { currentId = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).current; if (!load(currentId)) currentId = null; } catch {}
  const allowed = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  const server = http.createServer(async (req, res) => {
    try {
      // Only this machine's own Frame page may talk to the daemon.
      if (!allowed.has(req.headers.host)) return res.writeHead(403).end('forbidden');
      if (req.headers.origin && !allowed.has(req.headers.origin.replace(/^https?:\/\//, ''))) return res.writeHead(403).end('forbidden');
      const url = new URL(req.url, BASE); const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (req.method === 'GET') {
        if (url.pathname === '/') return sendFile(req, res, path.join(UI_DIR, 'index.html'));
        if (['app.js', 'text-draw.js', 'effects.js', 'live-graphics.js', 'timeline-groups.js', 'revision-controls.js', 'canvas-geometry.js', 'clip-move.js', 'official-brand-assets.js', 'fx-render.html', 'style.css', 'favicon.svg'].includes(parts[0]) && parts.length === 1) return sendFile(req, res, path.join(UI_DIR, parts[0]));
        if ((parts[0] === 'fxin' || (parts[0] === 'api' && parts[1] === 'fxjob')) && await handleJobRequest(req, res, parts, body)) return;
        if (url.pathname === '/api/ping') return json(res, { name: 'frame', version: VERSION, pid: process.pid, clients: clients.size });
        if (url.pathname === '/api/packs') return json(res, { packs: packs.listPacks() });
        if (parts[0] === 'pack' && parts.length === 3) { const pk = packs.getPack(parts[1]); const f = pk && pk.items.find((i) => i.file === parts[2]); return f ? sendFile(req, res, path.join(HOME, 'packs', pk.id, f.file), 'private, max-age=3600') : res.writeHead(404).end(); }
        if (url.pathname === '/api/tools') return json(res, { tools: TOOLS, instructions: INSTRUCTIONS });
        if (url.pathname === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          clients.add(res); req.on('close', () => clients.delete(res));
          const p = currentId ? load(currentId) : null;
          res.write(`data: ${JSON.stringify({ type: 'state', project: p ? publicProject(p) : null, projects: listProjects(), lastCallAt, version: VERSION })}\n\n`);
          if (genJobs.size) res.write(`data: ${JSON.stringify({ type: 'generating', jobs: [...genJobs.values()] })}\n\n`);
          return;
        }
        if (url.pathname === '/api/generating') return json(res, { jobs: [...genJobs.values()] });
        if (url.pathname === '/api/generating/preview') {
          const b = genPreview.get(url.searchParams.get('job_id')); if (!b) return res.writeHead(404).end();
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); return res.end(b);
        }
        const p = parts[1] && load(parts[1]);
        if (p && parts[0] === 'media') { const a = p.assets[parts[2]]; if (!a) return res.writeHead(404).end(); return sendFile(req, res, a.proxy ? cacheFile(p, `${a.id}.proxy.mp4`) : a.path, 'private, max-age=3600'); }
        if (p && parts[0] === 'matte') { const a = p.assets[parts[2]]; if (!a?.cutout) return res.writeHead(404).end(); return sendFile(req, res, matteFile(p)(a), 'private, max-age=3600'); }
        if (p && parts[0] === 'track') { const a = p.assets[parts[2]]; if (!a?.cutout) return res.writeHead(404).end(); return sendFile(req, res, cacheFile(p, `${a.id}.track.json`), 'private, max-age=3600'); }
        if (p && parts[0] === 'thumbs') return sendFile(req, res, cacheFile(p, `${path.basename(parts[2])}.thumbs.jpg`), 'private, max-age=3600');
        if (p && parts[0] === 'env') return sendFile(req, res, cacheFile(p, `${path.basename(parts[2])}.env.json`), 'private, max-age=3600');
        if (p && parts[0] === 'cache') return sendFile(req, res, cacheFile(p, path.basename(parts[2])), 'private, max-age=3600');
        if (p && parts[0] === 'render') { const r = p.renders.find((x) => x.id === parts[2]); if (!r?.file) return res.writeHead(404).end(); return sendFile(req, res, r.file); }
        return res.writeHead(404).end('not found');
      }
      if (req.method === 'POST') {
        if (url.pathname === '/api/call') { const b = JSON.parse(await body(req)); return json(res, await callTool(b.name, b.arguments || {})); }
        if (url.pathname === '/api/ui') return json(res, await uiAction(JSON.parse(await body(req))));
        if (url.pathname === '/api/generating') return json(res, { ok: true, job: genUpdate(JSON.parse(await body(req, 1e5))) });
        if (url.pathname === '/api/generating/preview') {
          const id = url.searchParams.get('job_id'), j = genJobs.get(id); if (!j) return json(res, { error: 'unknown job_id: post progress first' }, 404);
          genPreview.set(id, await body(req, 4e6)); j.previewV++; j.updatedAt = Date.now(); emitGen(); return json(res, { ok: true });
        }
        if (url.pathname === '/api/raster') {
          const p = load(url.searchParams.get('project')); const id = url.searchParams.get('clip');
          const c = p?.clips.find((x) => x.id === id); if (!c) return json(res, { error: 'no clip' }, 404);
          // The window says which text and style it drew. Store the upload under that key, and only if it is still the clip's
          // current text and style: a slow upload of an older look must never be stamped as current.
          let drawn; try { drawn = decodeURIComponent(req.headers['x-frame-text-key'] || ''); } catch { drawn = ''; }
          if (!drawn) return json(res, { error: 'missing X-Frame-Text-Key: say which text and style this image was drawn from' }, 400);
          const png = await body(req);
          if (drawn !== textHash(p, c)) return json(res, { error: 'stale: this caption changed since it was drawn', stale: true }, 409);
          storeRaster(p, c, png, Number(url.searchParams.get('x')), Number(url.searchParams.get('y')), drawn, 'window');
          save(p); return json(res, { ok: true });
        }
        if (parts[0] === 'api' && parts[1] === 'fxjob' && await handleJobRequest(req, res, parts, body)) return;
        if (url.pathname === '/api/shutdown') { json(res, { ok: true }); setTimeout(() => process.exit(0), 100); return; }
      }
      res.writeHead(404).end('not found');
    } catch (e) { try { json(res, { error: e.message }, 500); } catch {} }
  });
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Frame is already running on port ${PORT}.` : e.message); process.exit(1); });
  server.listen(PORT, '127.0.0.1', () => console.error(`Frame ${VERSION} · ${BASE} · data in ${HOME}`));
  // Build the on-device speech tool in the background at start, so the first import doesn't wait for the compile.
  media.transcriber().then((t) => console.error(`transcripts: ${t ? t.label : 'no engine (macOS 26 + swiftc, or Whisper)'}`)).catch(() => {});
  setInterval(() => { for (const c of clients) c.write(': keepalive\n\n'); }, 20000).unref();
  // A generator that died without saying so: drop its tile after two silent minutes.
  setInterval(() => { let gone = 0; for (const [id, j] of genJobs) if (Date.now() - j.updatedAt > 120000) { genJobs.delete(id); genPreview.delete(id); gone++; } if (gone) emitGen(true); }, 15000).unref();
  return server;
}
