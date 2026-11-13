// End-to-end check on a scratch instance: generates test media, edits it through the real tool path, renders, verifies the file.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-test-'));
const env = { ...process.env, FRAME_PORT: '4791', FRAME_HOME: path.join(tmp, 'home'), FRAME_NO_OPEN: '1', FRAME_PACE: '0' };
const base = 'http://127.0.0.1:4791';
let failed = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failed++; };

const clip = path.join(tmp, 'clip.mp4');
spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*440*t)*lt(mod(t,2),1.2)':d=6", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);

const daemon = spawn(process.execPath, [path.join(root, 'bin/frame.js'), 'serve'], { env, stdio: 'ignore' });
for (let i = 0; i < 40; i++) { try { await fetch(`${base}/api/ping`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
const call = async (name, args = {}) => { const r = await (await fetch(`${base}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) })).json(); return { ...r, text: r.content.map((c) => c.text || '').join('\n') }; };

try {
  let r = await call('frame_start', { name: 'smoke', aspect: '16:9' });
  ok('frame_start', /Frame is live/.test(r.text));
  r = await call('frame_import', { paths: [clip] });
  ok('frame_import measures silences', /silences/.test(r.text) && /a1 · video/.test(r.text), r.text.split('\n')[2]?.trim());
  r = await call('frame_edit', { ops: [{ op: 'add_clip', asset: 'a1' }, { op: 'remove_silences', min_silence: 0.4 }, { op: 'add_clip', asset: 'a1', track: 'V2', start: 0.5, in: 1, out: 2, scale: 0.3, x: 0.3, y: -0.3, grade: { saturation: 0 }, fadeIn: 0.2 }, { op: 'update_clip', id: 'missing' }] });
  ok('frame_edit applies ops and reports bad ones', /1\. ✓/.test(r.text) && /2\. ✓ Removed \d+ measured/.test(r.text) && /4\. ✗/.test(r.text));
  // The test clip ends in silence; cutting it must not leave a few frames of dead air behind as their own clip.
  const v1 = [...(r.text.split('\nV1:\n')[1] || '').split(/\n\S/)[0].matchAll(/· ([\d.]+)–([\d.]+)s ·/g)].map((m) => m[2] - m[1]);
  ok('remove_silences leaves no scraps of dead air', v1.length > 0 && Math.min(...v1) >= 0.1, `${v1.length} clips on V1, shortest ${Math.min(...v1).toFixed(2)}s`);
  r = await call('frame_view', { t: 1 });
  ok('frame_view returns an image', r.content.some((c) => c.type === 'image' && c.data.length > 2000));
  await fetch(`${base}/api/ui`, { method: 'POST', body: JSON.stringify({ action: 'message', text: 'make it shorter' }) });
  r = await call('frame_state');
  ok('user message reaches Claude', /make it shorter/.test(r.text));
  await fetch(`${base}/api/ui`, { method: 'POST', body: JSON.stringify({ action: 'pause' }) });
  r = await call('frame_edit', { ops: [{ op: 'clear_track', track: 'V1' }] });
  ok('pause blocks edits', /Not applied/.test(r.text) && /PAUSED/.test(r.text));
  await fetch(`${base}/api/ui`, { method: 'POST', body: JSON.stringify({ action: 'resume' }) });
  r = await call('frame_render', { quality: 'draft', output_dir: path.join(tmp, 'out') });
  const file = r.text.match(/Rendered: (.+)/)?.[1];
  ok('frame_render writes a playable MP4', !!file && fs.existsSync(file) && fs.statSync(file).size > 5000, r.text.split('\n')[1]);
  r = await call('frame_history', { action: 'undo' });
  ok('undo', /Done/.test(r.text));
  const blocked = await fetch(`${base}/api/ui`, { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' });
  ok('other websites cannot call the service', blocked.status === 403);
} finally {
  daemon.kill(); fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
