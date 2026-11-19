import { reframeRect } from './clip-reframe.js';
import { drawNodes, validateNodes } from './live-graphics.js';
// The one place effect pixels come from.
// The window imports this to preview effect clips live. The service runs this same file in headless Chrome to draw the
// frames that frame_view and the render composite (src/effects.js). Same code both ways: what you preview is what ships.
//
// An effect only draws. For each frame it gets:
//   f.W, f.H     size of the frame it draws, in pixels (the project size on export, the viewer size in the window)
//   f.t, f.d     seconds since the effect began, and the effect's length
//   f.base       the picture of the source track (V1 by default) at this moment, placed exactly as in the edit
//   f.matte      that picture's person cutout (white = person), same placement — or null if there is no cutout
//   f.matteAlpha true when f.matte carries the person in its alpha channel (the export path) instead of its brightness
//   f.plate      for effects with a plate setting: the empty-set shot, placed like the footage — or null
//   f.face       [x0,y0,x1,y1] of the largest face, in pixels — or null
//   f.person     [x0,y0,x1,y1] around the cutout, in pixels — or null
//   f.unit       project pixels per drawn pixel (1 on export), for numbers shown on screen
//   f.make(w,h)  a fresh canvas
// Rules: no clock, no network, randomness only from the seeded rng below, sizes relative to W/H. Frame n of an effect
// always draws the same pixels at any size.

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const lerp = (a, b, k) => a + (b - a) * k;
const prog = (t, start, len) => clamp((t - start) / Math.max(len, 1e-6), 0, 1);
const ease = {
  out: (k) => 1 - Math.pow(1 - k, 3),
  in: (k) => k * k * k,
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  back: (k) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); },
};
const hashStr = (s) => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** In over the first `inn` seconds, out over the last `out` seconds. */
const envelope = (f, inn = 0.25, out = 0.2) => Math.min(ease.out(prog(f.t, 0, inn)), ease.out(prog(f.d - f.t, 0, out)));

export const FONTS = { sans: '"Helvetica Neue", Helvetica, Arial, sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: 'Menlo, "SF Mono", Consolas, monospace' };
const font = (weight, px, fam) => `${weight} ${Math.max(1, px).toFixed(2)}px ${FONTS[fam] || fam}`;
/** Largest font size (px) at which text fits maxW and maxH. */
function fitSize(g, text, maxW, maxH, weight, fam) {
  g.font = font(weight, 100, fam); const w = g.measureText(text).width || 1;
  return Math.min(maxH, (100 * maxW) / w);
}

// ───────────────────────── shared helpers (also used by the service and the window)

/** Where a clip's picture sits in a W×H frame. Same maths as src/render.js. */
export function placeRect(aw, ah, c, W, H, localTime = 0, margin = 2) {
  if (c.reframe) return reframeRect(c.reframe, localTime, aw, ah, W, H, margin);
  const s = (c.fit === 'contain' ? Math.min(W / aw, H / ah) : Math.max(W / aw, H / ah)) * (c.scale || 1);
  const w = aw * s, h = ah * s;
  return { x: (W - w) / 2 + (c.x || 0) * W, y: (H - h) / 2 + (c.y || 0) * H, w, h };
}
/** A 0..1 box from the cutout track, mapped into frame pixels through the clip's placement. */
export const mapBox = (b, r) => (b ? [r.x + b[0] * r.w, r.y + b[1] * r.h, r.x + b[2] * r.w, r.y + b[3] * r.h] : null);

/**
 * Face and person boxes at source second s, from a cutout track ({fps, from, frames:[[face|0, person|0, cover]]}).
 * Averaged over five frames so a box does not shimmer; a frame with no detection is skipped, not counted as zero.
 */
export function trackAt(track, s) {
  if (!track?.frames?.length) return { face: null, person: null };
  const j = Math.round((s - track.from) * track.fps), out = {};
  for (const [key, col] of [['face', 0], ['person', 1]]) {
    const acc = [0, 0, 0, 0]; let n = 0;
    for (let k = j - 2; k <= j + 2; k++) { const b = track.frames[k]?.[col]; if (b) { for (let q = 0; q < 4; q++) acc[q] += b[q]; n++; } }
    out[key] = n ? acc.map((v) => v / n) : null;
  }
  return out;
}

/** Effect time for a clip at timeline second T: t counts from the effect's start, d is its length. */
export const effectTime = (c, T) => ({ t: (c.in || 0) + (T - c.start), d: c.out });

/** The source picture with the cutout as its alpha. Made once per frame. */
export function personLayer(f) {
  if (f._person !== undefined) return f._person;
  if (!f.base || !f.matte) return (f._person = null);
  const { W, H } = f, c = f.make(W, H);
  if (f.matteAlpha) { // the cutout already carries the person in its alpha: one composite, no pixel loop
    const g = c.getContext('2d'); g.drawImage(f.base, 0, 0, W, H); g.globalCompositeOperation = 'destination-in'; g.drawImage(f.matte, 0, 0, W, H);
    return (f._person = c);
  }
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(f.matte, 0, 0, W, H); const m = g.getImageData(0, 0, W, H).data;
  g.clearRect(0, 0, W, H); g.drawImage(f.base, 0, 0, W, H);
  const im = g.getImageData(0, 0, W, H), d = im.data;
  for (let i = 3; i < d.length; i += 4) d[i] = m[i - 3];
  g.putImageData(im, 0, 0);
  return (f._person = c);
}
/** White where the person is, transparent elsewhere. */
function matteAlpha(f) {
  if (f._ma !== undefined) return f._ma;
  if (!f.matte) return (f._ma = null);
  if (f.matteAlpha) return (f._ma = f.matte);
  const { W, H } = f, c = f.make(W, H), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(f.matte, 0, 0, W, H);
  const im = g.getImageData(0, 0, W, H), d = im.data;
  for (let i = 0; i < d.length; i += 4) { d[i + 3] = d[i]; d[i] = d[i + 1] = d[i + 2] = 255; }
  g.putImageData(im, 0, 0);
  return (f._ma = c);
}
/** How much of a sampled cutout pixel is person (0–255), whichever way the cutout carries it. */
const matteAt = (f, d, i) => (f.matteAlpha ? d[i + 3] : d[i]);
/**
 * The person for compositing somewhere else in the picture (a copy, a dissolving body): the outer ring of the cutout,
 * where person and background are mixed, is pulled in and the edge stays soft — so no halo of the old background.
 */
function softPerson(f) {
  if (f._soft !== undefined) return f._soft;
  const ma = matteAlpha(f); if (!ma || !f.base) return (f._soft = null);
  const { W, H } = f, m = f.make(W, H), mg = m.getContext('2d', { willReadFrequently: true });
  mg.filter = `blur(${Math.max(1, H * 0.0016).toFixed(2)}px)`; mg.drawImage(ma, 0, 0, W, H); mg.filter = 'none';
  const im = mg.getImageData(0, 0, W, H), d = im.data;
  for (let i = 3; i < d.length; i += 4) { const k = Math.min(1, Math.max(0, (d[i] / 255 - 0.4) / 0.5)); d[i] = k * k * (3 - 2 * k) * 255; }
  mg.putImageData(im, 0, 0);
  const c = f.make(W, H), g = c.getContext('2d'); g.drawImage(f.base, 0, 0, W, H); g.globalCompositeOperation = 'destination-in'; g.drawImage(m, 0, 0);
  return (f._soft = c);
}
/** Smooth deterministic noise in [0,1) at grid point (x, y): value noise over a lattice, so neighbours are related. */
function noise2(x, y, seed = 0) {
  const h = (i, j) => (hashStr(`${i},${j},${seed}`) % 10007) / 10007;
  const xi = Math.floor(x), yi = Math.floor(y), u = x - xi, v = y - yi, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), su), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), su), sv);
}
const drawBase = (g, f) => { if (f.base) g.drawImage(f.base, 0, 0, f.W, f.H); else { g.fillStyle = '#000'; g.fillRect(0, 0, f.W, f.H); } };
/** The head: the face box when there is one, otherwise the top of the person box. */
function headBox(f) {
  if (f.face) return f.face;
  if (!f.person) return null;
  const [x0, y0, x1, y1] = f.person, w = x1 - x0, hw = Math.min(w * 0.42, (y1 - y0) * 0.3);
  const cx = (x0 + x1) / 2; return [cx - hw / 2, y0 + hw * 0.25, cx + hw / 2, y0 + hw * 1.45];
}

