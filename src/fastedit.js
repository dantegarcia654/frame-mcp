// frame edit <file> — any footage to an edited vertical reel in under a minute, every step live in the Frame window.
//
// Nothing waits on anything it does not need:
//   t=0   project opens; Whisper starts in its own process (overlaps everything below)
//   ~1-4s the take is on V1 (import only blocks on the probe + audio envelope; thumbs/proxy follow in the background)
//   +0s   dead air cut from the measured audio, alternating punch-ins, score
//   ~10s  transcript lands → captions
//   +5-10s animated cards (one per idea, timed to the words) land one by one as they render
// Card text: a cards file written while the edit runs wins (see --wait-cards); otherwise rule-based cards are cut from
// your own sentences (quotes, never invented claims).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { call } from './mcp.js';
import { HOME } from './util.js';
import { renderCards, warmChrome, closeChrome } from './cards.js';
import { motionCentre, offsetFor } from './speedrun.js';
import { beatsFromWords } from './speedrun.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const txt = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILLERS = ['hey claude', 'hey', 'alright', 'all right', 'okay', 'ok', 'so', 'actually', 'and', 'but', 'like', 'you know', 'um', 'uh', 'well', 'now', 'just', 'then', 'right', 'i mean', 'yeah', 'oh'];
const TAIL = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'that', 'this', 'my', 'your', 'for', 'with', 'in', 'on', 'at', 'is', 'it', 'be', 'so', 'but', 'or', 'like', 'just', 'you', 'i']);

/** Sentences from timed words: split on end punctuation or a pause over 0.7 s. */
export function sentences(words) {
  const out = []; let cur = null;
  for (const w of words) {
    if (!cur || w.start - cur.end > 0.7) { cur = { start: w.start, end: w.end, words: [] }; out.push(cur); }
    cur.words.push(w.text); cur.end = w.end;
    if (/[.!?]$/.test(w.text)) cur = null;
  }
  return out.map((s) => ({ ...s, text: s.words.join(' ') }));
}

