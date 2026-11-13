#!/usr/bin/env node
// Records the Frame window to an MP4 using the Chrome already on this machine (headless, throwaway profile).
// usage: node scripts/record.mjs out.mp4 [--size 1600x900] [--script actions.mjs]
//   stop with: touch <out.mp4>.stop (or Ctrl-C). With --script, the module's default export drives the page
//   ({ send, evaluate, mouse, sleep }) and the recording stops when it returns.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const out = path.resolve(process.argv[2] || 'frame-demo.mp4');
const size = (process.argv.includes('--size') ? process.argv[process.argv.indexOf('--size') + 1] : '1600x900').split('x').map(Number);
const url = `http://127.0.0.1:${process.env.FRAME_PORT || 4747}`;
const windows = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
  .flatMap((d) => [path.join(d, 'Google/Chrome/Application/chrome.exe'), path.join(d, 'Microsoft/Edge/Application/msedge.exe')]);
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', ...windows].find((p) => fs.existsSync(p));
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
const waiting = new Map();
const send = (method, params = {}) => new Promise((res) => { waiting.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
ws.onopen = () => { send('Page.enable'); send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: size[0], maxHeight: size[1], everyNthFrame: 1 }); console.log(`recording ${url} → ${out}`); };
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); return; }
  if (m.method !== 'Page.screencastFrame') return;
  const file = path.join(tmp, `f${String(n++).padStart(6, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(m.params.data, 'base64'));
  frames.push({ file, t: m.params.metadata.timestamp });
  send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
};

let done = false; const marks = {};
async function finish() {
  if (done) return; done = true;
  try { ws.close(); } catch {} proc.kill();
  if (frames.length < 2) { console.error('No frames captured.'); process.exit(1); }
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.01, (frames[i + 1]?.t ?? f.t + 1.5) - f.t).toFixed(3)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  fs.writeFileSync(path.join(tmp, 'list.txt'), list);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: 'inherit' });
  if (Object.keys(marks).length) fs.writeFileSync(out + '.marks.json', JSON.stringify({ span: frames.at(-1).t - frames[0].t, marks: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, +(v - frames[0].t).toFixed(2)])) }, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(out + '.stop', { force: true });
  console.log(r.status === 0 ? `saved ${out} (${frames.length} frames, ${(frames.at(-1).t - frames[0].t).toFixed(1)}s)` : 'encode failed');
  process.exit(r.status ?? 1);
}
process.on('SIGINT', finish); process.on('SIGTERM', finish);
setInterval(() => { if (fs.existsSync(out + '.stop')) finish(); }, 500);

const scriptArg = process.argv.includes('--script') && process.argv[process.argv.indexOf('--script') + 1];
if (scriptArg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
  let mx = 0, my = 0;
  const mouse = {
    async move(x, y, ms = 500) { const n = Math.max(2, Math.round(ms / 16)), x0 = mx, y0 = my; for (let i = 1; i <= n; i++) { const k = i / n, e = k * k * (3 - 2 * k); mx = x0 + (x - x0) * e; my = y0 + (y - y0) * e; await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx, y: my, buttons: this.down ? 1 : 0, button: this.down ? 'left' : 'none' }); await sleep(16); } },
    async press() { this.down = true; await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mx, y: my, button: 'left', clickCount: 1 }); },
    async release() { this.down = false; await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mx, y: my, button: 'left', clickCount: 1 }); },
    async click(x, y, ms = 500) { await this.move(x, y, ms); await sleep(120); await this.press(); await sleep(60); await this.release(); },
  };
  await sleep(1500);
  // A visible pointer: headless Chrome draws none.
  await evaluate(`(() => { const c = document.createElement('div'); c.innerHTML = '<svg viewBox="0 0 12 16" width="18" height="24"><path d="M0 0v13l3.6-3.2L6 16l2.2-.9-2.4-6H11z" fill="#fff" stroke="#000"/></svg>'; c.style.cssText = 'position:fixed;left:0;top:0;z-index:999;pointer-events:none'; document.body.append(c); addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true); })()`);
  try { await (await import(pathToFileURL(path.resolve(scriptArg)).href)).default({ send, evaluate, mouse, sleep, mark: (name) => { marks[name] = Date.now() / 1000; } }); } catch (e) { console.error('script error:', e.message); }
  await sleep(600); finish();
}
