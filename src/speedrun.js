// frame speedrun <file> — one command from raw footage to a rendered vertical cut, every step live in the Frame window.
// It drives the daemon through the same tool calls an agent would (start → import → transcribe → edit → render),
// so nothing happens off-screen. The only local work is a quick motion scan to choose the vertical crop.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { call } from './mcp.js';
import { HOME } from './util.js';

const PUNCH = 1.15;   // punch-in scale on every other beat
const PAD_IN = 0.08;  // seconds kept before the first word of a beat
const PAD_OUT = 0.14; // seconds kept after the last word of a beat
const GAP = 0.3;      // a pause longer than this between words is cut out

const txt = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
async function tool(name, args) {
  const r = await call(name, args);
  const t = txt(r);
  if (r.isError) throw new Error(`${name}: ${t}`);
  return t;
}

/** Group words into beats: a new beat starts after a pause longer than GAP or after a sentence ends. */
export function beatsFromWords(words, duration) {
  const beats = [];
  let cur = null;
  for (const w of words) {
    const split = cur && (w.start - cur.lastEnd > GAP || /[.!?]$/.test(cur.lastText));
    if (!cur || split) { cur = { first: w.start, lastEnd: w.end, lastText: w.text, words: [w.text] }; beats.push(cur); }
    else { cur.lastEnd = w.end; cur.lastText = w.text; cur.words.push(w.text); }
  }
  const ranges = beats.map((b) => ({ in: Math.max(0, b.first - PAD_IN), out: Math.min(duration, b.lastEnd + PAD_OUT), label: b.words.slice(0, 4).join(' ') }));
  // Beats split at a sentence end with no real pause would overlap after padding: meet at the midpoint instead.
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].in < ranges[i - 1].out) { const m = (beats[i - 1].lastEnd + beats[i].first) / 2; ranges[i - 1].out = m; ranges[i].in = m; }
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return ranges.filter((r) => r.out - r.in > 0.2).map((r) => ({ ...r, in: r3(r.in), out: r3(r.out) }));
}

/** Where the action is, left to right (0–1 of the source width): the centroid of frame-to-frame motion. */
export function motionCentre(file, { cols = 96, rows = 54, fps = 6 } = {}) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', `fps=${fps},scale=${cols}:${rows},format=gray`, '-f', 'rawvideo', '-']);
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.on('error', () => resolve(null));
    ff.on('close', () => {
      const buf = Buffer.concat(chunks), size = cols * rows, n = Math.floor(buf.length / size);
      if (n < 2) return resolve(null);
      const col = new Float64Array(cols);
      for (let f = 1; f < n; f++) {
        const a = (f - 1) * size, b = f * size;
        for (let i = 0; i < size; i++) col[i % cols] += Math.abs(buf[b + i] - buf[a + i]);
      }
      // Handheld shake moves every column a little: subtract the median so only real action counts.
      const med = [...col].sort((x, y) => x - y)[cols >> 1];
      let wsum = 0, sum = 0;
      for (let c = 0; c < cols; c++) { const v = Math.max(0, col[c] - med); wsum += v * (c + 0.5) / cols; sum += v; }
      resolve(sum > 0 ? wsum / sum : null);
    });
  });
}

/** x offset (fraction of the output frame) that centres source column cx after a cover fit, kept inside the picture. */
export function offsetFor(cx, srcAspect, outAspect, scale = 1) {
  const W = (srcAspect / outAspect) * scale; // picture width measured in output-frame widths
  if (W <= 1.001 || cx == null) return 0;
  const lim = (W - 1) / 2;
  return Math.round(Math.max(-lim, Math.min(lim, (0.5 - cx) * W)) * 1000) / 1000;
}

