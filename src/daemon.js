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
import { buildGraph, ffmpegArgs, runFfmpeg } from './render.js';
import { TOOLS, INSTRUCTIONS } from './tools.js';
import { drawTextsHeadless } from './text.js';
import { textKey } from '../ui/text-draw.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACE = Number(process.env.FRAME_PACE ?? 140);
const projects = new Map();
const history = new Map();
const clients = new Set();
let currentId = null;
let lastCallAt = 0;

// ───────────────────────── storage
const pdir = (id) => mkdirp(path.join(HOME, 'projects', id));
const cacheFile = (p, name) => path.join(mkdirp(path.join(pdir(p.id), 'cache')), name);
function save(p) { p.updatedAt = Date.now(); fs.writeFileSync(path.join(pdir(p.id), 'project.json'), JSON.stringify(p)); }
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
function feed(p, e) {
  const entry = { id: uid('f_'), ts: Date.now(), actor: 'claude', kind: 'note', ...e };
  p.feed.push(entry); if (p.feed.length > 800) p.feed.splice(0, p.feed.length - 800);
  return entry;
}
function snapshot(p) {
  const h = history.get(p.id) || { undo: [], redo: [] }; history.set(p.id, h);
  h.undo.push(JSON.stringify({ clips: p.clips, markers: p.markers, tracks: p.tracks, width: p.width, height: p.height, fps: p.fps }));
  if (h.undo.length > 100) h.undo.shift();
  h.redo = [];
}
function timeTravel(p, dir) {
  const h = history.get(p.id); const from = dir === 'undo' ? h?.undo : h?.redo, to = dir === 'undo' ? h?.redo : h?.undo;
  if (!from?.length) return false;
  to.push(JSON.stringify({ clips: p.clips, markers: p.markers, tracks: p.tracks, width: p.width, height: p.height, fps: p.fps }));
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
  file = path.resolve(file.replace(/^~(?=\/)/, os.homedir()));
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
    if (a.needsProxy) { a.busy = 'making preview proxy'; emit(p); await media.makeProxy(file, cacheFile(p, `${a.id}.proxy.mp4`)); a.proxy = true; }
  } finally { delete a.busy; emit(p); }
  return a;
}

