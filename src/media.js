// Media probing + analysis. Everything here is measured from the file with ffmpeg/ffprobe.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run, round, mkdirp, HOME } from './util.js';

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
  // Also proxy anything bigger than ~720p: several 1080p/4K H.264 streams decoding at once is what makes in-browser playback stutter.
  info.needsProxy = kind === 'video' && (!WEB_VCODECS.has(info.vcodec) || /\.(mkv|avi|mts|mxf)$/i.test(file) || Math.max(info.width || 0, info.height || 0) > 1280);
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
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', 'scale=-2:720', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outFile]); // keyframe every ~0.33 s: scrubbing and clip jumps seek instantly
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

/**
 * Adaptive pause finder. Unlike findSilences (fixed dBFS), this measures the clip's own noise floor and
 * speech level, so a noisy room or quiet talker still gets sensible cuts. Uses hysteresis so breaths and
 * soft consonants at word edges are not mistaken for silence.
 * Returns { threshold_db, floor_db, speech_db, pauses:[{start,end}] } (source seconds, unpadded).
 */
export function findPauses(env, { threshold_db, min_silence = 0.45, from = 0, to = Infinity } = {}) {
  const a = Math.max(0, Math.floor(from * env.rate)), b = Math.min(env.rms.length, Math.ceil(to * env.rate));
  const db = env.rms.slice(a, b).map((v) => 20 * Math.log10(Math.max(v, 1e-5)));
  if (db.length < 5) return { threshold_db: null, floor_db: null, speech_db: null, pauses: [] };
  const sorted = [...db].sort((x, y) => x - y), q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  const floor = q(0.1), speech = q(0.92);
  let thr = threshold_db;
  if (thr == null) thr = Math.min(Math.max(floor + Math.max(7, 0.3 * (speech - floor)), -52), -28);
  const hi = thr + 4; // hysteresis: once in a pause, stay there until clearly louder than the threshold
  const pauses = []; let start = null, inPause = false;
  const close = (i) => { if (start != null && (i - start) / env.rate >= min_silence) pauses.push({ start: round(from + start / env.rate, 3), end: round(from + i / env.rate, 3) }); start = null; };
  db.forEach((v, i) => {
    if (!inPause && v < thr) { inPause = true; start = i; }
    else if (inPause && v > hi) { inPause = false; close(i); }
  });
  if (inPause) close(db.length);
  return { threshold_db: round(thr, 1), floor_db: round(floor, 1), speech_db: round(speech, 1), pauses };
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
  // Windows has no python3 (that name opens the Microsoft Store); it is python or py there.
  for (const c of [['whisper'], ['python3', '-m', 'whisper'], ['python', '-m', 'whisper'], ['py', '-m', 'whisper']]) {
    try { const r = await run(c[0], [...c.slice(1), '--help'], { strict: false, timeout: 20000 }); if (r.code === 0 && /word_timestamps/.test(r.stdout + r.stderr)) return c; } catch {}
  }
  return null;
}

// ── Transcription engines ─────────────────────────────────────────────────────────────────────────
// 1. macOS 26+: Apple's on-device SpeechAnalyzer (src/apple-speech.swift, compiled once into HOME/bin).
//    Measured on an M3 Pro: 8.7 min of talking head in 4.9 s with 4 parallel analyzers (Whisper base.en: ~140 s).
// 2. Anywhere else (Windows, Linux, older macOS) or when asked: Whisper, split into time ranges that run in
//    parallel across the CPU cores. Ranges overlap by 1.5 s and each keeps only the words centred inside it.
// Both run on this machine; nothing is uploaded. Names an engine mishears are fixed from HOME/spellings.json.

const APPLE_SRC = fileURLToPath(new URL('./apple-speech.swift', import.meta.url));
let appleBin = null;
/** Path to the compiled Apple speech tool, or null when this machine can't run it (not macOS 26+, no swiftc, or FRAME_NO_APPLE_SPEECH). Compiles once per source version (~50 s). */
export function appleSpeechBinary() {
  if (appleBin) return appleBin;
  appleBin = (async () => {
    // Darwin 25 is macOS 26, the first release with SpeechAnalyzer.
    if (process.platform !== 'darwin' || Number(os.release().split('.')[0]) < 25 || process.env.FRAME_NO_APPLE_SPEECH) return null;
    const hash = crypto.createHash('sha1').update(fs.readFileSync(APPLE_SRC)).digest('hex').slice(0, 10);
    const bin = path.join(HOME, 'bin', `apple-speech-${hash}`);
    if (fs.existsSync(bin)) return bin;
    mkdirp(path.dirname(bin));
    const tmp = `${bin}.${process.pid}.tmp`;
    try {
      const r = await run('swiftc', ['-O', '-parse-as-library', APPLE_SRC, '-o', tmp], { strict: false, timeout: 10 * 60000 });
      if (r.code !== 0 || !fs.existsSync(tmp)) return null;
      fs.renameSync(tmp, bin);
      return bin;
    } catch { return null; }
  })();
  return appleBin;
}

/** Which engine frame_transcribe will use here, or null if none: { id: 'apple' | 'whisper', label }. */
export async function transcriber() {
  if (await appleSpeechBinary()) return { id: 'apple', label: 'Apple on-device speech (macOS)' };
  if (await whisperAvailable()) return { id: 'whisper', label: `Whisper, ${Math.max(1, Math.floor(os.cpus().length / 2))} parallel ranges on long clips` };
  return null;
}

