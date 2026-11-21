import { MOVE_CURVES } from './clip-move.js';
import { BRAND_ASSETS } from './official-brand-assets.js';
// Declarative graphics: data only, shared by the editor and export. No eval, network or wall clock.
// Every node is one named object a person can click. Motion is data too: `anim` keyframes (clip-local seconds)
// move, scale, rotate, fade and drive a 0–1 progress `p` (typing, wipes, tile reveals, counters, slider values).
const KINDS = new Set(['rect', 'line', 'text', 'invader', 'slider', 'brand', 'pixtext', 'sprite']);
const COLORS = /^#[0-9a-f]{6}$/i;
const finite = (v, name, lo, hi) => { if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name} must be finite, ${lo}–${hi}`); };
const allowed = new Set(['id','kind','x','y','w','h','at','until','fade','fadeOut','color','fill','fill2','stroke','lineWidth','dash','radius','text','size','font','weight','align','shadow','reveal','cues','highlightAt','accent','edge','eye','speed','phase','value','asset','motion','anim','hz','spin','from','to','pad','rows','pal','tall','flip']);
export const EASES = {
  ...MOVE_CURVES,
  back: x => { const c = 1.7; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; },
  step: x => x >= 1 ? 1 : 0,
};
const ANIM_KEYS = { x: [-3, 3], y: [-3, 3], s: [0, 20], a: [0, 1], r: [-100, 100], p: [0, 1] };
const REVEALS = ['none', 'type', 'words', 'wipe', 'wipeup', 'wipedown', 'tiles'];

// ── pixel art (original sprites from the reel's kit: Clawd's cousins, Clawd, the spark) ─────────────────────────
export const PIXEL_FONT = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31], 3: [31, 2, 4, 2, 1, 17, 14],
  4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14], 6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8],
  8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 2, 12],
  ' ': [0, 0, 0, 0, 0, 0, 0], ':': [0, 12, 12, 0, 12, 12, 0], '!': [4, 4, 4, 4, 4, 0, 4], '?': [14, 17, 1, 2, 4, 0, 4],
  '.': [0, 0, 0, 0, 0, 12, 12], '-': [0, 0, 0, 31, 0, 0, 0], '>': [8, 4, 2, 1, 2, 4, 8], '/': [1, 1, 2, 4, 8, 16, 16],
  ',': [0, 0, 0, 0, 12, 4, 8], "'": [4, 4, 0, 0, 0, 0, 0], '+': [0, 4, 4, 31, 4, 4, 0], '%': [24, 25, 2, 4, 8, 19, 3],
  '<': [2, 4, 8, 16, 8, 4, 2], '=': [0, 0, 31, 0, 31, 0, 0], '#': [10, 10, 31, 10, 31, 10, 10], '*': [0, 21, 14, 31, 14, 21, 0],
};
const CLAWD = ['...XXXXXXXXXXXX...', '...XXEXXXXXXEXX...', '.XXXXXXXXXXXXXXXX.', '...XXXXXXXXXXXX...', '....X.X....X.X....'];
export const SPRITES = {
  squid: { tall: true, frames: [['..X........X..', '...XXXXXXXX...', '...XX.XX.XX...', '.XXXXXXXXXXXX.', '...XXXXXXXX...', '...X.X..X.X...'], ['..X........X..', '...XXXXXXXX...', '...XX.XX.XX...', 'XXXXXXXXXXXXXX', '...XXXXXXXX...', '..X.X....X.X..']] },
  block: { tall: true, frames: [['...XXXXXXXX...', '...XX....XX...', '.XXXXXXXXXXXX.', '...XXXXXXXX...', '....X.XX.X....'], ['...XXXXXXXX...', '...XX....XX...', 'XXXXXXXXXXXXXX', '...XXXXXXXX...', '...X..XX..X...']] },
  saucer: { tall: true, frames: [['.....XXXX.....', '...XXX..XXX...', '.XXXXXXXXXXXX.', '...XXXXXXXX...', '..X..X..X..X..'], ['.....XXXX.....', '...XXX..XXX...', 'XXXXXXXXXXXXXX', '...XXXXXXXX...', '...X..XX..X...']] },
  spark: { tall: false, frames: [['......X......', '..X...X...X..', '...X..X..X...', '....X.X.X....', '.....XXX.....', 'XXXXXXXXXXXXX', '.....XXX.....', '....X.X.X....', '...X..X..X...', '..X...X...X..', '......X......']] },
  clawd: { tall: true, frames: [CLAWD] },
  'clawd-blink': { tall: true, frames: [['...XXXXXXXXXXXX...', '...XXXXXXXXXXXX...', '.XXXXXXXXXXXXXXXX.', '...XXXXXXXXXXXX...', '....X.X....X.X....']] },
  'clawd-walk': { tall: true, frames: [CLAWD, ['...XXXXXXXXXXXX...', '...XXEXXXXXXEXX...', '.XXXXXXXXXXXXXXXX.', '...XXXXXXXXXXXX...', '...X.X......X.X...']] },
};

export function validateNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length > 400) throw new Error('Graphic nodes must be a list of at most 400 objects');
  const ids = new Set();
  for (const n of nodes) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw new Error('Each graphic node must be an object');
    for (const k of Object.keys(n)) if (!allowed.has(k)) throw new Error(`Unknown graphic property ${k}`);
    if (!/^[\w-]{1,64}$/.test(n.id || '') || ids.has(n.id)) throw new Error('Graphic nodes need unique stable ids');
    ids.add(n.id);
    if (n.kind === 'brand' && !Object.hasOwn(BRAND_ASSETS,n.asset || '')) throw new Error('Unknown official brand asset');
    if (n.kind === 'sprite' && !n.rows && !Object.hasOwn(SPRITES, n.asset || '')) throw new Error(`Unknown sprite ${n.asset}`);
    if (n.motion != null && !['none','float'].includes(n.motion)) throw new Error('Unknown graphic motion');
    if (!KINDS.has(n.kind)) throw new Error(`Unknown graphic kind ${n.kind}`);
    for (const k of ['x','y']) finite(n[k], k, -2, 3);
    for (const k of ['w','h','radius','lineWidth','size','shadow','dash']) if (n[k] != null) finite(n[k], k, 0, 4);
    for (const k of ['at','until','highlightAt']) if (n[k] != null) finite(n[k], k, 0, 86400);
    if ((n.until ?? 86400) <= (n.at ?? 0)) throw new Error('Graphic node interval must be positive');
    for (const k of ['fade','fadeOut','speed','phase','value','hz']) if (n[k] != null) finite(n[k], k, 0, 100);
    if (n.spin != null) finite(n.spin, 'spin', -100, 100);
    for (const k of ['from','to']) if (n[k] != null) finite(n[k], k, -1e9, 1e9);
    if (n.pad != null) finite(n.pad, 'pad', 0, 12);
    for (const k of ['color','fill','fill2','stroke','accent','edge','eye']) if (n[k] != null && !COLORS.test(n[k])) throw new Error(`Invalid ${k}`);
    if (n.text != null && (typeof n.text !== 'string' || n.text.length > 2000)) throw new Error('Graphic text must be at most 2000 characters');
    if (n.font != null && !['sans','serif','mono'].includes(n.font)) throw new Error('Invalid graphic font');
    if (n.align != null && !['left','center','right'].includes(n.align)) throw new Error('Invalid graphic alignment');
    if (n.weight != null && ![400,500,600,700,800,'italic','italic bold'].includes(n.weight)) throw new Error('Invalid graphic weight');
    if (n.reveal != null && !REVEALS.includes(n.reveal)) throw new Error('Invalid reveal mode');
    if (n.cues != null && (!Array.isArray(n.cues) || n.cues.length > 100 || n.cues.some((x,i,a) => !Number.isFinite(x) || x < 0 || x > 86400 || (i && x < a[i-1])))) throw new Error('Cues must be ordered finite times');
    if (n.anim != null) {
      if (!Array.isArray(n.anim) || n.anim.length > 64) throw new Error('anim must be a list of at most 64 keyframes');
      n.anim.forEach((f, i) => {
        if (!f || typeof f !== 'object') throw new Error('Each keyframe must be an object');
        for (const k of Object.keys(f)) if (k !== 't' && k !== 'e' && !ANIM_KEYS[k]) throw new Error(`Unknown keyframe property ${k}`);
        finite(f.t, 'keyframe t', 0, 86400); if (i && f.t < n.anim[i - 1].t) throw new Error('Keyframes must be in time order');
        for (const [k, [lo, hi]] of Object.entries(ANIM_KEYS)) if (f[k] != null) finite(f[k], `keyframe ${k}`, lo, hi);
        if (f.e != null && !Object.hasOwn(EASES, f.e)) throw new Error(`Unknown ease ${f.e}`);
      });
    }
    if (n.rows != null && (!Array.isArray(n.rows) || !n.rows.length || n.rows.length > 64 || n.rows.some((r) => typeof r !== 'string' || r.length > 64 || !/^[.\w#]*$/.test(r)))) throw new Error('Sprite rows must be up to 64 strings of up to 64 pixel characters');
    if (n.pal != null && (typeof n.pal !== 'object' || Object.keys(n.pal).length > 16 || Object.entries(n.pal).some(([k, v]) => k.length !== 1 || !COLORS.test(v)))) throw new Error('Sprite palette maps single characters to colours');
  }
  return nodes;
}
const clamp = x => Math.min(1, Math.max(0,x));
const fonts = {sans:'Arial, sans-serif',serif:'Georgia, serif',mono:'Menlo, monospace'};
function invader(g,x,y,w,h,color,phase) {
  const rows=['00100000100','00010001000','00111111100','01101110110','11111111111','10111111101','10100000101',phase%2?'00100100100':'00011011000'];
  g.fillStyle=color;
  rows.forEach((r,j)=>[...r].forEach((v,i)=>{if(v==='1')g.fillRect(x+i*w/11,y+j*h/8,Math.ceil(w/11),Math.ceil(h/8));}));
}
// The motion state of a node at clip-local time t: offsets (frame fractions), scale, alpha, rotation (radians), progress.
export function animAt(n, t) {
  const out = { x: 0, y: 0, s: 1, a: 1, r: 0, p: null };
  const A = n.anim; if (!A?.length) return out;
  if (n.hz) t = Math.floor(t * n.hz + 1e-6) / n.hz;
  for (const k of Object.keys(ANIM_KEYS)) {
    let prev = null, next = null;
    for (const f of A) { if (f[k] == null) continue; if (f.t <= t) prev = f; else { next = f; break; } }
    if (!prev && !next) continue;
    if (!prev) { out[k] = next[k]; continue; } if (!next) { out[k] = prev[k]; continue; }
    const u = clamp((t - prev.t) / Math.max(1e-6, next.t - prev.t));
    out[k] = prev[k] + (next[k] - prev[k]) * EASES[next.e || 'lin'](u);
  }
  return out;
}
const spriteDef = (n) => n.rows ? { tall: !!n.tall, frames: [n.rows] } : SPRITES[n.asset];
const textOf = (n, p) => {
  let s = n.text || '';
  if (s.includes('{v}')) { const v = Math.round((n.from ?? 0) + ((n.to ?? 100) - (n.from ?? 0)) * (p ?? 1)); s = s.replaceAll('{v}', String(v).padStart(n.pad || 0, '0')); }
  return s;
};
// The node's box at rest (before anim), in canvas pixels. Used for hit-testing, pivots and wipes.
export function nodeBox(g, n, W, H) {
  let x = n.x * W, y = n.y * H, w = (n.w ?? 0) * W, h = (n.h ?? 0) * H;
  if (n.kind === 'text') {
    g.save(); g.font = `${n.weight || 400} ${(n.size ?? .03) * H}px ${fonts[n.font || 'sans']}`;
    const lines = textOf(n, 1).split('\n'); w = Math.max(...lines.map((s) => g.measureText(s).width), 8); h = lines.length * (n.size ?? .03) * H * 1.15; g.restore();
    if (n.align === 'center') x -= w / 2; if (n.align === 'right') x -= w;
  } else if (n.kind === 'pixtext') {
    const px = (n.size ?? .005) * H, lines = textOf(n, 1).split('\n');
    w = Math.max(...lines.map((s) => s.length * 6 * px - px), px); h = lines.length * 10 * px - 3 * px;
    if (n.align === 'center') x -= w / 2; if (n.align === 'right') x -= w;
  } else if (n.kind === 'sprite') {
    const d = spriteDef(n), fr = d.frames[0], px = (n.size ?? .006) * H;
    w = fr[0].length * px; h = fr.length * px * (d.tall ? 2 : 1);
  } else if (n.kind === 'line') h = Math.max(h, (n.lineWidth ?? .002) * H, 6);
  else if (n.kind === 'slider') { const r = (n.size ?? .007) * H; y -= r; h = r * 2; }
  return { x, y, w, h };
}
function pixRun(g, s, x, y, px, n) {
  for (let i = 0; i < n; i++) {
    const rows = PIXEL_FONT[s[i]] || PIXEL_FONT[' '];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (rows[r] & (16 >> c)) g.fillRect(Math.round(x + i * 6 * px + c * px), Math.round(y + r * px), Math.ceil(px), Math.ceil(px));
  }
}
function revealClip(g, mode, p, b, H, edge) {
  if (mode === 'wipe') { g.beginPath(); g.rect(b.x - 2, b.y - H, (b.w + 4) * p, b.h + 2 * H); g.clip(); return null; }
  if (mode === 'wipeup') { g.beginPath(); g.rect(b.x - H, b.y + b.h * (1 - p) - 2, b.w + 2 * H, b.h * p + 4); g.clip(); return null; }
  if (mode === 'wipedown') { g.beginPath(); g.rect(b.x - H, b.y - 2, b.w + 2 * H, b.h * p + 4); g.clip(); return null; }
  if (mode === 'tiles') { // the reel's "generate" language: 40 px tiles sweeping left to right, leading edge flashing
    const s = 40 * H / 1920, cols = Math.ceil(b.w / s), rows = Math.ceil(b.h / s), lead = [];
    g.beginPath();
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) { const q = (cx + cy * .6) / (cols + rows * .6); if (q < p) { g.rect(b.x + cx * s, b.y + cy * s, s, s); if (edge && p < 1 && q > p - .05) lead.push([b.x + cx * s, b.y + cy * s, s]); } }
    g.clip(); return lead;
  }
  return null;
}
const brandPaths = new Map();
export function drawNodes(g, f, nodes) {
  const {W,H,t}=f;
  for (const n of nodes) {
    const at=n.at??0,until=n.until??Infinity;
    if(t<at || t>=until)continue;
    const m = animAt(n, t);
    let alpha = (n.fade ? clamp((t-at)/n.fade) : 1) * (n.fadeOut && until !== Infinity ? clamp((until - t) / n.fadeOut) : 1) * m.a;
    if (alpha <= 0.001) continue;
    g.save();
    g.globalAlpha *= alpha;
    const box = nodeBox(g, n, W, H);
    const rot = m.r + (n.spin ? n.spin * (t - at) : 0);
    if (m.x || m.y || m.s !== 1 || rot) {
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      g.translate(cx + m.x * W, cy + m.y * H); if (rot) g.rotate(rot); if (m.s !== 1) g.scale(m.s, m.s); g.translate(-cx, -cy);
    }
    const prog = m.p ?? (n.reveal === 'type' ? null : 1);
    const lead = n.reveal && !['none', 'type', 'words'].includes(n.reveal) ? revealClip(g, n.reveal, clamp(prog ?? 1), box, H, n.edge) : null;
    const x=n.x*W,y=n.y*H,w=(n.w??0)*W,h=(n.h??0)*H;
    const active=n.highlightAt!=null&&t>=n.highlightAt;
    const color=active ? n.accent||'#c55d3d' : n.color||'#20201e';
    g.fillStyle=n.fill||color;g.strokeStyle=n.stroke||color;g.lineWidth=(n.lineWidth??.002)*H;
    if(n.dash)g.setLineDash([n.dash*H,n.dash*H]);
    if(n.shadow){g.shadowBlur=n.shadow*H;g.shadowOffsetY=.004*H;g.shadowColor='rgba(0,0,0,.12)';}
    if(n.kind==='brand') {
      const asset=BRAND_ASSETS[n.asset];
      if(!brandPaths.has(n.asset))brandPaths.set(n.asset,asset.paths.map(p=>({path:new Path2D(p.d),color:p.color})));
      const lift=n.motion==='float' ? Math.sin((t-at)*2.8)*H*.005 : 0;
      g.translate(x,y+lift);g.scale(w/asset.width,h/asset.height);
      for(const part of brandPaths.get(n.asset)){g.fillStyle=n.color||part.color;g.fill(part.path);}
    } else if(n.kind==='rect') {
      g.beginPath();g.roundRect(x,y,w,h,(n.radius??0)*H);
      // a rect with no explicit fill and no border is a solid shape in its colour (so highlightAt can recolour it)
      if(n.fill||!n.stroke){
        let fs=active&&n.accent?n.accent:(n.fill||color);
        if(n.fill2&&!active){const gr=g.createLinearGradient(0,y,0,y+h);gr.addColorStop(0,fs);gr.addColorStop(1,n.fill2);fs=gr;}
        g.fillStyle=fs;g.fill();
      }
      if(n.stroke)g.stroke();
    } else if(n.kind==='line') {
      const reveal=n.fade&&!n.anim ? clamp((t-at)/n.fade) : clamp(m.p ?? 1);
      g.beginPath();g.moveTo(x,y);g.lineTo(x+w*reveal,y+h*reveal);g.stroke();
    } else if(n.kind==='text') {
      let text=textOf(n, m.p);
      if(n.reveal==='type')text=m.p!=null?text.slice(0,Math.floor(text.length*clamp(m.p)+1e-6)):text.slice(0,Math.floor((t-at)*(n.speed||28)));
      if(n.reveal==='words'){const k=(n.cues||[]).filter(c=>t>=c).length;text=text.split(/\s+/).slice(0,k).join(' ');}
      g.font=`${n.weight||400} ${(n.size??.03)*H}px ${fonts[n.font||'sans']}`;
      g.textAlign=n.align||'left';g.textBaseline='top';g.fillStyle=color;
      text.split('\n').forEach((line,i)=>g.fillText(line,x,y+i*(n.size??.03)*H*1.15));
    } else if(n.kind==='pixtext') {
      const px=(n.size??.005)*H, full=textOf(n, m.p).toUpperCase();
      let budget=n.reveal==='type'?(m.p!=null?Math.floor(full.replace(/\n/g,'').length*clamp(m.p)+1e-6):Math.floor((t-at)*(n.speed||28))):Infinity;
      if(n.shadow){g.shadowBlur=0;g.shadowOffsetY=0;}
      full.split('\n').forEach((line,i)=>{
        const lw=line.length*6*px-px, x0=n.align==='center'?x-lw/2:n.align==='right'?x-lw:x, k=Math.min(line.length,budget); budget-=k;
        if(n.shadow){g.fillStyle='#141413';g.globalAlpha*=.35;pixRun(g,line,x0+px,y+i*10*px+px,px,k);g.globalAlpha/=.35;}
        g.fillStyle=color;pixRun(g,line,x0,y+i*10*px,px,k);
      });
    } else if(n.kind==='sprite') {
      const d=spriteDef(n), px=(n.size??.006)*H, ph=d.tall?px*2:px;
      const fi=Math.floor((n.speed?(t-at)*n.speed:0)+(n.phase??0))%d.frames.length, fr=d.frames[fi], cols=fr[0].length;
      for(let r=0;r<fr.length;r++)for(let c=0;c<cols;c++){
        const ch=fr[r][n.flip?cols-1-c:c]; if(ch==='.')continue;
        g.fillStyle=ch==='E'?(n.eye||'#faf9f5'):ch==='X'?color:(n.pal?.[ch]||color);
        g.fillRect(Math.round(x+c*px),Math.round(y+r*ph),Math.ceil(px),Math.ceil(ph));
      }
    } else if(n.kind==='invader') invader(g,x,y,w,h,color,Math.floor(t*(n.speed??2)+(n.phase??0)));
    else if(n.kind==='slider') {
      g.strokeStyle=n.stroke||'#d6d1c5';g.beginPath();g.moveTo(x,y);g.lineTo(x+w,y);g.stroke();
      const v=m.p!=null?clamp(m.p):n.speed ? .5+.35*Math.sin((t-at)*n.speed+(n.phase??0)) : clamp(n.value??.5);
      g.fillStyle=color;g.beginPath();g.arc(x+w*v,y,(n.size??.007)*H,0,Math.PI*2);g.fill();
    }
    if(lead?.length){g.fillStyle=n.edge;for(const [lx,ly,s] of lead)g.fillRect(lx,ly,s,s);}
    g.restore();
  }
}
