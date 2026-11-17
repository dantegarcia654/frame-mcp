// The person cutout: for a video asset, a matte video (white = person) and a per-frame face/person track, made on this
// machine. ffmpeg decodes the footage exactly as the renderer sees it (rotation applied), a helper segments each frame,
// and ffmpeg encodes the mattes. Nothing is uploaded anywhere.
//   macOS:     Apple Vision person segmentation (scripts/cutout.swift, compiled on first use; ships with macOS)
//   elsewhere: rembg's u2net_human_seg (scripts/cutout_rembg.py), if installed
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, mkdirp, run, round } from './util.js';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

let engineMemo = null;
/** The engine that can cut out a person here, or null with the reason. */
export async function cutoutEngine() {
  if (engineMemo) return engineMemo;
  if (process.platform === 'darwin') {
    try { await run('xcrun', ['-f', 'swiftc'], { timeout: 20000 }); return (engineMemo = { id: 'vision', label: 'Apple Vision person segmentation (on this Mac)' }); } catch {}
  }
  try { await run('python3', ['-c', 'import rembg, onnxruntime, numpy, PIL'], { timeout: 30000 }); return (engineMemo = { id: 'rembg', label: 'rembg u2net_human_seg (on this machine)' }); } catch {}
  return { id: null, reason: process.platform === 'darwin' ? 'the Swift compiler is missing (install the Xcode command line tools: xcode-select --install), and rembg is not installed (pip install rembg onnxruntime)' : 'rembg is not installed (pip install rembg onnxruntime)' };
}

async function visionBinary() {
  const src = path.join(SCRIPTS, 'cutout.swift');
  const h = crypto.createHash('sha1').update(fs.readFileSync(src)).digest('hex').slice(0, 10);
  const bin = path.join(mkdirp(path.join(HOME, 'bin')), `frame-cutout-${h}`);
  if (!fs.existsSync(bin)) await run('xcrun', ['swiftc', '-O', src, '-o', bin], { timeout: 300000 });
  return bin;
}

/** The exact frame rate of a file as ffprobe reports it ("30000/1001"), so mattes line up with the footage frame for frame. */
async function frameRate(file) {
  try {
    const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate', '-of', 'json', file]);
    const s = JSON.parse(r.stdout).streams?.[0] || {};
    for (const q of [s.avg_frame_rate, s.r_frame_rate]) { const [n, d] = String(q || '').split('/').map(Number); if (n > 0 && d > 0 && n / d >= 5 && n / d <= 120) return { str: `${n}/${d}`, value: n / d }; }
  } catch {}
  return { str: '30', value: 30 };
}

