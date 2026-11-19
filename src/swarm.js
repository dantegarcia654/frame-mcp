// The swarm: agents that fill a story template on the timeline in seconds, then hand the cut to a Director for taste.
//   Caster   rules over the decision sheet: for each slot, the clip gemini-decision-1 most likely labeled with its role
//   Scouts   one gemini-decision-1 request per 2 s window of each slot's candidate clips, all in parallel
//   Trimmer  as soon as a slot's windows are answered, swaps in the window rated highest (with a variety rule)
//   Director the calling agent: looks at 1-fps filmstrips (frame_swarm strips) and re-picks moments (frame_swarm direct)
// Caster and Trimmer are plain rules over model answers; only the answers come from a model. Measured on one shoot
// (14 clips, 13 slots): rough cut on the timeline 1.1 s after start, every slot trimmed by ~6 s; the Director pass
// moved the cut from 6/13 to 9/13 shots on the same clip as the editor's approved cut.
import { run } from './util.js';

export const SWARM = { k: 3, win: 2, step: 1, reuse: 0.5, maxWindows: 400 };

/** Built-in story templates. Slot lengths follow the reference reel's cut grid; roles come from the template's pack. */
export const TEMPLATES = {
  'sketch-to-demo': {
    pack: 'sketch-to-demo',
    about: 'a hand drawing becomes a working app: reaction, payoff first, how it was made, the result revealed and used',
    slots: [
      { id: 'hook', role: 'reaction_hook', seconds: 0.87, about: "A person's face reacting to what they just saw, at the peak of the reaction." },
      { id: 'proof_menu', role: 'result_reveal', also: ['interactive_demo'], seconds: 2.1, about: 'The finished website or app on screen, looking its best (payoff first).' },
      { id: 'proof_action_a', role: 'interactive_demo', seconds: 1.47, about: 'The finished result being used or doing something visually striking.' },
      { id: 'proof_action_b', role: 'interactive_demo', seconds: 1.47, about: 'The finished result in use, from a different angle than the shot before.' },
      { id: 'draw', role: 'drawing', seconds: 1.43, about: 'A hand drawing the sketch on paper.' },
      { id: 'photo', role: 'photograph', seconds: 1.43, about: 'A phone camera framing the drawing.' },
      { id: 'open_tool', role: 'open_tool', seconds: 1.4, about: 'Opening the AI tool or website: the address bar, the site loading.' },
      { id: 'upload_drawing', role: 'upload_drawing', seconds: 1.2, about: 'Uploading the drawing into the tool: a file picker or attachment.' },
      { id: 'paste_prompt', role: 'enter_prompt', seconds: 1.03, about: 'Typing or pasting the prompt into the tool.' },
      { id: 'build_result', role: 'result_reveal', seconds: 2.9, about: 'The result revealed after the build: the moment it worked.' },
      { id: 'demo_a', role: 'interactive_demo', seconds: 0.73, about: 'The finished result being used.' },
      { id: 'demo_b', role: 'interactive_demo', seconds: 1.43, about: 'The finished result being used, a new angle.' },
      { id: 'demo_c', role: 'interactive_demo', seconds: 2.87, about: 'The last shot: the product clearly working.' },
    ],
  },
};

export const DIRECTOR_RULES = [
  'Pick the moment of peak action in each slot: the thing actually happening, not just before or after it.',
  'Every cut goes to a different angle or clip than the shot before it. Never use the same moment twice.',
  'Avoid camera junk: blur, the camera moving, half-framed screens, hands blocking what matters.',
  'Open strong and end on the result or product working, not on a text-heavy screen.',
];

