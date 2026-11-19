// End-to-end check on a scratch instance: generates test media, edits it through the real tool path, renders, verifies the file.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-test-'));
const env = { ...process.env, FRAME_PORT: '4791', FRAME_HOME: path.join(tmp, 'home'), FRAME_NO_OPEN: '1', FRAME_PACE: '0',
  FRAME_PROFILES: path.join(tmp, 'profiles'), FRAME_APPROVED_DIR: path.join(tmp, 'approved'), FRAME_INBOX_DIR: path.join(tmp, 'inbox'), FRAME_INBOX_URL: 'http://127.0.0.1:4797',
  // Decision sheet: always the local mock below, never Google, whatever key the developer has set.
  GEMINI_API_KEY: 'smoke', FRAME_DECISIONS: '', FRAME_DECISIONS_ENDPOINT: 'http://127.0.0.1:4794/v1beta/decisions' };
const base = 'http://127.0.0.1:4791';
let failed = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failed++; };

const clip = path.join(tmp, 'clip.mp4');
spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*440*t)*lt(mod(t,2),1.2)':d=6", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);

const noisy = path.join(tmp, 'noisy.mp4'); // tone bursts over a constant noise bed (-34 dBFS) — a fixed -38 dB threshold sees no silence here
spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=8', '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*300*t)*lt(mod(t,3),1.5)+0.02*(random(0)-0.5)*2':d=8", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', noisy]);
// A stand-in for the Gemini Decisions API: checks the request shape, answers deterministically. The first option of a
// choice wins at 90% (55% for the sketch-to-demo pack, to exercise REVIEW); a question named force_402 gets HTTP 402.
const decideSeen = [];
const decideMock = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    let j = {}; try { j = JSON.parse(b); } catch {}
    const v = j.input?.[0], q = j.questions || {};
    const shapeOk = req.method === 'POST' && req.headers['x-goog-api-key'] === 'smoke' && j.model === 'gemini-decision-1' && v?.type === 'video' && v.mime_type === 'video/mp4' && (v.data?.length || 0) > 1000 && Object.keys(q).length > 0;
    decideSeen.push({ shapeOk, keys: Object.keys(q) });
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!shapeOk) return send(400, { error: { code: 400, message: 'request shape not accepted by the mock' } });
    if (q.force_402) return send(402, { error: { code: 402, message: 'Your prepayment credits are depleted.' } });
    const top = q.role?.criteria?.upload_drawing ? 0.55 : 0.9, answers = {};
    for (const [k, x] of Object.entries(q)) {
      if (x.type === 'noul') answers[k] = { type: 'noul', noul: 0.8, confidence: 0.8 };
      else if (x.type === 'choice') { const o = Object.keys(x.criteria); answers[k] = { type: 'choice', choice: o[0], confidence: top, probabilities: Object.fromEntries(o.map((n, i) => [n, i ? (1 - top) / (o.length - 1) : top])) }; }
      else answers[k] = { type: 'score', score: 1.5, confidence: 0.75 };
    }
    send(200, { answers, usage: { total_tokens: 321 } });
  });
});
await new Promise((r) => decideMock.listen(4794, '127.0.0.1', r));
const daemon = spawn(process.execPath, [path.join(root, 'bin/frame.js'), 'serve'], { env, stdio: 'ignore' });
for (let i = 0; i < 40; i++) { try { await fetch(`${base}/api/ping`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
const call = async (name, args = {}) => { const r = await (await fetch(`${base}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) })).json(); return { ...r, text: r.content.map((c) => c.text || '').join('\n') }; };

try {
  let r = await call('frame_start', { name: 'smoke', aspect: '16:9' });
  ok('frame_start', /Frame is live/.test(r.text));
  r = await call('frame_import', { paths: [clip] });
  ok('frame_import measures silences', /silences/.test(r.text) && /a1 · video/.test(r.text), r.text.split('\n')[2]?.trim());
  ok('import labels the clip on the decision sheet, as a guess', /Decision sheet — gemini-decision-1 guesses, NOT measurements/.test(r.text) && /a1 clip\.mp4: talking_head 90% · hook 1\.5\/2/.test(r.text), r.text.match(/a1 clip\.mp4: .*/)?.[0]);
  r = await call('frame_edit', { ops: [{ op: 'add_clip', asset: 'a1' }, { op: 'remove_silences', min_silence: 0.4 }, { op: 'add_clip', asset: 'a1', track: 'V2', start: 0.5, in: 1, out: 2, scale: 0.3, x: 0.3, y: -0.3, grade: { saturation: 0 }, fadeIn: 0.2 }, { op: 'update_clip', id: 'missing' }] });
  ok('frame_edit applies ops and reports bad ones', /1\. ✓/.test(r.text) && /2\. ✓ Cut \d+ pauses/.test(r.text) && /4\. ✗/.test(r.text));
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

  // ── Truthful pixels: captions are drawn without a window, and a restyle can never ship the old look.
  const { findChrome } = await import('../src/text.js');
  const countPixels = (b64, test) => { // count pixels in a frame_view JPEG that pass test(r, g, b)
    const jpg = path.join(tmp, `look_${Date.now()}.jpg`); fs.writeFileSync(jpg, Buffer.from(b64, 'base64'));
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', jpg, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64e6 }).stdout;
    let n = 0; for (let i = 0; i < raw.length; i += 3) if (test(raw[i], raw[i + 1], raw[i + 2])) n++; return n;
  };
  const redPixels = (b64) => countPixels(b64, (r, g, b) => r > 180 && g < 90 && b < 90);
  const whitePixels = (b64) => countPixels(b64, (r, g, b) => r > 220 && g > 220 && b > 220);
  if (findChrome()) {
    await call('frame_start', { name: 'text', aspect: '9:16' });
    r = await call('frame_edit', { ops: [{ op: 'add_text', text: 'HHHH', start: 0, duration: 2, style: { size: 0.2, weight: 900, color: '#ffffff', y: 0.5 } }] });
    const tid = r.text.match(/\[(c_\w+)\]/)?.[1];
    r = await call('frame_view', { t: 0.5 });
    const img1 = r.content.find((c) => c.type === 'image')?.data;
    ok('captions are drawn with no window open', !!img1 && !/NOT in these frames/.test(r.text) && whitePixels(img1) > 2000 && redPixels(img1) < 50, img1 ? `white pixels ${whitePixels(img1)}` : r.text.match(/⚠.*/)?.[0]);
    r = await call('frame_edit', { ops: [{ op: 'update_clip', id: tid, style: { color: '#ff0000' } }] });
    ok('restyle reports the stored change', /color #ffffff → #ff0000/.test(r.text), r.text.split('\n')[0]);
    r = await call('frame_view', { t: 0.5 });
    const img2 = r.content.find((c) => c.type === 'image')?.data;
    ok('a restyled caption shows its new colour without a window', !!img2 && redPixels(img2) > 2000, `red pixels ${img2 ? redPixels(img2) : 'no image'}`);
  } else console.log('- skipped headless text checks: no Chrome/Chromium found');
  const { buildGraph } = await import('../src/render.js');
  const proj = { width: 100, height: 100, fps: 30, assets: {}, clips: [{ id: 't1', kind: 'text', track: 'T1', start: 0, in: 0, out: 1, speed: 1, text: { content: 'new', size: 0.1, color: '#fff' } }] };
  const g = buildGraph(proj, { rasters: { t1: { file: '/x.png', x: 0, y: 0, hash: JSON.stringify([{ content: 'old', size: 0.1, color: '#fff' }, 100, 100]) } }, assetPath: () => '' });
  ok('a caption drawn from older text is never composited', g.inputs.length === 0 && /changed since it was drawn/.test(g.warnings.join(' ')));

  // ── Honest edits
  await call('frame_start', { name: 'honest', aspect: '16:9' });
  await call('frame_import', { paths: [clip, noisy] });
  r = await call('frame_edit', { ops: [{ op: 'add_clip', asset: 'a1', in: 0, out: 2 }, { op: 'add_clip', asset: 'a1', in: 3, out: 4 }] });
  const [c1] = [...r.text.matchAll(/\[(c_\w+)\]/g)].map((m) => m[1]);
  r = await call('frame_edit', { ops: [{ op: 'update_clip', id: c1, asset: 'a2', in: 1, out: 3 }] });
  ok('update_clip rejects keys it does not apply', /✗ update_clip: update_clip does not change "asset"/.test(r.text) && /replace_source/.test(r.text) && new RegExp(`${c1} · 0–2s · a1 src 0–2`).test(r.text));
  r = await call('frame_edit', { ops: [{ op: 'replace_source', id: c1, asset: 'a2', in: 1 }] });
  ok('replace_source swaps footage and keeps the slot', /source a1 .* → a2 00:01\.00–00:03\.00/.test(r.text) && new RegExp(`${c1} · 0–2s · a2 src 1–3`).test(r.text), r.text.split('\n')[0]);
  r = await call('frame_edit', { ops: [{ op: 'replace_source', id: c1, asset: 'a1', in: 5 }] });
  ok('replace_source refuses a range past the end of the footage', /✗ replace_source: .* Nothing was changed/.test(r.text));
  r = await call('frame_edit', { ops: [{ op: 'set_project', magnetic: false }, { op: 'add_clip', asset: 'a1', in: 0, out: 1, start: 4 }] });
  ok('gaps on V1 are reported after an edit', /⚠ V1: [\d.]+s gap/.test(r.text), r.text.match(/⚠.*/)?.[0] || 'no warning');

  // ── A caption image uploaded for older text or style is refused, never stamped as current.
  const { textKey } = await import('../ui/text-draw.js');
  r = await call('frame_start', { name: 'raster', aspect: '9:16' });
  const rpid = r.text.match(/\((p_\w+)\)/)?.[1];
  r = await call('frame_edit', { ops: [{ op: 'add_text', text: 'OLD', start: 0, duration: 2 }] });
  const rid = r.text.match(/\[(c_\w+)\]/)?.[1];
  const readProj = () => JSON.parse(fs.readFileSync(path.join(env.FRAME_HOME, 'projects', rpid, 'project.json'), 'utf8'));
  const oldKey = textKey(readProj().clips.find((c) => c.id === rid), 1080, 1920);
  await call('frame_edit', { ops: [{ op: 'update_clip', id: rid, text: 'NEW' }] });
  const png = fs.readFileSync(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=8x8', '-frames:v', '1', path.join(tmp, 'p.png')]) && path.join(tmp, 'p.png'));
  const up = (key) => fetch(`${base}/api/raster?project=${rpid}&clip=${rid}&x=0&y=0`, { method: 'POST', headers: key == null ? {} : { 'X-Frame-Text-Key': encodeURIComponent(key) }, body: png });
  const stale = await up(oldKey), unlabelled = await up(null);
  const afterStale = readProj().rasters?.[rid];
  const newKey = textKey(readProj().clips.find((c) => c.id === rid), 1080, 1920);
  const fresh = await up(newKey);
  ok('an upload drawn from older text is refused, not stamped current', stale.status === 409 && unlabelled.status === 400 && (!afterStale || afterStale.hash === newKey && afterStale.by !== 'window') && fresh.status === 200 && readProj().rasters[rid].hash === newKey,
    `stale ${stale.status}, unlabelled ${unlabelled.status}, current ${fresh.status}`);

  // ── Moving a clip off the magnetic track closes the hole it leaves.
  await call('frame_start', { name: 'move-off', aspect: '16:9' });
  await call('frame_import', { paths: [clip] });
  r = await call('frame_edit', { ops: [{ op: 'keep_ranges', asset: 'a1', ranges: [{ in: 0, out: 1 }, { in: 2, out: 3 }, { in: 4, out: 5 }] }] });
  const [m1, m2, m3] = [...r.text.matchAll(/c_\w+/g)].map((m) => m[0]).filter((v, i, a) => a.indexOf(v) === i);
  r = await call('frame_edit', { ops: [{ op: 'update_clip', id: m2, track: 'V2' }] });
  ok('moving a V1 clip to V2 closes the gap on V1', new RegExp(`${m3} · 1–2s`).test(r.text) && new RegExp(`V2:\\n  ${m2} · 1–2s`).test(r.text) && !/⚠ V1/.test(r.text), r.text.split('\n')[0]);
  r = await call('frame_edit', { ops: [{ op: 'add_clip', asset: 'a1', track: 'V2', start: 4, in: 0, out: 0.5 }, { op: 'update_clip', id: m1, track: 'V2', start: 6 }] });
  ok('moving a clip onto V2 does not pack V2', new RegExp(`${m2} · 1–2s`).test(r.text) && /· 4–4\.5s/.test(r.text) && new RegExp(`${m1} · 6–7s`).test(r.text) && new RegExp(`${m3} · 0–1s`).test(r.text), r.text.split('\n').slice(0, 2).join(' | ').slice(0, 200));

  // ── 1.3 editing room: slip, save to library, style profiles, approve & save, Lines reflow.
  const ui = async (b) => (await fetch(`${base}/api/ui`, { method: 'POST', body: JSON.stringify(b) })).json();
  const projOf = (pid) => JSON.parse(fs.readFileSync(path.join(env.FRAME_HOME, 'projects', pid, 'project.json'), 'utf8'));
  r = await call('frame_start', { name: 'slip', aspect: '16:9' });
  const spid = r.text.match(/\((p_\w+)\)/)?.[1];
  await call('frame_import', { paths: [clip] });
  r = await call('frame_edit', { ops: [{ op: 'keep_ranges', asset: 'a1', ranges: [{ in: 1, out: 2 }, { in: 3, out: 4 }] }, { op: 'add_text', text: 'hi', start: 0, duration: 1 }] });
  const [s1, s2, st] = [...r.text.matchAll(/c_\w+/g)].map((m) => m[0]).filter((v, i, a) => a.indexOf(v) === i);
  const before = projOf(spid).clips.find((c) => c.id === s1);
  r = await call('frame_edit', { ops: [{ op: 'slip_clip', id: s1, by: 0.5 }] });
  let after = projOf(spid).clips, a1 = after.find((c) => c.id === s1), a2 = after.find((c) => c.id === s2);
  ok('slip keeps start and length; in and out move together', /✓ .*slipped \+0\.5s/.test(r.text) && a1.start === before.start && Math.abs((a1.out - a1.in) - (before.out - before.in)) < 1e-9 && a1.in === 1.5 && a1.out === 2.5 && a2.start === 1 && a2.in === 3,
    `start ${before.start}→${a1.start}, in ${before.in}→${a1.in}, out ${before.out}→${a1.out}, next clip start ${a2.start}`);
  r = await call('frame_edit', { ops: [{ op: 'slip_clip', id: s1, by: 60 }, { op: 'slip_clip', id: st, by: 1 }] });
  a1 = projOf(spid).clips.find((c) => c.id === s1);
  ok('slip stops at the end of the footage and refuses text', /stopped at the end of the footage/.test(r.text) && a1.in === 5 && a1.out === 6 && a1.start === 0 && /2\. ✗ slip_clip/.test(r.text), r.text.split('\n').slice(0, 2).join(' | ').slice(0, 200));

  // Save to Frame library: graceful when Frame Inbox is missing or not running; sends the clip's source range when it is.
  let res = await ui({ action: 'save_clip', id: s1 });
  ok('save to library without Frame Inbox fails gracefully', /not installed/.test(res.error || '') && projOf(spid).clips.length === 3, res.error);
  fs.mkdirSync(path.join(env.FRAME_INBOX_DIR, 'data'), { recursive: true }); fs.writeFileSync(path.join(env.FRAME_INBOX_DIR, 'data', 'access-token'), 'tok123\n');
  res = await ui({ action: 'save_clip', id: s1 });
  ok('save to library with Frame Inbox not running fails gracefully', /not running/.test(res.error || ''), res.error);
  const http = await import('node:http'); let got = null;
  const inbox = http.createServer((q, s) => { const ch = []; q.on('data', (d) => ch.push(d)); q.on('end', () => { got = { url: q.url, token: q.headers['x-frame-token'], body: Buffer.concat(ch) }; s.writeHead(200, { 'Content-Type': 'application/json' }); s.end('{"ok":true}'); }); });
  await new Promise((go) => inbox.listen(4797, '127.0.0.1', go));
  res = await ui({ action: 'save_clip', id: s1 });
  inbox.close();
  let sentLen = null; if (got) { const f = path.join(tmp, 'sent.mp4'); fs.writeFileSync(f, got.body); sentLen = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString()); }
  ok('save to library uploads the clip\'s source range with the inbox token', res.ok === true && got?.token === 'tok123' && /^\/api\/upload\?name=clip_c_/.test(got.url) && Math.abs(sentLen - 1) < 0.1, `uploaded ${sentLen}s, token ${got?.token}`);

  // Style profiles: one shared folder of Markdown files; frame_start returns the profile, frame_profile lists and shows it.
  fs.mkdirSync(env.FRAME_PROFILES, { recursive: true });
  fs.writeFileSync(path.join(env.FRAME_PROFILES, 'default.md'), '# Default\n- Captions are white, never yellow.\n');
  fs.writeFileSync(path.join(env.FRAME_PROFILES, 'reels.md'), '# Reels\n- No end card.\n');
  r = await call('frame_start', { name: 'profile', aspect: '9:16' });
  ok('frame_start returns the default style profile', /STYLE PROFILE "default"/.test(r.text) && /Captions are white, never yellow/.test(r.text));
  r = await call('frame_start', { name: 'profile2', aspect: '9:16', profile: 'reels' });
  const r2 = await call('frame_profile', {}), r3 = await call('frame_profile', { action: 'list' }), r4 = await call('frame_start', { name: 'x', profile: 'nope' }), r5 = await call('frame_state');
  ok('frame_profile shows the project\'s profile and lists them; a missing one is an error', /No end card/.test(r.text) && /STYLE PROFILE "reels"/.test(r2.text) && /default, reels|reels, default/.test(r3.text) && r4.isError && /No style profile "nope"/.test(r4.text) && /Style profile: "reels"/.test(r5.text));

  // Approve & save: copies the render out, never overwrites an existing file.
  r = await call('frame_start', { name: 'approve', aspect: '16:9' });
  const apid = r.text.match(/\((p_\w+)\)/)?.[1];
  await call('frame_import', { paths: [clip] });
  await call('frame_edit', { ops: [{ op: 'add_clip', asset: 'a1', in: 0, out: 1 }] });
  res = await ui({ action: 'approve' });
  const noRender = res.error;
  r = await call('frame_render', { quality: 'draft', output_dir: path.join(tmp, 'out2') });
  const rendered = r.text.match(/Rendered: (.+)/)?.[1];
  fs.mkdirSync(env.FRAME_APPROVED_DIR, { recursive: true }); fs.writeFileSync(path.join(env.FRAME_APPROVED_DIR, 'approve_v1.mp4'), 'keep me');
  const ap1 = await ui({ action: 'approve' }), ap2 = await ui({ action: 'approve' });
  ok('approve copies the render and never overwrites', /Render the project first/.test(noRender || '') && fs.readFileSync(path.join(env.FRAME_APPROVED_DIR, 'approve_v1.mp4'), 'utf8') === 'keep me'
    && ap1.file?.endsWith('approve_v2.mp4') && ap2.file?.endsWith('approve_v3.mp4') && fs.statSync(ap1.file).size === fs.statSync(rendered).size && fs.statSync(ap2.file).size === fs.statSync(rendered).size,
    `${path.basename(ap1.file || '?')}, ${path.basename(ap2.file || '?')}`);

  // Lines: n balanced lines, sized and wrapped so the window's drawText (the one drawing path) keeps exactly those breaks.
  const { balanceLines, reflowLines, drawText } = await import('../ui/text-draw.js');
  const mono = (s) => s.length * 10;
  const b2 = balanceLines('one two three four five six', 2, mono).lines, b3 = balanceLines('one two three four five six', 3, mono).lines, b9 = balanceLines('one two', 9, mono).lines;
  const W = 1080, H = 1920, fakeCtx = () => { const g = { font: '', drawn: [], measureText(t) { return { width: t.length * parseFloat(g.font.split(' ')[1]) * 0.5 }; }, fillText(t) { g.drawn.push(t); }, strokeText() {}, beginPath() {}, roundRect() {}, fill() {} }; return g; };
  const cap = { text: { content: 'the quick brown fox jumps over the lazy dog today', size: 0.055, color: '#fff', stroke: null, strokeWidth: 0, bg: null, weight: 800, x: 0.5, y: 0.5, maxWidth: 0.84, uppercase: true, font: 'x' } };
  const counts = [1, 2, 3, 4].map((n) => { const f = reflowLines(cap, n, W, (s, size) => s.length * size * H * 0.5); const g = fakeCtx(); drawText(g, { text: { ...cap.text, ...f.style, content: f.text } }, W, H); return g.drawn.length; });
  const auto = reflowLines({ text: { ...cap.text, content: 'a\nb c' } }, 'auto', W, () => 1);
  ok('Lines reflows text into N balanced lines that drawText keeps', b2.join('|') === 'one two three|four five six' && b3.join('|') === 'one two|three four|five six' && b9.length === 2 && counts.join() === '1,2,3,4' && auto.text === 'a b c',
    `2 → ${b2.join(' / ')}; drawn line counts for 1–4: ${counts.join(', ')}`);
  r = await call('frame_edit', { ops: [{ op: 'add_text', text: 'one two three', start: 0, duration: 1 }] });
  const lid = r.text.match(/\[(c_\w+)\]/)?.[1];
  r = await call('frame_edit', { ops: [{ op: 'update_clip', id: lid, text: 'one two\nthree', style: { size: 0.07, maxWidth: 0.5 } }] });
  const stored = projOf(apid).clips.find((c) => c.id === lid).text;
  ok('a reflow is stored through update_clip', /✓ [\s\S]*size 0\.055 → 0\.07 · maxWidth 0\.84 → 0\.5/.test(r.text) && stored.content === 'one two\nthree' && stored.size === 0.07 && stored.maxWidth === 0.5, r.text.replace(/\n/g, '⏎').slice(0, 120));

  // ── 1.4 effect clips and the person cutout: drawn by ui/effects.js, never shipped stale or wrong.
  const g2 = buildGraph({ width: 100, height: 100, fps: 30, assets: {}, clips: [{ id: 'e1', kind: 'effect', track: 'V2', start: 0, in: 0, out: 1, speed: 1, effect: { type: 'letter_window', params: {} } }] }, { effects: {}, assetPath: () => '' });
  ok('an effect with no drawn frames is never composited', g2.inputs.length === 0 && /has not been drawn/.test(g2.warnings.join(' ')));
  await call('frame_start', { name: 'effects', aspect: '9:16' });
  // prepare: false keeps the cutout from starting at import, so the "needs a cutout" path below is exercised.
  await call('frame_import', { paths: [clip], prepare: false });
  await call('frame_edit', { ops: [{ op: 'add_clip', asset: 'a1', in: 0, out: 3 }] });
  r = await call('frame_edit', { ops: [{ op: 'add_effect', effect: 'nope', start: 0 }, { op: 'add_effect', effect: 'letter_window', start: 0.5, duration: 1, params: { weight: 2000 } },
    { op: 'add_effect', effect: 'letter_window', start: 0.51, duration: 1, params: { text: 'HI', bg: '#ff0000' } }, { op: 'add_effect', effect: 'clone_row', start: 2, duration: 0.5, track: 'V1' }] });
  const fxId = r.text.match(/3\. ✓ .*\[(c_\w+)\]/)?.[1];
  ok('add_effect rejects unknown effects, out-of-range settings and its own source track; snaps to whole frames', /1\. ✗ add_effect: add_effect needs effect/.test(r.text) && /2\. ✗ .*weight must be a number from 100 to 900/.test(r.text)
    && /3\. ✓ Effect Letter window effect on V2 at 00:00\.50/.test(r.text) && /4\. ✗ .*cannot sit on the track it reads/.test(r.text), r.text.split('\n').slice(0, 4).join(' | ').slice(0, 260));
  r = await call('frame_effects', {});
  ok('frame_effects lists every effect with its settings', /clone_row — Clone row \(cue words: [^)]*\) \[needs a cutout/.test(r.text) && /letter_window — Letter window \(cue words: "letter window"/.test(r.text) && /settings: text \(text, default "FRAME"\)/.test(r.text), r.text.match(/• letter_window.*/)?.[0]?.slice(0, 160));
  if (findChrome()) {
    const look = async (t) => { const v = await call('frame_view', { t }); return { v, img: v.content.find((c) => c.type === 'image')?.data }; };
    let { v, img } = await look(1);
    ok('an effect clip is drawn in headless Chrome with ui/effects.js and composited', !!img && redPixels(img) > 20000 && !/Effect not in these frames/.test(v.text), img ? `red pixels ${redPixels(img)}` : v.text.match(/⚠.*/)?.[0]);
    r = await call('frame_edit', { ops: [{ op: 'update_clip', id: fxId, params: { bg: '#ffffff' } }] });
    ({ v, img } = await look(1));
    ok('a changed effect is redrawn, never shipped from its old frames', /bg #ff0000 → #ffffff/.test(r.text) && !!img && whitePixels(img) > 20000 && redPixels(img) < 500, img ? `white ${whitePixels(img)}, red ${redPixels(img)}` : 'no image');
    await call('frame_edit', { ops: [{ op: 'add_effect', effect: 'clone_row', start: 2, duration: 0.5 }] });
    ({ v } = await look(2.2));
    ok('an effect that needs a cutout says so instead of drawing wrong', /Effect not in these frames: .*needs a cutout of clip\.mp4/.test(v.text), v.text.match(/⚠.*/)?.[0]);
    r = await call('frame_render', { quality: 'draft', output_dir: path.join(tmp, 'out3') });
    ok('render refuses while an effect cannot be drawn', r.isError && /Not rendered: .*needs a cutout/.test(r.text), r.text.slice(0, 160));
    const { cutoutEngine } = await import('../src/cutout.js');
    if ((await cutoutEngine()).id) {
      r = await call('frame_cutout', { asset: 'a1', from: 0, to: 1, quality: 'fast' });
      ok('frame_cutout runs every frame and reports what it measured', /Cut out the person in a1 .*source 0–1s: 30 frames/.test(r.text) && /person in \d+\/30 frames/.test(r.text), r.text.split('\n').slice(0, 2).join(' | ').slice(0, 220));
      r = await call('frame_effects', {});
      ok('frame_effects names the part of the footage a cutout does not cover', /covers source 0–1s but this effect shows 2–2\.5s/.test(r.text), r.text.match(/⚠.*/)?.[0]);
    } else console.log('- skipped cutout checks: no cutout engine on this machine');
    r = await call('frame_render', { quality: 'draft', allow_missing_effects: true, output_dir: path.join(tmp, 'out3') });
    const fxFile = r.text.match(/Rendered: (.+)/)?.[1];
    const mid = fxFile && path.join(tmp, 'fxmid.jpg'); if (mid) spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', fxFile, '-frames:v', '1', mid]);
    ok('a render draws the effect frames it needs and names what it left out', !!fxFile && /Drew \d+ new effect frame/.test(r.text) && /left out/.test(r.text) && whitePixels(fs.readFileSync(mid).toString('base64')) > 5000, r.text.split('\n').slice(0, 3).join(' | ').slice(0, 220));
  } else console.log('- skipped effect drawing checks: no Chrome/Chromium found');
  {
    const { cutoutEngine } = await import('../src/cutout.js');
    if ((await cutoutEngine()).id) {
      await call('frame_start', { name: 'prepare', aspect: '9:16' });
      r = await call('frame_import', { paths: [clip] });
      const started = /Preparing in the background: .*person cutout of a1/.test(r.text);
      r = await call('frame_cutout', { asset: 'a1' });
      ok('import starts the person cutout in the background and frame_cutout waits for it', started && /Cut out the person in a1|a1 already has a cutout/.test(r.text), r.text.split('\n')[0].slice(0, 200));
    }
  }
  // Decision sheet and frame_decide (against the mock above)
  {
    await call('frame_start', { name: 'decide', aspect: '9:16' });
    r = await call('frame_import', { paths: [clip], decide_pack: 'sketch-to-demo' });
    ok('an unsure role is marked REVIEW, with the runner-up', /a1 clip\.mp4: REVIEW, unsure: reaction_hook 55% or \w+ \d+%/.test(r.text), r.text.match(/a1 clip\.mp4: .*/)?.[0]);
    r = await call('frame_state');
    ok('frame_state carries the decision sheet', /Decision sheet/.test(r.text) && /pack "sketch-to-demo"/.test(r.text));
    r = await call('frame_decide', { questions: { looks_at_lens: 'Does someone look at the lens?', shot: { type: 'choice', instructions: 'What shot is this?', criteria: ['Close-up', 'Wide shot'] } } });
    ok('frame_decide answers yes/no and choice questions as guesses', /NOT measurements/.test(r.text) && /looks_at_lens: yes \(P\(yes\) 80%\)/.test(r.text) && /shot: close_up 90% · wide_shot 10%/.test(r.text), r.text.split('\n').slice(2, 4).join(' | '));
    r = await call('frame_decide', { questions: { x: { type: 'maybe', instructions: 'Hmm?' } } });
    ok('frame_decide rejects a malformed question with a usable message', r.isError && /type must be "yes_no", "choice" or "score"/.test(r.text), r.text.slice(0, 120));
    r = await call('frame_decide', { from: 1, to: 3, questions: { force_402: 'Anything?' } });
    ok('frame_decide says plainly when Google refuses (credits used up)', /failed: Google says the prepaid credits are used up/.test(r.text) && /source 1–3s/.test(r.text), r.text.match(/failed: .*/)?.[0]);
    ok('every request the mock saw had the documented shape', decideSeen.length >= 4 && decideSeen.every((x) => x.shapeOk), `${decideSeen.length} requests`);
  }
  // The swarm: Caster + Scouts + Trimmer on a custom template, then strips and a Director pick (against the mock)
  {
    await call('frame_start', { name: 'swarm', aspect: '9:16' });
    await call('frame_import', { paths: [clip, noisy] });
    const slots = [{ id: 'one', role: 'talking_head', seconds: 1 }, { id: 'two', role: 'talking_head', seconds: 1.5 }];
    r = await call('frame_swarm', { slots, pack: 'general' });
    ok('frame_swarm builds and trims every slot, live, and hands over the Director brief', /Swarm built the "custom" cut/.test(r.text) && /2\/2 slots trimmed/.test(r.text) && /NOW YOU ARE THE DIRECTOR/.test(r.text), r.text.split('\n')[0].slice(0, 200));
    r = await call('frame_state');
    const v1 = (r.text.split('\nV1:\n')[1] || '').split(/\n[A-Z]/)[0];
    ok('the swarm cut is on V1 with the template lengths', (v1.match(/· [\d.]+–[\d.]+s ·/g) || []).length === 2 && /0–2\.5s|2\.5s/.test(v1), v1.trim().split('\n').join(' | ').slice(0, 200));
    r = await call('frame_swarm', { slots, pack: 'general' });
    ok('frame_swarm will not overwrite V1 unless told to', r.isError && /replace: true/.test(r.text));
    r = await call('frame_swarm', { action: 'strips' });
    ok('strips returns a filmstrip image per candidate clip', r.content.filter((c) => c.type === 'image' && c.data.length > 2000).length === 2 && /Frame n is at second n/.test(r.text));
    r = await call('frame_swarm', { action: 'direct', picks: [{ slot: 'one', asset: 'a2', start: 3, why: 'test pick' }, { slot: 'nope', asset: 'a1', start: 0 }] });
    ok('direct applies the Director pick and names the bad one', /1\. ✓ .*a2 00:03\.00/.test(r.text) && /no slot "nope"/.test(r.text), r.text.split('\n')[0].slice(0, 160));
  }
  {
    await call('frame_start', { name: 'Local title prompt' });
    await call('frame_edit', { ops: [{ op: 'add_effect', effect: 'live_graphic', label: 'Main title', start: 1, duration: 2,
      params: { nodes: [{ id: 'main-title', kind: 'text', x: .5, y: .5, text: 'First look' }] } }] });
    const callsBefore = decideSeen.length;
    r = await call('frame_prompt', { prompt: 'Change the Main title to "Take two".', playhead: 2 });
    const jobId = JSON.parse(r.content[0].text).job_id;
    r = await call('frame_prompt_jobs');
    const job = JSON.parse(r.content[0].text).find(j => j.id === jobId);
    ok('the local title prompt routes one text edit without a model request', job?.status === 'ready'
      && job.route.provider === 'local-title' && job.before === 'First look' && job.after === 'Take two'
      && decideSeen.length === callsBefore);
  }
} finally {
  decideMock.close();
  daemon.kill(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // the daemon may still be finishing a write
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
