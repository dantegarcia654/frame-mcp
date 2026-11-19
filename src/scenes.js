// Renders scene clips (ui/scene-draw.js) to video in headless Chrome, so frame_view and the export composite exactly
// what the window previews. Several Chromes run at once; each one takes the next scene from the queue, draws every
// frame of it and pipes the frames into ffmpeg (H.264 for full-frame scenes, ProRes 4444 with alpha for overlays).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from './text.js';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function staticServer() {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(UI, rel);
    if (!file.startsWith(UI) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function cdpConnect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  return { send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}

/** One headless Chrome with the scene page loaded. */
async function openBrowser(port) {
  const chrome = findChrome(); if (!chrome) throw new Error('No Chrome/Chromium/Edge/Brave found to draw scenes (set FRAME_CHROME).');
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-scenes-'));
  const dport = 9700 + Math.floor(Math.random() * 280);
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${dport}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 120 && !target; i++) { try { const l = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json(); target = l.find((t) => t.type === 'page'); } catch {} if (!target) await sleep(100); }
  if (!target) { proc.kill('SIGKILL'); throw new Error('headless Chrome did not start'); }
  const cdp = await cdpConnect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/scene-render.html` });
  const ev = async (expression, awaitPromise = false) => { const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }); if (r.exceptionDetails) throw new Error('scene draw failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
  for (let i = 0; i < 100; i++) { try { if ((await ev('typeof window.__ready')) === 'object') break; } catch {} await sleep(60); }
  await ev('window.__ready', true);
  const close = async () => { try { cdp.close(); } catch {} const gone = new Promise((r) => proc.once('exit', r)); proc.kill(); await Promise.race([gone, sleep(2500)]); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} };
  return { ev, close };
}

function encoder(file, fps, alpha) {
  const args = alpha
    ? ['-v', 'error', '-y', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', '-', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', file]
    : ['-v', 'error', '-y', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps), '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file];
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = ''; ff.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const done = new Promise((res, rej) => ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg (scene encode) failed: ${err}`)))));
  return { write: (buf) => (ff.stdin.write(buf) ? null : new Promise((r) => ff.stdin.once('drain', r))), end: () => { ff.stdin.end(); return done; } };
}

/**
 * Render scene clips to video files.
 * @param jobs [{ id, clip, W, H, fps, T0 (timeline seconds at scene time 0), len (scene seconds to draw), alpha, file }]
 * @param o.onDone(job) called as each file is finished · o.concurrency Chromes at once
 */
export async function renderSceneClips(jobs, o = {}) {
  if (!jobs.length) return;
  const srv = await staticServer(), port = srv.address().port;
  const queue = [...jobs].sort((a, b) => b.len - a.len);
  const n = Math.max(1, Math.min(queue.length, o.concurrency || Math.max(2, Math.min(6, os.cpus().length - 3))));
  const worker = async () => {
    const b = await openBrowser(port);
    try {
      for (let j; (j = queue.shift());) {
        await b.ev(`window.__setup(${JSON.stringify(j.clip).replace(/</g, '\\u003c')}, ${j.W}, ${j.H})`);
        const enc = encoder(j.file, j.fps, j.alpha), frames = Math.max(1, Math.round(j.len * j.fps));
        for (let f = 0; f < frames; f++) {
          const lt = f / j.fps, url = await b.ev(`window.__draw(${lt}, ${j.T0 + lt}, '${j.alpha ? 'image/png' : 'image/jpeg'}', 0.93)`);
          const w = enc.write(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')); if (w) await w;
        }
        await enc.end();
        o.onDone?.(j);
      }
    } finally { await b.close(); }
  };
  try { await Promise.all(Array.from({ length: n }, worker)); } finally { srv.close(); }
}

/** Still JPEGs of one scene at the given scene times (for contact sheets and quick looks). */
export async function sceneStills(clip, times, { W = 1080, H = 1920, T0 = 0 } = {}) {
  const srv = await staticServer(), b = await openBrowser(srv.address().port);
  try {
    await b.ev(`window.__setup(${JSON.stringify(clip).replace(/</g, '\\u003c')}, ${W}, ${H})`);
    const out = [];
    for (const t of times) { const url = await b.ev(`window.__draw(${t}, ${T0 + t}, 'image/jpeg', 0.9)`); out.push(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')); }
    return out;
  } finally { await b.close(); srv.close(); }
}