// ───────────────────────── the effects
// needs: 'cutout' = draws nothing useful without a person cutout of the footage under it (frame_cutout).
// uses: 'cutout' = works without one, and looks better with one (it gets the cutout whenever the footage has one).
// matte: false = only reads the face/person boxes from the cutout, not its pixels (saves extracting them).
// opaque: true = covers the whole frame (it draws the picture under it itself), so it is stored as JPEG.
// A setting's range is enforced: values outside it are rejected, never clamped silently.

const num = (def, min, max, about, step) => ({ kind: 'number', default: def, min, max, about, ...(step ? { step } : {}) });
const txt = (def, about) => ({ kind: 'text', default: def, about });
const col = (def, about) => ({ kind: 'color', default: def, about });
const pick = (def, options, about) => ({ kind: 'choice', default: def, options, about });
const list = (about) => ({ kind: 'list', default: [], about });
const FONT = pick('sans', ['sans', 'serif', 'mono'], 'typeface');
const OUTLINE = (def) => num(def, 0, 0.2, 'black outline width as a share of the letter height (0 = none)');
/** White type with a clean black outline (the house style): stroke first, then fill. */
function outlined(g, text, x, y, px, P) {
  if (P.outline > 0) { g.lineJoin = 'round'; g.miterLimit = 2; g.lineWidth = px * P.outline * 2; g.strokeStyle = '#000'; g.strokeText(text, x, y); }
  g.fillStyle = P.color; g.fillText(text, x, y);
}


// Where each effect does its work in the frame: a box around what it draws and a point an agent's cursor can hold.
// Same geometry as each effect's draw, so agent_swarm sends each agent to its own edit.
const WHERE = {
  track_box(g, f, P) {
    let b = P.target === 'face' ? headBox(f) : f.person || headBox(f); if (!b) return null;
    const pad = P.pad * Math.max(b[2] - b[0], b[3] - b[1]); b = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
    return { box: b, at: [b[2], b[3]] };
  },
  text_behind(g, f, P) {
    const text = String(P.text) || ' ', px = P.size > 0 ? P.size * f.H : fitSize(g, text, f.W * 0.94, f.H * 0.5, P.weight, P.font);
    g.font = font(P.weight, px, P.font); const w = g.measureText(text).width, x0 = (f.W - w) / 2, y = P.y * f.H;
    return { box: [x0, y - px * 0.42, x0 + w, y + px * 0.42], at: [x0 + w, y - px * 0.42] };
  },
  orbit_text(g, f, P) {
    const head = headBox(f); if (!head) return null;
    const fw = head[2] - head[0], fh = head[3] - head[1], cx = (head[0] + head[2]) / 2, cy = (head[1] + head[3]) / 2 + P.lift * fh;
    const rx = P.radius * fw, ry = rx * P.tilt, px = P.size * fh;
    return { box: [cx - rx - px * 0.5, cy - ry - px, cx + rx + px * 0.5, cy + ry + px], at: [cx + rx + px * 0.5, cy - ry - px] };
  },
  rack_focus(g, f) { return { box: [f.W * 0.04, f.H * 0.04, f.W * 0.96, f.H * 0.96], at: [f.W * 0.07, f.H * 0.12] }; },
  clone_row(g, f, P) {
    const b = f.person; if (!b) return null;
    const ax = (b[0] + b[2]) / 2, half = (b[2] - b[0]) / 2, reach = Math.round(P.count) * P.spread * f.W, h = b[3] - b[1];
    return { box: [Math.max(f.W * 0.02, ax - reach - half * 0.5), b[1] + h * 0.04, Math.min(f.W * 0.98, ax + reach + half * 0.5), Math.min(f.H * 0.98, b[3])], at: [ax - P.spread * f.W * 1.05, b[1] + h * 0.14] };
  },
  code_body(g, f) {
    const b = f.person; if (!b) return null; const w = b[2] - b[0], h = b[3] - b[1];
    return { box: b, at: [b[2] - w * 0.12, b[1] + h * 0.74] };
  },
  comment_drop(g, f, P) {
    const w = P.width * f.W, h = f.H * 0.072, x = (f.W - w) / 2; let yc = P.y >= 0 ? P.y * f.H : f.H * 0.16;
    const fb = P.y < 0 && headBox(f);
    if (fb) { const top = fb[1] - (fb[3] - fb[1]) * 0.25, bottom = fb[3] + (fb[3] - fb[1]) * 0.1; yc = top - h * 0.8 > f.H * 0.06 ? top - h * 0.8 : bottom + h * 0.9; }
    return { box: [x, yc - h / 2, x + w, yc + h / 2], at: [x + w - h * 0.75, yc + h * 0.12] };
  },
  impact_frame(g, f, P) {
    const text = String(P.text || 'IMPACT'), px = fitSize(g, text, f.W * 0.9, f.H * 0.14, 900, 'sans');
    g.font = font(900, px, 'sans'); const w = g.measureText(text).width, y = f.H * 0.86;
    return { box: [(f.W - w) / 2, y - px * 0.5, (f.W + w) / 2, y + px * 0.5], at: [(f.W - w) / 2, y - px * 0.5] };
  },
  letter_window(g, f, P) {
    const text = String(P.text) || ' ', px = fitSize(g, text, f.W * 0.9, f.H * 0.42, P.weight, P.font);
    g.font = font(P.weight, px, P.font); const w = g.measureText(text).width, x0 = (f.W - w) / 2, y = f.H / 2;
    return { box: [x0, y - px * 0.4, x0 + w, y + px * 0.4], at: [x0 + w, y + px * 0.4] };
  },
  blow_away(g, f) {
    const b = f.person; if (!b) return null; const w = b[2] - b[0], h = b[3] - b[1];
    return { box: b, at: [b[0] + w * 0.1, b[1] + h * 0.3] };
  },
};