async function renderStill(p, t, maxDim = 720) {
  const out = cacheFile(p, `look_${uid()}.jpg`);
  const g = buildGraph(p, { window: [t], still: true, rasters: p.rasters, assetPath: assetPath(p), scale: Math.min(1, maxDim / Math.max(p.width, p.height)) });
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

// ───────────────────────── tools
const handlers = {
  async frame_start(a) {
    if (a.action === 'list') { const l = listProjects(); return [text(l.length ? l.map((x) => `${x.id} · "${x.name}" · ${x.duration}s · ${x.clips} clips · ${new Date(x.updatedAt).toLocaleString()}`).join('\n') : 'No projects yet.')]; }
    let p;
    if (a.project_id) { p = current(a.project_id); }
    else { p = newProject({ name: a.name || 'Untitled edit', aspect: a.aspect || '9:16', fps: a.fps || 30 }); p.inbox = []; p.rasters = {}; projects.set(p.id, p); }
    setCurrent(p.id);
    if (a.plan) { p.plan = a.plan; feed(p, { kind: 'plan', text: a.plan }); }
    else if (!a.project_id) feed(p, { kind: 'system', actor: 'frame', text: `Session opened · ${p.width}×${p.height} @ ${p.fps} fps` });
    emit(p);
    const shown = await ensureWindow();
    return [text(`Frame is live at ${BASE} ${shown ? '(window is open and connected)' : '(could not confirm a window is open — tell the user to open that URL; if you have a browser/preview pane tool, open it there)'}.\n\n${describe(p)}\n\nThe user is watching. Narrate with frame_note, make every change through frame_edit, and check each tool result for user input.`)];
  },

  async frame_import(a) {
    const p = current(a.project_id);
    let files = [];
    for (const f of a.paths || []) {
      const abs = path.resolve(String(f).replace(/^~(?=\/)/, os.homedir()));
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) files.push(...fs.readdirSync(abs).filter((n) => media.kindFromExt(n)).sort().map((n) => path.join(abs, n)));
      else files.push(abs);
    }
    if (!files.length) throw new Error('frame_import needs paths: absolute paths to video, audio or image files (or a folder of them).');
    const out = [];
    for (const f of files) { try { out.push(assetSummary(p, await importOne(p, f, a))); } catch (e) { out.push(`✗ ${f}: ${e.message}`); } }
    return [text(`Imported into "${p.name}":\n` + out.map((s) => '  ' + s).join('\n'))];
  },

  async frame_transcribe(a) {
    const p = current(a.project_id); const asset = p.assets[a.asset];
    if (!asset) throw new Error(`No asset "${a.asset}".`);
    if (a.words) {
      asset.transcript = { engine: a.source || 'supplied by Claude', words: a.words.map((w) => ({ text: String(w.text).trim(), start: round(Number(w.start), 2), end: round(Number(w.end), 2) })) };
      feed(p, { kind: 'op', op: 'transcript', text: `Transcript attached to ${asset.name}: ${asset.transcript.words.length} words` }); emit(p);
      return [text(`Stored ${asset.transcript.words.length} words on ${asset.id}.`)];
    }
    if (asset.transcript && !a.force) return [text(`Transcript of ${asset.id} (${asset.transcript.engine}), source seconds:\n${transcriptLines(asset.transcript.words)}`)];
    if (!(await media.whisperAvailable())) return [text(`No local Whisper is installed, so Frame cannot transcribe by itself. Options: (1) install it — \`pip install -U openai-whisper\` — and call again, or (2) get word timings any other way and call frame_transcribe with words: [{text,start,end}].`)];
    asset.busy = 'transcribing'; feed(p, { kind: 'op', op: 'transcribe', text: `Transcribing ${asset.name} with Whisper ${a.model || 'base.en'}…`, why: a.why }); emit(p);
    try {
      const tr = await media.transcribe(asset.path, { model: a.model || 'base.en', language: a.language });
      const env = loadEnv(p)(asset.id);
      const al = env ? media.alignWordsToSpeech(tr.words, env) : { words: tr.words, moved: 0 };
      asset.transcript = { engine: tr.engine, words: al.words, realigned: al.moved };
      feed(p, { kind: 'op', op: 'transcript', text: `Transcript ready: ${tr.words.length} words with word-level timing${al.moved ? ` · ${al.moved} word(s) Whisper had placed inside silence were moved onto the measured speech` : ''}` });
    } finally { delete asset.busy; emit(p); }
    return [text(`Transcript of ${asset.id} (${asset.transcript.engine}), source seconds. Whisper can mishear names — check before using as captions.\n${transcriptLines(asset.transcript.words)}`)];
  },

  async frame_note(a) {
    const p = current(a.project_id);
    feed(p, { kind: ['thinking', 'decision', 'plan', 'question', 'note'].includes(a.kind) ? a.kind : 'note', text: String(a.text || '').slice(0, 2000), agent: a.agent });
    if (a.kind === 'plan') p.plan = a.text;
    emit(p);
    return [text('Shown in Frame.')];
  },

  async frame_edit(a) {
    const p = current(a.project_id);
    if (!Array.isArray(a.ops) || !a.ops.length) throw new Error('frame_edit needs ops: [{op: "...", ...}].');
    if (p.paused) return [text('Not applied.')];
    snapshot(p);
    if (a.summary) { feed(p, { kind: 'decision', text: a.summary, agent: a.agent }); emit(p); await sleep(PACE); }
    const results = [];
    for (let i = 0; i < a.ops.length; i++) {
      const op = a.ops[i];
      if (p.paused) { results.push(`${i + 1}. ⏸ not applied — the user paused`); continue; }
      try {
        const r = applyOp(p, op, { loadEnv: loadEnv(p) });
        feed(p, { kind: 'op', op: op.op, text: r.text, why: op.why, clipIds: r.clipIds, t: r.t, agent: op.agent || a.agent });
        results.push(`${i + 1}. ✓ ${r.text}${r.clipIds?.length && r.clipIds.length <= 6 ? ` [${r.clipIds.join(', ')}]` : ''}`);
        emit(p, { focus: { clipIds: r.clipIds, t: r.t, agent: op.agent || a.agent || 'Claude' } });
        if (i < a.ops.length - 1) await sleep(PACE);
      } catch (e) { results.push(`${i + 1}. ✗ ${op.op}: ${e.message}`); }
    }
    if (clients.size) await waitRasters(p, 1500);
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
    const times = (a.times || [a.t ?? 0]).slice(0, 6);
    const { missing, reason } = await ensureRasters(p);
    for (const t of times) {
      const r = await renderStill(p, Number(t));
      const name = path.basename(r.file);
      content.push(text(`Composited frame at ${t}s (rendered by the same ffmpeg graph as the final export):`), { type: 'image', data: fs.readFileSync(r.file).toString('base64'), mimeType: 'image/jpeg' });
      feed(p, { kind: 'look', text: `Checked the composited frame at ${tc(Number(t))}`, why: a.why, img: `/cache/${p.id}/${name}`, t: Number(t) });
      emit(p, { focus: { t: Number(t), agent: 'Claude' } });
    }
    if (missing.length) content.push(text(`⚠ ${missing.length} text clip(s) are NOT in these frames (${missing.map((c) => `"${c.text.content.slice(0, 20)}"`).join(', ')}): ${reason}.`));
    return content;
  },

  async frame_state(a) {
    const p = current(a.project_id);
    let s = describe(p);
    if (a.include_transcript) for (const as of Object.values(p.assets)) if (as.transcript) s += `\n\nTranscript ${as.id} (source seconds):\n${transcriptLines(as.transcript.words)}`;
    if (a.include_timeline_words) { const w = timelineWords(p, a.track || 'V1'); s += `\n\nWords as they now fall on the timeline (${a.track || 'V1'}):\n${transcriptLines(w)}`; }
    const rn = p.renders.at(-1); if (rn) s += `\n\nLast render: ${rn.status}${rn.file ? ' · ' + rn.file : ''}${rn.progress != null && rn.status === 'rendering' ? ` · ${Math.round(rn.progress * 100)}%` : ''}`;
    return [text(s)];
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
    const quality = a.quality === 'draft' ? 'draft' : 'final';
    const n = p.renders.length + 1;
    const safe = p.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'frame';
    const movies = path.join(os.homedir(), 'Movies');
    const outDir = mkdirp(a.output_dir ? path.resolve(a.output_dir.replace(/^~(?=\/)/, os.homedir())) : path.join(fs.existsSync(movies) ? movies : os.homedir(), 'Frame'));
    const file = path.join(outDir, `${safe}_v${n}${quality === 'draft' ? '_draft' : ''}.mp4`);
    const g = buildGraph(p, { rasters: p.rasters, assetPath: assetPath(p), scale: quality === 'draft' ? 0.5 : 1, loudnorm: a.loudnorm !== false });
    const r = { id: 'r' + n, status: 'rendering', progress: 0, file, quality, startedAt: Date.now(), timelineVersion: p.version };
    p.renders.push(r); p.status = { state: 'rendering', label: 'Rendering' };
    feed(p, { kind: 'render', text: `Rendering ${quality} MP4 · ${round(D, 2)}s · ${g.inputs.length} inputs through ffmpeg`, why: a.why, renderId: r.id }); emit(p);
    let lastEmit = 0;
    try {
      await runFfmpeg(ffmpegArgs(g, file, { quality }), D, (pr) => { r.progress = pr; if (Date.now() - lastEmit > 300) { lastEmit = Date.now(); emit(p); } });
      const info = await media.probe(file); const loud = await media.loudness(file);
      Object.assign(r, { status: 'done', progress: 1, endedAt: Date.now(), duration: info.duration, width: info.width, height: info.height, bytes: fs.statSync(file).size, loudness: loud });
      p.status = { state: 'done', label: 'Render complete' };
      feed(p, { kind: 'render', text: `Render complete · ${info.width}×${info.height} · ${info.duration}s · ${(r.bytes / 1e6).toFixed(1)} MB${loud ? ` · ${loud.lufs} LUFS` : ''} · took ${round((r.endedAt - r.startedAt) / 1000, 1)}s`, renderId: r.id, done: true });
      emit(p, { rendered: r.id });
      return [text(`Rendered: ${file}\nMeasured: ${info.width}×${info.height}, ${info.duration}s, ${(r.bytes / 1e6).toFixed(1)} MB${loud ? `, ${loud.lufs} LUFS integrated, true peak ${loud.true_peak_db} dBFS` : ''}.${[...g.warnings, ...(missing.length ? [`${missing.length} text clip(s) left out of this render on request (allow_missing_text): ${reason}`] : [])].map((w) => '\n⚠ ' + w).join('')}\nThe user can play it in the Frame window. Use frame_view to check frames yourself.`)];
    } catch (e) {
      Object.assign(r, { status: 'failed', error: e.message }); p.status = { state: 'idle', label: 'Render failed' };
      feed(p, { kind: 'render', text: 'Render failed: ' + e.message.slice(-300), renderId: r.id }); emit(p);
      throw e;
    }
  },
};

