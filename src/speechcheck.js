// Speech cut-off check: a cut must never land while the speaker is still talking.
// Reads each source's measured loudness envelope (RMS every 20 ms, cached at import) and looks at every
// V1 edge: speech still sounding across an out point clips the end of a word; speech already sounding
// before an in point clips its start. Contiguous splits of the same source are not cuts and are skipped.
// Nothing here is a guess: levels are measured against each source's own noise floor.

const MAX_FIX = 0.6;      // longer than this and the cut probably removes a take on purpose: flag, don't fix
const PAD = 0.04;         // a breath of air after the last sound / before the first

function levels(env) {
  const r = env.rms, sorted = r.filter((x) => x > 0).sort((a, b) => a - b);
  const noise = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0.001;
  return { r, rate: env.rate, on: Math.max(noise * 5, 0.012), off: Math.max(noise * 2.2, 0.0045) };
}
const at = (L, t) => L.r[Math.max(0, Math.min(L.r.length - 1, Math.round(t * L.rate)))] || 0;
const peak = (L, a, b) => { let m = 0; for (let t = a; t <= b + 1e-9; t += 1 / L.rate) m = Math.max(m, at(L, t)); return m; };
function quietFrom(L, t, dir) {             // first time (moving dir = ±1) with 100 ms below the off level
  const step = 1 / L.rate; let run = 0;
  for (let k = 0; k < 4 * L.rate; k++) {
    const x = t + dir * k * step;
    if (at(L, x) < L.off) { if (++run >= 5) return x - dir * 4 * step; } else run = 0;
  }
  return null;
}
const wordAt = (a, s) => {
  const ws = a.transcript?.words || [];
  const hit = ws.find((w) => s >= w.start - 0.05 && s <= w.end + 0.05);
  if (hit) return hit.text;
  const before = ws.filter((w) => w.end <= s + 0.05 && s - w.end < 1.0).pop();   // a tail past the transcript's word end
  return before ? before.text : '';
};

export function speechCutoffs(p, loadEnv) {
  const v1 = p.clips.filter((c) => c.track === 'V1' && (c.kind === 'video' || c.kind === 'audio') && !c.muted).sort((a, b) => a.start - b.start);
  const out = [];
  v1.forEach((c, i) => {
    const a = p.assets[c.asset]; if (!a?.hasAudio) return;
    const env = loadEnv(c.asset); if (!env?.rms?.length) return;
    const L = levels(env), sp = c.speed || 1, prev = v1[i - 1], next = v1[i + 1];
    // END edge
    const contEnd = next && next.asset === c.asset && Math.abs(next.in - c.out) < 0.03;
    if (!contEnd && peak(L, c.out - 0.02, c.out + 0.06) > L.on && at(L, c.out - 0.02) > L.off) {
      const q = quietFrom(L, c.out, +1), need = q == null ? Infinity : q - c.out + PAD;
      out.push({ id: c.id, edge: 'end', t: c.start + (c.out - c.in) / sp, word: wordAt(a, c.out - 0.05), by: Math.round(need * 100) / 100, fix: need <= MAX_FIX });
    }
    // START edge
    const contStart = prev && prev.asset === c.asset && Math.abs(c.in - prev.out) < 0.03;
    if (!contStart && peak(L, c.in - 0.06, c.in - 0.02) > L.on) {
      const q = quietFrom(L, c.in, -1), need = q == null ? Infinity : c.in - q + PAD;
      out.push({ id: c.id, edge: 'start', t: c.start, word: wordAt(a, c.in + 0.05), by: Math.round(need * 100) / 100, fix: need <= MAX_FIX });
    }
  });
  return out.sort((x, y) => x.t - y.t);
}

// Padded dead air: the last sound of a V1 clip ends well before its cut. Report only: sometimes the pause is the point.
export function deadAir(p, loadEnv, limit = 0.35) {
  const v1 = p.clips.filter((c) => c.track === 'V1' && (c.kind === 'video' || c.kind === 'audio') && !c.muted).sort((a, b) => a.start - b.start);
  const out = [];
  v1.forEach((c, i) => {
    const a = p.assets[c.asset]; if (!a?.hasAudio) return; const env = loadEnv(c.asset); if (!env?.rms?.length) return;
    const next = v1[i + 1]; if (next && next.asset === c.asset && Math.abs(next.in - c.out) < 0.03) return;
    const L = levels(env); let last = null;
    for (let t = c.out; t >= c.in; t -= 1 / L.rate) if (at(L, t) > L.off) { last = t; break; }
    if (last == null) return;
    const gap = c.out - last;
    if (gap > limit) out.push({ id: c.id, t: c.start + (last - c.in) / (c.speed || 1), gap: Math.round(gap * 100) / 100, word: wordAt(a, last - 0.05) });
  });
  return out;
}
export function deadAirLines(list, tc) {
  return list.map((x) => `Dead air: ${x.gap}s of silence after "${x.word}" at ${tc(x.t)} before the cut (${x.id}) — trim it unless the pause is deliberate`);
}

export function cutoffLines(list, tc) {
  return list.map((x) => `Speech cut off at ${tc(x.t)} (${x.edge === 'end' ? 'end of' : 'start of'} "${x.word}") — ${x.fix ? `extend ${x.edge} of ${x.id} by ${x.by}s` : 'speech keeps going for more than 0.6 s: probably a removed take, check by ear'}`);
}
