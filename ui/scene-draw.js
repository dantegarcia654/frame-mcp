// The one place scene pixels come from.
// A "scene" clip is a motion-designed explainer beat (title, steps, stat, chat, …) described by a few params.
// The Frame window draws it live in the preview; the service runs this same file in headless Chrome to turn scene
// clips into video for frame_view and the export (src/scenes.js). Every frame is a pure function of time, so any frame
// can be drawn on its own and the preview matches the render. Importing this file in Node is safe: nothing touches a
// canvas until a draw call.

export const SCENE_ENGINE = 1;
const TAU = Math.PI * 2;
const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n));
const P = (t, a, d) => clamp((t - a) / Math.max(1e-6, d));
const E = {
  out: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  out3: (x) => 1 - Math.pow(1 - x, 3),
  in3: (x) => x * x * x,
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
};
/** Damped spring from 0 to 1, t seconds after it starts. */
const spring = (t, w = 14, z = 0.55) => {
  if (t <= 0) return 0;
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
};
const hexA = (hex, a) => { const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a)})`; };

// ───────────────────────── look
export const THEMES = {
  ink: { bg: '#0A0A0F', card: '#15151D', card2: '#1D1D27', fg: '#F5F2EA', muted: '#8E8B9C', accent: '#FF5B1F', accent2: '#7A5CFF', good: '#34D27D', bad: '#FF4D5E', on: '#0A0A0F', glow: 0.2, grain: 0.06, dark: true },
  paper: { bg: '#F2EDE3', card: '#FFFFFF', card2: '#F8F4EC', fg: '#131313', muted: '#7B756C', accent: '#FF4F00', accent2: '#2F5BFF', good: '#12A058', bad: '#E5383B', on: '#FFFFFF', glow: 0.13, grain: 0.05, dark: false },
  electric: { bg: '#060A1E', card: '#0D1536', card2: '#131E4A', fg: '#EEF1FF', muted: '#8890C4', accent: '#36F1C6', accent2: '#FF4FD8', good: '#36F1C6', bad: '#FF5C7A', on: '#04121A', glow: 0.24, grain: 0.06, dark: true },
  mono: { bg: '#0D0D0D', card: '#181818', card2: '#222222', fg: '#F2F2F2', muted: '#8A8A8A', accent: '#F2F2F2', accent2: '#555555', good: '#F2F2F2', bad: '#9A9A9A', on: '#0D0D0D', glow: 0.07, grain: 0.07, dark: true },
};
function theme(s) {
  const th = { ...(THEMES[s.theme] || THEMES.ink), ...(s.colors || {}) };
  if (s.accent) th.accent = s.accent;
  th.line = hexA(th.fg, 0.11); th.dot = hexA(th.fg, th.dark ? 0.075 : 0.1);
  th.shadow = th.dark ? 'rgba(0,0,0,0.5)' : 'rgba(60,40,10,0.13)';
  return th;
}

const FAM = { sans: 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif', mono: '"JetBrains Mono", ui-monospace, Menlo, monospace' };
const FIT = new Map();
/** Load the scene fonts (Inter variable, JetBrains Mono). base = URL prefix of the ui folder ('' in the window). */
export async function loadSceneFonts(base = '') {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return;
  const faces = [
    new FontFace('Inter', `url(${base}/fonts/Inter-Variable.ttf)`, { weight: '100 900' }),
    new FontFace('JetBrains Mono', `url(${base}/fonts/jetbrains-mono-latin-500-normal.woff2)`, { weight: '500' }),
    new FontFace('JetBrains Mono', `url(${base}/fonts/jetbrains-mono-latin-700-normal.woff2)`, { weight: '700' }),
  ];
  await Promise.all(faces.map((f) => f.load().then((ff) => document.fonts.add(ff)).catch(() => {})));
  FIT.clear(); // layouts measured with a fallback font are wrong now
}

function setFont(g, px, w = 800, fam = 'sans', track = -0.025) {
  g.font = `${w} ${Math.max(1, px).toFixed(1)}px ${FAM[fam] || FAM.sans}`;
  g.letterSpacing = `${(track * px).toFixed(2)}px`;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
}
/** "*word*" marks highlighted words, "\n" forces a line break. */
function toks(s) {
  const out = []; let hi = false;
  for (const piece of String(s ?? '').replace(/\\n/g, '\n').split(/(\*|\n)/)) {
    if (piece === '*') { hi = !hi; continue; }
    if (piece === '\n') { out.push({ br: true }); continue; }
    for (const w of piece.split(/[ \t]+/).filter(Boolean)) out.push({ w, hi });
  }
  return out;
}
const plain = (s) => String(s ?? '').replace(/\*/g, '').replace(/\\n|\n/g, ' ');
function wrap(g, s, maxW) {
  const space = g.measureText(' ').width, lines = [];
  let cur = { toks: [], w: 0 };
  for (const t of toks(s)) {
    if (t.br) { lines.push(cur); cur = { toks: [], w: 0 }; continue; }
    const tw = g.measureText(t.w).width;
    if (cur.toks.length && cur.w + space + tw > maxW) { lines.push(cur); cur = { toks: [], w: 0 }; }
    const x = cur.toks.length ? cur.w + space : 0;
    cur.toks.push({ ...t, x, tw }); cur.w = x + tw;
  }
  if (cur.toks.length || !lines.length) lines.push(cur);
  return lines;
}
/** Largest size (≤ maxPx) at which s fits maxW in at most maxLines lines. */
function fit(g, s, maxW, maxPx, maxLines = 3, w = 800, fam = 'sans', track = -0.03, minPx = 22) {
  const key = [s, maxW | 0, maxPx | 0, maxLines, w, fam, track].join('|');
  let r = FIT.get(key);
  if (!r) {
    let px = maxPx;
    for (;;) {
      setFont(g, px, w, fam, track);
      const L = wrap(g, s, maxW);
      if ((L.length <= maxLines && L.every((l) => l.w <= maxW + 1)) || px <= minPx) { r = { px, lines: L }; break; }
      px = Math.floor(px * 0.94);
    }
    if (FIT.size > 600) FIT.clear();
    FIT.set(key, r);
  }
  setFont(g, r.px, w, fam, track);
  return r;
}

// ───────────────────────── motion helpers
/** Exit progress for element i (0 → 1 over the scene's last 0.42 s, staggered). */
const ex = (c, i = 0) => E.in3(clamp(c.X * 1.5 - i * 0.12));
/** Fade-and-rise entrance plus the shared exit. */
function enter(c, t0, dur = 0.6, i = 0) {
  const k = E.out(P(c.t, t0, dur)), x = ex(c, i);
  return { a: clamp(k * 1.4) * (1 - x), dy: (1 - k) * 46 * c.u - x * 70 * c.u, k };
}
const rr = (g, x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2)); };
function card(c, x, y, w, h, r, o = {}) {
  const { g, th, u } = c;
  g.save();
  g.shadowColor = o.glow ? hexA(th.accent, 0.35) : th.shadow; g.shadowBlur = (o.glow ? 60 : 46) * u; g.shadowOffsetY = (o.glow ? 0 : 16) * u;
  g.fillStyle = o.fill || th.card; rr(g, x, y, w, h, r); g.fill();
  g.restore();
  // a soft top sheen so cards read as surfaces, not flat boxes
  const sh = g.createLinearGradient(0, y, 0, y + h);
  sh.addColorStop(0, hexA('#FFFFFF', th.dark ? 0.045 : 0.5)); sh.addColorStop(0.5, hexA('#FFFFFF', 0));
  g.fillStyle = sh; rr(g, x, y, w, h, r); g.fill();
  g.lineWidth = 2 * u; g.strokeStyle = o.stroke || th.line; rr(g, x + u, y + u, w - 2 * u, h - 2 * u, r); g.stroke();
}
function disc(g, x, y, r, fill) { g.fillStyle = fill; g.beginPath(); g.arc(x, y, Math.max(0, r), 0, TAU); g.fill(); }

/** Lines that slide up from behind a mask, staggered; they leave the same way. Returns the block height. */
function maskedLines(c, L, o) {
  const { g, t, th } = c;
  const { x, y, px, lh = 1.06, align = 'left', t0 = 0, stagger = 0.08, dur = 0.8, color = th.fg, w = 800, fam = 'sans', track = -0.03, hiStyle = 'underline', hiColor = th.accent } = o;
  const LH = px * lh;
  setFont(g, px, w, fam, track);
  L.forEach((line, i) => {
    const k = E.out(P(t, t0 + i * stagger, dur)), xo = ex(c, i);
    if (k <= 0 || xo >= 1) return;
    const lx = align === 'center' ? x - line.w / 2 : align === 'right' ? x - line.w : x;
    const top = y + i * LH, base = top + px * 0.86;
    g.save();
    g.beginPath(); g.rect(lx - px, top - px * 0.06, line.w + px * 2, LH + px * 0.16); g.clip();
    g.translate(0, (1 - k) * LH * 1.04 - xo * LH * 1.04);
    const hk = E.out3(P(t, t0 + i * stagger + dur * 0.45, 0.45));
    if (hiStyle === 'pill') for (const tk of line.toks) if (tk.hi && hk > 0) {
      g.fillStyle = hiColor; rr(g, lx + tk.x - px * 0.16, base - px * 0.84, (tk.tw + px * 0.32) * spring(t - (t0 + i * stagger + dur * 0.4), 16, 0.6), px * 1.04, px * 0.22); g.fill();
    }
    for (const tk of line.toks) {
      g.fillStyle = tk.hi ? (hiStyle === 'pill' && hk > 0.35 ? th.on : hiColor) : color;
      g.fillText(tk.w, lx + tk.x, base);
    }
    g.restore();
    if (hiStyle === 'underline') for (const tk of line.toks) if (tk.hi && hk > 0) {
      const ux = lx + tk.x, uy = base + px * 0.13 - xo * LH, uw = tk.tw * hk;
      g.save(); g.globalAlpha = 1 - xo; g.strokeStyle = hiColor; g.lineWidth = Math.max(3, px * 0.075); g.lineCap = 'round';
      g.beginPath(); g.moveTo(ux, uy); g.quadraticCurveTo(ux + uw / 2, uy + px * 0.05, ux + uw, uy - px * 0.02); g.stroke(); g.restore();
    }
  });
  return L.length * LH;
}

function kicker(c, text, x, y, t0, align = 'left') {
  const { g, th, u } = c, e = enter(c, t0, 0.6);
  if (e.a <= 0 || !text) return;
  setFont(g, 27 * u, 700, 'mono', 0.16);
  const label = String(text).toUpperCase(), tw = g.measureText(label).width;
  const padX = 24 * u, h = 58 * u, w = tw + padX * 2 + 26 * u, bx = align === 'center' ? x - w / 2 : x;
  g.save(); g.globalAlpha = e.a; g.translate((1 - e.k) * -30 * u, e.dy * 0.4);
  g.fillStyle = hexA(th.accent, 0.12); rr(g, bx, y - h / 2, w, h, h / 2); g.fill();
  g.strokeStyle = hexA(th.accent, 0.5); g.lineWidth = 2 * u; g.stroke();
  const pulse = 0.5 + 0.5 * Math.sin(c.T * 5);
  disc(g, bx + padX + 6 * u, y, 15 * u, hexA(th.accent, 0.28 * pulse));
  disc(g, bx + padX + 6 * u, y, 7 * u, th.accent);
  g.fillStyle = th.accent; g.textBaseline = 'middle'; g.fillText(label, bx + padX + 26 * u, y + 1.5 * u);
  g.restore();
}

// ───────────────────────── icons (24-unit stroke paths)
const ICONS = {
  film: 'M4 4h16v16H4z M8 4v16 M16 4v16 M4 8h4 M4 12h4 M4 16h4 M16 8h4 M16 12h4 M16 16h4',
  play: 'M8 5l11 7-11 7z',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M8.1 7.9L20 20 M8.1 16.1L20 4',
  spark: 'M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z',
  sparkles: 'M10 3l1.6 5.4L17 10l-5.4 1.6L10 17l-1.6-5.4L3 10l5.4-1.6z M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z',
  check: 'M4 12.5l5 5L20 6.5',
  x: 'M6 6l12 12 M18 6L6 18',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3.5 2',
  chat: 'M4 5h16v11H9l-5 4z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
  download: 'M12 4v12 M7 11l5 5 5-5 M4 20h16',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5 11a7 7 0 0 0 14 0 M12 18v3',
  cursor: 'M5 3l14 7-6 2-2 6z',
  music: 'M9 18V5l11-2v13 M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  chart: 'M5 20V11 M11 20V5 M17 20v-6 M3 20h18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M16 16l5 5',
  doc: 'M6 2h8l5 5v15H6z M14 2v5h5 M9 13h7 M9 17h7',
  image: 'M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 6',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3 3.5 3 14.5 0 18 M12 3c-3 3.5-3 14.5 0 18',
  heart: 'M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z',
  star: 'M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 17l-5.6 3 1.3-6.2L3 9.5l6.3-.7z',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  phone: 'M7 2h10v20H7z M11 18h2',
  money: 'M12 2v20 M17 6H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6',
  calendar: 'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4',
  mail: 'M3 5h18v14H3z M3 6l9 7 9-7',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9L7 7 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1',
  cpu: 'M6 6h12v12H6z M9.5 9.5h5v5h-5z M9 2v4 M15 2v4 M9 18v4 M15 18v4 M2 9h4 M2 15h4 M18 9h4 M18 15h4',
  rocket: 'M12 2c3 2 5 6 5 10l-2 4H9l-2-4c0-4 2-8 5-10z M12 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z M9 16l-3 4 M15 16l3 4',
  frame: 'M3 8V3h5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5',
  wave: 'M3 10v4 M7 7v10 M11 4v16 M15 8v8 M19 10v4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  plus: 'M12 5v14 M5 12h14',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  down: 'M12 5v14 M6 13l6 6 6-6',
  robot: 'M5 8h14v11H5z M12 4v4 M9 13v.5 M15 13v.5 M9 16.5h6 M2 12v3 M22 12v3',
  code: 'M8 7l-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16',
  terminal: 'M3 4h18v16H3z M7 9l3 3-3 3 M12 15h5',
  trend: 'M3 17l6-6 4 4 8-8 M15 7h6v6',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  cloud: 'M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.3 3.3 0 0 0 7 18z',
  brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1z M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1',
  fire: 'M12 22c4 0 7-3 7-7 0-5-5-7-5-12-3 2-5 5-5 8-1-1-2-2-2-4-2 2-2 5-2 8 0 4 3 7 7 7z',
  trophy: 'M7 4h10v5a5 5 0 0 1-10 0z M7 6H4v2a3 3 0 0 0 3 3 M17 6h3v2a3 3 0 0 1-3 3 M12 14v4 M8 21h8 M9 18h6',
};
const ICON_WORDS = [
  [/\b(video|footage|clip|clips|film|reel|reels|movie|b-roll)\b/i, 'film'], [/\b(cut|cuts|trim|edit|edits|editing|scissors)\b/i, 'scissors'],
  [/\b(ai|claude|gpt|model|agent|agents|magic|smart|auto|automatic)\b/i, 'sparkles'], [/\b(time|minute|minutes|second|seconds|hour|hours|fast|quick|speed|instant)\b/i, 'clock'],
  [/\b(chat|talk|message|ask|prompt|comment|dm|reply)\b/i, 'chat'], [/\b(upload|drop|import|add)\b/i, 'upload'],
  [/\b(export|download|render|ship|publish|post|deliver)\b/i, 'download'], [/\b(watch|see|preview|view|views|live|look)\b/i, 'eye'],
  [/\b(caption|captions|text|script|write|doc|docs|notes)\b/i, 'doc'], [/\b(music|sound|audio|sfx|song|beat)\b/i, 'music'],
  [/\b(voice|mic|record|speak|podcast)\b/i, 'mic'], [/(\$|\b(money|revenue|price|cost|pay|earn|profit|sales)\b)/i, 'money'],
  [/\b(grow|growth|trend|increase|scale|more)\b/i, 'trend'], [/\b(code|dev|api|build|ship)\b/i, 'code'], [/\b(terminal|command|cli)\b/i, 'terminal'],
  [/\b(user|users|you|creator|creators|people|team|customer|customers)\b/i, 'user'], [/\b(image|photo|picture|thumbnail|design)\b/i, 'image'],
  [/\b(search|find|research)\b/i, 'search'], [/\b(secure|safe|private|lock|security)\b/i, 'lock'], [/\b(idea|ideas|create|generate|new)\b/i, 'spark'],
  [/\b(target|goal|aim|focus)\b/i, 'target'], [/\b(setting|settings|config|tune|control)\b/i, 'gear'], [/\b(world|global|web|internet)\b/i, 'globe'],
  [/\b(love|like|likes|heart)\b/i, 'heart'], [/\b(launch|start|go)\b/i, 'rocket'], [/\bframe\b/i, 'frame'], [/\b(layer|layers|stack)\b/i, 'layers'],
  [/\b(link|connect|integrate|sync)\b/i, 'link'], [/\b(cloud|server|deploy)\b/i, 'cloud'], [/\b(robot|bot)\b/i, 'robot'],
  [/\b(calendar|schedule|date|day|week)\b/i, 'calendar'], [/\b(mail|email|inbox)\b/i, 'mail'], [/\b(phone|mobile|app)\b/i, 'phone'],
  [/\b(chart|data|stat|stats|analytics|numbers)\b/i, 'chart'], [/\b(think|brain|learn|memory)\b/i, 'brain'], [/\b(viral|hot|fire)\b/i, 'fire'], [/\b(win|best|top)\b/i, 'trophy'],
];
export const ICON_NAMES = Object.keys(ICONS);
const autoIcon = (text, i = 0) => (ICON_WORDS.find(([re]) => re.test(plain(text))) || [null, ['spark', 'bolt', 'layers', 'target', 'star', 'eye'][i % 6]])[1];
const PATHS = {};
/** Stroke icon centred on x, y. k < 1 draws it partway (stroke-on). */
function icon(c, name, x, y, size, color, k = 1, lw = 2.1) {
  const { g } = c; if (k <= 0) return;
  const p = (PATHS[name] ||= new Path2D(ICONS[name] || ICONS.spark));
  g.save(); g.translate(x - size / 2, y - size / 2); g.scale(size / 24, size / 24);
  g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = color;
  if (k < 1) g.setLineDash([64 * k, 200]);
  g.stroke(p); g.restore();
}
const items = (s, key = 'items') => (Array.isArray(s[key]) ? s[key] : []).map((it, i) => {
  const o = typeof it === 'string' ? { text: it } : { ...it, text: it.text ?? it.label ?? '' };
  return { ...o, icon: ICONS[o.icon] ? o.icon : autoIcon(o.text, i) };
});

// ───────────────────────── backdrop, chrome, transitions
function glow(g, W, H, x, y, r, hex, a) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, hexA(hex, a)); gr.addColorStop(0.55, hexA(hex, a * 0.35)); gr.addColorStop(1, hexA(hex, 0));
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
}
function backdrop(c) {
  const { g, th, W, H, T, u } = c;
  g.fillStyle = th.bg; g.fillRect(0, 0, W, H);
  glow(g, W, H, W * (0.16 + 0.12 * Math.sin(T * 0.21)), H * (0.2 + 0.06 * Math.cos(T * 0.17)), W * 1.0, th.accent, th.glow);
  glow(g, W, H, W * (0.88 + 0.08 * Math.sin(T * 0.15 + 2)), H * (0.82 + 0.05 * Math.sin(T * 0.23 + 1)), W * 1.15, th.accent2, th.glow * 0.9);
  const s = 60 * u, oy = (T * 8 * u) % s, d = 2.6 * u;
  g.fillStyle = th.dot;
  for (let y = -oy; y < H + s; y += s) for (let x = s / 2; x < W; x += s) g.fillRect(x - d / 2, y - d / 2, d, d);
}
const NOISE = new WeakMap();
function grainPattern(g) {
  let p = NOISE.get(g); if (p) return p;
  const n = 180, cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : Object.assign(document.createElement('canvas'), { width: n, height: n });
  const x = cv.getContext('2d'), im = x.createImageData(n, n);
  let seed = 0x9e3779b9;
  for (let i = 0; i < n * n; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; const v = 128 + (((seed >>> 0) % 256) - 128) * 0.9; im.data.set([v, v, v, 255], i * 4); }
  x.putImageData(im, 0, 0);
  p = g.createPattern(cv, 'repeat'); NOISE.set(g, p); return p;
}
function finish(c) {
  const { g, th, W, H, T } = c;
  const v = g.createRadialGradient(W / 2, H * 0.48, H * 0.3, W / 2, H * 0.48, H * 0.82);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, `rgba(0,0,0,${th.dark ? 0.42 : 0.12})`);
  g.fillStyle = v; g.fillRect(0, 0, W, H);
  const pat = grainPattern(g), f = Math.floor(T * 24);
  pat.setTransform(new DOMMatrix([1, 0, 0, 1, (f * 73) % 180, (f * 131) % 180]));
  g.save(); g.globalCompositeOperation = 'overlay'; g.globalAlpha = th.grain * 2; g.fillStyle = pat; g.fillRect(0, 0, W, H); g.restore();
}
function hud(c) {
  const { g, s, th, W, H, u, T } = c;
  if (s.hud === false || s.hud === 'off') return;
  const m = 58 * u, L = 46 * u;
  g.save(); g.strokeStyle = hexA(th.fg, 0.3); g.lineWidth = 3.5 * u; g.lineCap = 'square';
  for (const [x, y, dx, dy] of [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]) {
    g.beginPath(); g.moveTo(x, y + dy * L); g.lineTo(x, y); g.lineTo(x + dx * L, y); g.stroke();
  }
  setFont(g, 23 * u, 500, 'mono', 0.1); g.textBaseline = 'middle'; g.fillStyle = hexA(th.fg, 0.5);
  const ly = m + 2 * u;
  if (s.hud === 'rec') {
    disc(g, m + L + 30 * u, ly, 7 * u, hexA(th.bad, Math.sin(T * TAU) > -0.2 ? 0.95 : 0.25));
    const ts = `${String(Math.floor(T / 60)).padStart(2, '0')}:${String(Math.floor(T % 60)).padStart(2, '0')}:${String(Math.floor((T % 1) * 30)).padStart(2, '0')}`;
    g.fillText(`REC ${ts}`, m + L + 48 * u, ly);
  } else if (s.brand) g.fillText(String(s.brand).toUpperCase(), m + L + 22 * u, ly);
  if (s.n && s.count) { g.textAlign = 'right'; g.fillText(`${String(s.n).padStart(2, '0')} / ${String(s.count).padStart(2, '0')}`, W - m - L - 22 * u, ly); g.textAlign = 'left'; }
  if (s.total) {
    const bw = 190 * u, bx = W - m - L - 22 * u - bw, by = H - m - 2 * u;
    g.fillStyle = hexA(th.fg, 0.14); rr(g, bx, by - 2.5 * u, bw, 5 * u, 3 * u); g.fill();
    g.fillStyle = hexA(th.accent, 0.9); rr(g, bx, by - 2.5 * u, Math.max(5 * u, bw * clamp(T / s.total)), 5 * u, 3 * u); g.fill();
  }
  if (s.hud === 'rec' && s.brand) g.fillText(String(s.brand).toUpperCase(), m + L + 22 * u, H - m - 2 * u);
  g.restore();
}
const WIPE = 0.34;
/** A slanted two-tone panel that sweeps up through the cut: the outgoing scene draws its first half, the incoming its second. */
function wipe(c) {
  const { g, s, th, t, D, W, H } = c;
  let k = null;
  if (s.out === 'wipe' && t > D - WIPE) k = 0.5 * E.in3(P(t, D - WIPE, WIPE));
  if (s.in === 'wipe' && t < WIPE) k = 0.5 + 0.5 * E.out3(P(t, 0, WIPE));
  if (k == null) return;
  const sl = H * 0.14, span = H + 2 * sl;
  const band = (lead, col) => {
    const p = clamp(k * 2 + lead, 0, 2), y0 = H + sl - p * span, y1 = y0 + span;
    g.fillStyle = col; g.beginPath(); g.moveTo(0, y0 + sl / 2); g.lineTo(W, y0 - sl / 2); g.lineTo(W, y1 - sl / 2); g.lineTo(0, y1 + sl / 2); g.closePath(); g.fill();
  };
  band(0.07, th.accent2); band(0, th.accent);
}

// ───────────────────────── templates
// len(s): natural length in seconds. draw(c): one frame. cues(s, D): sound hits [{t, sfx, g?, d?}] in scene seconds.
const stepTimes = (n, D) => Array.from({ length: n }, (_, i) => 0.55 + i * ((D - 1.45) / Math.max(1, n)));
const flowTimes = (n, D) => Array.from({ length: n }, (_, i) => 0.35 + i * ((D - 1.5) / Math.max(1, n - 1)));
function chatPlan(s) {
  const msgs = (Array.isArray(s.messages) ? s.messages : []).map((m) => (typeof m === 'string' ? { from: 'user', text: m } : { from: /^(ai|claude|assistant|bot|frame|gpt|agent)$/i.test(m.from || m.role || '') ? 'ai' : 'user', text: m.text || '' }));
  let tt = 0.35; const out = [];
  for (const m of msgs) {
    if (m.from === 'user') { const type = Math.min(1.0, 0.25 + plain(m.text).length * 0.022); out.push({ ...m, typeAt: tt, at: tt + type }); tt += type + 0.35; }
    else { out.push({ ...m, at: tt + 0.1, textAt: tt + 0.65 }); tt += 0.65 + Math.min(2.2, plain(m.text).length / 46) + 0.35; }
  }
  return { msgs: out, end: tt };
}
function termPlan(s) {
  let tt = 0.4; const out = [];
  for (const raw of Array.isArray(s.lines) ? s.lines : []) {
    const line = String(raw), cmd = /^\s*[$>❯]/.test(line);
    if (cmd) { const d = Math.min(1.3, 0.2 + line.length / 34); out.push({ line, cmd, at: tt, done: tt + d }); tt += d + 0.22; }
    else { out.push({ line, cmd, at: tt, done: tt }); tt += 0.2; }
  }
  return { lines: out, end: tt };
}
function fmtNum(v, dec, commas) {
  const s = v.toFixed(dec);
  if (!commas) return s;
  const [a, b] = s.split('.'); return a.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (b ? '.' + b : '');
}
function title_(c, s, y, maxPx = 88, t0 = 0.1, align = 'left') {
  if (!s.title) return y;
  const { g, W, M, u } = c, x = align === 'center' ? W / 2 : M;
  if (s.kicker) { kicker(c, s.kicker, x, y, t0, align); y += 90 * u; }
  const f = fit(g, s.title, W - 2 * M, maxPx * u, 2, 850);
  return y + maskedLines(c, f.lines, { x, y, px: f.px, lh: 1.05, t0: t0 + 0.05, align }) + 64 * u;
}

const TEMPLATES = {
  title: {
    about: 'Headline beat. text (use *word* to highlight, \\n to break), kicker?, sub?, icon?, align? ("left"|"center").',
    len: () => 3,
    draw(c) {
      const { g, s, th, W, H, u, M } = c, CW = W - 2 * M, align = s.align === 'center' ? 'center' : 'left', ax = align === 'center' ? W / 2 : M;
      const f = fit(g, s.text || 'Your headline here', CW, 152 * u, 4, 850, 'sans', -0.035);
      const LH = f.px * 1.04, blockH = f.lines.length * LH;
      const sub = s.sub ? fit(g, s.sub, CW * 0.94, 46 * u, 3, 500, 'sans', -0.01) : null;
      const subH = sub ? sub.lines.length * sub.px * 1.32 + 46 * u : 0;
      const top = H * 0.5 - (blockH + subH) / 2 + 40 * u;
      orbit(c, align === 'center' ? W / 2 : W - M - 150 * u, top - (align === 'center' ? 260 : 230) * u, 128 * u, 0.04, s.icon || autoIcon(s.text));
      if (s.kicker) kicker(c, s.kicker, ax, top - 74 * u, 0.12, align);
      maskedLines(c, f.lines, { x: ax, y: top, px: f.px, lh: 1.04, align, t0: 0.2, stagger: 0.085, w: 850, track: -0.035 });
      if (sub) { setFont(g, sub.px, 500, 'sans', -0.01); maskedLines(c, sub.lines, { x: ax, y: top + blockH + 46 * u, px: sub.px, lh: 1.32, align, t0: 0.62, stagger: 0.06, color: th.muted, w: 500, track: -0.01, hiStyle: 'color' }); }
    },
    cues: (s) => [{ t: 0.05, sfx: 'whoosh' }, { t: 0.2, sfx: 'pop', g: 0.45 }, String(s.text || '').includes('*') && { t: 0.72, sfx: 'tick' }].filter(Boolean),
  },

  word: {
    about: 'Punch beat: 1–3 huge words that slam in with a shockwave. text, sub?.',
    len: () => 1.7,
    draw(c) {
      const { g, s, th, W, H, u, t, M } = c, CW = W - 2 * M;
      const f = fit(g, s.text || 'Boom.', CW, 330 * u, 3, 900, 'sans', -0.05);
      const land = 0.3, shk = t > land ? Math.exp(-(t - land) * 10) : 0;
      g.translate(Math.sin(t * 93) * 16 * u * shk, Math.cos(t * 71) * 12 * u * shk);
      for (let i = 0; i < 3; i++) {
        const k = P(t, land + i * 0.07, 0.75); if (k <= 0 || k >= 1) continue;
        g.save(); g.strokeStyle = hexA(i === 1 ? th.accent2 : th.accent, (1 - k) * 0.75); g.lineWidth = (1 - k) * 16 * u;
        g.beginPath(); g.arc(W / 2, H * 0.47, E.out(k) * W * (0.62 + i * 0.12), 0, TAU); g.stroke(); g.restore();
      }
      const LH = f.px * 0.98, top = H * 0.47 - (f.lines.length * LH) / 2 - (s.sub ? 40 * u : 0), xo = ex(c);
      g.save(); g.translate(W / 2, H * 0.47); g.scale(1 + 0.12 * xo, 1 + 0.12 * xo); g.translate(-W / 2, -H * 0.47); g.globalAlpha = 1 - xo;
      let ci = 0;
      f.lines.forEach((line, li) => {
        const lx = W / 2 - line.w / 2, base = top + li * LH + f.px * 0.8;
        for (const tk of line.toks) for (let j = 0; j < tk.w.length; j++) {
          const k = spring(t - 0.04 - ci++ * 0.03, 17, 0.42);
          if (k <= 0) continue;
          const cx = lx + tk.x + g.measureText(tk.w.slice(0, j)).width;
          g.save(); g.translate(cx, base + (1 - k) * f.px * 0.75); g.rotate((1 - k) * 0.22); g.globalAlpha = clamp(k * 2) * (1 - xo);
          g.fillStyle = tk.hi ? th.accent : th.fg; g.fillText(tk.w[j], 0, 0); g.restore();
        }
      });
      g.restore();
      if (s.sub) { const sf = fit(g, s.sub, CW, 50 * u, 2, 600, 'sans', -0.01); maskedLines(c, sf.lines, { x: W / 2, y: top + f.lines.length * LH + 50 * u, px: sf.px, lh: 1.25, align: 'center', t0: 0.55, color: th.muted, w: 600, track: -0.01, hiStyle: 'color' }); }
    },
    cues: () => [{ t: 0.02, sfx: 'whoosh', g: 0.8 }, { t: 0.3, sfx: 'impact' }],
  },

  steps: {
    about: 'Numbered process: title?, kicker?, items: ["step", …] or [{text, icon}] (2–4). Each step lights up, then checks off.',
    len: (s) => 1.45 + Math.max(2, items(s).length) * 0.9 + 0.3,
    draw(c) {
      const { g, s, th, W, H, u, t, M, D } = c, CW = W - 2 * M, it = items(s), n = it.length || 1;
      let y = title_(c, s, H * 0.17);
      const ch = 178 * u, gap = 30 * u, listH = n * ch + (n - 1) * gap;
      const y0 = Math.min(Math.max(y, H * 0.56 - listH / 2), H * 0.86 - listH), ts = stepTimes(n, D);
      const bx = M + 86 * u, br = 46 * u;
      for (let i = 0; i < n - 1; i++) {
        const k = E.inOut(P(t, ts[i + 1] - 0.32, 0.32)), ya = y0 + i * (ch + gap) + ch / 2 + br + 8 * u, yb = y0 + (i + 1) * (ch + gap) + ch / 2 - br - 8 * u;
        if (t < ts[i] + 0.1) continue;
        g.save(); g.globalAlpha = 1 - ex(c, i); g.lineCap = 'round'; g.lineWidth = 5 * u;
        g.strokeStyle = th.line; g.beginPath(); g.moveTo(bx, ya); g.lineTo(bx, yb); g.stroke();
        if (k > 0) { g.strokeStyle = th.accent; g.beginPath(); g.moveTo(bx, ya); g.lineTo(bx, ya + (yb - ya) * k); g.stroke(); }
        g.restore();
      }
      it.forEach((item, i) => {
        const k = spring(t - ts[i], 12, 0.65); if (k <= 0.001) return;
        const xo = ex(c, i), cy = y0 + i * (ch + gap), active = t >= ts[i] && (i === n - 1 || t < ts[i + 1]), done = i < n - 1 && t >= ts[i + 1];
        g.save(); g.globalAlpha = clamp(k * 1.6) * (1 - xo); g.translate((1 - k) * 160 * u, -xo * 60 * u);
        card(c, M, cy, CW, ch, 38 * u, { stroke: active ? hexA(th.accent, 0.75) : th.line, glow: active && k > 0.9 });
        const fk = E.out(P(t, ts[i] + 0.12, 0.35)), by = cy + ch / 2;
        disc(g, bx, by, br * (0.6 + 0.4 * spring(t - ts[i] - 0.05, 16, 0.5)), hexA(th.accent, 0.14 + 0.86 * fk));
        if (done) icon(c, 'check', bx, by, 50 * u, th.on, E.out3(P(t, ts[i + 1], 0.3)), 3);
        else { setFont(g, 42 * u, 800, 'sans', -0.02); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = fk > 0.5 ? th.on : th.accent; g.fillText(String(i + 1), bx, by + 2 * u); }
        const tf = fit(g, item.text, CW - 250 * u, 50 * u, 2, 720, 'sans', -0.02, 30 * u), LH = tf.px * 1.2;
        g.fillStyle = done ? hexA(th.fg, 0.62) : th.fg;
        tf.lines.forEach((l, li) => { let x = M + 168 * u; for (const tk of l.toks) { g.fillStyle = tk.hi ? th.accent : done ? hexA(th.fg, 0.62) : th.fg; g.fillText(tk.w, x + tk.x, by - (tf.lines.length * LH) / 2 + li * LH + tf.px * 0.92); } });
        if (s.icons !== false) icon(c, item.icon, M + CW - 70 * u, by, 46 * u, active ? th.accent : hexA(th.fg, 0.35), E.out3(P(t, ts[i] + 0.2, 0.5)));
        g.restore();
      });
    },
    cues: (s, D) => { const ts = stepTimes(items(s).length || 1, D); return [s.title && { t: 0.08, sfx: 'whoosh', g: 0.7 }, ...ts.flatMap((x, i) => [{ t: x + 0.02, sfx: 'pop' }, i < ts.length - 1 && { t: ts[i + 1], sfx: 'tick' }])].filter(Boolean); },
  },

  stat: {
    about: 'Big number that counts up inside a gauge. value (number), prefix?, unit?, label?, kicker?, fill? (gauge fill 0–1), decimals?.',
    len: () => 3.2,
    draw(c) {
      const { g, s, th, W, H, u, t, M } = c, cx = W / 2, cy = H * 0.43, R = 340 * u, xo = ex(c);
      const value = Number(s.value) || 0, dec = s.decimals ?? (String(s.value).split('.')[1]?.length || 0);
      const ck = E.out(P(t, 0.25, 1.35)), land = 1.6;
      g.save(); g.globalAlpha = 1 - xo; g.translate(0, -xo * 60 * u);
      const ra = E.out(P(t, 0.05, 0.9));
      for (let i = 0; i < 72; i++) {
        if (i / 72 > ra) break;
        const a = -Math.PI / 2 + (i / 72) * TAU, l = (i % 6 === 0 ? 26 : 12) * u, r0 = R + 34 * u;
        g.strokeStyle = hexA(th.fg, i % 6 === 0 ? 0.3 : 0.14); g.lineWidth = 3 * u;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * (r0 + l), cy + Math.sin(a) * (r0 + l)); g.stroke();
      }
      g.strokeStyle = hexA(th.fg, 0.08); g.lineWidth = 18 * u; g.beginPath(); g.arc(cx, cy, R, 0, TAU * ra); g.stroke();
      const frac = clamp(s.fill ?? 0.78) * ck, a1 = -Math.PI / 2 + frac * TAU;
      if (frac > 0.002) {
        g.save(); g.shadowColor = hexA(th.accent, 0.8); g.shadowBlur = 36 * u; g.strokeStyle = th.accent; g.lineWidth = 18 * u; g.lineCap = 'round';
        g.beginPath(); g.arc(cx, cy, R, -Math.PI / 2, a1); g.stroke(); g.restore();
        disc(g, cx + Math.cos(a1) * R, cy + Math.sin(a1) * R, 15 * u, th.fg);
      }
      const final = fmtNum(value, dec, s.commas !== false && Math.abs(value) >= 10000), str = fmtNum(value * ck, dec, s.commas !== false && Math.abs(value) >= 10000);
      const pre = s.prefix ? String(s.prefix) : '', unit = s.unit ? String(s.unit) : '';
      let px = 270 * u; setFont(g, px, 850, 'sans', -0.04);
      const cell = () => g.measureText('0').width, wOf = (x) => [...x].reduce((a, ch) => a + (/\d/.test(ch) ? cell() : g.measureText(ch).width), 0);
      for (let i = 0; i < 30; i++) { setFont(g, px, 850, 'sans', -0.04); const tw = wOf(final) + (pre ? px * 0.62 * 0.7 : 0) + (unit ? px * 0.5 * 0.62 * unit.length + px * 0.06 : 0); if (tw <= R * 1.62) break; px *= 0.93; }
      const bump = 1 + 0.06 * Math.sin(Math.PI * P(t, land, 0.28));
      setFont(g, px, 850, 'sans', -0.04);
      const nw = wOf(str), preW = pre ? (setFont(g, px * 0.62, 750, 'sans', -0.02), g.measureText(pre).width) : 0, unitW = unit ? (setFont(g, px * 0.5, 800, 'sans', -0.02), g.measureText(unit).width + px * 0.05) : 0;
      const total = preW + nw + unitW, x0 = cx - total / 2, base = cy + px * 0.35;
      g.save(); g.translate(cx, cy); g.scale(bump, bump); g.translate(-cx, -cy);
      if (pre) { setFont(g, px * 0.62, 750, 'sans', -0.02); g.fillStyle = th.muted; g.fillText(pre, x0, base); }
      setFont(g, px, 850, 'sans', -0.04); g.fillStyle = th.fg;
      let x = x0 + preW; const cw = cell();
      for (const ch of str) { if (/\d/.test(ch)) { g.textAlign = 'center'; g.fillText(ch, x + cw / 2, base); g.textAlign = 'left'; x += cw; } else { g.fillText(ch, x, base); x += g.measureText(ch).width; } }
      if (unit) { setFont(g, px * 0.5, 800, 'sans', -0.02); g.fillStyle = th.accent; g.fillText(unit, x + px * 0.05, base); }
      g.restore(); g.restore();
      if (s.kicker) kicker(c, s.kicker, W / 2, cy - R - 120 * u, 0.1, 'center');
      if (s.label) { const lf = fit(g, s.label, W - 2 * M, 62 * u, 2, 750, 'sans', -0.02); maskedLines(c, lf.lines, { x: W / 2, y: cy + R + 120 * u, px: lf.px, lh: 1.15, align: 'center', t0: 0.55, w: 750, track: -0.02 }); }
    },
    cues: () => [{ t: 0.04, sfx: 'whoosh' }, ...Array.from({ length: 12 }, (_, k) => ({ t: 0.25 + 1.3 * Math.pow(k / 12, 1.7), sfx: 'tick', g: 0.55 })), { t: 1.6, sfx: 'ding' }],
  },

  compare: {
    about: 'Before vs after. before: {label?, items:[…]} (or ["…"]), after: {label?, items:[…]}, title?. Before items get struck out, after items check in.',
    len: () => 4.4,
    draw(c) {
      const { g, s, th, W, H, u, t, M } = c, CW = W - 2 * M;
      const side = (v, label) => (Array.isArray(v) ? { label, items: v } : { label: v?.label || label, items: v?.items || [] });
      const b = side(s.before || s.left, 'Before'), a = side(s.after || s.right, 'After');
      let y = title_(c, s, H * 0.13, 80, 0.05);
      const rowH = 84 * u, head = 112 * u, pad = 44 * u, hb = head + b.items.length * rowH + pad, ha = head + a.items.length * rowH + pad, gap = 118 * u;
      const y0 = Math.max(y, H * 0.52 - (hb + gap + ha) / 2), y1 = y0 + hb + gap;
      const panel = (sd, py, ph, kind, t0) => {
        const k = spring(t - t0, 11, 0.7), xo = ex(c, kind === 'after' ? 1 : 0); if (k <= 0.001) return;
        const dim = kind === 'before' ? 1 - 0.45 * E.out(P(t, 1.5, 0.6)) : 1;
        g.save(); g.globalAlpha = clamp(k * 1.6) * (1 - xo) * dim;
        g.translate(kind === 'before' ? (1 - k) * -170 * u : 0, kind === 'after' ? (1 - k) * 170 * u : 0); g.translate(0, -xo * 60 * u);
        card(c, M, py, CW, ph, 40 * u, kind === 'after' ? { stroke: hexA(th.accent, 0.8), glow: k > 0.9 } : {});
        setFont(g, 26 * u, 700, 'mono', 0.16); const lab = String(sd.label).toUpperCase(), lw = g.measureText(lab).width + 104 * u;
        g.fillStyle = kind === 'after' ? th.accent : hexA(th.fg, 0.08); rr(g, M + 36 * u, py + 34 * u, lw, 56 * u, 28 * u); g.fill();
        icon(c, kind === 'after' ? 'check' : 'x', M + 70 * u, py + 62 * u, 28 * u, kind === 'after' ? th.on : th.bad, 1, 3);
        g.fillStyle = kind === 'after' ? th.on : th.muted; g.textBaseline = 'middle'; g.fillText(lab, M + 96 * u, py + 63 * u);
        sd.items.forEach((txt, i) => {
          const ry = py + head + i * rowH + rowH / 2, tf = fit(g, txt, CW - 190 * u, 44 * u, 1, kind === 'after' ? 720 : 600, 'sans', -0.015, 26 * u);
          const ik = kind === 'after' ? spring(t - (t0 + 0.3 + i * 0.16), 15, 0.55) : 1;
          if (kind === 'after') { disc(g, M + 70 * u, ry, 22 * u * ik, hexA(th.accent, 0.18)); icon(c, 'check', M + 70 * u, ry, 26 * u, th.accent, ik, 3.2); }
          else disc(g, M + 70 * u, ry, 6 * u, hexA(th.fg, 0.35));
          setFont(g, tf.px, kind === 'after' ? 720 : 600, 'sans', -0.015); g.textBaseline = 'middle';
          g.fillStyle = kind === 'after' ? th.fg : hexA(th.fg, 0.75); g.globalAlpha *= kind === 'after' ? clamp(ik * 1.5) : 1;
          g.fillText(plain(txt), M + 112 * u, ry + 2 * u);
          g.globalAlpha = clamp(k * 1.6) * (1 - xo) * dim;
          if (kind === 'before') {
            const sk = E.inOut(P(t, 1.25 + i * 0.13, 0.32)), w = g.measureText(plain(txt)).width;
            if (sk > 0) { g.strokeStyle = th.bad; g.lineWidth = 5 * u; g.lineCap = 'round'; g.beginPath(); g.moveTo(M + 106 * u, ry + 3 * u); g.lineTo(M + 106 * u + (w + 12 * u) * sk, ry + 3 * u); g.stroke(); }
          }
        });
        g.restore();
      };
      panel(b, y0, hb, 'before', 0.12);
      const vk = spring(t - 0.85, 14, 0.5), vy = y0 + hb + gap / 2;
      if (vk > 0) { g.save(); g.globalAlpha = 1 - ex(c, 1); disc(g, W / 2, vy, 50 * u * vk, th.card2); g.strokeStyle = th.line; g.lineWidth = 2 * u; g.beginPath(); g.arc(W / 2, vy, 50 * u * vk, 0, TAU); g.stroke(); icon(c, 'down', W / 2, vy, 40 * u * vk, th.accent, 1, 2.6); g.restore(); }
      panel(a, y1, ha, 'after', 1.0);
    },
    cues: (s) => { const b = Array.isArray(s.before) ? s.before : s.before?.items || [], a = Array.isArray(s.after) ? s.after : s.after?.items || []; return [{ t: 0.1, sfx: 'whoosh' }, { t: 0.85, sfx: 'pop', g: 0.6 }, { t: 1.0, sfx: 'whoosh', g: 0.7 }, ...b.map((_, i) => ({ t: 1.25 + i * 0.13, sfx: 'swipe', g: 0.6 })), ...a.map((_, i) => ({ t: 1.32 + i * 0.16, sfx: 'tick' }))]; },
  },

  flow: {
    about: 'Diagram: nodes connected by animated arrows with data pulses. nodes: ["A","B","C"] or [{text, icon}] (3–5), title?.',
    len: (s) => 1.5 + (Math.max(3, items(s, 'nodes').length) - 1) * 0.6 + 1.2,
    draw(c) {
      const { g, s, th, W, H, u, t, M, D } = c, nd = items(s, 'nodes'), n = nd.length || 1;
      const yTop = title_(c, s, H * 0.13, 78, 0.05) + 20 * u, yBot = H * 0.85, nh = 138 * u, nw = Math.min(W - 2 * M - 140 * u, 640 * u), ts = flowTimes(n, D);
      const pos = nd.map((_, i) => ({ x: W / 2 + (n > 1 ? (i % 2 ? 1 : -1) * 115 * u : 0), y: yTop + nh / 2 + (n > 1 ? (i / (n - 1)) * (yBot - yTop - nh) : (yBot - yTop - nh) / 2) }));
      const bez = (a, b, k) => { const p0 = [a.x, a.y + nh / 2], p3 = [b.x, b.y - nh / 2], dy = (p3[1] - p0[1]) * 0.55, p1 = [p0[0], p0[1] + dy], p2 = [p3[0], p3[1] - dy], q = 1 - k; return [q * q * q * p0[0] + 3 * q * q * k * p1[0] + 3 * q * k * k * p2[0] + k * k * k * p3[0], q * q * q * p0[1] + 3 * q * q * k * p1[1] + 3 * q * k * k * p2[1] + k * k * k * p3[1]]; };
      for (let i = 0; i < n - 1; i++) {
        const k = E.inOut(P(t, ts[i] + 0.18, ts[i + 1] - ts[i] - 0.05)); if (k <= 0) continue;
        g.save(); g.globalAlpha = 1 - ex(c, i); g.lineCap = 'round'; g.lineJoin = 'round';
        g.strokeStyle = th.line; g.lineWidth = 6 * u; g.beginPath(); for (let j = 0; j <= 40; j++) { const p = bez(pos[i], pos[i + 1], j / 40); j ? g.lineTo(...p) : g.moveTo(...p); } g.stroke();
        g.strokeStyle = th.accent; g.lineWidth = 6 * u; g.beginPath(); for (let j = 0; j <= 40; j++) { const p = bez(pos[i], pos[i + 1], (j / 40) * k); j ? g.lineTo(...p) : g.moveTo(...p); } g.stroke();
        if (k >= 1) for (let d = 0; d < 2; d++) { const ph = ((t - ts[i + 1]) * 0.85 + d * 0.5) % 1, p = bez(pos[i], pos[i + 1], ph); g.save(); g.shadowColor = th.accent; g.shadowBlur = 24 * u; disc(g, p[0], p[1], 9 * u, th.fg); g.restore(); }
        g.restore();
      }
      nd.forEach((node, i) => {
        const k = spring(t - ts[i], 13, 0.55); if (k <= 0.001) return;
        const { x, y } = pos[i], xo = ex(c, i), last = i === n - 1 && t > ts[i] + 0.2;
        g.save(); g.globalAlpha = clamp(k * 1.7) * (1 - xo); g.translate(x, y - xo * 50 * u); g.scale(0.82 + 0.18 * k, 0.82 + 0.18 * k); g.translate(-x, -y);
        card(c, x - nw / 2, y - nh / 2, nw, nh, 36 * u, last ? { stroke: hexA(th.accent, 0.85), glow: true } : {});
        g.fillStyle = hexA(th.accent, last ? 1 : 0.15); rr(g, x - nw / 2 + 26 * u, y - 43 * u, 86 * u, 86 * u, 24 * u); g.fill();
        icon(c, node.icon, x - nw / 2 + 69 * u, y, 46 * u, last ? th.on : th.accent, E.out3(P(t, ts[i] + 0.1, 0.5)), 2.3);
        const tf = fit(g, node.text, nw - 170 * u, 48 * u, 2, 750, 'sans', -0.02, 28 * u), LH = tf.px * 1.15;
        tf.lines.forEach((l, li) => { for (const tk of l.toks) { g.fillStyle = tk.hi ? th.accent : th.fg; g.fillText(tk.w, x - nw / 2 + 138 * u + tk.x, y - (tf.lines.length * LH) / 2 + li * LH + tf.px * 0.9); } });
        g.restore();
      });
    },
    cues: (s, D) => { const n = items(s, 'nodes').length || 1, ts = flowTimes(n, D); return [s.title && { t: 0.04, sfx: 'whoosh', g: 0.7 }, ...ts.map((x) => ({ t: x + 0.02, sfx: 'pop' })), ...ts.slice(0, -1).map((x) => ({ t: x + 0.2, sfx: 'swipe', g: 0.45 }))].filter(Boolean); },
  },

  chat: {
    about: 'Chat window: messages: [{from:"user"|"ai", text}] (2–4). User text types into the input then sends; the AI shows a typing indicator, then streams its reply. title? (window name).',
    len: (s) => chatPlan(s).end + 0.9,
    draw(c) {
      const { g, s, th, W, H, u, t, M } = c, plan = chatPlan(s), wx = M - 18 * u, ww = W - 2 * M + 36 * u, wy = H * 0.15, wh = H * 0.68;
      const k = spring(t, 11, 0.7), xo = ex(c);
      g.save(); g.globalAlpha = clamp(k * 1.5) * (1 - xo); g.translate(W / 2, wy + wh / 2 - xo * 60 * u); g.scale(0.93 + 0.07 * k, 0.93 + 0.07 * k); g.translate(-W / 2, -(wy + wh / 2));
      card(c, wx, wy, ww, wh, 44 * u);
      ['#FF5F57', '#FEBC2E', '#28C840'].forEach((col, i) => disc(g, wx + 48 * u + i * 34 * u, wy + 44 * u, 10 * u, col));
      setFont(g, 26 * u, 500, 'mono', 0.06); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = th.muted; g.fillText(s.title || 'Claude', W / 2, wy + 45 * u); g.textAlign = 'left';
      g.fillStyle = th.line; g.fillRect(wx, wy + 88 * u, ww, 2 * u);
      const ib = { x: wx + 30 * u, y: wy + wh - 122 * u, w: ww - 60 * u, h: 92 * u };
      const areaTop = wy + 120 * u, areaBot = ib.y - 26 * u, bw = ww * 0.74, px = 40 * u, LH = px * 1.32, pad = 30 * u;
      const lay = plan.msgs.map((m) => { setFont(g, px, 600, 'sans', -0.01); const L = wrap(g, m.text, bw - pad * 2); return { ...m, L, h: L.length * LH + pad * 1.6 }; });
      let used = 0; const shown = [];
      for (const m of lay) {
        const vis = t >= (m.from === 'user' ? m.at : m.at);
        if (!vis) continue;
        const a = m.from === 'user' ? spring(t - m.at, 15, 0.62) : 1;
        shown.push({ m, y: used, a }); used += (m.h + 22 * u) * clamp(a * 1.2);
      }
      const scroll = Math.max(0, used - (areaBot - areaTop));
      g.save(); g.beginPath(); g.rect(wx, areaTop - 20 * u, ww, areaBot - areaTop + 20 * u); g.clip();
      for (const { m, y, a } of shown) {
        const by = areaTop + y - scroll;
        if (m.from === 'user') {
          const bwid = Math.max(...m.L.map((l) => l.w)) + pad * 2, bx = wx + ww - 30 * u - bwid;
          g.save(); g.globalAlpha *= clamp(a * 1.4); g.translate(bx + bwid, by + m.h); g.scale(0.6 + 0.4 * a, 0.6 + 0.4 * a); g.translate(-(bx + bwid), -(by + m.h));
          g.fillStyle = th.accent; g.beginPath(); g.roundRect(bx, by, bwid, m.h, [36 * u, 36 * u, 10 * u, 36 * u]); g.fill();
          setFont(g, px, 600, 'sans', -0.01); g.fillStyle = th.on; m.L.forEach((l, li) => { for (const tk of l.toks) g.fillText(tk.w, bx + pad + tk.x, by + pad * 0.8 + li * LH + px * 0.95); });
          g.restore();
        } else {
          const typing = t < m.textAt, bx = wx + 30 * u;
          if (typing) {
            g.fillStyle = th.card2; g.beginPath(); g.roundRect(bx, by, 150 * u, 84 * u, [36 * u, 36 * u, 36 * u, 10 * u]); g.fill();
            for (let d = 0; d < 3; d++) disc(g, bx + 45 * u + d * 30 * u, by + 42 * u - Math.max(0, Math.sin((t * 7 - d * 0.9))) * 10 * u, 9 * u, hexA(th.fg, 0.55));
          } else {
            const total = m.L.reduce((n, l) => n + l.toks.reduce((a2, tk) => a2 + tk.w.length + 1, 0), 0), shownCh = Math.floor((t - m.textAt) * 46 + 1);
            let left = Math.min(total, shownCh), lines = 0, maxW = 0;
            setFont(g, px, 600, 'sans', -0.01);
            const draw = [];
            for (const l of m.L) { if (left <= 0) break; lines++; let w = 0; for (const tk of l.toks) { if (left <= 0) break; const part = tk.w.slice(0, left); left -= tk.w.length + 1; draw.push([part, tk.x, lines - 1, tk.hi]); w = tk.x + g.measureText(part).width; } maxW = Math.max(maxW, w); }
            const bh = lines * LH + pad * 1.6;
            g.fillStyle = th.card2; g.beginPath(); g.roundRect(bx, by, maxW + pad * 2, bh, [36 * u, 36 * u, 36 * u, 10 * u]); g.fill();
            for (const [part, x, li, hi] of draw) { g.fillStyle = hi ? th.accent : th.fg; g.fillText(part, bx + pad + x, by + pad * 0.8 + li * LH + px * 0.95); }
          }
        }
      }
      g.restore();
      // the input bar: user messages type here first
      g.fillStyle = hexA(th.fg, 0.05); rr(g, ib.x, ib.y, ib.w, ib.h, ib.h / 2); g.fill(); g.strokeStyle = th.line; g.lineWidth = 2 * u; g.stroke();
      const typingMsg = plan.msgs.find((m) => m.from === 'user' && t >= m.typeAt && t < m.at);
      setFont(g, 36 * u, 500, 'sans', -0.01); g.textBaseline = 'middle';
      if (typingMsg) {
        const full = plain(typingMsg.text), n = Math.ceil(full.length * P(t, typingMsg.typeAt, typingMsg.at - typingMsg.typeAt - 0.08));
        let shownT = full.slice(0, n); while (g.measureText(shownT).width > ib.w - 170 * u && shownT.length > 1) shownT = shownT.slice(1);
        g.fillStyle = th.fg; g.fillText(shownT, ib.x + 38 * u, ib.y + ib.h / 2 + 2 * u);
        if (Math.sin(t * 16) > 0) { g.fillStyle = th.accent; g.fillRect(ib.x + 40 * u + g.measureText(shownT).width, ib.y + 26 * u, 4 * u, ib.h - 52 * u); }
      } else { g.fillStyle = th.muted; g.fillText(s.placeholder || 'Message…', ib.x + 38 * u, ib.y + ib.h / 2 + 2 * u); }
      disc(g, ib.x + ib.w - ib.h / 2, ib.y + ib.h / 2, 32 * u, typingMsg ? th.accent : hexA(th.fg, 0.12));
      icon(c, 'arrow', ib.x + ib.w - ib.h / 2, ib.y + ib.h / 2, 30 * u, typingMsg ? th.on : th.muted, 1, 2.6);
      g.restore();
    },
    cues: (s) => chatPlan(s).msgs.flatMap((m) => m.from === 'user'
      ? [...Array.from({ length: Math.max(2, Math.floor((m.at - m.typeAt) / 0.075)) }, (_, i) => ({ t: m.typeAt + i * 0.075, sfx: 'type', g: 0.5 })), { t: m.at, sfx: 'pop' }]
      : [{ t: m.at, sfx: 'tick', g: 0.5 }, { t: m.textAt, sfx: 'pop', g: 0.55 }]),
  },

  terminal: {
    about: 'Terminal window. lines: ["$ command", "output", "✓ done"] — "$" lines type out, others print. title?.',
    len: (s) => termPlan(s).end + 1.0,
    draw(c) {
      const { g, s, th, W, H, u, t, M } = c, plan = termPlan(s), wx = M - 18 * u, ww = W - 2 * M + 36 * u, wy = H * 0.2, wh = H * 0.56;
      const k = spring(t, 11, 0.7), xo = ex(c);
      g.save(); g.globalAlpha = clamp(k * 1.5) * (1 - xo); g.translate(W / 2, wy + wh / 2 - xo * 60 * u); g.scale(0.93 + 0.07 * k, 0.93 + 0.07 * k); g.translate(-W / 2, -(wy + wh / 2));
      card(c, wx, wy, ww, wh, 40 * u, { fill: th.dark ? '#08080C' : '#15151B' });
      ['#FF5F57', '#FEBC2E', '#28C840'].forEach((col, i) => disc(g, wx + 46 * u + i * 32 * u, wy + 42 * u, 10 * u, col));
      setFont(g, 24 * u, 500, 'mono', 0.04); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#7C7A88'; g.fillText(s.title || '~/project — zsh', W / 2, wy + 43 * u); g.textAlign = 'left';
      const px = 33 * u, LH = px * 1.55, x0 = wx + 44 * u, top = wy + 120 * u, maxLines = Math.floor((wh - 160 * u) / LH);
      const vis = plan.lines.filter((l) => t >= l.at), off = Math.max(0, vis.length - maxLines);
      setFont(g, px, 500, 'mono', 0);
      vis.slice(off).forEach((l, i) => {
        const y = top + i * LH + px; let txt = l.line, col = '#D8D6E0';
        if (l.cmd) { const n = Math.ceil(l.line.length * P(t, l.at, l.done - l.at)); txt = l.line.slice(0, n); }
        if (/^\s*[$>❯]/.test(l.line)) { g.fillStyle = th.accent === '#F2F2F2' ? '#FFFFFF' : th.accent; const m = l.line.match(/^\s*[$>❯]/)[0]; g.fillText(m, x0, y); txt = txt.slice(m.length); col = '#FFFFFF'; }
        else if (/^\s*(✓|✔|done|ok)/i.test(l.line)) col = th.good; else if (/^\s*(✗|✘|!|error)/i.test(l.line)) col = th.bad; else if (/^\s*#/.test(l.line)) col = '#6E6C7C';
        const xx = /^\s*[$>❯]/.test(l.line) ? x0 + px * 1.25 : x0;
        g.globalAlpha = clamp(k * 1.5) * (1 - xo) * (l.cmd ? 1 : clamp((t - l.at) * 8)); g.fillStyle = col; g.fillText(txt, xx, y);
        const cur = vis[vis.length - 1] === l && (t < l.done || Math.sin(t * 9) > 0);
        if (cur) { g.fillStyle = th.accent === '#F2F2F2' ? '#FFFFFF' : th.accent; g.fillRect(xx + g.measureText(txt).width + 4 * u, y - px * 0.8, px * 0.55, px * 1.0); }
      });
      g.restore();
    },
    cues: (s) => termPlan(s).lines.flatMap((l) => (l.cmd ? Array.from({ length: Math.max(2, Math.floor((l.done - l.at) / 0.06)) }, (_, i) => ({ t: l.at + i * 0.06, sfx: 'type', g: 0.45 })) : [{ t: l.at, sfx: /✓|✔|done/i.test(l.line) ? 'ding' : 'tick', g: /✓|✔|done/i.test(l.line) ? 0.35 : 0.4 }])),
  },

  bars: {
    about: 'Bar chart race: items: [{label, value, hi?}] (2–5), unit?, prefix?, title?. Bars grow and count; the highlight (or the largest) is in accent.',
    len: () => 3.6,
    draw(c) {
      const { g, s, th, W, H, u, t, M } = c, CW = W - 2 * M, it = (Array.isArray(s.items) ? s.items : []).map((x) => (typeof x === 'object' ? x : { label: String(x), value: 0 }));
      const max = s.max ?? Math.max(1, ...it.map((x) => Number(x.value) || 0)), hiI = it.some((x) => x.hi) ? it.findIndex((x) => x.hi) : it.findIndex((x) => Number(x.value) === max);
      const y = title_(c, s, H * 0.17, 84, 0.05), rowH = 176 * u, y0 = Math.max(y + 20 * u, H * 0.56 - (it.length * rowH) / 2);
      it.forEach((x, i) => {
        const t0 = 0.4 + i * 0.26, e = enter(c, t0 - 0.15, 0.5, i), gk = E.out(P(t, t0, 1.05)); if (e.a <= 0) return;
        const ry = y0 + i * rowH, v = (Number(x.value) || 0) * gk, hi = i === hiI, dec = String(x.value).split('.')[1]?.length || 0;
        g.save(); g.globalAlpha = e.a; g.translate(0, e.dy);
        setFont(g, 40 * u, 650, 'sans', -0.01); g.fillStyle = hi ? th.fg : hexA(th.fg, 0.72); g.fillText(plain(x.label), M, ry + 40 * u);
        const val = `${s.prefix || ''}${fmtNum(v, dec, v >= 10000)}${s.unit || ''}`; setFont(g, 44 * u, 800, 'sans', -0.02); g.textAlign = 'right'; g.fillStyle = hi ? th.accent : th.fg; g.fillText(val, M + CW, ry + 42 * u); g.textAlign = 'left';
        g.fillStyle = hexA(th.fg, 0.07); rr(g, M, ry + 66 * u, CW, 60 * u, 30 * u); g.fill();
        const bw = Math.max(60 * u, CW * ((Number(x.value) || 0) / max) * gk);
        if (hi) { const gr = g.createLinearGradient(M, 0, M + bw, 0); gr.addColorStop(0, th.accent2); gr.addColorStop(1, th.accent); g.save(); g.shadowColor = hexA(th.accent, 0.6); g.shadowBlur = 30 * u; g.fillStyle = gr; rr(g, M, ry + 66 * u, bw, 60 * u, 30 * u); g.fill(); g.restore(); }
        else { g.fillStyle = hexA(th.fg, 0.28); rr(g, M, ry + 66 * u, bw, 60 * u, 30 * u); g.fill(); }
        g.restore();
      });
    },
    cues: (s) => [{ t: 0.05, sfx: 'whoosh', g: 0.7 }, ...(Array.isArray(s.items) ? s.items : []).map((_, i) => ({ t: 0.4 + i * 0.26, sfx: 'swipe', g: 0.5 })), { t: 1.45 + ((s.items?.length || 1) - 1) * 0.26, sfx: 'ding', g: 0.6 }],
  },

  grid: {
    about: 'Feature grid: items: ["…"] or [{text, icon}] (2, 4 or 6), title?. Tiles pop in with icons drawing on.',
    len: (s) => 1.2 + items(s).length * 0.16 + 1.4,
    draw(c) {
      const { g, s, th, W, H, u, t, M } = c, CW = W - 2 * M, it = items(s), cols = 2, rows = Math.ceil(it.length / cols), gap = 30 * u, tw = (CW - gap) / cols, thh = 300 * u;
      const y = title_(c, s, H * 0.15, 84, 0.05), y0 = Math.max(y + 10 * u, H * 0.55 - (rows * thh + (rows - 1) * gap) / 2);
      it.forEach((item, i) => {
        const t0 = 0.45 + i * 0.16, k = spring(t - t0, 13, 0.55), xo = ex(c, i); if (k <= 0.001) return;
        const x = M + (i % cols) * (tw + gap), yy = y0 + Math.floor(i / cols) * (thh + gap);
        g.save(); g.globalAlpha = clamp(k * 1.6) * (1 - xo); g.translate(x + tw / 2, yy + thh / 2 - xo * 50 * u); g.scale(0.8 + 0.2 * k, 0.8 + 0.2 * k); g.translate(-(x + tw / 2), -(yy + thh / 2));
        card(c, x, yy, tw, thh, 38 * u);
        g.fillStyle = hexA(th.accent, 0.14); rr(g, x + 34 * u, yy + 34 * u, 96 * u, 96 * u, 28 * u); g.fill();
        icon(c, item.icon, x + 82 * u, yy + 82 * u, 52 * u, th.accent, E.out3(P(t, t0 + 0.1, 0.55)), 2.3);
        const tf = fit(g, item.text, tw - 68 * u, 46 * u, 2, 750, 'sans', -0.02, 26 * u), LH = tf.px * 1.18;
        tf.lines.forEach((l, li) => { for (const tk of l.toks) { g.fillStyle = tk.hi ? th.accent : th.fg; g.fillText(tk.w, x + 34 * u + tk.x, yy + thh - 40 * u - (tf.lines.length - 1 - li) * LH); } });
        g.restore();
      });
    },
    cues: (s) => [s.title && { t: 0.05, sfx: 'whoosh', g: 0.7 }, ...items(s).map((_, i) => ({ t: 0.45 + i * 0.16, sfx: 'pop', g: 0.7 }))].filter(Boolean),
  },

  cta: {
    about: 'End beat: text (use *WORD* for the keyword pill, e.g. "Comment *FRAME*"), sub?, icon? (default play). Logo mark draws, keyword pops, arrows point down.',
    len: () => 3,
    draw(c) {
      const { g, s, th, W, H, u, t, M } = c, cx = W / 2, cy = H * 0.33, S = 250 * u, L = 70 * u;
      const ck = (i) => E.out3(P(t, 0.08 + i * 0.07, 0.45)), push = 1 + 0.08 * Math.sin(Math.PI * P(t, 0.55, 0.3));
      g.save(); g.globalAlpha = 1 - ex(c); g.strokeStyle = th.fg; g.lineWidth = 9 * u; g.lineCap = 'round'; g.lineJoin = 'round';
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([dx, dy], i) => {
        const k = ck(i), x = cx + dx * (S / 2) * push, y = cy + dy * (S / 2) * push; if (k <= 0) return;
        g.beginPath(); g.moveTo(x, y - dy * L * k); g.lineTo(x, y); g.lineTo(x - dx * L * k, y); g.stroke();
      });
      const pk = spring(t - 0.42, 13, 0.5), ic = s.icon || 'play';
      if (pk > 0) {
        g.save(); g.translate(cx, cy); g.scale(pk, pk);
        if (ic === 'play') { g.fillStyle = th.accent; g.beginPath(); g.moveTo(-34 * u, -46 * u); g.lineTo(52 * u, 0); g.lineTo(-34 * u, 46 * u); g.closePath(); g.lineJoin = 'round'; g.strokeStyle = th.accent; g.lineWidth = 14 * u; g.stroke(); g.fill(); }
        else icon(c, ic, 0, 0, 120 * u, th.accent, 1, 2.4);
        g.restore();
      }
      g.restore();
      const f = fit(g, s.text || 'Follow for *more*', W - 2 * M, 112 * u, 3, 850, 'sans', -0.035), LH = f.px * 1.12;
      const ty = H * 0.53;
      maskedLines(c, f.lines, { x: W / 2, y: ty, px: f.px, lh: 1.12, align: 'center', t0: 0.5, stagger: 0.08, w: 850, track: -0.035, hiStyle: 'pill' });
      let yy = ty + f.lines.length * LH + 40 * u;
      if (s.sub) { const sf = fit(g, s.sub, W - 2 * M, 46 * u, 2, 500, 'sans', -0.01); maskedLines(c, sf.lines, { x: W / 2, y: yy, px: sf.px, lh: 1.3, align: 'center', t0: 0.85, color: th.muted, w: 500, track: -0.01, hiStyle: 'color' }); yy += sf.lines.length * sf.px * 1.3; }
      const ak = P(t, 1.1, 0.4);
      if (ak > 0) for (let i = 0; i < 3; i++) {
        const ph = (t * 1.6 - i * 0.22) % 1, a = (0.25 + 0.75 * Math.max(0, Math.sin(ph * Math.PI))) * ak * (1 - ex(c));
        g.save(); g.strokeStyle = hexA(th.accent, a); g.lineWidth = 8 * u; g.lineCap = 'round'; g.lineJoin = 'round';
        const ay = Math.max(yy + 90 * u, H * 0.8) + i * 34 * u; g.beginPath(); g.moveTo(cx - 34 * u, ay - 17 * u); g.lineTo(cx, ay + 17 * u); g.lineTo(cx + 34 * u, ay - 17 * u); g.stroke(); g.restore();
      }
    },
    cues: () => [{ t: 0.05, sfx: 'whoosh' }, { t: 0.42, sfx: 'pop' }, { t: 0.95, sfx: 'ding', g: 0.7 }],
  },
};

/** Decorative orbit ring with an icon, used behind titles. */
function orbit(c, x, y, r, t0, ic) {
  const { g, th, u, t, T } = c, k = spring(t - t0, 9, 0.62), xo = ex(c, 0);
  if (k <= 0.001) return;
  g.save(); g.globalAlpha = clamp(k * 1.5) * (1 - xo); g.translate(x, y - xo * 40 * u); g.scale(k * (1 - 0.2 * xo), k * (1 - 0.2 * xo));
  disc(g, 0, 0, r * 0.64, hexA(th.accent, 0.13));
  g.save(); g.rotate(T * 0.5); g.setLineDash([9 * u, 13 * u]); g.lineWidth = 3 * u; g.strokeStyle = hexA(th.fg, 0.28); g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke(); g.restore();
  g.save(); g.rotate(-T * 0.9); g.lineWidth = 7 * u; g.lineCap = 'round'; g.strokeStyle = th.accent; g.beginPath(); g.arc(0, 0, r, 0, 1.1); g.stroke(); g.restore();
  const a = T * 1.4; disc(g, Math.cos(a) * r * 1.28, Math.sin(a) * r * 1.28, 9 * u, th.accent2);
  icon(c, ic || 'spark', 0, 0, r * 0.72, th.accent, E.out3(P(t, t0 + 0.15, 0.6)), 1.9);
  g.restore();
}

// ───────────────────────── public API
export const SCENE_TEMPLATES = Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, v.about]));
const def = (s) => TEMPLATES[s?.template] || TEMPLATES.title;
/** Natural length of a scene in seconds. */
export const sceneLen = (s) => Math.round(def(s).len(s || {}) * 100) / 100;
/** Sound hits for a scene, in scene seconds: [{t, sfx, g?}]. */
export const sceneCues = (s, D = s.len || sceneLen(s)) => def(s).cues(s, D).filter((q) => q && q.t >= 0 && q.t < D);
/** Short description for the timeline and the clip list. */
export const sceneLabel = (s) => `${s.template}: ${plain(s.text || s.title || s.value || (s.items && (s.items[0]?.text || s.items[0]?.label || s.items[0])) || (s.messages && (s.messages[0]?.text || s.messages[0])) || (s.lines && s.lines[0]) || (s.nodes && (s.nodes[0]?.text || s.nodes[0])) || '').slice(0, 40)}`;

/**
 * Draw one frame of a scene clip on a W×H frame.
 * @param lt scene seconds (0 = the scene's own start), T timeline seconds (keeps the backdrop continuous across cuts)
 */
export function drawScene(g, clip, lt, W, H, T = lt) {
  const s = clip.scene || clip, d = def(s), D = s.len || sceneLen(s);
  const c = { g, s, th: theme(s), W, H, u: Math.min(W / 1080, H / 1920), t: lt, D, T, M: Math.round(92 * Math.min(W / 1080, H / 1920)) };
  c.X = s.out === 'wipe' || s.out === 'hold' ? 0 : P(lt, D - 0.42, 0.42);
  const bg = s.bg !== 'none';
  g.save();
  if (bg) backdrop(c);
  const z = 1 + 0.03 * E.inOut(clamp(lt / D));
  g.translate(W / 2, H / 2); g.scale(z, z); g.translate(-W / 2, -H / 2);
  g.save(); d.draw(c); g.restore();
  g.restore();
  g.save(); wipe(c); if (bg) { hud(c); finish(c); } g.restore();
}
