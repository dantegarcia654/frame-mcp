// Media probing + analysis. Everything here is measured from the file with ffmpeg/ffprobe.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, round, mkdirp } from './util.js';

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts|mxf)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|aif|aiff|opus)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const WEB_VCODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);

export async function checkFfmpeg() {
  try { const r = await run('ffmpeg', ['-version']); return r.stdout.split('\n')[0]; }
  catch { return null; }
}

export async function probe(file) {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  let kind = v ? 'video' : a ? 'audio' : null;
  if (IMAGE_EXT.test(file) || (v && !a && (j.format?.format_name || '').match(/image2|png_pipe|jpeg_pipe|webp_pipe|gif/) && !VIDEO_EXT.test(file))) kind = 'image';
  if (!kind) throw new Error(`Not a media file Frame can read: ${file}`);
  const info = { kind, duration: round(Number(j.format?.duration || v?.duration || a?.duration || 0)), hasAudio: !!a && kind !== 'image' };
  if (v) {
    let w = v.width, h = v.height;
    const rot = Number(v.tags?.rotate || (v.side_data_list || []).find((s) => s.rotation != null)?.rotation || 0);
    if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
    const [n, d] = (v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
    Object.assign(info, { width: w, height: h, fps: round(d ? n / d : 30, 2), vcodec: v.codec_name });
  }
  if (a) info.acodec = a.codec_name;
  if (kind === 'image') { info.duration = 0; info.hasAudio = false; }
  // Browsers cannot play every codec/container; those get a small H.264 proxy for preview only.
  info.needsProxy = kind === 'video' && (!WEB_VCODECS.has(info.vcodec) || /\.(mkv|avi|mts|mxf)$/i.test(file));
  return info;
}

/** Sprite strip of evenly spaced frames, for the bin and the timeline clips. */
export async function makeThumbs(file, info, outFile) {
  if (info.kind === 'audio') return 0;
  if (info.kind === 'image') {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', 'scale=-2:120', '-frames:v', '1', '-q:v', '5', outFile]);
    return 1;
  }
  const n = Math.max(1, Math.min(40, Math.ceil(info.duration / 1.5)));
  const rate = n / Math.max(info.duration, 0.1);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `fps=${rate},scale=-2:120,tile=${n}x1`, '-frames:v', '1', '-q:v', '6', outFile]);
  return n;
}

export async function makeProxy(file, outFile) {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', 'scale=-2:720', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outFile]);
}

/** Decode to 8 kHz mono and measure 50 peak + RMS windows per second. */
export async function audioEnvelope(file) {
  const SR = 8000, WIN = 160; // 20 ms
  const peaks = [], rms = [];
  let carry = Buffer.alloc(0);
  await run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], {
    strict: false,
    onStdout: (d) => {
      let buf = carry.length ? Buffer.concat([carry, d]) : d;
      const bytes = WIN * 2;
      let off = 0;
      for (; off + bytes <= buf.length; off += bytes) {
        let pk = 0, sq = 0;
        for (let i = 0; i < WIN; i++) { const s = buf.readInt16LE(off + i * 2) / 32768; const a = Math.abs(s); if (a > pk) pk = a; sq += s * s; }
        peaks.push(Math.round(pk * 255)); rms.push(Math.sqrt(sq / WIN));
      }
      carry = buf.subarray(off);
    },
  });
  return { rate: 50, peaks, rms };
}

/** Silences from the measured RMS envelope. threshold in dBFS. */
export function findSilences(env, { threshold_db = -38, min_silence = 0.35 } = {}) {
  const thr = 10 ** (threshold_db / 20), out = [];
  let start = null;
  const push = (i) => { if (start != null) { const a = start / env.rate, b = i / env.rate; if (b - a >= min_silence) out.push({ start: round(a, 2), end: round(b, 2) }); start = null; } };
  env.rms.forEach((v, i) => { if (v < thr) { if (start == null) start = i; } else push(i); });
  push(env.rms.length);
  return out;
}

export async function loudness(file) {
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { strict: false });
  const sum = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const I = sum.match(/I:\s+(-?[\d.]+) LUFS/), P = sum.match(/Peak:\s+(-?[\d.]+) dBFS/);
  return I ? { lufs: Number(I[1]), true_peak_db: P ? Number(P[1]) : null } : null;
}

export async function sceneCuts(file, threshold = 0.3) {
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-an', '-vf', `scale=160:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], { strict: false, timeout: 180000 });
  return [...r.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => round(Number(m[1]), 2));
}

/** Word-level transcript via a locally installed Whisper. Returns null if none is installed. */
export async function whisperAvailable() {
  for (const c of [['whisper', ['--help']], ['python3', ['-m', 'whisper', '--help']]]) {
    try { const r = await run(c[0], c[1], { strict: false, timeout: 20000 }); if (r.code === 0 && /word_timestamps/.test(r.stdout + r.stderr)) return c[0] === 'whisper' ? ['whisper'] : ['python3', '-m', 'whisper']; } catch {}
  }
  return null;
}

export async function transcribe(file, { model = 'base.en', language } = {}, onLog) {
  const cmd = await whisperAvailable();
  if (!cmd) return null;
  const dir = mkdirp(fs.mkdtempSync(path.join(os.tmpdir(), 'frame-whisper-')));
  const wav = path.join(dir, 'audio.wav');
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav]);
  const args = [...cmd.slice(1), wav, '--model', model, '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', dir, '--fp16', 'False'];
  if (language) args.push('--language', language);
  await run(cmd[0], args, { onStderr: onLog, timeout: 30 * 60000 });
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'audio.json'), 'utf8'));
  const words = [];
  for (const seg of j.segments || []) for (const w of seg.words || []) words.push({ text: w.word.trim(), start: round(w.start, 2), end: round(w.end, 2) });
  fs.rmSync(dir, { recursive: true, force: true });
  return { words, text: (j.text || '').trim(), engine: `whisper ${model}` };
}

export function kindFromExt(file) { return VIDEO_EXT.test(file) ? 'video' : AUDIO_EXT.test(file) ? 'audio' : IMAGE_EXT.test(file) ? 'image' : null; }

/**
 * Whisper often places the first word after a pause too early, inside the silence.
 * Move any word whose midpoint falls in a measured silence to the nearest measured speech edge.
 */
export function alignWordsToSpeech(words, env) {
  const sil = findSilences(env, { threshold_db: -38, min_silence: 0.35 });
  let moved = 0;
  const out = words.map((w) => ({ ...w }));
  out.forEach((w, i) => {
    const mid = (w.start + w.end) / 2, s = sil.find((x) => mid > x.start && mid < x.end);
    if (!s) return;
    const len = Math.max(0.12, w.end - w.start), next = out[i + 1], prev = out[i - 1];
    if (s.end - mid <= mid - s.start && s.end - mid < 1.5) { // speech resumes soon after: push forward
      w.start = round(s.end, 2); w.end = round(Math.min(w.start + len, next ? Math.max(next.start, w.start + 0.1) : w.start + len), 2);
      if (next && next.start < w.end) next.start = w.end;
      moved++;
    } else if (mid - s.start < 1.5) { // word trails into the pause: pull back
      w.end = round(s.start, 2); w.start = round(Math.max(prev ? prev.end : 0, w.end - len), 2);
      moved++;
    }
  });
  return { words: out, moved };
}
