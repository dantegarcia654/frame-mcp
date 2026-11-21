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
const probe = external('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', source]);
let sourceInfo = {};
try { sourceInfo = JSON.parse(probe.stdout); } catch {}
const video = sourceInfo.streams?.find(s => s.codec_type === 'video' && s.width > 0 && s.height > 0);
const duration = Number(sourceInfo.format?.duration);
if (probe.status !== 0 || !video || !Number.isFinite(duration) || duration < 2) {
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
const evidence = { source, output, sampleKind: 'caller-supplied; synthetic samples do not establish creator acceptance', operations: [], limitations: ['Local tool-path gate, not a test of AI-client MCP registration or creator UX', 'No promise of 30-second full export or unlimited-footage indexing'] };
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
let renderDir;
try {
  fs.mkdirSync(output, { recursive: true });
  // Each run owns its render folder; rerunning never overwrites earlier evidence/media.
  renderDir = fs.mkdtempSync(path.join(output, 'run-'));
  evidence.renderDirectory = renderDir;
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
  const existing = new Set(fs.readdirSync(renderDir).filter(f => /\.mp4$/i.test(f)));
  const rendered = frame('frame_render', { quality: 'draft', output_dir: renderDir, loudnorm: false }, 600_000);
  assert.match(rendered, /Rendered:/, 'FRAME did not report a successful render');
  const files = fs.readdirSync(renderDir).filter(f => /\.mp4$/i.test(f) && !existing.has(f)).map(f => path.join(renderDir, f));
  assert.ok(files.length, `Render returned without an MP4: ${rendered.slice(-1200)}`);
  const newest = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const check = external('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', newest]);
  assert.equal(check.status, 0, 'Final MP4 failed ffprobe');
  const finalInfo = JSON.parse(check.stdout);
  const finalVideo = finalInfo.streams?.find(s => s.codec_type === 'video' && s.width > 0 && s.height > 0);
  const finalDuration = Number(finalInfo.format?.duration);
  assert.ok(finalVideo && Number.isFinite(finalDuration) && finalDuration > 0, 'Final MP4 has no playable video');
  const expectedDuration = Math.min(duration, 12) - 0.5;
  assert.ok(Math.abs(finalDuration - expectedDuration) <= 0.12, `Revision was not reflected in export: expected ${expectedDuration}s, got ${finalDuration}s`);
  const decode = external('ffmpeg', ['-v', 'error', '-xerror', '-i', newest, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-']);
  assert.equal(decode.status, 0, `Final MP4 did not fully decode: ${decode.stderr}`);
  evidence.export = { path: newest, seconds: finalDuration, expectedSeconds: expectedDuration, bytes: fs.statSync(newest).size, fullyDecoded: true };
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
  try { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n'); if (renderDir) fs.writeFileSync(path.join(renderDir, 'creator-activation-evidence.json'), JSON.stringify(evidence, null, 2) + '\n'); console.log(`Evidence: ${file}`); }
  catch (e) { console.error(`Could not save evidence: ${e.message}`); process.exitCode = 1; }
  fs.rmSync(scratch, { recursive: true, force: true });
}
