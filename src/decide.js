// The decision sheet: typed answers about each clip from Google's Gemini Decisions API (gemini-decision-1).
// Answers are yes/no, choice or score, each with probabilities and a 0–1 confidence. They are the model's guesses,
// never measurements, and every place they are shown says so. Off unless a Gemini API key is present.
// Uploading: a small decision proxy (360 px, 2 fps, mono 16 kHz) of each clip goes to Google. Nothing else does.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, run, round } from './util.js';

export const MODEL = 'gemini-decision-1';
export const THRESHOLD = 0.7; // measured on sketch-to-demo footage: answers at or above it were right 96% of the time
export const MAX_SECONDS = 600; // longer clips are not labeled at import; ask about a range with frame_decide instead
const ENDPOINT = process.env.FRAME_DECISIONS_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/decisions';
const keyFile = () => path.join(HOME, 'gemini.key');

/** Whether labeling is on, and why not if it is off. Read on every use so a key added later is picked up. */
export function decisionsConfig() {
  if (/^(off|0|false|no)$/i.test(process.env.FRAME_DECISIONS || '')) return { on: false, reason: 'turned off with FRAME_DECISIONS=off' };
  let key = process.env.GEMINI_API_KEY || '';
  let source = 'GEMINI_API_KEY';
  if (!key && fs.existsSync(keyFile())) { key = fs.readFileSync(keyFile(), 'utf8').trim(); source = keyFile(); }
  if (!key) return { on: false, reason: `no Gemini API key. Set GEMINI_API_KEY or save a paid-tier key in ${keyFile()} (the free tier lets Google train on what you upload)` };
  return { on: true, key, source, endpoint: ENDPOINT };
}

// ───────────────────────── question packs
const yesno = (instructions) => ({ type: 'noul', instructions });
const COMMON = {
  camera_junk: yesno('Is most of this clip unusable camera junk: pocket, floor, ceiling, heavy blur, or the camera being picked up or set down?'),
  stability: { type: 'score', instructions: 'How steady is the camera in this clip?', criteria: ['Shaky or handheld with distracting movement.', 'Mostly steady with some movement.', 'Locked off or perfectly steady.'] },
  hook_strength: { type: 'score', instructions: 'As the very first shot of a short vertical reel, how likely is this clip to stop someone scrolling?', criteria: ['Would not stop someone scrolling.', 'Might make someone pause.', 'Would stop someone scrolling.'] },
};
export const PACKS = {
  general: {
    about: 'what kind of footage each clip is. Not yet scored against real edits, so check the roles you rely on.',
    questions: {
      role: { type: 'choice', instructions: 'This clip is raw footage for a short video edit. Which best describes it? Pick the one it shows most.', criteria: {
        talking_head: 'A person talking to the camera.',
        screen_recording: 'A recording of a phone or computer screen, or an app or website being used.',
        hands_demo: 'Hands doing something on camera: drawing, writing, building, unboxing, or using a device.',
        b_roll: 'Scenery, objects, places, or people who are not talking to the camera.',
        reaction: "A person's face reacting (surprise, laughter, delight) with little or no talking.",
        graphic: 'A title card, text, diagram, chart, or other graphic.',
        junk: 'Unusable: pocket, floor, ceiling, heavy blur, or the camera being picked up or set down.',
      } },
      ...COMMON,
    },
  },
  'sketch-to-demo': {
    about: 'the 14 story steps of a "hand drawing becomes a working app" reel. Scored on real cuts: 83–91% top-1 agreement, 96% when confidence was 70% or more.',
    questions: {
      role: { type: 'choice', instructions: 'This clip is raw footage for a short reel that shows a hand drawing being turned into a working app by an AI tool. Which step does this clip show? Pick the one it shows most.', criteria: {
        reaction_hook: "A person's face reacting to the camera (surprise, delight, confusion), the kind of shot that opens a reel.",
        drawing: 'A hand drawing a sketch on paper, or the finished hand-drawn sketch on its own.',
        photograph: 'Someone photographing the drawing with a phone, or a phone camera viewfinder framing the drawing.',
        open_tool: "Opening the AI tool or website: typing its address, the site loading, the tool's home screen.",
        select_model: 'Choosing an AI model from a menu or dropdown.',
        connect_tool: 'Connecting an integration, account or tool inside the app.',
        upload_drawing: 'Attaching or uploading an image file into the tool: a file picker or an attachment thumbnail.',
        enter_prompt: "Typing or pasting a text prompt into the tool's input box.",
        build_in_progress: 'The tool working: code streaming, a progress indicator, a preview being generated.',
        result_reveal: 'The finished result shown for the first time, for example the generated site or app on screen, possibly next to the sketch.',
        interactive_demo: 'Someone using the finished result: clicking, playing or otherwise interacting with the working app or site.',
        outro: 'A closing shot: logo, end card, call to action or wrap-up.',
        shared_setup: 'General setup footage useful for several videos: desk, laptop or screen with no specific step happening.',
        unclassified: 'None of the above, or camera junk: pocket, floor, heavy blur, the camera being picked up or set down.',
      } },
      drawing_visible: yesno('Is a hand-drawn sketch on paper clearly visible at some point in this clip?'),
      ...COMMON,
    },
  },
};

