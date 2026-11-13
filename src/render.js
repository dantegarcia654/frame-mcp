// Turns the timeline into one ffmpeg command. The same graph renders the final MP4 and the still frames Claude looks at.
import { spawn } from 'node:child_process';
import { round } from './util.js';
import { dur, end, projectDuration } from './project.js';
import { textKey } from '../ui/text-draw.js';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const f = (n) => String(round(n, 4));
const hex = (c) => '0x' + String(c || '#00ff00').replace('#', '').padEnd(6, '0').slice(0, 6);

function fadeFactor(c, t) {
  const lt = t - c.start, d = dur(c); let k = 1;
  if (c.fadeIn && lt < c.fadeIn) k *= Math.max(0, lt / c.fadeIn);
  if (c.fadeOut && lt > d - c.fadeOut) k *= Math.max(0, (d - lt) / c.fadeOut);
  return k;
}

/** CSS-equivalent grade so the browser preview and the render match: brightness(k) contrast(c) saturate(s). */
function gradeFilters(g) {
  const out = [];
  const b = g.brightness ?? 1, c = g.contrast ?? 1, s = g.saturation ?? 1;
  if (b !== 1 || c !== 1) { const e = `clip((val*${f(b)}-127.5)*${f(c)}+127.5\\,0\\,255)`; out.push(`lutrgb=r='${e}':g='${e}':b='${e}'`); }
  if (s !== 1) {
    const R = 0.213, G = 0.715, B = 0.072;
    out.push(`colorchannelmixer=rr=${f(R + (1 - R) * s)}:rg=${f(G - G * s)}:rb=${f(B - B * s)}:gr=${f(R - R * s)}:gg=${f(G + (1 - G) * s)}:gb=${f(B - B * s)}:br=${f(R - R * s)}:bg=${f(G - G * s)}:bb=${f(B + (1 - B) * s)}`);
  }
  return out;
}

/**
 * @param p project
 * @param o.window [t0,t1] timeline seconds (default whole project)
 * @param o.still  render one frame at window[0]
 * @param o.rasters { clipId: {file,x,y,hash} } drawn captions (ui/text-draw.js, by the window or headless Chrome); stale ones are skipped
 * @param o.assetPath (asset) => absolute path
 */