export const EFFECTS = {
  live_graphic: {
    label: 'Live graphic', input: false,
    about: 'Editable vector layers drawn live. Change nodes or palette without encoding. Export uses this same canvas renderer.',
    params: { nodes: list('Declarative timed rect, line, text, invader and slider layers; unique ids, normalized geometry and spoken-word cues') },
    draw(g, f, P) { drawNodes(g, f, P.nodes); },
  },
  // Export only (src/effects.js liveStack): all live graphic layers of a timeline drawn as one overlay, each in its own clip time.
  live_stack: {
    label: 'Live layers', input: false, hidden: true,
    about: 'All live graphic layers drawn together for export. Built by the service, never placed by hand.',
    params: { layers: list('Live graphic layers with their timeline start/end, clip in, opacity and fades') },
    draw(g, f, P) {
      const T = f.t;
      for (const L of P.layers) {
        if (T < L.s - 1e-6 || T >= L.e - 1e-6) continue;
        const lt = T - L.s, d = L.e - L.s; let k = L.o ?? 1;
        if (L.fi && lt < L.fi) k *= Math.max(0, lt / L.fi);
        if (L.fo && lt > d - L.fo) k *= Math.max(0, (d - lt) / L.fo);
        if (k <= 0) continue;
        g.save(); g.globalAlpha *= Math.min(1, k);
        try { drawNodes(g, { ...f, t: L.i + lt }, L.nodes); } finally { g.restore(); }
      }
    },
  },
  clone_row: {
    label: 'Clone row', needs: 'cutout', opaque: true, say: ['clone row', 'clone rows'],
    about: 'Copies of the person step out from behind them to both sides, each a little smaller, darker and softer with distance — lit like the room, with no cut-out halo.',
    params: {
      count: num(2, 1, 4, 'copies on each side', 1),
      spread: num(0.3, 0.08, 0.6, 'distance between copies, as a share of the frame width'),
      shrink: num(0.86, 0.5, 1, 'size of each copy relative to the one in front of it'),
      dim: num(0.8, 0, 1, 'brightness of the nearest copies; each further pair is dimmer'),
      depth: num(1, 0, 4, 'how much further copies soften, like a lens focused on the front person'),
      stagger: num(0.08, 0, 0.5, 'seconds between each pair stepping out'),
    },
    draw(g, f, P) {
      drawBase(g, f);
      const person = personLayer(f), soft = softPerson(f); if (!person || !soft) return;
      const box = f.person || [0, 0, f.W, f.H], ax = (box[0] + box[2]) / 2, ay = box[3];
      const leave = ease.out(prog(f.d - f.t, 0, 0.22)), px = f.H / 1920;
      for (let k = Math.round(P.count); k >= 1; k--) {
        const k0 = (k - 1) * P.stagger, appear = ease.back(prog(f.t, k0, 0.38)), s = Math.pow(P.shrink, k);
        for (const side of [-1, 1]) {
          g.save();
          g.globalAlpha = clamp(prog(f.t, k0, 0.12), 0, 1) * leave;
          // Further copies: dimmer, a touch less saturated and softer, as a lens and room light would make them.
          g.filter = `brightness(${Math.pow(P.dim, k).toFixed(3)}) saturate(${Math.pow(0.93, k).toFixed(3)})${P.depth > 0 ? ` blur(${(k * P.depth * 0.9 * px).toFixed(2)}px)` : ''}`;
          g.translate(ax + side * k * P.spread * f.W * appear * leave, ay); g.scale(s, s); g.translate(-ax, -ay);
          g.drawImage(soft, 0, 0);
          g.restore();
        }
      }
      g.drawImage(person, 0, 0); // the real person stays in front, with the original cutout edge on the original background
    },
  },

  text_behind: {
    label: 'Text behind', needs: 'cutout', opaque: true, say: ['text behind'],
    about: 'A headline stands behind the person, so they appear in front of the words. Letters rise in one by one. Works best when the person does not fill the frame.',
    params: {
      text: txt('FRAME', 'the words (sentence case; capitals only on the one word to stress)'), color: col('#ffffff', 'text colour'), font: FONT,
      weight: num(900, 100, 900, 'font weight', 100), outline: OUTLINE(0.03),
      size: num(0, 0, 0.6, 'letter height as a share of the frame height; 0 = as large as fits the width'),
      y: num(0.3, 0, 1, 'vertical centre of the text, 0 = top, 1 = bottom'),
      stagger: num(0.05, 0, 0.3, 'seconds between letters appearing'),
    },
    draw(g, f, P) {
      drawBase(g, f);
      const text = String(P.text);
      const px = P.size > 0 ? P.size * f.H : fitSize(g, text, f.W * 0.94, f.H * 0.5, P.weight, P.font);
      g.font = font(P.weight, px, P.font); g.textBaseline = 'middle'; g.textAlign = 'left';
      const total = g.measureText(text).width, x0 = (f.W - total) / 2, y = P.y * f.H;
      const leave = ease.out(prog(f.d - f.t, 0, 0.2));
      [...text].forEach((ch, i) => {
        const k = ease.out(prog(f.t, i * P.stagger, 0.42));
        if (k <= 0) return;
        g.globalAlpha = Math.min(1, k * 1.4) * leave;
        outlined(g, ch, x0 + g.measureText(text.slice(0, i)).width, y + (1 - k) * px * 0.55, px, P);
      });
      g.globalAlpha = 1;
      const person = personLayer(f); if (person) g.drawImage(person, 0, 0);
    },
  },

  orbit_text: {
    label: 'Orbit text', needs: 'cutout', opaque: true, say: ['orbit text', 'orbit ring', 'orbit'],
    about: 'A ring of letters circles the head in 3D: it passes behind the head and comes round in front of it, above the eyes.',
    params: {
      text: txt('Edited in FRAME · ', 'the words on the ring (repeated to fill it)'),
      color: col('#ffffff', 'letter colour'), font: FONT, outline: OUTLINE(0.05),
      speed: num(0.3, -2, 2, 'turns per second; negative turns the other way'),
      radius: num(1.05, 0.5, 3, 'ring width as a multiple of the face width'),
      tilt: num(0.24, 0, 0.8, 'how far the ring leans toward the camera (0 = seen edge-on)'),
      lift: num(-0.62, -1.5, 1.5, 'ring height relative to the face centre, in face heights (negative = higher); the default keeps the front of the ring above the eyes'),
      size: num(0.24, 0.05, 1, 'letter height as a share of the face height'),
    },
    draw(g, f, P) {
      drawBase(g, f);
      const head = headBox(f), person = personLayer(f);
      if (!head) return;
      const fw = head[2] - head[0], fh = head[3] - head[1], open = envelope(f, 0.35, 0.22);
      const cx = (head[0] + head[2]) / 2, cy = (head[1] + head[3]) / 2 + P.lift * fh;
      const rx = P.radius * fw * lerp(0.55, 1, open), ry = rx * P.tilt, px = P.size * fh;
      g.font = font(800, px, P.font); g.textAlign = 'center'; g.textBaseline = 'middle';
      const unit = String(P.text) || ' ', circ = 2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2);
      const per = Math.max(1, g.measureText(unit).width), reps = Math.max(1, Math.round(circ / per));
      const chars = [...unit.repeat(reps)], n = chars.length, a0 = 2 * Math.PI * P.speed * f.t;
      // Letters go round with decreasing angle, so the front half reads left to right and the back half is seen from behind.
      const items = chars.map((ch, j) => { const a = a0 - (j / n) * 2 * Math.PI; return { ch, x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), depth: Math.sin(a), face: Math.sin(a) }; });
      const drawChar = (it) => {
        if (it.ch === ' ') return;
        const d = (it.depth + 1) / 2;
        g.save(); g.translate(it.x, it.y);
        g.scale(Math.sign(it.face || 1) * Math.max(0.1, Math.abs(it.face)) * lerp(0.7, 1, d), lerp(0.78, 1, d));
        g.globalAlpha = lerp(0.45, 1, d) * open;
        outlined(g, it.ch, 0, 0, px, P); g.restore();
      };
      items.filter((it) => it.depth < 0).sort((a, b) => a.depth - b.depth).forEach(drawChar); // behind the head
      if (person) g.drawImage(person, 0, 0);
      items.filter((it) => it.depth >= 0).sort((a, b) => a.depth - b.depth).forEach(drawChar); // in front of it
    },
  },

  rack_focus: {
    label: 'Rack focus', needs: 'cutout', opaque: true, say: ['rack focus'],
    about: 'A focus pull: the background melts into blur while the person stays sharp — or the other way round.',
    params: {
      onto: pick('person', ['person', 'background'], 'what ends up sharp'),
      blur: num(0.012, 0.002, 0.04, 'strongest blur, as a share of the frame height'),
      at: num(0, 0, 10, 'seconds into the effect when the pull starts'),
      pull: num(0.5, 0.05, 5, 'seconds the pull takes'),
    },
    draw(g, f, P) {
      const k = ease.inOut(prog(f.t, P.at, P.pull)), B = P.blur * f.H;
      const bg = P.onto === 'person' ? B * k : B * (1 - k), fg = P.onto === 'person' ? 0 : B * k;
      const zoom = 1 + 0.012 * k; // lenses breathe slightly as they focus
      g.save(); g.translate(f.W / 2, f.H / 2); g.scale(zoom, zoom); g.translate(-f.W / 2, -f.H / 2);
      const m = bg * 2; // overdraw the edges so the blur does not pull black in from outside the frame
      g.filter = bg > 0.3 ? `blur(${bg.toFixed(2)}px)` : 'none';
      if (f.base) g.drawImage(f.base, -m, -m, f.W + 2 * m, f.H + 2 * m); else drawBase(g, f);
      g.filter = 'none';
      const person = personLayer(f), ma = matteAlpha(f);
      if (person && fg <= 0.3) g.drawImage(person, 0, 0);
      else if (person && ma) { // a soft person: blur the picture inside a widened, feathered cutout, so no sharp edge is left
        const t = f.make(f.W, f.H), tg = t.getContext('2d');
        tg.filter = `blur(${fg.toFixed(2)}px)`; tg.drawImage(f.base, 0, 0, f.W, f.H);
        tg.globalCompositeOperation = 'destination-in'; tg.filter = `blur(${(fg * 1.5).toFixed(2)}px)`;
        tg.drawImage(ma, 0, 0); tg.drawImage(ma, 0, 0);
        g.drawImage(t, 0, 0);
      }
      g.restore();
    },
  },

  code_body: {
    label: 'Code body', needs: 'cutout', opaque: true, say: ['code body'],
    about: 'The person turns into running code: their body is redrawn as monospace characters in their own colours.',
    params: {
      cell: num(0.016, 0.006, 0.05, 'character height as a share of the frame height'),
      color: pick('source', ['source', 'green', 'white', 'red'], 'character colour: the person\'s own colours, or one colour'),
      dark: num(0.86, 0, 1, 'how dark the body is behind the characters'),
      sweep: num(0.35, 0, 3, 'seconds the code takes to sweep down over the body'),
    },
    draw(g, f, P) {
      drawBase(g, f);
      if (!f.matte || !f.base) return;
      const ch = P.cell * f.H, cw = ch * 0.6, cols = Math.ceil(f.W / cw), rows = Math.ceil(f.H / ch);
      const s = f.make(cols, rows), sg = s.getContext('2d', { willReadFrequently: true });
      sg.drawImage(f.base, 0, 0, cols, rows); const px = sg.getImageData(0, 0, cols, rows).data;
      sg.clearRect(0, 0, cols, rows); sg.drawImage(f.matte, 0, 0, cols, rows); const mk = sg.getImageData(0, 0, cols, rows).data;
      const leave = ease.out(prog(f.d - f.t, 0, 0.2)), front = P.sweep > 0 ? ease.out(prog(f.t, 0, P.sweep)) * 1.15 : 2;
      const ma = matteAlpha(f);
      if (ma) { g.save(); g.globalAlpha = P.dark * leave; g.filter = 'brightness(0)'; g.drawImage(ma, 0, 0); g.restore(); }
      g.font = font(500, ch * 0.92, 'mono'); g.textBaseline = 'top'; g.textAlign = 'left';
      const shift = Math.floor(f.t * 24), fixed = { green: [80, 255, 140], white: [235, 235, 235], red: [255, 70, 55] }[P.color];
      for (let r = 0; r < rows; r++) {
        if (r / rows > front) break;
        for (let c = 0; c < cols; c++) {
          const i = (r * cols + c) * 4; if (matteAt(f, mk, i) < 128) continue;
          const glyph = CODE[(r * 131 + c + shift) % CODE.length]; if (glyph === ' ') continue;
          const lum = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
          let R, G, Bc;
          if (fixed) [R, G, Bc] = fixed.map((v) => v * lerp(0.55, 1, lum));
          else { const mx = Math.max(px[i], px[i + 1], px[i + 2], 1), to = lerp(150, 255, Math.min(1, lum * 1.6)); [R, G, Bc] = [px[i], px[i + 1], px[i + 2]].map((v) => lerp(to, (v / mx) * to, 0.75)); } // the person's own hue, lifted so dark clothes still read
          g.fillStyle = `rgba(${R | 0},${G | 0},${Bc | 0},${(lerp(0.62, 1, lum) * leave).toFixed(3)})`;
          g.fillText(glyph, c * cw, r * ch);
        }
      }
    },
  },

  letter_window: {
    label: 'Letter window', needs: null, opaque: true, say: ['letter window', 'letter dive', 'letter body'],
    about: 'A giant word on a plain near-black background with the video playing inside its letters; at the end the camera dives into one letter and the video takes over the frame.',
    params: {
      text: txt('FRAME', 'the word'), bg: col('#0b0c0e', 'background colour'), font: FONT,
      weight: num(900, 100, 900, 'font weight', 100),
      dive: num(0.55, 0, 5, 'seconds of the dive at the end; 0 = no dive'),
      into: num(-1, -1, 40, 'which letter to dive into (0 = first); -1 = the middle one', 1),
    },
    draw(g, f, P) {
      const text = String(P.text) || ' ', chars = [...text];
      const px = fitSize(g, text, f.W * 0.9, f.H * 0.42, P.weight, P.font);
      g.font = font(P.weight, px, P.font); g.textBaseline = 'middle'; g.textAlign = 'left';
      const total = g.measureText(text).width, x0 = (f.W - total) / 2, y = f.H / 2;
      // Dive target: a point inside the chosen letter's stroke (not its hole), found on a small mask.
      let idx = P.into < 0 ? Math.floor((chars.length - 1) / 2) : Math.min(chars.length - 1, P.into);
      while (idx > 0 && chars[idx] === ' ') idx--;
      const lx0 = x0 + g.measureText(chars.slice(0, idx).join('')).width, lw = g.measureText(chars[idx]).width;
      const q = 8, mw = Math.max(1, Math.ceil(lw / q)), mh = Math.max(1, Math.ceil(px / q));
      const m = f.make(mw, mh), mg = m.getContext('2d', { willReadFrequently: true });
      mg.font = font(P.weight, px / q, P.font); mg.textBaseline = 'middle'; mg.fillStyle = '#fff'; mg.fillText(chars[idx], 0, mh / 2);
      const md = mg.getImageData(0, 0, mw, mh).data; let best = null;
      for (let yy = 0; yy < mh; yy++) for (let xx = 0; xx < mw; xx++) if (md[(yy * mw + xx) * 4 + 3] > 200) { const dd = (xx - mw / 2) ** 2 + (yy - mh / 2) ** 2; if (!best || dd < best[2]) best = [xx, yy, dd]; }
      const tx = best ? lx0 + (best[0] + 0.5) * q : lx0 + lw / 2, ty = best ? y - px / 2 + (best[1] + 0.5) * q : y;
      const kd = P.dive > 0 ? ease.in(prog(f.t, f.d - P.dive, P.dive)) : 0, z = lerp(1, 90, kd);
      const intro = ease.out(prog(f.t, 0, 0.3)), s0 = lerp(1.12, 1, intro);
      g.fillStyle = P.bg; g.fillRect(0, 0, f.W, f.H);
      const L = f.make(f.W, f.H), lg = L.getContext('2d');
      lg.translate(lerp(tx, f.W / 2, Math.min(1, kd * 3)), lerp(ty, f.H / 2, Math.min(1, kd * 3))); lg.scale(z * s0, z * s0); lg.translate(-tx, -ty);
      lg.font = g.font; lg.textBaseline = 'middle'; lg.fillStyle = '#000'; lg.fillText(text, x0, y);
      lg.setTransform(1, 0, 0, 1, 0, 0); lg.globalCompositeOperation = 'source-in';
      if (f.base) lg.drawImage(f.base, 0, 0, f.W, f.H); else { lg.fillStyle = '#111'; lg.fillRect(0, 0, f.W, f.H); }
      g.globalAlpha = intro; g.drawImage(L, 0, 0); g.globalAlpha = 1;
    },
  },

  track_box: {
    label: 'Tracking box', needs: 'cutout', matte: false, say: ['tracking box', 'track box', 'live cursor'],
    about: 'A thin selection box locks onto the face (or the whole person) and follows it, with its measured size and a small labelled cursor holding the corner. Everything sits outside the face: nothing crosses the eyes or mouth.',
    params: {
      target: pick('face', ['face', 'person'], 'what the box follows'), label: txt('Claude', 'name on the cursor (empty for none)'),
      pad: num(0.22, 0.12, 1, 'space around the target, as a share of its size (at least 0.12, so the box never touches the face)'),
      readout: pick('size', ['size', 'none'], 'show the box size in pixels'), color: col('#ffffff', 'line colour'),
      cursor: pick('on', ['on', 'off'], 'draw its own cursor on the corner; turn off when an agent_swarm agent holds it'),
    },
    draw(g, f, P) {
      let b = P.target === 'face' ? headBox(f) : f.person || headBox(f); if (!b) return;
      const w0 = b[2] - b[0], h0 = b[3] - b[1], pad = P.pad * Math.max(w0, h0);
      b = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
      const k = ease.out(prog(f.t, 0, 0.32)), leave = ease.out(prog(f.d - f.t, 0, 0.18));
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      const [x0, y0, x1, y1] = [lerp(cx, b[0], k), lerp(cy, b[1], k), lerp(cx, b[2], k), lerp(cy, b[3], k)];
      const lw = Math.max(1, f.H * 0.0011), hs = f.H * 0.0055;
      g.globalAlpha = leave * Math.min(1, k * 1.5);
      g.strokeStyle = P.color; g.lineWidth = lw; g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = lw * 2;
      g.strokeRect(x0, y0, x1 - x0, y1 - y0); g.shadowBlur = 0;
      g.fillStyle = P.color; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = Math.max(0.75, lw * 0.6);
      for (const [hx, hy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) { g.fillRect(hx - hs / 2, hy - hs / 2, hs, hs); g.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs); }
      const fs = f.H * 0.0125;
      if (P.readout === 'size' && k > 0.6) { // the box's real size in project pixels, above the box
        const s = `${Math.round((x1 - x0) * f.unit)} × ${Math.round((y1 - y0) * f.unit)}`;
        g.font = font(500, fs, 'mono'); const tw = g.measureText(s).width;
        const bx = x0, by = y0 - fs * 1.9;
        g.fillStyle = 'rgba(0,0,0,0.55)'; g.beginPath(); g.roundRect(bx, by, tw + fs, fs * 1.5, fs * 0.25); g.fill();
        g.fillStyle = P.color; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(s, bx + fs * 0.5, by + fs * 0.75);
      }
      if (P.cursor === 'off') return;
      // The cursor glides in and holds the bottom-right corner, pointing in from outside the box.
      const ck = ease.out(prog(f.t, 0.05, 0.45)), ax = lerp(x1 + f.W * 0.3, x1, ck), ay = lerp(y1 + f.H * 0.12, y1, ck), cs = f.H * 0.02;
      g.save(); g.translate(ax, ay); g.scale(cs / 16, cs / 16);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, 13); g.lineTo(3.6, 9.8); g.lineTo(6, 16); g.lineTo(8.2, 15.1); g.lineTo(5.8, 9.1); g.lineTo(11, 9.1); g.closePath();
      g.fillStyle = '#fff'; g.fill(); g.lineWidth = 1; g.strokeStyle = '#000'; g.stroke(); g.restore();
      if (P.label) {
        g.font = font(600, fs, 'sans'); const tw = g.measureText(P.label).width, lx = ax + cs * 0.75, ly = ay + cs * 0.8;
        g.fillStyle = '#fff'; g.beginPath(); g.roundRect(lx, ly, tw + fs * 1.1, fs * 1.7, fs * 0.35); g.fill();
        g.fillStyle = '#000'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(P.label, lx + fs * 0.55, ly + fs * 0.85);
      }
    },
  },

  impact_frame: {
    label: 'Impact frame', needs: null, uses: 'cutout', opaque: true, say: ['impact frame', 'impact'],
    about: 'A comic-book hit: a white flash, the picture turned to black ink on white paper with speed lines, a shake, and one big word. With a cutout, only the person is inked and the background becomes paper.',
    params: {
      text: txt('IMPACT', 'the big word (empty for none)'),
      ink: num(0.42, 0.1, 0.9, 'where light turns to ink: higher = more black'),
      lines: num(80, 0, 240, 'number of speed lines', 1),
      flash: num(0.07, 0, 0.5, 'seconds of white flash at the start'),
    },
    draw(g, f, P) {
      const r = rng(hashStr(P.text) ^ 0x9e3779b9);
      const shake = (1 - prog(f.t, 0, 0.28)) * f.H * 0.012, j = rng(Math.floor(f.t * 60) + 7);
      g.save(); g.translate((j() - 0.5) * 2 * shake, (j() - 0.5) * 2 * shake);
      g.fillStyle = '#fff'; g.fillRect(-f.W, -f.H, f.W * 3, f.H * 3);
      const person = personLayer(f), box = f.person || [f.W * 0.25, f.H * 0.2, f.W * 0.75, f.H];
      const ocx = (box[0] + box[2]) / 2, ocy = box[1] + (box[3] - box[1]) * 0.3, R = Math.hypot(f.W, f.H);
      g.fillStyle = '#000';
      for (let i = 0; i < P.lines; i++) { // speed lines rushing out from behind the subject
        const a = r() * Math.PI * 2, w = (0.002 + r() * 0.012) * Math.PI, r0 = (0.28 + r() * 0.25) * Math.min(f.W, f.H);
        g.beginPath(); g.moveTo(ocx + Math.cos(a) * r0, ocy + Math.sin(a) * r0);
        g.lineTo(ocx + Math.cos(a - w) * R, ocy + Math.sin(a - w) * R); g.lineTo(ocx + Math.cos(a + w) * R, ocy + Math.sin(a + w) * R); g.fill();
      }
      const inkF = `grayscale(1) brightness(${(0.5 / P.ink).toFixed(3)}) contrast(9)`;
      const src = person || f.base;
      if (src) {
        const t = f.make(f.W, f.H), tg = t.getContext('2d'); tg.filter = inkF; tg.drawImage(src, 0, 0, f.W, f.H);
        if (!person) { g.globalCompositeOperation = 'multiply'; }
        g.drawImage(t, 0, 0); g.globalCompositeOperation = 'source-over';
      }
      if (P.text) {
        const k = ease.out(prog(f.t, 0.04, 0.16)), s = lerp(1.5, 1, k);
        const px = fitSize(g, P.text, f.W * 0.9, f.H * 0.14, 900, 'sans');
        g.save(); g.translate(f.W / 2, f.H * 0.86); g.scale(s, s); g.rotate(-0.035);
        g.font = font(900, px, 'sans'); g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
        g.globalAlpha = k; g.lineWidth = px * 0.16; g.strokeStyle = '#000'; g.strokeText(P.text, 0, 0); g.fillStyle = '#fff'; g.fillText(P.text, 0, 0);
        g.restore();
      }
      g.restore();
      const fl = P.flash > 0 ? 1 - prog(f.t, 0, P.flash) : 0;
      if (fl > 0) { g.fillStyle = `rgba(255,255,255,${fl.toFixed(3)})`; g.fillRect(0, 0, f.W, f.H); }
    },
  },

  comment_drop: {
    label: 'Comment drop', needs: null, uses: 'cutout', matte: false, say: ['comment drop'],
    about: 'A comment box drops in and types out a word, as if someone is commenting on the video. It sits clear of the face.',
    params: {
      text: txt('FRAME', 'what gets typed'), name: txt('you', 'name next to the avatar'),
      y: num(-1, -1, 1, 'vertical centre of the box; -1 = automatic, clear of the face (needs the cutout\'s face box; otherwise 0.16)'), width: num(0.8, 0.3, 1, 'box width as a share of the frame width'),
      typing: num(0.09, 0.02, 0.5, 'seconds per typed character'),
    },
    draw(g, f, P) {
      const k = ease.back(prog(f.t, 0, 0.42)), leave = ease.out(prog(f.d - f.t, 0, 0.2));
      const w = P.width * f.W, h = f.H * 0.072, x = (f.W - w) / 2;
      let yc = P.y >= 0 ? P.y * f.H : f.H * 0.16;
      const fb = P.y < 0 && headBox(f);
      if (fb) { const top = fb[1] - (fb[3] - fb[1]) * 0.25, bottom = fb[3] + (fb[3] - fb[1]) * 0.1; yc = top - h * 0.8 > f.H * 0.06 ? top - h * 0.8 : bottom + h * 0.9; } // above the head if it fits, else under the chin
      const y = lerp(-h * 1.5, yc - h / 2, k) - (1 - leave) * h;
      const fs = h * 0.3, typed = [...String(P.text)].slice(0, Math.floor(Math.max(0, f.t - 0.45) / P.typing)).join('');
      g.globalAlpha = Math.min(1, prog(f.t, 0, 0.15)) * leave;
      g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = h * 0.35; g.shadowOffsetY = h * 0.08;
      g.fillStyle = '#fff'; g.beginPath(); g.roundRect(x, y, w, h, h * 0.24); g.fill();
      g.shadowColor = 'transparent';
      const av = h * 0.56, ax = x + h * 0.28 + av / 2, ay = y + h / 2;
      g.fillStyle = '#d9d9d9'; g.beginPath(); g.arc(ax, ay, av / 2, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#555'; g.font = font(700, av * 0.45, 'sans'); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(P.name || '?').slice(0, 1).toUpperCase(), ax, ay + av * 0.02);
      g.textAlign = 'left'; const tx = ax + av / 2 + h * 0.22;
      g.fillStyle = '#8e8e8e'; g.font = font(500, fs * 0.8, 'sans'); g.fillText(String(P.name), tx, y + h * 0.3);
      g.font = font(typed ? 600 : 400, fs, 'sans'); g.fillStyle = typed ? '#111' : '#9a9a9a';
      g.fillText(typed || 'Add a comment…', tx, y + h * 0.64);
      if (Math.floor(f.t * 2.2) % 2 === 0 || typed.length < [...String(P.text)].length) { const cw = g.measureText(typed).width; if (typed) g.fillRect(tx + cw + fs * 0.12, y + h * 0.64 - fs * 0.55, Math.max(1, fs * 0.07), fs * 1.1); }
      const bw = h * 0.95, bx = x + w - bw - h * 0.22, by = y + h * 0.25;
      g.fillStyle = typed ? '#111' : '#eeeeee'; g.beginPath(); g.roundRect(bx, by, bw, h * 0.5, h * 0.25); g.fill();
      g.fillStyle = typed ? '#fff' : '#a0a0a0'; g.font = font(700, fs * 0.8, 'sans'); g.textAlign = 'center'; g.fillText('Post', bx + bw / 2, by + h * 0.25);
    },
  },
};