/** Normalise user-written questions. A plain string is a yes/no question. Throws with a usable message. */
export function normaliseQuestions(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q) || !Object.keys(q).length) throw new Error('questions must be an object like {"eyes_on_lens": "Does the speaker look at the lens?"}.');
  const out = {};
  for (const [k, v] of Object.entries(q)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(k)) throw new Error(`Question key "${k}" must be lower_snake_case.`);
    const x = typeof v === 'string' ? { type: 'noul', instructions: v } : { ...v };
    if (x.type === 'yes_no' || x.type === 'yesno') x.type = 'noul';
    if (!['noul', 'choice', 'score'].includes(x.type)) throw new Error(`Question "${k}": type must be "yes_no", "choice" or "score".`);
    if (!x.instructions) throw new Error(`Question "${k}" needs instructions (the question itself).`);
    if (x.type === 'choice') {
      if (Array.isArray(x.criteria)) x.criteria = Object.fromEntries(x.criteria.map((o) => [String(o).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60), String(o)]));
      if (!x.criteria || Object.keys(x.criteria).length < 2) throw new Error(`Question "${k}": a choice needs at least 2 options in criteria.`);
    }
    if (x.type === 'score' && (!Array.isArray(x.criteria) || x.criteria.length < 2)) throw new Error(`Question "${k}": a score needs criteria, an array of at least 2 level descriptions from worst to best.`);
    out[k] = { type: x.type, instructions: String(x.instructions), ...(x.criteria ? { criteria: x.criteria } : {}) };
  }
  return out;
}

