// frame reel <inbox clip id…> — assemble a vertical reel from Frame Inbox footage, live in the Frame window.
// No transcription on the clock: the Inbox already holds word timings, silences and a 1080p proxy for every clip.
// The assembly is a fixed recipe (beats → cuts, alternating punch-ins, captions, score, a whoosh between shots).
// When the cut is on the timeline it writes ~/.frame/reel-latest.json so a polish pass can start while it renders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { call } from './mcp.js';
import { HOME } from './util.js';
import { beatsFromWords, motionCentre, offsetFor } from './speedrun.js';

const INBOX = path.join(os.homedir(), 'Library', 'Application Support', 'FrameInbox', 'data');
const MAX_LEN = 22;   // seconds: a reel, not a recap
const PUNCH = 1.12;

const txt = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
async function tool(name, args) { const r = await call(name, args); const t = txt(r); if (r.isError) throw new Error(`${name}: ${t}`); return t; }

export function inboxRecord(key) {
  const dir = path.join(INBOX, 'records');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const byId = files.find((f) => f.startsWith(key));
  const recs = byId ? [byId] : files;
  for (const f of recs) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (byId || r.name === key) return r;
  }
  throw new Error(`No Frame Inbox clip "${key}" (use an id prefix or the original file name).`);
}

/** Words worth cutting on. Whisper junk (most words flagged, or the same phrase looping) counts as no speech. */
export function usableWords(rec) {
  const all = rec.transcript?.words || [];
  const ok = all.filter((w) => !w.review_required && w.end - w.start > 0.02);
  const uniq = new Set(ok.map((w) => w.text.toLowerCase().replace(/[^a-z']/g, ''))).size;
  const junk = all.length > 6 && (ok.length < all.length * 0.6 || uniq < ok.length * 0.35);
  return { words: junk ? [] : ok, junk };
}

function freeBytes(dir) { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; } }

export async function reel(keys, { name, score = 'in-motion', render = true, log = console.log } = {}) {
  const t0 = Date.now();
  const at = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
  const free = freeBytes(HOME);
  if (free < 1.5e9) throw new Error(`Only ${(free / 1e9).toFixed(2)} GB free on disk. Free at least 1.5 GB first: renders and project saves fail on a full disk.`);
  const recs = keys.map(inboxRecord);
  const clips = recs.map((r) => ({ rec: r, ...usableWords(r), file: fs.existsSync(r.edit_path || '') ? r.edit_path : r.path }));

  const started = await tool('frame_start', { name: name || `Reel · ${recs.map((r) => r.name.replace(/\.[^.]+$/, '')).join(' + ')}`, plan: `Reel from ${recs.length} Inbox clip(s): cut on the spoken beats, punch-ins, captions, score + whoosh, render. Transcripts come from the Inbox index, so nothing waits on Whisper.` });
  const pid = started.match(/\((p_[a-z0-9]+)\)/)[1];
  const [ow, oh] = started.match(/· (\d+)×(\d+) @/).slice(1).map(Number);
  log(`${at()} project ${pid}`);
  const junk = clips.filter((c) => c.junk).map((c) => c.rec.name);
  await tool('frame_note', { project_id: pid, kind: 'decision', text: `Footage: ${clips.map((c) => `${c.rec.name}${c.rec.role ? ` (${c.rec.role})` : ''}`).join(', ')}.${junk.length ? ` Transcript looks like Whisper junk on ${junk.join(', ')}: used as music-only B-roll.` : ''}` });

  // Packs: score + whoosh, found by item id.
  const packsDir = path.join(HOME, 'packs');
  const findPack = (id) => { for (const p of fs.readdirSync(packsDir)) { const f = fs.readdirSync(path.join(packsDir, p)).find((x) => x.replace(/\.[^.]+$/, '') === id); if (f) return path.join(packsDir, p, f); } return null; };
  const audio = [findPack(score), findPack('whoosh-fast')].filter(Boolean);
  const imported = await tool('frame_import', { project_id: pid, paths: [...clips.map((c) => c.file), ...audio] });
  const assetIds = [...imported.matchAll(/^\s+(a\d+) · (video|audio|image)/gm)].map((m) => m[1]);
  clips.forEach((c, i) => { c.asset = assetIds[i]; });
  const [scoreId, whooshId] = audio.map((_, i) => assetIds[clips.length + i]);
  log(`${at()} imported ${clips.length} clip(s)`);

  // Hand the Inbox transcripts to Frame so captions follow the cuts.
  for (const c of clips) if (c.words.length) await tool('frame_transcribe', { project_id: pid, asset: c.asset, words: c.words, source: `Frame Inbox (${c.rec.transcript.engine || 'whisper'})` });

  // Beats per clip, then trim the whole reel to MAX_LEN keeping order.
  const beats = [];
  for (const c of clips) {
    const dur = c.rec.proxy_info?.duration || c.rec.info.duration;
    const bs = c.words.length ? beatsFromWords(c.words, dur) : [{ in: Math.max(0, dur / 2 - 1.4), out: Math.min(dur, dur / 2 + 1.4), label: 'B-roll' }];
    for (const b of bs) beats.push({ ...b, clip: c, broll: !c.words.length });
  }
  let total = 0; const keep = [];
  for (const b of beats) { const d = b.out - b.in; if (total + d > MAX_LEN && keep.length) break; keep.push(b); total += d; }

  // Crop centre only matters for footage that is not already the reel's shape.
  for (const c of clips) {
    const pi = c.rec.proxy_info || c.rec.info; c.srcAspect = pi.width / pi.height;
    c.cx = Math.abs(c.srcAspect - ow / oh) > 0.05 ? await motionCentre(c.file) : 0.5;
  }

  await tool('frame_note', { project_id: pid, kind: 'decision', text: `${keep.length} beats, ${total.toFixed(1)} s. Laying them on the timeline in order.` });
  let t = 0, prev = null, flip = false; const cuts = [];
  for (const b of keep) {
    const same = prev && prev.clip === b.clip; flip = same ? !flip : false;
    const scale = flip ? PUNCH : 1;
    await tool('frame_edit', { project_id: pid, summary: b.label, ops: [{ op: 'add_clip', asset: b.clip.asset, track: 'V1', in: b.in, out: b.out, fit: 'cover', scale, x: offsetFor(b.clip.cx, b.clip.srcAspect, ow / oh, scale), muted: b.broll, label: b.label, why: same ? 'same angle: punch-in so the cut reads' : 'new shot' }] });
    if (prev && !same) cuts.push(t);
    t += b.out - b.in; prev = b;
  }
  log(`${at()} cut on the timeline · ${keep.length} beats · ${t.toFixed(1)}s`);

  const ops = [];
  if (clips.some((c) => c.words.length)) ops.push({ op: 'add_captions', replace: true, why: 'captions from the Inbox transcript, following every cut' });
  const speech = keep.some((b) => !b.broll);
  if (scoreId) ops.push({ op: 'add_clip', asset: scoreId, track: 'A1', start: 0, in: 0, out: +t.toFixed(2), volume: speech ? 0.28 : 0.7, fadeOut: 0.5, why: 'score under everything' });
  if (whooshId) for (const c of cuts) ops.push({ op: 'add_clip', asset: whooshId, track: 'A2', start: +Math.max(0, c - 0.2).toFixed(2), volume: 0.6, why: 'whoosh into the new shot' });
  const finished = ops.length ? await tool('frame_edit', { project_id: pid, summary: 'Captions + sound', ops }) : '';
  const captions = [...(finished.split(/\n(?=[A-Z]\d+:)/).find((s) => s.startsWith('T1:')) || '').matchAll(/(c_[a-z0-9]+) · ([\d.]+)–([\d.]+)s · "([^"]*)"/g)].map((m) => ({ id: m[1], start: +m[2], end: +m[3], text: m[4] }));
  log(`${at()} ${captions.length} captions, score${cuts.length ? ` + ${cuts.length} whoosh` : ''}`);

  // The polish pass can start now, while the first render runs.
  const handoff = { project_id: pid, at: new Date().toISOString(), duration: +t.toFixed(2), clips: clips.map((c) => ({ asset: c.asset, name: c.rec.name, role: c.rec.role, transcript: c.words.map((w) => w.text).join(' ') })), beats: keep.map((b) => ({ asset: b.clip.asset, in: b.in, out: b.out, label: b.label })), captions };
  fs.writeFileSync(path.join(HOME, 'reel-latest.json'), JSON.stringify(handoff, null, 2));

  let out = null;
  if (render) {
    await tool('frame_note', { project_id: pid, text: 'Assembly done. Rendering v1 while the polish pass reviews captions and framing.' });
    out = (await tool('frame_render', { project_id: pid, why: 'assembly v1' })).match(/Rendered: (.+\.mp4)/)?.[1] || null;
    handoff.render = out; fs.writeFileSync(path.join(HOME, 'reel-latest.json'), JSON.stringify(handoff, null, 2));
    log(`${at()} rendered ${out}`);
  }
  log(`\nAssembly done in ${((Date.now() - t0) / 1000).toFixed(1)}s · project ${pid}`);
  return handoff;
}