/** A card line cut from a spoken sentence: fillers and lead-ins off, the main clause, at most 8 words, original casing. */
export function cardLine(text) {
  const LEAD = ['can we', 'can you', 'could you', 'could we', 'i want you to', 'i want to', 'we need to', 'you need to', 'make sure you', 'go ahead and'];
  let toks = String(text).replace(/[“”"]/g, '').replace(/ -(\w)/g, '-$1').split(/\s+/).filter(Boolean);
  const low = () => toks.map((w) => w.toLowerCase().replace(/[^a-z0-9'.-]/g, '')).join(' ');
  toks = toks.filter((w, i) => !(/^(um|uh),?$/i.test(w)));
  const butAt = toks.findIndex((w, i) => i > 0 && /^but$/i.test(w));
  if (butAt > 0 && toks.length - butAt - 1 >= 3) toks = toks.slice(butAt + 1);
  for (let changed = true; changed;) {
    changed = false;
    for (const f of [...LEAD, ...FILLERS]) {
      const n = f.split(' ').length;
      if (low().replace(/[,.]/g, '').startsWith(f + ' ') && toks.length > n) { toks = toks.slice(n); changed = true; }
    }
  }
  const comma = toks.findIndex((w, i) => i >= 2 && /,$/.test(w));
  if (comma >= 2 && comma < 8) toks = toks.slice(0, comma + 1);
  toks = toks.slice(0, 8).map((w) => w.replace(/[,!?]+$/, '').replace(/\.$/, ''));
  while (toks.length && TAIL.has(toks[toks.length - 1].toLowerCase())) toks.pop();
  if (toks.length < 3) return null;
  const s = toks.join(' ').replace(/\bi\b/g, 'I').replace(/\bai\b/gi, 'AI').replace(/(\d) %/g, '$1%');
  return s[0].toUpperCase() + s.slice(1);
}

function parseTrack(out, name) {
  const block = (out.split(/\n(?=[A-Z]\d+:)/).find((s) => s.startsWith(name + ':')) || '');
  return [...block.matchAll(/(c_[a-z0-9]+) · ([\d.]+)–([\d.]+)s · (a\d+) src ([\d.]+)–([\d.]+)/g)].map((m) => ({ id: m[1], start: +m[2], end: +m[3], asset: m[4], in: +m[5], out: +m[6] }));
}
const toTimeline = (clips, t) => { for (const c of clips) if (t >= c.in - 0.05 && t < c.out) return c.start + Math.max(0, t - c.in); const nx = clips.find((c) => c.in > t); return nx ? nx.start : null; };

/** Headless Chrome for the cards starts with the run and is always killed at the end, whatever happens. */
export async function fastEdit(file, opts = {}) {
  const warm = warmChrome();
  let watchdog;
  try {
    return await Promise.race([fastEditRun(file, opts, warm), new Promise((_, j) => { watchdog = setTimeout(() => j(new Error('the whole edit passed 150 s; stopped')), 150000); })]);
  } finally { clearTimeout(watchdog); await closeChrome(warm); }
}

async function fastEditRun(file, { name, waitCards = 0, log = console.log } = {}, warm) {
  const t0 = Date.now(); const T = () => (Date.now() - t0) / 1000; const marks = [];
  const mark = (s) => { marks.push([T(), s]); log(`[${T().toFixed(1)}s] ${s}`); };
  // Every step has a deadline: a hung step (e.g. a stalled headless Chrome on a full disk) fails the run in seconds
  // with its name, instead of hanging it forever.
  const tool = async (n, a, ms = 45000) => {
    let to; const r = await Promise.race([call(n, a), new Promise((_, j) => { to = setTimeout(() => j(new Error(`${n} did not answer in ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(to));
    const t = txt(r); if (r.isError) throw new Error(`${n}: ${t}`); return t;
  };
  file = path.resolve(String(file).replace(/^~(?=[\\/])/, os.homedir()));
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  const free = (() => { try { const s = fs.statfsSync(HOME); return s.bavail * s.bsize; } catch { return Infinity; } })();
  if (free < 0.15e9) throw new Error(`Only ${(free / 1e9).toFixed(2)} GB free: clear space first (Whisper, the preview proxy and cards need ~50 MB).`);

  fs.mkdirSync(path.join(HOME, 'edits'), { recursive: true });
  const work = fs.mkdtempSync(path.join(HOME, 'edits', 'run-')); // one folder per run: its cards stay with its project
  // 1. Whisper starts first, in parallel with everything else.
  // Long footage is split into overlapping chunks transcribed in parallel (each process gets its share of the cores).
  const wordsFile = path.join(work, 'words.json');
  const whisperDone = (async () => {
    const dur = await new Promise((res) => { const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]); let o = ''; p.stdout.on('data', (d) => (o += d)); p.on('close', () => res(Number(o) || 0)); });
    const n = Math.max(1, Math.min(4, Math.ceil(dur / 40))), len = dur / n, ov = 1.5;
    const threads = String(Math.max(2, Math.floor(os.cpus().length / n)));
    const parts = await Promise.all(Array.from({ length: n }, async (_, i) => {
      const from = Math.max(0, i * len - ov), to = Math.min(dur, (i + 1) * len + ov);
      const wav = path.join(work, `chunk${i}.wav`), jf = path.join(work, `words${i}.json`);
      await new Promise((res) => spawn('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(from), '-t', String(to - from), '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav]).on('close', res));
      const code = await new Promise((res) => spawn('python3', [path.join(HERE, 'whisper_words.py'), wav, jf, 'base.en', String(from), String(i ? i * len : -1e9), String(i < n - 1 ? (i + 1) * len : 1e9)], { stdio: 'ignore', env: { ...process.env, OMP_NUM_THREADS: threads } }).on('close', res));
      return code === 0 && fs.existsSync(jf) ? JSON.parse(fs.readFileSync(jf, 'utf8')).words : null;
    }));
    if (parts.some((p) => !p)) return null;
    const words = parts.flat().sort((a, b) => a.start - b.start);
    fs.writeFileSync(wordsFile, JSON.stringify({ words }));
    return { words, text: words.map((w) => w.text).join(' '), chunks: n };
  })();

  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const started = await tool('frame_start', { name: name || `${base} · edit`, plan: 'Fast edit: take on the timeline, dead air out, punch-ins, score → captions when the transcript lands → animated cards timed to what you say. Every step lands live.' });
  const P = started.match(/\((p_[a-z0-9]+)\)/)[1];
  fs.writeFileSync(path.join(work, 'project.txt'), P);
  try { fs.rmSync(path.join(HOME, 'edit-latest'), { force: true, recursive: true }); fs.symlinkSync(work, path.join(HOME, 'edit-latest')); } catch {}
  mark(`project ${P}`);

  const packs = path.join(HOME, 'packs');
  const pack = (id) => { for (const d of fs.readdirSync(packs)) { const f = fs.readdirSync(path.join(packs, d)).find((x) => x.replace(/\.[^.]+$/, '') === id); if (f) return path.join(packs, d, f); } return null; };
  const imp = await tool('frame_import', { project_id: P, paths: [file, pack('in-motion'), pack('whoosh-fast')].filter(Boolean) });
  const ids = [...imp.matchAll(/^\s+(a\d+) · (\w+) · .*?· ([\d.]+)s/gm)].map((m) => ({ id: m[1], kind: m[2], dur: +m[3] }));
  const [vid, mus, wh] = ids; mark(`imported (${vid.dur}s)`);
  // Wider than the reel (landscape / square): find where the action is, in parallel, and crop to it.
  const [sw, sh] = (imp.match(/· (\d+)×(\d+)/) || []).slice(1).map(Number);
  const wide = sw && sh && sw / sh > 9 / 16 * 1.15;
  const cxP = wide ? motionCentre(file) : Promise.resolve(0.5);
  const frameOps = async (clips) => { if (!wide) return []; const cx = await cxP; return clips.map((c, i) => ({ op: 'update_clip', id: c.id, x: offsetFor(cx, sw / sh, 9 / 16, i % 2 ? 1.12 : 1) })); };

  // 2. Picture first: whole take, then dead air out on the measured audio.
  let out = await tool('frame_edit', { project_id: P, summary: 'Take on the timeline, dead air out', ops: [{ op: 'add_clip', asset: vid.id, track: 'V1', fit: 'cover' }, { op: 'remove_silences', track: 'V1' }] });
  let v1 = parseTrack(out, 'V1'); mark(`cut: ${v1.length} shots`);
  let D = Math.max(...v1.map((c) => c.end));
  const punch = v1.map((c, i) => ({ op: 'update_clip', id: c.id, scale: i % 2 ? 1.12 : 1, why: i % 2 ? 'punch-in so the jump cut reads' : undefined })).filter((o) => o.scale !== 1);
  await tool('frame_edit', { project_id: P, summary: 'Punch-ins + score', ops: [...punch, ...(mus ? [{ op: 'add_clip', asset: mus.id, track: 'A2', start: 0, in: 0, out: +Math.min(D, mus.dur).toFixed(2), volume: 0.2, fadeOut: 0.6 }] : [])] });
  mark('punch-ins + score');

  // 3. Words → captions.
  const tr = await whisperDone;
  // Whisper splits decimals ("5" ".2"): glue them back so captions and cards read "5.2".
  const words = [];
  for (const w of tr?.words || []) { const prev = words[words.length - 1]; if (prev && /^\.\d/.test(w.text) && /\d$/.test(prev.text)) { prev.text += w.text; prev.end = w.end; } else words.push({ ...w }); }
  fs.writeFileSync(path.join(work, 'transcript.txt'), tr?.text || '');
  mark(`transcript: ${words.length} words${tr?.chunks > 1 ? ` (${tr.chunks} chunks in parallel)` : ''}`);
  // Junk check: Whisper on music, laughter or noise loops one token ("ha ha ha…"). Treat that as no speech.
  const toks = words.map((w) => w.text.toLowerCase().replace(/[^a-z0-9']/g, '')).filter(Boolean);
  const counts = toks.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map());
  const junk = toks.length >= 12 && (counts.size / toks.length < 0.3 || Math.max(...counts.values()) / toks.length > 0.4);
  if (junk) { mark(`transcript looks like noise (${counts.size} distinct of ${toks.length} words): treating as no speech`); words.length = 0; }
  if (words.length >= 6) {
    await tool('frame_transcribe', { project_id: P, asset: vid.id, words, source: 'whisper base.en (parallel)' });
    // Now that the words are known: one shot per sentence (and per pause), alternating framing so every cut reads.
    const beats = beatsFromWords(words, vid.dur);
    out = await tool('frame_edit', { project_id: P, summary: `Recut on the words: ${beats.length} beats`, ops: [{ op: 'clear_track', track: 'V1' }, { op: 'keep_ranges', asset: vid.id, ranges: beats }] });
    v1 = parseTrack(out, 'V1'); D = Math.max(...v1.map((c) => c.end));
    out = await tool('frame_edit', { project_id: P, summary: 'Punch-ins + captions', ops: [...v1.filter((_, i) => i % 2).map((c) => ({ op: 'update_clip', id: c.id, scale: 1.12 })), ...(await frameOps(v1)), { op: 'add_captions', replace: true, max_words: 3, style: { size: 0.05, y: 0.8 } }, ...(mus ? [{ op: 'clear_track', track: 'A2' }, { op: 'add_clip', asset: mus.id, track: 'A2', start: 0, in: 0, out: +Math.min(D, mus.dur).toFixed(2), volume: 0.2, fadeOut: 0.6 }] : [])] });
    mark(`recut on the words: ${v1.length} shots + captions`);
  } else {
    // No speech: a music-led montage of the take instead (even beats, alternating framing, louder score).
    const beat = 2, n = Math.max(1, Math.min(12, Math.floor(vid.dur / beat))), step = vid.dur / n;
    out = await tool('frame_edit', { project_id: P, summary: 'No speech: music-led montage', ops: [{ op: 'clear_track', track: 'V1' }, { op: 'keep_ranges', asset: vid.id, ranges: Array.from({ length: n }, (_, i) => ({ in: +(i * step).toFixed(2), out: +(i * step + Math.min(beat, step)).toFixed(2) })) }] });
    v1 = parseTrack(out, 'V1'); D = Math.max(...v1.map((c) => c.end));
    await tool('frame_edit', { project_id: P, summary: 'Montage framing + score', ops: [...v1.filter((_, i) => i % 2).map((c) => ({ op: 'update_clip', id: c.id, scale: 1.15 })), ...(await frameOps(v1)), { op: 'update_clip', id: v1[0].id, muted: false }, ...(mus ? [{ op: 'clear_track', track: 'A2' }, { op: 'add_clip', asset: mus.id, track: 'A2', start: 0, in: 0, out: +Math.min(D, mus.dur).toFixed(2), volume: 0.6, fadeOut: 0.6 }] : [])] });
    mark('montage (no speech)');
  }

  // 4. Cards: a cards file written during the run wins; otherwise lines cut from what was said.
  const cardsFile = path.join(work, 'cards.json');
  if (waitCards > 0 && words.length >= 6) { const until = Date.now() + waitCards * 1000; while (!fs.existsSync(cardsFile) && Date.now() < until) await sleep(150); }
  let lines = [];
  if (fs.existsSync(cardsFile)) {
    lines = JSON.parse(fs.readFileSync(cardsFile, 'utf8')).map((c) => ({ text: c.text, sub: c.sub, at: toTimeline(v1, c.at), src: c.at })).filter((c) => c.at != null);
    mark(`cards: ${lines.length} from cards file`);
  } else if (words.length >= 6) {
    let last = -99;
    for (const s of sentences(words)) {
      const line = cardLine(s.text); const at = toTimeline(v1, s.start);
      if (!line || at == null || at - last < 6 || lines.length >= 10) continue;
      lines.push({ text: line, at }); last = at;
    }
    mark(`cards: ${lines.length} cut from your sentences`);
  }
  if (lines.length) {
    const cards = lines.map((l, i) => ({
      id: `k${i}`, start: +l.at.toFixed(2), end: +Math.min(i + 1 < lines.length ? lines[i + 1].at - 0.1 : D, l.at + 4.2, D).toFixed(2),
      y: 330, kind: 'title', text: l.text, sub: l.sub, upper: false, size: i === 0 ? 70 : 60,
      theme: i === 0 ? 'purple' : i % 2 ? 'paper' : 'ink', enter: i === 0 ? 'pop' : i % 3 === 1 ? 'slide' : i % 3 === 2 ? 'pop' : 'slam',
    })).filter((c) => c.end - c.start > 0.8);
    fs.writeFileSync(path.join(work, 'cards-used.json'), JSON.stringify(cards, null, 2));
    await renderCards({ cards }, path.join(work, 'cards'), { compact: true, warm, onCard: async (k, f, place) => {
      const id = (await tool('frame_import', { project_id: P, paths: [f] })).match(/^\s+(a\d+) · /m)[1];
      await tool('frame_edit', { project_id: P, summary: `Card: ${k.text}`, ops: [{ op: 'add_clip', asset: id, track: 'V2', start: k.start, ...place, label: `card ${k.id}` }, ...(wh ? [{ op: 'add_clip', asset: wh.id, track: 'A3', start: +Math.max(0, k.start - 0.12).toFixed(2), volume: 0.4 }] : [])] });
    } });
    mark(`${cards.length} cards on V2`);
  }
  await tool('frame_note', { project_id: P, text: `Edit done in ${T().toFixed(1)} s: ${v1.length} shots, ${words.length >= 6 ? 'captions, ' : ''}${lines.length} cards, score. Preview in the window.` });
  const res = { project_id: P, seconds: +T().toFixed(1), duration: +D.toFixed(2), shots: v1.length, words: words.length, cards: lines.map((l) => l.text), marks };
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(res, null, 2));
  log(`\nDone in ${T().toFixed(1)}s · ${P} · ${D.toFixed(1)}s reel · ${v1.length} shots · ${lines.length} cards`);
  return res;
}