EFFECTS.blow_away = {
  label: 'Blow away', needs: 'cutout', opaque: true, say: ['blow away', 'blown away'],
  about: 'The person breaks apart into particles that drift away, leaving the empty set behind. Needs plate: a shot of the empty set from the same locked camera angle (film about 3 s with nobody in frame) — Frame never invents what is behind the person. Particle colours come from the person\'s own pixels; their paths are seeded, so every render is identical.',
  params: {
    plate: { kind: 'asset', default: '', about: 'asset id of the empty-set shot (image or video) from the same locked angle — required' },
    direction: pick('right', ['right', 'left', 'up'], 'which way the particles drift'),
    at: num(0.15, 0, 10, 'seconds into the effect when the break-up starts'),
    dissolve: num(1.4, 0.2, 6, 'seconds the break-up takes to cross the body'),
    grain: num(0.006, 0.002, 0.02, 'particle size as a share of the frame height'),
  },
  draw(g, f, P) {
    if (!f.plate) throw new Error('blow_away needs a plate: a shot of the empty set from the same locked angle. Frame never invents the background behind the person.');
    g.drawImage(f.plate, 0, 0, f.W, f.H);
    const person = softPerson(f); if (!person || !f.person) return;
    const [bx0, by0, bx1, by1] = f.person, bw = Math.max(1, bx1 - bx0), bh = Math.max(1, by1 - by0);
    const cs = Math.max(2, P.grain * f.H), cols = Math.ceil(f.W / cs), rows = Math.ceil(f.H / cs);
    const sm = f.make(cols, rows), sg = sm.getContext('2d', { willReadFrequently: true });
    sg.drawImage(f.base, 0, 0, cols, rows); const px = sg.getImageData(0, 0, cols, rows).data;
    sg.clearRect(0, 0, cols, rows); sg.drawImage(f.matte, 0, 0, cols, rows); const mk = sg.getImageData(0, 0, cols, rows).data;
    const k = (f.t - P.at) / P.dissolve, dir = { right: [1, -0.22], left: [-1, -0.22], up: [0.12, -1] }[P.direction];
    const seed = hashStr(P.direction) % 9973, keep = sm; // reuse the small canvas as the "still standing" mask
    const mask = sg.createImageData(cols, rows), md = mask.data, parts = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 4, m = matteAt(f, mk, i); if (m < 40) continue;
      const x = (c + 0.5) * cs, y = (r + 0.5) * cs;
      // Where the break-up front reaches this cell: from the side the particles fly toward, across the body, ragged.
      const u = P.direction === 'up' ? (y - by0) / bh : P.direction === 'right' ? (bx1 - x) / bw : (x - bx0) / bw;
      const v = clamp(u, 0, 1) * 0.72 + noise2(c / 7, r / 7, seed) * 0.2 + noise2(c, r, seed + 1) * 0.08;
      const left = (k - v) * P.dissolve; // seconds since this cell broke off (negative = still standing)
      md[i + 3] = clamp(-left / 0.06, 0, 1) * 255; // soft front, not a hard cut
      if (left > 0 && m > 127) parts.push([x, y, left, px[i], px[i + 1], px[i + 2], c, r]);
    }
    sg.putImageData(mask, 0, 0);
    // What still stands: the soft-edged person, masked by the front (scaled up smoothly).
    const st = f.make(f.W, f.H), stg = st.getContext('2d');
    stg.drawImage(person, 0, 0); stg.globalCompositeOperation = 'destination-in'; stg.imageSmoothingEnabled = true; stg.drawImage(keep, 0, 0, f.W, f.H);
    g.drawImage(st, 0, 0);
    // Particles: seeded drift and lift, a little swirl, shrinking and fading as they go.
    const speed = f.H * 0.42;
    for (const [x, y, age, R, G, B, c, r] of parts) {
      const a = 1 - age / 1.5; if (a <= 0) continue;
      const h1 = noise2(c * 1.7, r * 1.3, seed + 2), h2 = noise2(c * 0.9, r * 2.1, seed + 3);
      const s = speed * (0.45 + h1 * 0.9), lift = f.H * 0.05 * (0.4 + h2) * age * age;
      const px2 = x + dir[0] * s * age + Math.sin(age * 4 + h2 * 6.3) * cs * 1.5;
      const py2 = y + dir[1] * s * age - lift + Math.cos(age * 3 + h1 * 6.3) * cs;
      const sz = cs * lerp(1, 0.35, Math.min(1, age / 1.2));
      g.fillStyle = `rgba(${R},${G},${B},${(a * a).toFixed(3)})`;
      g.fillRect(px2 - sz / 2, py2 - sz / 2, sz, sz);
    }
  },

};

