// Timed dry run of the effects-reel recipe: footage in, rendered MP4 out, through the same tool path an AI uses.
//   node scripts/dryrun-effects-reel.mjs <talking-head video> [--plate=<empty-set shot>] [--from=20] [--seconds=30] [--keep]
// Runs a private Frame service (its own port and data folder), then times each stage:
//   import (cutout + transcript start in the background) → place the take → transcript → effects from cue words
//   → wait for the cutout → draft render (draws every effect frame) → final render.
// If the take never says the effect names (a stand-in take), the cue words are inserted into its transcript at even
// times and the report says so. If no plate is given, a frame of the take stands in for the empty set (the person is
// in it, so blow_away looks wrong; the timing is real) and the report says so.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || '1']; }));
const input = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!input || !fs.existsSync(input)) { console.error('usage: node scripts/dryrun-effects-reel.mjs <talking-head video> [--plate=<empty-set shot>] [--from=0] [--seconds=30] [--keep]'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-dryrun-')), port = Number(args.port || 4795), base = `http://127.0.0.1:${port}`;
const env = { ...process.env, FRAME_PORT: String(port), FRAME_HOME: path.join(tmp, 'home'), FRAME_NO_OPEN: '1', FRAME_PACE: '0', FRAME_PROFILES: path.join(tmp, 'profiles') };

// The take: the requested seconds of the input (made before the clock starts — in real use this is the file you filmed).
const seconds = Number(args.seconds || 30), from = Number(args.from || 0);
const take = path.join(tmp, 'take.mp4');
spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(from), '-t', String(seconds), '-i', input, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-c:a', 'aac', take]);
let plate = args.plate, standInPlate = false;
if (!plate) { plate = path.join(tmp, 'plate-stand-in.jpg'); standInPlate = true; spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', take, '-frames:v', '1', '-q:v', '2', plate]); }

const daemon = spawn(process.execPath, [path.join(root, 'bin/frame.js'), 'serve'], { env, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/ping`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
const call = async (name, a = {}) => { const r = await (await fetch(`${base}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: a }) })).json(); const text = r.content.map((c) => c.text || '').join('\n'); if (r.isError) throw new Error(`${name}: ${text.slice(0, 600)}`); return text; };

const stages = []; let t = Date.now(); const T0 = t;
const stage = async (name, fn) => { const s = Date.now(); const out = await fn(); const now = Date.now(); stages.push({ name, s: (now - s) / 1000, at: (now - T0) / 1000, note: typeof out === 'string' ? out : '' }); return out; };
const notes = [];
try {
  await stage('open project + import (cutout and transcript start in background)', async () => { await call('frame_start', { name: 'effects reel dry run', aspect: '9:16' }); const r = await call('frame_import', { paths: [take, plate] }); return (r.match(/Preparing in the background: (.*?)\./) || [])[1] || ''; });
  await stage('place the take on V1', () => call('frame_edit', { ops: [{ op: 'add_clip', asset: 'a1' }] }).then(() => ''));
  const tr = await stage('transcript (waits for the background one)', async () => { const r = await call('frame_transcribe', { asset: 'a1' }); return (r.match(/^\(waited.*\)$/m) || [''])[0]; });
  // Stand-in: if the take does not say the cue words, put them into the transcript at even times.
  const cueWords = ['tracking box', 'text behind', 'rack focus', 'clone row', 'orbit text', 'code body', 'comment drop', 'impact frame', 'comment', 'blow away', 'letter window'];
  const said = cueWords.filter((w) => tr.toLowerCase().includes(w));
  if (said.length < 8) {
    const state = JSON.parse(fs.readFileSync(path.join(env.FRAME_HOME, 'projects', fs.readdirSync(path.join(env.FRAME_HOME, 'projects'))[0], 'project.json'), 'utf8'));
    const words = state.assets.a1.transcript.words.slice();
    const step = (seconds - 2) / cueWords.length;
    cueWords.forEach((w, k) => { const s = 0.4 + k * step; words.push({ text: w, start: Math.round(s * 100) / 100, end: Math.round((s + 0.5) * 100) / 100 }); });
    words.sort((a, b) => a.start - b.start);
    await call('frame_transcribe', { asset: 'a1', words, source: 'dry run: Whisper words plus inserted cue words' });
    notes.push(`The take says ${said.length} of the cue phrases, so all cue phrases were inserted into its transcript every ${step.toFixed(1)} s (stand-in script).`);
  }
  const lay = await stage('lay out all effects from the cue words (one frame_edit op)', () => call('frame_edit', { ops: [{ op: 'add_effects_at_words', stop: ['comment'], params: { blow_away: { plate: 'a2' }, comment_drop: { text: 'FRAME' } } }] }));
  const placed = lay.match(/placed (\d+)/)?.[1];
  stages.at(-1).note = `placed ${placed} effects${/NOT placed/.test(lay) ? ' — ' + lay.match(/NOT placed: [^\n]*/)[0].slice(0, 200) : ''}`;
  await stage('cutout (waits for the background one)', async () => { const r = await call('frame_cutout', { asset: 'a1' }); return (r.match(/\(waited.*?\)/) || [''])[0] + ' ' + (r.match(/in [\d.]+s with .*?\)\./) || [''])[0]; });
  const draft = await stage('draft render (draws every effect frame)', () => call('frame_render', { quality: 'draft', output_dir: path.join(tmp, 'out') }));
  stages.at(-1).note = [draft.match(/Drew .*/)?.[0], draft.match(/Measured: [^.]*/)?.[0]].filter(Boolean).join(' · ');
  const fin = await stage('final render', () => call('frame_render', { quality: 'final', output_dir: args.out || path.join(tmp, 'out') }));
  const file = fin.match(/Rendered: (.+)/)?.[1];
  stages.at(-1).note = (fin.match(/Measured: [^\n]*/) || [''])[0] + (fin.match(/⚠[^\n]*/g) || []).join(' ');
  const total = (Date.now() - T0) / 1000;
  console.log(`\nEffects reel dry run — ${seconds} s take (${path.basename(input)} from ${from}s), ${os.cpus()[0].model}`);
  console.log('─'.repeat(100));
  for (const s of stages) console.log(`${s.s.toFixed(1).padStart(6)} s  (at ${s.at.toFixed(1).padStart(5)} s)  ${s.name}${s.note ? `\n${' '.repeat(23)}${s.note}` : ''}`);
  console.log('─'.repeat(100));
  console.log(`TOTAL footage → final MP4: ${total.toFixed(1)} s  ${total < 60 ? '✓ under 60 s' : '✗ OVER 60 s'}`);
  if (standInPlate) notes.push('No plate was given, so a frame of the take stood in for the empty set: the person is in it, so blow_away looks wrong in this run; its timing is real.');
  for (const n of notes) console.log(`note: ${n}`);
  console.log(`final MP4: ${file}`);
  if (!args.keep && !args.out) console.log('(temporary files are deleted; pass --keep or --out=<dir> to keep the render)');
} catch (e) { console.error('dry run failed:', e.message); process.exitCode = 1; }
finally { daemon.kill(); if (!args.keep) fs.rmSync(tmp, { recursive: true, force: true }); }
