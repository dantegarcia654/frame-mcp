// An isolated, real-footage first-day activation gate. Never changes source media or ~/.frame.
// Usage: node scripts/creator-activation.mjs /absolute/path/to/clip.mp4 [output-directory]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ? path.resolve(process.argv[2]) : null;
const output = path.resolve(process.argv[3] || path.join(process.cwd(), 'frame-activation-exports'));
if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
  console.error('Usage: node scripts/creator-activation.mjs /absolute/path/to/clip.mp4 [output-directory]');
  process.exit(2);
}
const executable = path.join(root, 'bin/frame.js');
const external = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
for (const cmd of ['ffmpeg', 'ffprobe']) {
  if (external(cmd, ['-version']).status !== 0) {
    console.error(`Missing ${cmd}. Install FFmpeg before onboarding.`);
    process.exit(2);
  }
}
const probe = external('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', source]);
const duration = Number(probe.stdout.trim());
if (probe.status !== 0 || !Number.isFinite(duration) || duration < 2) {
  console.error('Use a readable video of at least two seconds for the first-run gate.');
  process.exit(2);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-creator-'));
const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const env = {
  ...process.env,
  FRAME_HOME: path.join(scratch, 'home'),
  FRAME_PORT: String(port),
  FRAME_NO_OPEN: '1',
  FRAME_PACE: '0',
  FRAME_DECISIONS: 'off',
};
const evidence = { source, output, operations: [], limitations: ['Local tool-path gate, not a test of AI-client MCP registration or creator UX', 'No promise of 30-second full export or unlimited-footage indexing'] };
function frame(name, args, limitMs = 180_000) {
  const start = performance.now();
  const run = spawnSync(process.execPath, [executable, 'call', name, JSON.stringify(args)], {
    env, encoding: 'utf8', timeout: limitMs, maxBuffer: 20 * 1024 * 1024,
  });
  const seconds = Math.round((performance.now() - start) / 10) / 100;
  const operation = { name, seconds, ok: run.status === 0 };
  evidence.operations.push(operation);
  if (run.status !== 0) {
    throw new Error(`${name} failed (exit ${run.status ?? 'timeout'}): ${(run.stderr || run.stdout || '').slice(-2500)}`);
  }
  return run.stdout;
}
try {
  fs.mkdirSync(output, { recursive: true });
  frame('frame_start', { name: 'Creator activation check', aspect: '9:16' });
  const imported = frame('frame_import', { paths: [source], prepare: false, decide: false, scenes: false });
  assert.match(imported, /a1\b/, 'First imported asset not identified as a1');
  const firstCut = frame('frame_edit', {
    fast: true, ops: [{ op: 'add_clip', asset: 'a1', track: 'V1', in: 0, out: Math.min(duration, 12), why: 'First creator cut' }],
  });
  const match = firstCut.match(/\[(c_[a-z0-9]+)\]/i);
  assert.ok(match, `Cannot identify first clip in edit result: ${firstCut.slice(-1200)}`);
  const viewed = frame('frame_view', { t: 0.5 });
  assert.match(viewed, /\[image image\//, 'FRAME did not return a composited image');
  const revision = frame('frame_edit', {
    fast: true, ops: [{ op: 'trim_clip', id: match[1], edge: 'end', by: 0.5, why: 'Creator asks for a tighter cut' }],
  });
  assert.match(revision, /✓/, 'Revision did not report success');
  const existing = new Set(fs.readdirSync(output).filter(f => /\.mp4$/i.test(f)));
  const rendered = frame('frame_render', { quality: 'draft', output_dir: output, loudnorm: false }, 600_000);
  assert.match(rendered, /Rendered:/, 'FRAME did not report a successful render');
  const files = fs.readdirSync(output).filter(f => /\.mp4$/i.test(f) && !existing.has(f)).map(f => path.join(output, f));
  assert.ok(files.length, `Render returned without an MP4: ${rendered.slice(-1200)}`);
  const newest = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const check = external('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', newest]);
  assert.equal(check.status, 0, 'Final MP4 failed ffprobe');
  evidence.export = { path: newest, seconds: Number(check.stdout.trim()), bytes: fs.statSync(newest).size };
  evidence.passed = true;
  console.log(`PASS: import → first cut → visual check → revision → playable draft export\n${newest}`);
} catch (error) {
  evidence.passed = false;
  evidence.error = error.message;
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  const stopped = spawnSync(process.execPath, [executable, 'stop'], { env, encoding: 'utf8', timeout: 10_000 });
  evidence.serviceStop = stopped.status === 0 ? 'attempted' : 'failed';
  const file = path.join(output, 'creator-activation-evidence.json');
  try { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n'); console.log(`Evidence: ${file}`); }
  catch (e) { console.error(`Could not save evidence: ${e.message}`); process.exitCode = 1; }
  fs.rmSync(scratch, { recursive: true, force: true });
}