EFFECTS.agent_swarm = {
  label: 'Agent swarm', needs: 'cutout',
  about: 'The agents that made the edit, replaying what Frame logged them doing. An agent is on screen only while its own job is happening: its cursor and coloured tag (with the clock time its edit ran) fly in from the nearest edge as its effect begins, and its log types out step by step, from the edit history: the cue word the transcript heard, the clip it placed and its length, the Apple Vision cutout or face box the effect reads (the real cutout edge of this frame is traced as that line appears), and the frame count. A blueprint box shows where the effect draws. It leaves when the effect ends. add_agent_swarm builds the jobs from the edit history; nothing in the log is made up.',
  params: {
    jobs: list('who did what: [{agent, effect, start, end, params}], seconds from the start of this clip; add_agent_swarm fills it from the edit history'),
    boxes: pick('on', ['on', 'off'], 'blueprint box around each effect as its agent lands'),
    size: num(1, 0.5, 2.5, 'size of the cursors and tags'),
    lead: num(0.6, 0.2, 2, 'seconds an agent takes to fly in to its effect (it leaves just as fast)'),
  },
  draw(g, f, P) {
    const jobs = Array.isArray(P.jobs) ? P.jobs.filter((j) => j && WHERE[j.effect]) : []; if (!jobs.length) return;
    const W = f.W, H = f.H, t = f.t, names = [...new Set(jobs.map((j) => String(j.agent || 'Claude')))];
    const cs = H * 0.02 * P.size, fs = H * 0.011 * P.size, ph = fs * 2, ic = ph * 0.64;
    const head = headBox(f), ctr = head ? [(head[0] + head[2]) / 2, (head[1] + head[3]) / 2] : [W / 2, H * 0.4];
    // Keep a tag (it hangs below-right of its point) off the eyes and mouth: push the point sideways out of the face.
    const keepOff = ([x, y]) => {
      x = clamp(x, W * 0.03, W * 0.97); y = clamp(y, H * 0.05, H * 0.95);
      if (head) {
        const tw = fs * 9, fx0 = head[0] - tw, fx1 = head[2] + cs, fy0 = head[1] - ph * 1.6, fy1 = head[3] + cs;
        if (x > fx0 && x < fx1 && y > fy0 && y < fy1) x = x - fx0 < fx1 - x ? fx0 : fx1;
      }
      return [x, y];
    };
    const spots = new Map();
    const spot = (j) => {
      if (!spots.has(j)) { g.save(); const r = WHERE[j.effect](g, f, { ...effectParams(j.effect), ...(j.params || {}) }); g.restore(); spots.set(j, r ? { box: r.box, at: keepOff(r.at) } : null); }
      return spots.get(j);
    };
    // Just off screen at the frame edge nearest a point: where an agent comes in from and goes back to.
    const edge = ([x, y]) => {
      const d = [x, W - x, y, H - y], m = Math.min(...d), off = cs * 2 + fs * 10;
      return m === d[0] ? [-off, y] : m === d[1] ? [W + off, y] : m === d[2] ? [x, -off] : [x, H + off];
    };
    // A curved flight that bows away from the face, so a cursor never cuts across it.
    const arc = (a, b, k) => {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      let nx = -dy / L, ny = dx / L; if ((mx - ctr[0]) * nx + (my - ctr[1]) * ny < 0) { nx = -nx; ny = -ny; }
      const cx = mx + nx * L * 0.22, cy = my + ny * L * 0.22, u = 1 - k;
      return [u * u * a[0] + 2 * u * k * cx + k * k * b[0], u * u * a[1] + 2 * u * k * cy + k * k * b[1]];
    };
    // Only agents with a job right now: flying in to it, working on it, or leaving it. Nothing idles on screen.
    const live = [];
    for (const j of jobs) {
      const tin = j.start - P.lead, tout = j.end + P.lead * 0.8;
      if (t < tin || t > tout) continue;
      const sp = spot(j); if (!sp) continue;
      const i = names.indexOf(String(j.agent || 'Claude')), e = edge(sp.at);
      const work = [sp.at[0] + Math.sin(t * 5.3 + i) * H * 0.0025, sp.at[1] + Math.cos(t * 4.1 + i) * H * 0.0025];
      const p = t <= j.end ? arc(e, work, ease.out(prog(t, tin, P.lead))) : arc(work, e, ease.in(prog(t, j.end, P.lead * 0.8)));
      live.push({ name: names[i], i, p, j });
    }
    const PAL = ['#4ade80', '#7dd3fc', '#f9a8d4', '#fde047', '#c4b5fd', '#fdba74', '#93c5fd', '#fca5a5', '#bef264', '#5eead4', '#f0abfc', '#fcd34d'];
    // When each logged step shows, from the start of the effect: the cue word as it is spoken, then the placement, then
    // what the effect reads from the cutout, then the frames. Steps without a log line are skipped, not invented.
    const AT = { heard: 0, placed: 0.3, matte: 0.55, face: 0.55, frames: 0.8, edit: 1.05 };
    // The real cutout edge of this frame (what Apple Vision found), traced top to bottom in the agent's colour.
    const traceMatte = (k, color) => {
      if (!f.matte || k <= 0) return;
      const cell = Math.max(3, Math.round(H / 170)), cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
      const m = f.make(cols, rows), mg = m.getContext('2d', { willReadFrequently: true }); mg.drawImage(f.matte, 0, 0, cols, rows);
      const d = mg.getImageData(0, 0, cols, rows).data, on = (c, r) => matteAt(f, d, (r * cols + c) * 4) >= 128;
      g.fillStyle = color; const upto = Math.min(rows - 1, k * rows);
      for (let r = 1; r < upto; r++) for (let c = 1; c < cols - 1; c++) {
        if (on(c, r) && (!on(c - 1, r) || !on(c + 1, r) || !on(c, r - 1) || !on(c, r + 1))) g.fillRect(c * cell, r * cell, cell * 0.7, cell * 0.7);
      }
    };
    const faceBrackets = (alpha, color) => {
      const b = head; if (!b || alpha <= 0) return;
      const L = Math.min(b[2] - b[0], b[3] - b[1]) * 0.18; g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = Math.max(1.5, H * 0.0016);
      for (const [x, y, sx, sy] of [[b[0], b[1], 1, 1], [b[2], b[1], -1, 1], [b[0], b[3], 1, -1], [b[2], b[3], -1, -1]]) { g.beginPath(); g.moveTo(x, y + sy * L); g.lineTo(x, y); g.lineTo(x + sx * L, y); g.stroke(); }
      g.globalAlpha = 1;
    };
    // Data first (under the tags): the cutout edge or face box the effect reads, while that log line is showing.
    for (const { i, j } of live) {
      const color = PAL[i % PAL.length], step = (j.log || []).find((x) => x.k === 'matte' || x.k === 'face'); if (!step) continue;
      const t0 = j.start + AT[step.k], vis = Math.min(1, prog(t, t0, 0.1)) * (1 - prog(t, t0 + 0.55, 0.25));
      if (vis <= 0) continue;
      if (step.k === 'matte') { g.globalAlpha = vis * 0.9; traceMatte(prog(t, t0, 0.3), color); g.globalAlpha = 1; }
      else if (j.effect !== 'track_box') faceBrackets(vis, color); // the tracking box already is the face box
    }
    const fm = H * 0.0108 * P.size, lh = fm * 1.45, pad = fm * 0.6;
    const faceR = head ? [head[0] - (head[2] - head[0]) * 0.06, head[1] - (head[3] - head[1]) * 0.06, head[2] + (head[2] - head[0]) * 0.06, head[3] + (head[3] - head[1]) * 0.06] : null;
    const overlap = (x, y, w, h) => (!faceR ? 0 : Math.max(0, Math.min(x + w, faceR[2]) - Math.max(x, faceR[0])) * Math.max(0, Math.min(y + h, faceR[3]) - Math.max(y, faceR[1])));
    const outside = (x, y, w, h) => w * h - Math.max(0, Math.min(x + w, W) - Math.max(x, 0)) * Math.max(0, Math.min(y + h, H) - Math.max(y, 0));
    for (const { name, i, p, j } of live) {
      const [x, y] = p, color = PAL[i % PAL.length];
      g.save(); g.translate(x, y); g.scale(cs / 16, cs / 16);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, 13); g.lineTo(3.6, 9.8); g.lineTo(6, 16); g.lineTo(8.2, 15.1); g.lineTo(5.8, 9.1); g.lineTo(11, 9.1); g.closePath();
      g.fillStyle = '#f4f4f5'; g.fill(); g.lineWidth = 1.1; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.stroke(); g.restore();
      // Tag: robot, name, and the clock time this agent's edit ran (from the log).
      g.font = font(650, fs, 'sans'); const nw = g.measureText(name).width;
      g.font = font(500, fs * 0.82, 'mono'); const clk = String(j.clock || ''), cw = clk ? g.measureText(clk).width + fs * 0.5 : 0;
      const pw = fs * 0.55 + ic + fs * 0.45 + nw + cw + fs * 0.7;
      // The log panel under the tag: every line it will show, so the block does not jump as lines appear.
      const lines = (j.log || []).map((x) => ({ ...x, at: j.start + (AT[x.k] ?? 0) }));
      g.font = font(500, fm, 'mono'); const lw = lines.reduce((m, x) => Math.max(m, g.measureText(`› ${x.s}`).width), 0);
      const panW = lines.length ? lw + pad * 2 : 0, panH = lines.length ? lines.length * lh + pad * 1.4 : 0, gap = fs * 0.4;
      const bw = Math.max(pw, panW), bh = ph + (panH ? gap + panH : 0);
      // Place the tag and log beside the cursor wherever they cover the face least (and stay on screen).
      const cands = [[x + cs * 0.55, y + cs * 0.9], [x - bw - cs * 0.15, y + cs * 0.9], [x + cs * 0.55, y - bh - cs * 0.2], [x - bw - cs * 0.15, y - bh - cs * 0.2]];
      // Also keep off the agent's own work when it is a word or a small graphic (the box is most of the frame otherwise).
      const own = spot(j)?.box, ownSmall = own && (own[2] - own[0]) * (own[3] - own[1]) < W * H * 0.3;
      const onOwn = (x0, y0, w, h) => (!ownSmall ? 0 : Math.max(0, Math.min(x0 + w, own[2]) - Math.max(x0, own[0])) * Math.max(0, Math.min(y0 + h, own[3]) - Math.max(y0, own[1])));
      let best = cands[0], bestS = Infinity;
      for (const [cx, cy] of cands) { const sc = overlap(cx, cy, bw, bh) * 4 + onOwn(cx, cy, bw, bh) * 1.5 + outside(cx, cy, bw, bh); if (sc < bestS - 1) { best = [cx, cy]; bestS = sc; } }
      const lx = clamp(best[0], W * 0.01, W * 0.99 - bw), ly = clamp(best[1], H * 0.01, H * 0.99 - bh);
      g.shadowColor = color; g.shadowBlur = fs * 1.4;
      g.fillStyle = color; g.beginPath(); g.roundRect(lx, ly, pw, ph, ph * 0.28); g.fill(); g.shadowBlur = 0;
      const ix = lx + fs * 0.55, iy = ly + (ph - ic) / 2;
      g.fillStyle = 'rgba(15,23,42,0.78)'; g.beginPath(); g.roundRect(ix, iy, ic, ic, ic * 0.3); g.fill();
      g.fillStyle = color; for (const ex of [0.33, 0.67]) { g.beginPath(); g.arc(ix + ic * ex, iy + ic * 0.52, ic * 0.12, 0, 2 * Math.PI); g.fill(); }
      g.textBaseline = 'middle'; g.textAlign = 'left';
      g.fillStyle = 'rgba(15,23,42,0.92)'; g.font = font(650, fs, 'sans'); g.fillText(name, ix + ic + fs * 0.45, ly + ph / 2 + fs * 0.04);
      if (clk) { g.fillStyle = 'rgba(15,23,42,0.6)'; g.font = font(500, fs * 0.82, 'mono'); g.fillText(clk, ix + ic + fs * 0.45 + nw + fs * 0.5, ly + ph / 2 + fs * 0.04); }
      // Log lines type out at the moment of each step.
      const shown = lines.filter((x) => t >= x.at);
      if (shown.length) {
        const px0 = lx, py0 = ly + ph + gap;
        g.fillStyle = 'rgba(8,12,20,0.74)'; g.beginPath(); g.roundRect(px0, py0, panW, shown.length * lh + pad * 1.4, fm * 0.45); g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1; g.stroke();
        g.font = font(500, fm, 'mono');
        shown.forEach((x, n) => {
          const full = x.s, typed = full.slice(0, Math.ceil(full.length * prog(t, x.at, 0.22))), yy = py0 + pad * 0.7 + lh * n + lh / 2;
          g.fillStyle = color; g.fillText('›', px0 + pad, yy);
          g.fillStyle = '#e5e7eb'; const tx = px0 + pad + g.measureText('› ').width; g.fillText(typed, tx, yy);
          if (typed.length < full.length || (n === shown.length - 1 && Math.floor(t * 3) % 2 === 0)) g.fillRect(tx + g.measureText(typed).width + fm * 0.1, yy - fm * 0.5, fm * 0.5, fm);
        });
      }
    }
  },
};

