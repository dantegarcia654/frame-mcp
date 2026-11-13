// The one place caption pixels come from.
// The window imports this for the live preview and to rasterise captions. The service runs this same file in headless
// Chrome when no window is open (src/text.js). Because both use this code, the preview, frame_view and the render
// draw identical text. Do not draw text anywhere else.

const clampN = (n, a, b) => Math.min(b, Math.max(a, n));

/** The key a raster is stored under. Any change to the text or its style, or to the frame size, makes a new key. */
export const textKey = (c, W, H) => JSON.stringify([c.text, W, H]);

/** Draw a text clip onto a 2D context of a W×H frame. Returns the box it covers (with room for the stroke). */
export function drawText(g, c, W, H) {
  const s = c.text, px = s.size * H;
  g.font = `${s.weight} ${px}px ${s.font}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  const maxW = s.maxWidth * W, lines = [];
  for (const para of (s.uppercase ? s.content.toUpperCase() : s.content).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) { const tryL = line ? `${line} ${word}` : word; if (line && g.measureText(tryL).width > maxW) { lines.push(line); line = word; } else line = tryL; }
    lines.push(line);
  }
  const lh = px * 1.2, bw = Math.max(...lines.map((l) => g.measureText(l).width)), bh = lines.length * lh;
  const cx = s.x * W, cy = s.y * H, pad = s.bg ? px * 0.35 : 0, sw = (s.stroke ? s.strokeWidth : 0) * px;
  if (s.bg) { g.fillStyle = s.bg; g.beginPath(); g.roundRect(cx - bw / 2 - pad * 1.3, cy - bh / 2 - pad * 0.6, bw + pad * 2.6, bh + pad * 1.2, px * 0.18); g.fill(); }
  lines.forEach((l, i) => {
    const y = cy - bh / 2 + lh * (i + 0.5);
    if (s.stroke && sw > 0) { g.strokeStyle = s.stroke; g.lineWidth = sw; g.strokeText(l, cx, y); }
    g.fillStyle = s.color; g.fillText(l, cx, y);
  });
  const m = Math.ceil(sw + pad * 1.4 + px * 0.25);
  return { x: Math.floor(cx - bw / 2 - m), y: Math.floor(cy - bh / 2 - m), w: Math.ceil(bw + m * 2), h: Math.ceil(bh + m * 2) };
}

/**
 * Lines: split the words of a caption into exactly n lines (fewer if there are fewer words) so the widest line is as
 * short as possible. measure(str) returns the drawn width of a line. Captions are a few words, so an exhaustive search is cheap.
 * @returns { lines: string[], widest } — widest is measure() of the widest line
 */
export function balanceLines(content, n, measure) {
  const words = String(content).replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [], widest: 0 };
  n = clampN(Math.floor(n) || 1, 1, words.length);
  const N = words.length, w = (i, j) => measure(words.slice(i, j).join(' '));
  const best = Array.from({ length: n + 1 }, () => Array(N + 1).fill(Infinity)), cut = Array.from({ length: n + 1 }, () => Array(N + 1).fill(0));
  best[0][0] = 0;
  for (let k = 1; k <= n; k++) for (let j = k; j <= N; j++) for (let i = k - 1; i < j; i++) { const v = Math.max(best[k - 1][i], w(i, j)); if (v < best[k][j]) { best[k][j] = v; cut[k][j] = i; } }
  const lines = []; for (let k = n, j = N; k > 0; k--) { const i = cut[k][j]; lines.unshift(words.slice(i, j).join(' ')); j = i; }
  return { lines, widest: best[n][N] };
}

/**
 * The style a Lines button sets: the text reflowed into n balanced lines, sized as large as fits the frame (up to normal
 * caption size), and a line width just wide enough that drawText keeps exactly those breaks. n = 'auto' joins the words
 * back into one paragraph and lets drawText wrap it again. measureAt(str, sizeFraction) measures with the caption's font.
 * @returns { text, style: { size?, maxWidth } }
 */
export function reflowLines(c, n, W, measureAt) {
  const s = c.text, round3 = (v) => Math.round(v * 1000) / 1000;
  if (n === 'auto' || n === 'Auto') return { text: String(s.content).replace(/\n/g, ' ').split(/\s+/).filter(Boolean).join(' '), style: { maxWidth: 0.84 } };
  const { lines, widest } = balanceLines(s.content, n, (str) => measureAt(s.uppercase ? str.toUpperCase() : str, s.size));
  if (!lines.length) return { text: s.content, style: {} };
  const room = 0.94 * W, size = Math.min(Math.max(s.size, 0.055), (s.size * room) / widest); // 1 line → 3 lines grows the text back
  const widestAt = (widest * size) / s.size;
  return { text: lines.join('\n'), style: { size: round3(size), maxWidth: round3(clampN(widestAt / W + 0.04, 0.12, 1)) } };
}

/**
 * Draw one text clip on a full frame and crop it to its box.
 * @param make (w, h) => canvas — OffscreenCanvas in the window, a <canvas> element in headless Chrome
 * @returns { x, y, canvas } where x, y is where the crop sits in the frame
 */
export function rasterText(c, W, H, make) {
  const full = make(W, H);
  const r = drawText(full.getContext('2d'), c, W, H);
  const x = clampN(r.x, 0, W - 2), y = clampN(r.y, 0, H - 2), w = clampN(r.w, 2, W - x), h = clampN(r.h, 2, H - y);
  const crop = make(w, h); crop.getContext('2d').drawImage(full, x, y, w, h, 0, 0, w, h);
  return { x, y, canvas: crop };
}