export async function speedrun(file, { name, model, render = true, log = console.log } = {}) {
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const step = (s) => log(`[${secs()}] ${s}`);
  file = path.resolve(String(file).replace(/^~(?=[\\/])/, os.homedir()));
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  const base = path.basename(file).replace(/\.[^.]+$/, '');

  const started = await tool('frame_start', { name: name || `${base} speed run`, plan: `Speed run on ${path.basename(file)}: import → transcribe → cut the pauses → reframe vertical → punch-ins → captions → render.` });
  const pid = started.match(/\((p_[a-z0-9]+)\)/)?.[1];
  const [ow, oh] = (started.match(/· (\d+)×(\d+) @/) || []).slice(1).map(Number);
  if (!pid) throw new Error(`Could not read the project id from frame_start:\n${started}`);
  step(`project ${pid} open in Frame`);

  const imported = await tool('frame_import', { project_id: pid, paths: [file] });
  const m = imported.match(/(a\d+) · video · .*? · ([\d.]+)s · (\d+)×(\d+)/);
  if (!m) throw new Error(`Import did not produce a video asset:\n${imported}`);
  const [, aid, dur, sw, sh] = [m[0], m[1], Number(m[2]), Number(m[3]), Number(m[4])];
  step(`imported ${aid} · ${dur}s · ${sw}×${sh}`);

  // The crop scan runs on this machine while the daemon transcribes.
  const centreP = motionCentre(file);
  await tool('frame_transcribe', { project_id: pid, asset: aid, ...(model ? { model } : {}), why: 'word timings drive the cuts and the captions' });
  const proj = JSON.parse(fs.readFileSync(path.join(HOME, 'projects', pid, 'project.json'), 'utf8'));
  const words = proj.assets?.[aid]?.transcript?.words || [];
  const cx = await centreP;
  step(`transcribed ${words.length} words · action centred at ${cx == null ? 'n/a' : Math.round(cx * 100) + '% across'}`);

  const ranges = words.length ? beatsFromWords(words, dur) : [{ in: 0, out: dur, label: 'whole take' }];
  const kept = ranges.reduce((s, r) => s + r.out - r.in, 0);
  await tool('frame_note', { project_id: pid, kind: 'decision', text: `${ranges.length} beat${ranges.length === 1 ? '' : 's'} from the speech, ${(dur - kept).toFixed(2)}s of pauses cut. ${sw / sh > (ow / oh) * 1.05 ? `Wide source: cropping to vertical around the action (${cx == null ? 'centre' : Math.round(cx * 100) + '% across'}).` : ''} Punch-in on every other beat.` });
  const cut = await tool('frame_edit', { project_id: pid, summary: 'Cut to the speech', ops: [{ op: 'keep_ranges', asset: aid, ranges, why: 'keep every spoken beat, drop the dead air' }] });
  const v1 = (cut.split(/\n(?=[A-Z]\d+:)/).find((s) => s.startsWith('V1:')) || '').match(/c_[a-z0-9]+/g) || [];
  step(`cut: ${ranges.length} beat(s), ${(dur - kept).toFixed(2)}s removed`);

  const srcAspect = sw / sh, outAspect = ow / oh;
  const ops = v1.map((id, i) => {
    const scale = v1.length > 1 && i % 2 === 1 ? PUNCH : 1;
    return { op: 'update_clip', id, fit: 'cover', scale, x: offsetFor(cx, srcAspect, outAspect, scale), why: scale > 1 ? 'punch-in for energy' : 'frame the action' };
  });
  if (words.length) ops.push({ op: 'add_captions', why: 'captions from the transcript, following every cut' });
  const edited = await tool('frame_edit', { project_id: pid, summary: 'Reframe, punch-ins, captions', ops });
  const captions = (edited.split(/\n(?=[A-Z]\d+:)/).find((s) => s.startsWith('T1:')) || '').match(/"[^"]*"/g) || [];
  step(`reframed ${v1.length} clip(s), ${captions.length} caption(s)`);

  let out = null;
  if (render) {
    const r = await tool('frame_render', { project_id: pid, why: 'speed run export' });
    out = r.match(/Rendered: (.+\.mp4)/)?.[1] || null;
    step(`rendered ${out}`);
  }
  await tool('frame_note', { project_id: pid, text: `Speed run finished in ${secs()}.${captions.length ? ' Captions come straight from Whisper: check names and odd words.' : ''}` });
  log(`\nDone in ${secs()} · project ${pid}${out ? `\n${out}` : ''}`);
  if (captions.length) log(`Captions (straight from Whisper, check them): ${captions.join(' · ')}`);
  return { project_id: pid, file: out, seconds: (Date.now() - t0) / 1000, captions };
}