// The characters code_body writes with: this file's own drawing code, so the "code" on screen is real.
const CODE = (EFFECTS.code_body.draw.toString() + EFFECTS.orbit_text.draw.toString()).replace(/\s+/g, ' ');

/** Defaults for an effect, merged with what is set. Throws a plain explanation for anything unknown or out of range. */
export function effectParams(type, given = {}, current = null) {
  if (type === 'live_graphic' && given.nodes !== undefined) validateNodes(given.nodes);
  const fx = EFFECTS[type];
  if (!fx) throw new Error(`No effect "${type}". Effects: ${Object.keys(EFFECTS).join(', ')}.`);
  const out = current ? { ...current } : Object.fromEntries(Object.entries(fx.params).map(([k, s]) => [k, s.default]));
  const bad = Object.keys(given || {}).filter((k) => !fx.params[k]);
  if (bad.length) throw new Error(`${type} has no setting ${bad.map((k) => `"${k}"`).join(', ')}. Its settings: ${Object.keys(fx.params).join(', ')}. Nothing was changed.`);
  for (const [k, v] of Object.entries(given || {})) {
    const s = fx.params[k];
    if (s.kind === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < s.min || n > s.max) throw new Error(`${type}.${k} must be a number from ${s.min} to ${s.max} (got ${JSON.stringify(v)}). Nothing was changed.`);
      out[k] = s.step === 1 ? Math.round(n) : n;
    } else if (s.kind === 'choice') {
      if (!s.options.includes(v)) throw new Error(`${type}.${k} must be one of ${s.options.join(', ')} (got ${JSON.stringify(v)}). Nothing was changed.`);
      out[k] = v;
    } else if (s.kind === 'color') {
      if (!/^#[0-9a-f]{6}$/i.test(String(v))) throw new Error(`${type}.${k} must be a colour like #ffffff (got ${JSON.stringify(v)}). Nothing was changed.`);
      out[k] = String(v).toLowerCase();
    } else if (s.kind === 'list') {
      if (!Array.isArray(v) || v.length > 400 || v.some((x) => !x || typeof x !== 'object') || JSON.stringify(v).length > 400000) throw new Error(`${type}.${k} must be a list of at most 400 objects and 400 KB. Nothing was changed.`);
      out[k] = JSON.parse(JSON.stringify(v));
    } else if (s.kind === 'asset') {
      if (!/^[\w:.-]*$/.test(String(v ?? ''))) throw new Error(`${type}.${k} must be an asset id like "a2" (got ${JSON.stringify(v)}). Nothing was changed.`);
      out[k] = String(v ?? '');
    } else out[k] = String(v ?? '').slice(0, 200);
  }
  if (type === 'live_graphic') validateNodes(out.nodes);
  return out;
}