/** Spelling fixes for names an engine mishears, e.g. {"clawed": "Claude"}, from HOME/spellings.json (single words, case-insensitive). */
export function spellings() {
  try { const j = JSON.parse(fs.readFileSync(path.join(HOME, 'spellings.json'), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
function applySpellings(words, map) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (!lower.size) return 0;
  let fixed = 0;
  for (const w of words) {
    const m = w.text.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}'’-]+)([^\p{L}\p{N}]*)$/u);
    const rep = m && lower.get(m[2].toLowerCase());
    if (rep && rep !== m[2]) { w.text = m[1] + rep + m[3]; fixed++; }
  }
  return fixed;
}

async function appleTranscribe(bin, wav, { language, vocabulary, duration }) {
  const chunks = Math.max(1, Math.min(8, Math.round(duration / 60)));
  const r = await run(bin, [wav, language || 'en-US', String(chunks), vocabulary.join(',')], { strict: false, timeout: 15 * 60000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `apple-speech exited ${r.code}`);
  const j = JSON.parse(r.stdout);
  const words = j.words.map((w) => ({ text: w.text, start: round(w.start, 2), end: round(w.end, 2) }));
  return { words, engine: `Apple on-device speech ${j.engine.split(' ')[1] || ''}${chunks > 1 ? `, ${chunks} parallel` : ''}`.trim() };
}

async function whisperTranscribe(cmd, wav, dir, { model, language, duration }, onLog) {
  const cpus = os.cpus().length;
  const par = duration > 90 ? Math.max(1, Math.min(8, Math.floor(cpus / 2), Math.ceil(duration / 60))) : 1;
  const step = duration / par, threads = String(Math.max(1, Math.floor(cpus / par)));
  const parts = await Promise.all(Array.from({ length: par }, async (_, i) => {
    const from = i * step, to = i === par - 1 ? duration + 1 : (i + 1) * step;
    const lo = par === 1 ? 0 : Math.max(0, from - 1.5), hi = Math.min(duration, to + 1.5);
    const part = par === 1 ? wav : path.join(dir, `part${i}.wav`);
    if (par > 1) await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(lo), '-t', String(hi - lo), '-i', wav, '-c', 'copy', part]);
    const out = mkdirp(path.join(dir, `out${i}`));
    const args = [...cmd.slice(1), part, '--model', model, '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', out, '--fp16', 'False', '--threads', threads];
    if (language) args.push('--language', language);
    await run(cmd[0], args, { onStderr: onLog, timeout: 30 * 60000 });
    const j = JSON.parse(fs.readFileSync(path.join(out, `${path.basename(part, '.wav')}.json`), 'utf8'));
    const words = [];
    for (const seg of j.segments || []) for (const w of seg.words || []) {
      const s = w.start + lo, e = w.end + lo, mid = (s + e) / 2;
      if (par === 1 || (mid >= from && mid < to)) words.push({ text: w.word.trim(), start: round(s, 2), end: round(e, 2) });
    }
    return words;
  }));
  return { words: parts.flat().sort((a, b) => a.start - b.start), engine: `whisper ${model}${par > 1 ? `, ${par} parallel` : ''}` };
}

/**
 * Word-level transcript on this machine. engine "auto" (default) uses Apple on-device speech when it can,
 * else Whisper; passing a Whisper model or engine "whisper" forces Whisper. Returns null if no engine exists.
 */
export async function transcribe(file, { model, language, engine = 'auto', vocabulary, duration = 0 } = {}, onLog) {
  const t0 = Date.now();
  const forceWhisper = engine === 'whisper' || (engine === 'auto' && !!model);
  const apple = forceWhisper ? null : await appleSpeechBinary();
  if (engine === 'apple' && !apple) throw new Error('Apple on-device speech needs macOS 26 or later and the Xcode command line tools (swiftc).');
  const wcmd = apple ? null : await whisperAvailable();
  if (!apple && !wcmd) return null;
  const dir = mkdirp(fs.mkdtempSync(path.join(os.tmpdir(), 'frame-speech-')));
  const wav = path.join(dir, 'audio.wav');
  const map = spellings(), vocab = vocabulary || [...new Set(Object.values(map).map(String))];
  let tr, note = '';
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav]);
    if (!duration) duration = (await probe(wav)).duration || 0;
    if (apple) {
      try { tr = await appleTranscribe(apple, wav, { language, vocabulary: vocab, duration }); }
      catch (e) {
        const c = await whisperAvailable(); if (!c) throw e;
        note = `Apple on-device speech failed (${String(e.message).slice(0, 160)}), so Whisper ran instead`;
        tr = await whisperTranscribe(c, wav, dir, { model: model || 'base.en', language, duration }, onLog);
      }
    } else tr = await whisperTranscribe(wcmd, wav, dir, { model: model || 'base.en', language, duration }, onLog);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const spelled = applySpellings(tr.words, map);
  return { words: tr.words, text: tr.words.map((w) => w.text).join(' '), engine: tr.engine, seconds: round((Date.now() - t0) / 1000, 1), spelled, note };
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
