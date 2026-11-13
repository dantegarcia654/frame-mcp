// Draws text clips without the Frame window, by running ui/text-draw.js (the same code the window uses) in headless Chrome.
// The ffmpeg most people have (including Homebrew's default) is built without drawtext, and Node has no canvas, so a
// browser is the only zero-dependency way to draw text that matches the preview pixel for pixel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DRAW_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'text-draw.js');

const CANDIDATES = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
  win32: [`${process.env['PROGRAMFILES'] || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`],
};

function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) { const f = path.join(dir, name); if (fs.existsSync(f)) return f; }
  return null;
}

/** Absolute path of a Chromium-based browser, or null. FRAME_CHROME overrides the search. */
export function findChrome() {
  if (process.env.FRAME_CHROME) return fs.existsSync(process.env.FRAME_CHROME) ? process.env.FRAME_CHROME : null;
  for (const c of CANDIDATES[process.platform] || []) { const f = path.isAbsolute(c) ? (fs.existsSync(c) ? c : null) : onPath(c); if (f) return f; }
  return null;
}

const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/**
 * Draw text clips in headless Chrome.
 * @param jobs [{ id, clip, W, H }]
 * @returns { [id]: { x, y, png: Buffer } }
 * Throws with a plain explanation when no browser is available or drawing fails.
 */
export async function drawTextsHeadless(jobs, { timeoutMs = 30000 } = {}) {
  if (!jobs.length) return {};
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chrome, Chromium, Edge or Brave found to draw text without the Frame window (set FRAME_CHROME to one).');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-text-'));
  try {
    const payload = JSON.stringify(jobs.map((j) => ({ id: j.id, c: { text: j.clip.text }, W: j.W, H: j.H }))).replace(/</g, '\\u003c');
    const page = `<!doctype html><meta charset="utf-8"><body><pre id="out">PENDING</pre><script type="module">
${fs.readFileSync(DRAW_JS, 'utf8')}
const out = {};
try {
  for (const j of ${payload}) {
    const r = rasterText(j.c, j.W, j.H, (w, h) => { const e = document.createElement('canvas'); e.width = w; e.height = h; return e; });
    out[j.id] = { x: r.x, y: r.y, png: r.canvas.toDataURL('image/png') };
  }
  document.getElementById('out').textContent = 'FRAMETEXT' + JSON.stringify(out) + 'FRAMETEXT';
} catch (e) { document.getElementById('out').textContent = 'FRAMEERR' + e.message + 'FRAMEERR'; }
</script>`;
    const file = path.join(dir, 'text.html'); fs.writeFileSync(file, page);
    // A throwaway profile, so this never touches the user's own browser profile or sessions.
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
      `--user-data-dir=${path.join(dir, 'profile')}`, '--virtual-time-budget=5000', '--dump-dom', 'file://' + file];
    const html = await new Promise((resolve, reject) => {
      const p = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`headless Chrome did not finish drawing text within ${timeoutMs / 1000}s`)); }, timeoutMs);
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      p.on('error', (e) => { clearTimeout(t); reject(new Error('could not start headless Chrome: ' + e.message)); });
      p.on('close', (code) => { clearTimeout(t); code === 0 || out ? resolve(out) : reject(new Error(`headless Chrome exited ${code}: ${err.slice(-400)}`)); });
    });
    // Only read the <pre> the page wrote into; the dumped DOM also contains the script source.
    const pre = html.match(/<pre id="out">([\s\S]*?)<\/pre>/); if (!pre) throw new Error('headless Chrome returned no page');
    const text = unescapeHtml(pre[1]);
    const bad = text.match(/^FRAMEERR([\s\S]*)FRAMEERR$/); if (bad) throw new Error('drawing text failed in headless Chrome: ' + bad[1]);
    const m = text.match(/^FRAMETEXT([\s\S]*)FRAMETEXT$/); if (!m) throw new Error('headless Chrome did not finish drawing text');
    const res = {};
    for (const [id, r] of Object.entries(JSON.parse(m[1]))) res[id] = { x: r.x, y: r.y, png: Buffer.from(r.png.split(',')[1], 'base64') };
    return res;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