/** Template from a name or a custom slot list. Custom slots: [{id, role, seconds, about?}], roles from the pack. */
export function resolveTemplate(a, packs, defaultPack) {
  if (a.slots?.length) {
    const pack = a.pack || defaultPack || 'general';
    const roles = Object.keys(packs[pack]?.questions.role.criteria || {});
    const slots = a.slots.map((s, i) => {
      const id = String(s.id || `slot_${i + 1}`);
      if (!roles.includes(s.role)) throw new Error(`Slot "${id}": role must be one of the "${pack}" pack's roles: ${roles.join(', ')}.`);
      const seconds = Number(s.seconds); if (!(seconds >= 0.3 && seconds <= 30)) throw new Error(`Slot "${id}": seconds must be 0.3–30.`);
      return { id, role: s.role, also: s.also || [], seconds, about: s.about || packs[pack].questions.role.criteria[s.role] };
    });
    if (new Set(slots.map((s) => s.id)).size !== slots.length) throw new Error('Slot ids must be unique.');
    return { name: a.template || 'custom', pack, about: a.about || 'custom template', slots };
  }
  const name = a.template || 'sketch-to-demo';
  const t = TEMPLATES[name]; if (!t) throw new Error(`Unknown template "${name}". Built in: ${Object.keys(TEMPLATES).join(', ')}; or pass slots.`);
  return { name, ...t, slots: t.slots.map((s) => ({ also: [], ...s })) };
}

const roleP = (as, roles) => roles.reduce((n, r) => n + (as.decisions?.answers?.role?.probabilities?.[r] || 0), 0);

/** Caster: candidates per slot (top-K clips by labeled role), and a first pick that spreads repeats over clips. */
export function cast(slots, assets, k = SWARM.k) {
  const uses = new Map();
  return slots.map((s) => {
    const roles = [s.role, ...(s.also || [])];
    const cands = assets.filter((as) => as.duration >= Math.min(s.seconds, 1)).map((as) => ({ as, p: roleP(as, roles) })).sort((x, y) => y.p - x.p).slice(0, k).filter((c) => c.p > 0.02);
    if (!cands.length) return { ...s, cands, pick: null };
    const c = [...cands].sort((x, y) => (uses.get(x.as.id) || 0) - (uses.get(y.as.id) || 0) || y.p - x.p)[0];
    const n = (uses.get(c.as.id) || 0) + 1; uses.set(c.as.id, n);
    const len = Math.min(s.seconds, c.as.duration);
    const mid = Math.min(c.as.duration - len / 2, Math.max(len / 2, c.as.duration * (n === 1 ? 0.5 : 0.75)));
    return { ...s, cands, pick: { asset: c.as.id, in: +(mid - len / 2).toFixed(2), p: c.p } };
  });
}

/** Scout windows: every WIN-second window (STEP apart) of each candidate clip, with the slots that want it. */
export function windowsFor(cast) {
  const byAsset = new Map();
  for (const s of cast) for (const c of s.cands) { const e = byAsset.get(c.as.id) || { as: c.as, slots: [] }; e.slots.push(s); byAsset.set(c.as.id, e); }
  const out = [];
  for (const { as, slots } of byAsset.values()) for (let t = 0; t + 0.6 <= as.duration; t += SWARM.step) out.push({ as, from: +t.toFixed(2), to: +Math.min(as.duration, t + SWARM.win).toFixed(2), slots });
  return out;
}

/** Trimmer: the best answered window for a slot, scaled down for junk and for clips already used (variety rule). */
export function bestWindow(windows, used) {
  const overlaps = (w) => used.some((u) => u.asset === w.as.id && w.from < u.out - 0.3 && w.to > u.in + 0.3);
  const scored = windows.map((w) => ({ ...w, score: w.p * (1 - 0.5 * w.junk) * SWARM.reuse ** used.filter((u) => u.asset === w.as.id).length })).sort((x, y) => y.score - x.score);
  return scored.find((w) => !overlaps(w)) || scored[0] || null;
}

/** One window cut from the decision proxy (already small: 360 px, 2 fps). */
export async function windowClip(proxyFile, from, to, out) {
  await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(from), '-t', String(Math.max(0.5, to - from)), '-i', proxyFile, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-c:a', 'aac', '-b:a', '32k', out]);
  return out;
}

/** A filmstrip: one frame per `step` seconds, COLS per row, left to right then down. Frame n is at second n × step. */
export async function filmstrip(file, duration, out, { cols = 5, height = 160, maxFrames = 60 } = {}) {
  const step = Math.max(1, Math.ceil(duration / maxFrames));
  const n = Math.max(1, Math.floor(duration / step));
  const rows = Math.ceil(n / cols);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `fps=1/${step},scale=-2:${height},tile=${cols}x${rows}:padding=4:margin=4:color=black`, '-frames:v', '1', '-q:v', '4', out]);
  return { step, cols, frames: n };
}