/** Draw one frame of an effect clip. f is described at the top of this file. */
export function drawEffect(g, c, f) {
  const fx = EFFECTS[c.effect?.type];
  if (!fx) throw new Error(`No effect "${c.effect?.type}"`);
  const P = { ...effectParams(c.effect.type), ...c.effect.params };
  g.save();
  try { fx.draw(g, f, P); } finally { g.restore(); }
}

/** Text Claude and the window use to describe the catalogue. */
export function describeEffects() {
  return Object.entries(EFFECTS).filter(([, fx]) => !fx.hidden).map(([id, fx]) => `• ${id} — ${fx.label}${fx.say ? ` (cue words: ${fx.say.map((w) => `"${w}"`).join(', ')})` : ''}${fx.needs === 'cutout' ? ` [needs a cutout of the footage under it: frame_cutout${fx.params.plate ? '; and a plate' : ''}]` : fx.uses === 'cutout' ? ' [uses a cutout when the footage has one]' : ''}. ${fx.about}\n    settings: ${Object.entries(fx.params).map(([k, s]) => `${k} (${s.kind === 'number' ? `${s.min}–${s.max}, default ${s.default}` : s.kind === 'choice' ? `${s.options.join('|')}, default ${s.default}` : s.kind === 'asset' ? 'asset id' : `${s.kind}, default "${s.default}"`}): ${s.about}`).join('; ')}`).join('\n');
}
