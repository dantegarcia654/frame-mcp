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
