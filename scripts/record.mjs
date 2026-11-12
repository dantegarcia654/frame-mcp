#!/usr/bin/env node
// Records the Frame window to an MP4 using the Chrome already on this machine (headless, throwaway profile).
// usage: node scripts/record.mjs out.mp4 [--size 1600x900]   → stop with: touch <out.mp4>.stop   (or Ctrl-C)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = path.resolve(process.argv[2] || 'frame-demo.mp4');
const size = (process.argv.includes('--size') ? process.argv[process.argv.indexOf('--size') + 1] : '1600x900').split('x').map(Number);
const url = `http://127.0.0.1:${process.env.FRAME_PORT || 4747}`;
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('Chrome not found.'); process.exit(1); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-rec-'));
const port = 9333 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tmp}/profile`, `--window-size=${size[0]},${size[1]}`, '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--hide-scrollbars', url], { stdio: 'ignore' });

let ws, n = 0, id = 0; const frames = [];
for (let i = 0; i < 60 && !ws; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const pg = pages.find((p) => p.type === 'page'); if (pg) ws = new WebSocket(pg.webSocketDebuggerUrl); } catch {}
}
if (!ws) { console.error('Could not attach to Chrome.'); proc.kill(); process.exit(1); }
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
ws.onopen = () => { send('Page.enable'); send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: size[0], maxHeight: size[1], everyNthFrame: 1 }); console.log(`recording ${url} → ${out}`); };
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method !== 'Page.screencastFrame') return;
  const file = path.join(tmp, `f${String(n++).padStart(6, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(m.params.data, 'base64'));
  frames.push({ file, t: m.params.metadata.timestamp });
  send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
};

let done = false;
async function finish() {
  if (done) return; done = true;
  try { ws.close(); } catch {} proc.kill();
  if (frames.length < 2) { console.error('No frames captured.'); process.exit(1); }
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.01, (frames[i + 1]?.t ?? f.t + 1.5) - f.t).toFixed(3)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  fs.writeFileSync(path.join(tmp, 'list.txt'), list);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(out + '.stop', { force: true });
  console.log(r.status === 0 ? `saved ${out} (${frames.length} frames, ${(frames.at(-1).t - frames[0].t).toFixed(1)}s)` : 'encode failed');
  process.exit(r.status ?? 1);
}
process.on('SIGINT', finish); process.on('SIGTERM', finish);
setInterval(() => { if (fs.existsSync(out + '.stop')) finish(); }, 500);
