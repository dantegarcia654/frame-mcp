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

const noisy = path.join(tmp, 'noisy.mp4'); // tone bursts over a constant noise bed (-34 dBFS) — a fixed -38 dB threshold sees no silence here
spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=8', '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*300*t)*lt(mod(t,3),1.5)+0.02*(random(0)-0.5)*2':d=8", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', noisy]);
const daemon = spawn(process.execPath, [path.join(root, 'bin/frame.js'), 'serve'], { env, stdio: 'ignore' });
for (let i = 0; i < 40; i++) { try { await fetch(`${base}/api/ping`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
const call = async (name, args = {}) => { const r = await (await fetch(`${base}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) })).json(); return { ...r, text: r.content.map((c) => c.text || '').join('\n') }; };

try {
  let r = await call('frame_start', { name: 'smoke', aspect: '16:9' });
  ok('frame_start', /Frame is live/.test(r.text));
  r = await call('frame_import', { paths: [clip] });
  ok('frame_import measures silences', /silences/.test(r.text) && /a1 · video/.test(r.text), r.text.split('\n')[2]?.trim());
  r = await call('frame_edit', { ops: [{ op: 'add_clip', asset: 'a1' }, { op: 'remove_silences', min_silence: 0.4 }, { op: 'add_clip', asset: 'a1', track: 'V2', start: 0.5, in: 1, out: 2, scale: 0.3, x: 0.3, y: -0.3, grade: { saturation: 0 }, fadeIn: 0.2 }, { op: 'update_clip', id: 'missing' }] });
  ok('frame_edit applies ops and reports bad ones', /1\. ✓/.test(r.text) && /2\. ✓ Cut \d+ pauses/.test(r.text) && /4\. ✗/.test(r.text));
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
  r = await call('frame_start', { name: 'silence', aspect: '16:9' });
  await call('frame_import', { paths: [noisy] });
  r = await call('frame_cut_silence', { dry_run: true });
  ok('frame_cut_silence: no clip yet is reported, not crashed', /No pauses|DRY RUN|Error/.test(r.text));
  await call('frame_edit', { ops: [{ op: 'add_clip', asset: 'a1' }] });
  r = await call('frame_cut_silence', { dry_run: true, style: 'tight' });
  ok('dry run finds pauses over a noise bed and changes nothing', /DRY RUN — would remove [1-9]/.test(r.text) && /Nothing changed/.test(r.text), r.text.split('\n')[0].slice(0, 160));
  r = await call('frame_cut_silence', { style: 'tight' });
  const dur = Number(r.text.match(/duration ([\d.]+)s/)?.[1]);
  ok('frame_cut_silence shortens the timeline', /Cut [1-9]\d* pauses/.test(r.text) && dur > 0 && dur < 7, `duration ${dur}s from 8s`);
  // magnetic timeline + extend with rest of footage
  r = await call('frame_start', { name: 'magnetic', aspect: '16:9' });
  await call('frame_import', { paths: [clip] });
  r = await call('frame_edit', { ops: [{ op: 'keep_ranges', asset: 'a1', ranges: [{ in: 0, out: 1 }, { in: 2, out: 3 }, { in: 4, out: 5 }] }] });
  const ids = [...r.text.matchAll(/c_\w+/g)].map((m) => m[0]).filter((v, i, a) => a.indexOf(v) === i);
  r = await call('frame_edit', { ops: [{ op: 'extend_clip', id: ids[0], by: 0.5 }] });
  ok('extend_clip pulls in more source and ripples later clips', /Extended end of .* by 0\.5s/.test(r.text) && /1\.5–2\.5s/.test(r.text) && /2\.5–3\.5s/.test(r.text), r.text.split('\n')[0].slice(0, 120));
  r = await call('frame_edit', { ops: [{ op: 'extend_clip', id: ids[2], all: true }, { op: 'extend_clip', id: ids[2], by: 1 }] });
  ok('extend_clip stops at the end of the footage', /Extended end/.test(r.text) && /no more source footage/.test(r.text));
  r = await call('frame_edit', { ops: [{ op: 'trim_clip', id: ids[0], edge: 'start', by: 0.3 }, { op: 'delete_clip', id: ids[1] }] });
  ok('trim and delete leave no gaps', /Trimmed start/.test(r.text) && /closed the gap/.test(r.text) && !/ c_\w+ · [1-9]/.test('') && /0–1\.2s/.test(r.text), r.text.split('\n').slice(0, 2).join(' | ').slice(0, 200));

} finally {
  daemon.kill(); fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