/** One run of decode → helper → encode over `frames` frames starting at source second ss. */
function segment({ file, ss, frames, fps, W, H, helper, track, out, onBytes }) {
  const decArgs = ['-v', 'error', '-ss', String(ss), '-i', file, '-an', '-sn', '-vf', `fps=${fps},scale=${W}:${H}:flags=bicubic`, '-frames:v', String(frames), '-pix_fmt', 'bgra', '-f', 'rawvideo', '-'];
  const helArgs = [...helper[1], track];
  const encArgs = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', fps, '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', '15', out];
  const command = `ffmpeg ${decArgs.join(' ')} | ${path.basename(helper[0])} ${helArgs.join(' ')} | ffmpeg ${encArgs.join(' ')}`;
  const done = new Promise((resolve, reject) => {
    const dec = spawn('ffmpeg', decArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const hel = spawn(helper[0], helArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    const enc = spawn('ffmpeg', encArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    const errs = { dec: '', hel: '', enc: '' }; let closed = 0, failed = false;
    const fail = (e) => { if (failed) return; failed = true; for (const p of [dec, hel, enc]) try { p.kill('SIGKILL'); } catch {} reject(e); };
    for (const [n, p] of [['dec', dec], ['hel', hel], ['enc', enc]]) {
      p.stderr.on('data', (d) => { errs[n] = (errs[n] + d).slice(-1500); });
      p.on('error', (e) => fail(new Error(`${n === 'hel' ? 'the cutout helper' : 'ffmpeg'} could not start: ${e.message}`)));
      p.on('close', (code) => {
        if (failed) return;
        if (code !== 0) return fail(new Error(`${n === 'dec' ? 'decoding the footage' : n === 'hel' ? 'the cutout helper' : 'encoding the matte'} failed (exit ${code}): ${errs[n].trim().slice(-600)}`));
        if (++closed === 3) resolve();
      });
    }
    dec.stdout.pipe(hel.stdin); hel.stdin.on('error', () => {}); enc.stdin.on('error', () => {});
    hel.stdout.on('data', (d) => { onBytes(d.length); if (!enc.stdin.write(d)) { hel.stdout.pause(); enc.stdin.once('drain', () => hel.stdout.resume()); } });
    hel.stdout.on('end', () => enc.stdin.end());
  });
  return { done, command };
}

/**
 * Cut the person out of asset `a` between source seconds from and to.
 * The range is split into chunks that run side by side (each its own decoder, helper and encoder), then joined
 * without re-encoding: on a 30 s 1080×1920 take, 4 chunks took 8.6 s where one took 30 s (M3 Pro, "balanced").
 * Writes the matte to matteOut (H.264, same frame rate as the footage) and the track to trackOut (JSON).
 * onProgress(fraction). Returns everything measured about the result.
 */
export async function makeCutout(a, { from = 0, to = a.duration, quality = 'balanced', chunks, matteOut, trackOut, onProgress } = {}) {
  const eng = await cutoutEngine();
  if (!eng.id) throw new Error(`Frame cannot cut out a person on this machine: ${eng.reason}.`);
  // Balanced mattes are coarser than 1080 px, so they are stored at half size (measured: mean difference 1.3/255 after
  // upscaling, invisible at the hair line) — faster to make and to read. Accurate mattes keep up to 1920 px.
  const k = Math.min(1, (quality === 'accurate' ? 1920 : 960) / Math.max(a.width, a.height)), W = even(a.width * k), H = even(a.height * k);
  const fr = await frameRate(a.path), total = Math.max(1, Math.round((to - from) * fr.value));
  // Vision runs on the Neural Engine and GPU, so a few chunks overlap well; rembg is CPU-bound and gets two at most.
  const n = Math.max(1, Math.min(chunks ?? (eng.id === 'vision' ? 4 : 2), Math.ceil(total / 45)));
  const per = Math.ceil(total / n), tmp = fs.mkdtempSync(path.join(path.dirname(matteOut), 'cut-'));
  const helper = eng.id === 'vision' ? [await visionBinary(), [String(W), String(H), quality]]
    : ['python3', [path.join(SCRIPTS, 'cutout_rembg.py'), String(W), String(H), quality]];
  const t0 = Date.now(); let bytes = 0, lastP = 0;
  const onBytes = (b) => { bytes += b; const p = Math.min(1, bytes / (W * H) / total); if (onProgress && p - lastP > 0.01) { lastP = p; onProgress(p); } };
  const segs = [];
  for (let i = 0; i < n; i++) {
    const first = i * per, count = Math.min(per, total - first); if (count <= 0) break;
    // Start a quarter frame early: the accurate seek then keeps exactly the frame that sits on the chunk boundary.
    segs.push(segment({ file: a.path, ss: round(Math.max(0, from + first / fr.value - 0.25 / fr.value), 5), frames: count, fps: fr.str, W, H, helper, track: path.join(tmp, `t${i}.jsonl`), out: path.join(tmp, `m${i}.mp4`), onBytes }));
  }
  try {
    await Promise.all(segs.map((x) => x.done));
    const lines = segs.flatMap((_, i) => fs.readFileSync(path.join(tmp, `t${i}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    if (!lines.length) throw new Error('No frames came out of the footage in that range.');
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, segs.map((_, i) => `file '${path.join(tmp, `m${i}.mp4`).replace(/'/g, "'\\''")}'`).join('\n'));
    const joined = path.join(tmp, 'matte.mp4');
    if (segs.length === 1) fs.renameSync(path.join(tmp, 'm0.mp4'), joined);
    else await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', joined]);
    fs.renameSync(joined, matteOut);
    const track = { fps: fr.value, from, to, width: W, height: H, frames: lines.map((x) => [x.f || 0, x.p || 0, x.c]) };
    fs.writeFileSync(trackOut, JSON.stringify(track));
    const withPerson = lines.filter((x) => x.c >= 0.005).length, withFace = lines.filter((x) => x.f).length;
    const cover = lines.reduce((s, x) => s + x.c, 0) / lines.length;
    return {
      engine: eng.id, engineLabel: eng.label, quality, fps: round(fr.value, 3), fpsExact: fr.str, from: round(from), to: round(to), width: W, height: H, chunks: segs.length,
      frames: lines.length, expected: total, withPerson, withFace, cover: round(cover, 3), seconds: round((Date.now() - t0) / 1000, 1),
      command: segs.map((x, i) => `# chunk ${i + 1} of ${segs.length}\n${x.command}`).join('\n') + (segs.length > 1 ? `\n# then: ffmpeg -f concat -safe 0 -i list.txt -c copy matte.mp4` : ''),
      version: crypto.createHash('sha1').update(fs.readFileSync(trackOut)).digest('hex').slice(0, 10),
    };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