// ───────────────────────── the decision proxy
/** A small copy made only for the model: it samples video at about 1 fps, so more pixels or frames only add upload time. */
export async function makeDecisionProxy(file, outFile, { from = 0, to } = {}) {
  if (fs.existsSync(outFile)) return outFile;
  const tmp = `${outFile}.part.mp4`;
  const span = to != null ? ['-ss', String(from), '-t', String(Math.max(0.5, to - from))] : from ? ['-ss', String(from)] : [];
  const args = ['-v', 'error', '-y', ...span, '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'fps=2,scale=360:360:force_original_aspect_ratio=increase:force_divisible_by=2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', tmp];
  await run('ffmpeg', args);
  fs.renameSync(tmp, outFile);
  return outFile;
}
export const proxyCommand = 'ffmpeg -i <clip> -vf fps=2,scale=360:360:force_original_aspect_ratio=increase -crf 32 -ac 1 -ar 16000 -b:a 32k <decision proxy>.mp4';

// ───────────────────────── the call
let active = 0; const queue = []; const MAX_PARALLEL = Number(process.env.FRAME_DECISIONS_PARALLEL || 24); // paid Tier 1 allows 1,000+ requests a minute
const slot = () => new Promise((r) => { if (active < MAX_PARALLEL) { active++; r(); } else queue.push(r); });
const release = () => { const n = queue.shift(); if (n) n(); else active--; };

/** One request: the proxy file plus questions. Returns {answers, tokens, ms}. Errors say what to do. */
export async function ask(cfg, proxyFile, questions) {
  const body = JSON.stringify({ model: MODEL, input: [{ type: 'video', data: fs.readFileSync(proxyFile).toString('base64'), mime_type: 'video/mp4' }], questions });
  await slot();
  const t0 = Date.now();
  try {
    for (let attempt = 1; ; attempt++) {
      let res, txt;
      try {
        res = await fetch(cfg.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.key }, body, signal: AbortSignal.timeout(120000) });
        txt = await res.text();
      } catch (e) {
        if (attempt < 3) { await new Promise((r) => setTimeout(r, 800 * attempt)); continue; }
        throw new Error(`could not reach the Gemini Decisions API: ${e.message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      if (!res.ok) {
        let msg = txt.slice(0, 300); try { msg = JSON.parse(txt).error?.message || msg; } catch {}
        if (res.status === 402) throw new Error(`Google says the prepaid credits are used up (${msg.trim()})`);
        if (res.status === 401 || res.status === 403) throw new Error(`Google rejected the API key from ${cfg.source} (${res.status}: ${msg.trim()})`);
        throw new Error(`Gemini Decisions API error ${res.status}: ${msg.trim()}`);
      }
      const j = JSON.parse(txt);
      if (!j.answers) throw new Error(`the API answered without "answers": ${txt.slice(0, 200)}`);
      return { answers: j.answers, tokens: j.usage?.total_tokens ?? null, ms: Date.now() - t0 };
    }
  } finally { release(); }
}

// ───────────────────────── reading answers
const pct = (x) => `${Math.round(x * 100)}%`;
/** Ranked options of a choice answer: [[option, probability], …]. */
export const ranked = (ans) => Object.entries(ans?.probabilities || {}).sort((a, b) => b[1] - a[1]);
/** One answer in words, for tool results. */
export function answerText(q, ans) {
  if (!ans) return 'no answer';
  if (q.type === 'noul') return `${ans.noul >= 0.5 ? 'yes' : 'no'} (P(yes) ${pct(ans.noul)})`;
  if (q.type === 'choice') { const r = ranked(ans); return r.slice(0, 3).map(([k, v]) => `${k} ${pct(v)}`).join(' · '); }
  const max = (q.criteria?.length || 3) - 1;
  return `${round(ans.score, 2)} on 0–${max}${q.criteria ? ` (${max ? q.criteria[Math.min(max, Math.round(ans.score))] : q.criteria[0]})` : ''}`;
}
/** The short summary the sheet, the window and frame_state show for an asset. */
export function sheetSummary(d) {
  const a = d?.answers; if (!a) return null;
  const r = ranked(a.role);
  const [role, conf] = r[0] || [];
  return {
    role, conf: conf ?? null, review: conf == null || conf < THRESHOLD, second: r[1] || null,
    junk: a.camera_junk?.noul ?? null, hook: a.hook_strength?.score ?? null, steady: a.stability?.score ?? null,
    drawing: a.drawing_visible?.noul ?? null,
  };
}
/** One sheet line: "drawing 95% · hook 1.8/2 · steady 1.4/2 · junk 12%", or a REVIEW line below the threshold. */
export function sheetLine(d) {
  if (!d) return 'not labeled';
  if (d.status === 'pending') return 'labeling…';
  if (d.status === 'failed') return `labeling failed: ${d.error}`;
  const s = sheetSummary(d); if (!s) return 'no answers';
  const head = s.review ? `REVIEW, unsure: ${s.role} ${pct(s.conf)}${s.second ? ` or ${s.second[0]} ${pct(s.second[1])}` : ''}` : `${s.role} ${pct(s.conf)}`;
  const bits = [head];
  if (s.hook != null) bits.push(`hook ${round(s.hook, 1)}/2`);
  if (s.steady != null) bits.push(`steady ${round(s.steady, 1)}/2`);
  if (s.junk != null && s.junk >= 0.5) bits.push(`JUNK? ${pct(s.junk)}`);
  if (s.drawing != null) bits.push(`drawing visible ${pct(s.drawing)}`);
  return bits.join(' · ');
}