export function buildGraph(p, o) {
  const total = projectDuration(p);
  const [t0, t1] = o.still ? [o.window[0], o.window[0] + 1 / p.fps] : (o.window || [0, total]);
  const D = t1 - t0, W = p.width, H = p.height, FPS = p.fps;
  const inputs = [], filters = [], warnings = [], audio = [];
  const order = (t) => (t[0] === 'T' ? 1000 : 0) + Number(t.slice(1));
  const visual = p.clips.filter((c) => c.kind !== 'audio' && end(c) > t0 + 0.0005 && c.start < t1 - 0.0005)
    .sort((a, b) => order(a.track) - order(b.track) || a.start - b.start);
  filters.push(`color=c=black:s=${W}x${H}:r=${FPS}:d=${f(D)}[base]`);
  let last = 'base', n = 0;
  const addInput = (args) => (inputs.push(args), inputs.length - 1);

  for (const c of visual) {
    const cs = Math.max(c.start, t0), ce = Math.min(end(c), t1), ls = cs - t0, le = ce - t0;
    const srcIn = c.in + (cs - c.start) * c.speed, srcDur = (ce - cs) * c.speed;
    let idx, chain = [], X, Y;
    let opacity = c.opacity ?? 1;
    if (o.still) opacity *= fadeFactor(c, t0);
    if (c.kind === 'text') {
      const r = o.rasters?.[c.id];
      if (!r) { warnings.push(`Text "${c.text.content.slice(0, 24)}" (${c.id}) has not been drawn, so it is not in this output.`); continue; }
      // Never composite a caption drawn from older text or style: that is how a restyle "succeeds" and the old look ships.
      if (r.hash !== textKey(c, W, H)) { warnings.push(`Text "${c.text.content.slice(0, 24)}" (${c.id}) changed since it was drawn, so it is not in this output.`); continue; }
      idx = addInput(['-loop', '1', '-framerate', String(FPS), '-t', f(Math.max(le - ls, 1 / FPS)), '-i', r.file]);
      chain.push('format=rgba'); X = r.x; Y = r.y;
    } else {
      const a = p.assets[c.asset]; const file = o.assetPath(a);
      const s = (c.fit === 'contain' ? Math.min(W / a.width, H / a.height) : Math.max(W / a.width, H / a.height)) * (c.scale || 1);
      const sw = even(a.width * s), sh = even(a.height * s);
      X = Math.round((W - sw) / 2 + (c.x || 0) * W); Y = Math.round((H - sh) / 2 + (c.y || 0) * H);
      if (c.kind === 'image') idx = addInput(['-loop', '1', '-framerate', String(FPS), '-t', f(Math.max(le - ls, 1 / FPS)), '-i', file]);
      else {
        idx = addInput(['-ss', f(srcIn), '-t', f(Math.max(srcDur, 1 / FPS)), '-i', file]);
        chain.push(`setpts=(PTS-STARTPTS)/${f(c.speed)}`, `fps=${FPS}`);
        if (a.hasAudio && !c.muted && (c.volume ?? 1) > 0 && !o.still) audio.push({ c, idx, ls, le });
      }
      chain.push(`scale=${sw}:${sh}`, 'setsar=1');
      const g = c.grade ? gradeFilters(c.grade) : [];
      if (g.length) chain.push('format=rgba', ...g);
      if (c.key) chain.push(`chromakey=${hex(c.key.color)}:${f(c.key.similarity)}:${f(c.key.blend)}`);
    }
    const fades = !o.still && (c.fadeIn || c.fadeOut);
    if (opacity < 1 || fades) chain.push('format=rgba');
    if (opacity < 1) chain.push(`colorchannelmixer=aa=${f(Math.max(0, opacity))}`);
    if (fades) {
      const local = c.start - cs; // negative when the window starts inside the clip
      if (c.fadeIn && local >= -0.0005) chain.push(`fade=t=in:st=0:d=${f(c.fadeIn / 1)}:alpha=1`);
      if (c.fadeOut && end(c) <= t1 + 0.0005) chain.push(`fade=t=out:st=${f(Math.max(0, (le - ls) - c.fadeOut))}:d=${f(c.fadeOut)}:alpha=1`);
    }
    chain.push(`setpts=PTS+${f(ls)}/TB`);
    filters.push(`[${idx}:v]${chain.join(',')}[c${n}]`);
    filters.push(`[${last}][c${n}]overlay=x=${X}:y=${Y}:enable='gte(t,${f(ls)})*lt(t,${f(le)})':eof_action=pass[v${n}]`);
    last = `v${n}`; n++;
  }

  if (!o.still) {
    for (const c of p.clips.filter((c) => c.kind === 'audio' && end(c) > t0 && c.start < t1 && !c.muted && (c.volume ?? 1) > 0)) {
      const cs = Math.max(c.start, t0), ce = Math.min(end(c), t1);
      const idx = addInput(['-ss', f(c.in + (cs - c.start) * c.speed), '-t', f((ce - cs) * c.speed), '-i', o.assetPath(p.assets[c.asset])]);
      audio.push({ c, idx, ls: cs - t0, le: ce - t0 });
    }
  }
  const outs = [];
  audio.forEach(({ c, idx, ls, le }, i) => {
    const ch = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
    if (c.speed !== 1) { let s = c.speed; while (s < 0.5) { ch.push('atempo=0.5'); s /= 0.5; } while (s > 2) { ch.push('atempo=2'); s /= 2; } ch.push(`atempo=${f(s)}`); }
    if ((c.volume ?? 1) !== 1) ch.push(`volume=${f(c.volume)}`);
    if (c.fadeIn) ch.push(`afade=t=in:st=0:d=${f(c.fadeIn)}`);
    if (c.fadeOut) ch.push(`afade=t=out:st=${f(Math.max(0, (le - ls) - c.fadeOut))}:d=${f(c.fadeOut)}`);
    ch.push(`adelay=${Math.round(ls * 1000)}:all=1`);
    filters.push(`[${idx}:a]${ch.join(',')}[a${i}]`); outs.push(`[a${i}]`);
  });
  let aLabel = null;
  if (!o.still) {
    const tail = `apad,atrim=0:${f(D)}${o.loudnorm ? ',loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.84:level=disabled,aresample=48000' : ''}[aout]`;
    if (!outs.length) filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${f(D)}[aout]`);
    else if (outs.length === 1) filters.push(`${outs[0]}${tail}`);
    else filters.push(`${outs.join('')}amix=inputs=${outs.length}:normalize=0:dropout_transition=0,${tail}`);
    aLabel = 'aout';
  }
  let vOut = last;
  if (o.scale && o.scale !== 1) { filters.push(`[${last}]scale=${even(W * o.scale)}:${even(H * o.scale)}[vout]`); vOut = 'vout'; }
  return { inputs, filters, vOut, aLabel, duration: D, warnings };
}

export function ffmpegArgs(g, outFile, { still = false, quality = 'final' } = {}) {
  const args = ['-hide_banner', '-y', '-nostats'];
  for (const i of g.inputs) args.push(...i);
  args.push('-filter_complex', g.filters.join(';'), '-map', `[${g.vOut}]`);
  if (still) args.push('-frames:v', '1', '-q:v', '4', outFile);
  else {
    args.push('-map', `[${g.aLabel}]`, '-c:v', 'libx264', '-preset', quality === 'draft' ? 'veryfast' : 'medium', '-crf', quality === 'draft' ? '26' : '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', f(g.duration), '-movflags', '+faststart', '-progress', 'pipe:1', outFile);
  }
  return args;
}

export function runFfmpeg(args, duration, onProgress, attempt = 1) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', stalled = false, last = Date.now();
    // ffmpeg very occasionally deadlocks on start; if it reports nothing for 45 s, kill it and try once more.
    const dog = setInterval(() => { if (Date.now() - last > 45000) { stalled = true; p.kill('SIGKILL'); } }, 2000);
    p.stdout.on('data', (d) => { last = Date.now(); const m = [...d.toString().matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop(); if (m && onProgress && duration) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration)); });
    p.stderr.on('data', (d) => { err = (err + d).slice(-6000); });
    p.on('error', (e) => { clearInterval(dog); reject(new Error('ffmpeg could not start: ' + e.message)); });
    p.on('close', (code) => {
      clearInterval(dog);
      if (stalled && attempt < 2) return runFfmpeg(args, duration, onProgress, attempt + 1).then(resolve, reject);
      if (stalled) return reject(new Error('ffmpeg stalled twice without making progress.'));
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.slice(-1800)}`));
    });
  });
}