const MUTATING = new Set(['frame_pack', 'frame_import', 'frame_edit', 'frame_cut_silence', 'frame_render', 'frame_step', 'frame_transcribe', 'frame_camera_move']);
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
  switch (b.action) {
    case 'message': { const t = String(b.text || '').trim().slice(0, 4000); if (!t) break; feed(p, { actor: 'user', kind: 'user', text: t, t: b.t }); say('message', b.t != null ? `${t}  (playhead at ${round(b.t, 2)}s${b.clip ? `, selected clip ${b.clip}` : ''})` : t); break; }
    case 'pause': p.paused = true; p.status = { state: 'paused', label: 'Paused by you' }; feed(p, { actor: 'user', kind: 'user', text: 'Paused Claude' }); say('control', 'User pressed PAUSE.'); break;
    case 'resume': p.paused = false; p.status = { state: 'active', label: 'Resumed' }; feed(p, { actor: 'user', kind: 'user', text: 'Resumed Claude' }); say('control', 'User pressed RESUME — continue.'); break;
    case 'ops': {
      snapshot(p);
      for (const op of b.ops || []) {
        try { const r = applyOp(p, op, { loadEnv: loadEnv(p) }); feed(p, { actor: 'user', kind: 'op', op: op.op, text: r.text, clipIds: r.clipIds, t: r.t }); say('manual edit', `${r.text}${r.clipIds?.length === 1 ? ` [${r.clipIds[0]}]` : ''}`); }
        catch (e) { emit(p); return { error: e.message }; }
      }
      break;
    }
    case 'undo': case 'redo': if (timeTravel(p, b.action)) { feed(p, { actor: 'user', kind: 'op', op: b.action, text: b.action === 'undo' ? 'Undo' : 'Redo' }); say('manual edit', `User pressed ${b.action}; re-read the timeline with frame_state.`); } break;
    case 'render': callTool('frame_render', { project_id: p.id, quality: b.quality, why: 'Requested from the Frame window' }); say('control', `User started a ${b.quality || 'final'} render from the Frame window.`); return { ok: true };
    case 'reveal': { const r = p.renders.find((x) => x.id === b.id); if (r?.file && fs.existsSync(r.file)) { if (process.platform === 'darwin') spawn('open', ['-R', r.file]); else openBrowser(path.dirname(r.file)); } return { ok: true }; }
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
        if (['app.js', 'text-draw.js', 'style.css', 'favicon.svg'].includes(parts[0]) && parts.length === 1) return sendFile(req, res, path.join(UI_DIR, parts[0]));
        if (url.pathname === '/api/ping') return json(res, { name: 'frame', version: VERSION, pid: process.pid, clients: clients.size });
        if (url.pathname === '/api/packs') return json(res, { packs: packs.listPacks() });
        if (parts[0] === 'pack' && parts.length === 3) { const pk = packs.getPack(parts[1]); const f = pk && pk.items.find((i) => i.file === parts[2]); return f ? sendFile(req, res, path.join(HOME, 'packs', pk.id, f.file), 'private, max-age=3600') : res.writeHead(404).end(); }
        if (url.pathname === '/api/tools') return json(res, { tools: TOOLS, instructions: INSTRUCTIONS });
        if (url.pathname === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          clients.add(res); req.on('close', () => clients.delete(res));
          const p = currentId ? load(currentId) : null;
          res.write(`data: ${JSON.stringify({ type: 'state', project: p ? publicProject(p) : null, projects: listProjects(), lastCallAt, version: VERSION })}\n\n`);
          return;
        }
        const p = parts[1] && load(parts[1]);
        if (p && parts[0] === 'media') { const a = p.assets[parts[2]]; if (!a) return res.writeHead(404).end(); return sendFile(req, res, a.proxy ? cacheFile(p, `${a.id}.proxy.mp4`) : a.path, 'private, max-age=3600'); }
        if (p && parts[0] === 'thumbs') return sendFile(req, res, cacheFile(p, `${path.basename(parts[2])}.thumbs.jpg`), 'private, max-age=3600');
        if (p && parts[0] === 'env') return sendFile(req, res, cacheFile(p, `${path.basename(parts[2])}.env.json`), 'private, max-age=3600');
        if (p && parts[0] === 'cache') return sendFile(req, res, cacheFile(p, path.basename(parts[2])), 'private, max-age=3600');
        if (p && parts[0] === 'render') { const r = p.renders.find((x) => x.id === parts[2]); if (!r?.file) return res.writeHead(404).end(); return sendFile(req, res, r.file); }
        return res.writeHead(404).end('not found');
      }
      if (req.method === 'POST') {
        if (url.pathname === '/api/call') { const b = JSON.parse(await body(req)); return json(res, await callTool(b.name, b.arguments || {})); }
        if (url.pathname === '/api/ui') return json(res, await uiAction(JSON.parse(await body(req))));
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
        if (url.pathname === '/api/shutdown') { json(res, { ok: true }); setTimeout(() => process.exit(0), 100); return; }
      }
      res.writeHead(404).end('not found');
    } catch (e) { try { json(res, { error: e.message }, 500); } catch {} }
  });
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Frame is already running on port ${PORT}.` : e.message); process.exit(1); });
  server.listen(PORT, '127.0.0.1', () => console.error(`Frame ${VERSION} · ${BASE} · data in ${HOME}`));
  setInterval(() => { for (const c of clients) c.write(': keepalive\n\n'); }, 20000).unref();
  return server;
}
