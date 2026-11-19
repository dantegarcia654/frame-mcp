// Animated card renderer: spec → one transparent ProRes 4444 clip per card, rendered in parallel.
// 1. Headless Chrome draws every visual state of every card to a transparent PNG (src/cards-draw.js).
// 2. ffmpeg animates the states (spring pop / slam / slide in, snap out) onto a 1080×1920 transparent frame.
// Each clip starts at its card's start time; Frame places it on an overlay track.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const F = (x) => Number(x).toFixed(3);

async function cdpConnect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  return { send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}

/** Kill Chrome and remove its profile (it can still be writing for a moment after the kill; never fail on cleanup). */
export async function closeChrome({ prof, chrome }) {
  try { chrome.kill('SIGKILL'); } catch {}
  for (let i = 0; i < 10; i++) { try { fs.rmSync(prof, { recursive: true, force: true }); if (!fs.existsSync(prof)) return; } catch {} await sleep(150); }
}

/** Start headless Chrome now (≈2 s) so it is ready when the card text is. */
export function warmChrome() {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-cards-'));
  const port = 9600 + Math.floor(Math.random() * 300);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  return { prof, port, chrome };
}

/** Draw all card states in one headless Chrome (a warmed one if given). Returns per card [{at, w, h, file}]. */
export async function drawStates(cards, dir, warm) {
  const { prof, port, chrome } = warm || warmChrome();
  try {
    let target;
    for (let i = 0; i < 80 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(100); }
    if (!target) throw new Error('Chrome did not start');
    const cdp = await cdpConnect(target.webSocketDebuggerUrl);
    const lib = fs.readFileSync(path.join(HERE, 'cards-draw.js'), 'utf8');
    const r0 = await cdp.send('Runtime.evaluate', { expression: lib + ';document.fonts.ready.then(()=>true)', awaitPromise: true });
    if (r0.exceptionDetails) throw new Error(JSON.stringify(r0.exceptionDetails).slice(0, 400));
    const out = [];
    for (const k of cards) {
      const r = await cdp.send('Runtime.evaluate', { expression: `window.cardStates(${JSON.stringify(k)})`, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`card ${k.id}: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
      out.push(r.result.value.map((s, i) => { const file = path.join(dir, `${k.id}_${String(i).padStart(2, '0')}.png`); fs.writeFileSync(file, Buffer.from(s.png.split(',')[1], 'base64')); return { at: s.at, w: s.w, h: s.h, file }; }));
    }
    cdp.close();
    return out;
  } finally { if (!warm) await closeChrome({ prof, chrome }); } // a warmed Chrome is closed by whoever warmed it
}

/** Motion: scale S(t), offset DX/DY(t) for the whole card (all states share it); t = seconds since the card started. */
function motion(k, D) {
  const p = (dur, d = 0) => `clip((t-${d})/${dur},0,1)`;
  const exit = `(1-0.1*${p(0.2, F(D - 0.2))})`;
  if (k.enter === 'slam') return { S: `(1.25-0.25*(1-pow(1-${p(0.16)},3)))*${exit}`, DX: `8*sin(t*95)*gte(t,0.16)*(1-${p(0.22, 0.16)})`, DY: '0' };
  if (k.enter === 'slide') return { S: exit, DX: `-300*pow(1-${p(0.32)},3)`, DY: '0' };
  const b = p(0.4); // spring pop (easeOutBack) + rise
  return { S: `(0.8+0.2*(1+2.70158*pow(${b}-1,3)+1.70158*pow(${b}-1,2)))*${exit}`, DX: '0', DY: `80*pow(1-${p(0.36)},3)` };
}

function run(cmd, args) {
  return new Promise((res, rej) => { const pr = spawn(cmd, args); let e = ''; pr.stderr.on('data', (d) => (e += d)); pr.on('close', (c) => (c ? rej(new Error(e.slice(-800))) : res())); });
}

/** Composite one card's states into a transparent full-frame clip. */
export async function animateCard(k, states, file, { W = 1080, H = 1920, fps = 30, compact = false } = {}) {
  // compact: a canvas just big enough for the card and its motion (≈4-6× fewer pixels than a full frame, so it encodes
  // that much faster); the caller positions it. Otherwise a full transparent frame with the card at k.y.
  const mw = Math.max(...states.map((s) => s.w)), mh = Math.max(...states.map((s) => s.h));
  const cw = compact ? Math.min(W, Math.ceil((mw * 1.28 + (k.enter === 'slide' ? 320 : 0) + 24) / 2) * 2) : W;
  const ch = compact ? Math.ceil((mh * 1.28 + 100) / 2) * 2 : H;
  const cy = compact ? ch / 2 : k.y;
  const D = k.end - k.start;
  const { S, DX, DY } = motion(k, D);
  const args = ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black@0.0:s=${cw}x${ch}:r=${fps}:d=${F(D)},format=rgba`];
  for (const s of states) args.push('-loop', '1', '-framerate', String(fps), '-t', F(D), '-i', s.file);
  const g = []; let last = '0:v';
  states.forEach((s, i) => {
    const until = i + 1 < states.length ? states[i + 1].at : D;
    g.push(`[${i + 1}:v]format=rgba,scale=w='trunc(iw*${S}/2)*2':h='trunc(ih*${S}/2)*2':eval=frame,fade=t=in:st=0:d=0.1:alpha=1,fade=t=out:st=${F(D - 0.2)}:d=0.2:alpha=1[s${i}]`);
    g.push(`[${last}][s${i}]overlay=x='(W-w)/2+${DX}':y='${cy}-h/2+${DY}':eval=frame:enable='between(t,${F(s.at)},${F(until - 0.0001)})'[o${i}]`);
    last = `o${i}`;
  });
  // VP9 with alpha: small, plays in the Frame window as-is (no preview proxy), and Frame's renderer decodes it with libvpx.
  args.push('-filter_complex', g.join(';'), '-map', `[${last}]`, '-t', F(D), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '0', '-crf', '24', '-auto-alt-ref', '0', file);
  await run('ffmpeg', args);
  return { file, w: cw, h: ch };
}

/** Render a whole spec. onCard(card, file) fires as each clip finishes (they run in parallel). */
export async function renderCards(spec, outDir, { onCard, compact = false, warm } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const states = await drawStates(spec.cards, outDir, warm);
  return Promise.all(spec.cards.map(async (k, i) => {
    const r = await animateCard(k, states[i], path.join(outDir, `${k.id}.webm`), { compact });
    // Frame placement for a compact clip: native pixel size, centred at k.y (contain-fit scale undone).
    r.place = compact ? { fit: 'contain', scale: +(1 / Math.min(1080 / r.w, 1920 / r.h)).toFixed(5), y: +((k.y - 960) / 1920).toFixed(4) } : { fit: 'cover' };
    if (onCard) await onCard(k, r.file, r.place);
    return { card: k, ...r };
  }));
}
