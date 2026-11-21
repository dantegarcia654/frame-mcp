// Keyframed position for footage clips (a face sliding into the bottom half, a panel sliding out).
// clip.move = [{ t, x?, y?, e? }]: t in seconds from the clip's start on the timeline, x/y offsets in frame fractions
// added to the clip's own x/y, e the ease INTO that keyframe. Shared by the window (ui/app.js) and export (src/render.js).
export const MOVE_CURVES = {
  lin: q => q,
  out: q => 1 - (1 - q) ** 3,
  in: q => q ** 3,
  io: q => q < .5 ? 4 * q ** 3 : 1 - (-2 * q + 2) ** 3 / 2,
  out4: q => 1 - (1 - q) ** 4,
};
export const MOVE_EASES = Object.keys(MOVE_CURVES);

export const easeProgress = (ease, q) => MOVE_CURVES[ease || 'lin'](q);
export const easeExpression = (ease, q) => ({
  lin: q, out: `(1-pow(1-${q},3))`, in: `pow(${q},3)`, out4: `(1-pow(1-${q},4))`,
  io: `if(lt(${q},0.5),4*pow(${q},3),1-pow(-2*${q}+2,3)/2)`,
}[ease || 'lin']);

export function validateMove(m) {
  if (m == null) return null;
  if (!Array.isArray(m) || !m.length || m.length > 16) throw new Error('move must be a list of 1–16 keyframes {t, x?, y?, e?}.');
  m.forEach((f, i) => {
    if (!f || typeof f !== 'object' || Object.keys(f).some((k) => !['t', 'x', 'y', 'e'].includes(k))) throw new Error('A move keyframe has only t, x, y and e.');
    if (!Number.isFinite(f.t) || f.t < 0 || (i && f.t < m[i - 1].t)) throw new Error('move keyframe times must be ordered seconds from the clip start.');
    for (const k of ['x', 'y']) if (f[k] != null && (!Number.isFinite(f[k]) || Math.abs(f[k]) > 3)) throw new Error(`move ${k} must be a frame fraction between -3 and 3.`);
    if (f.e != null && !MOVE_EASES.includes(f.e)) throw new Error(`move ease must be one of ${MOVE_EASES.join(', ')}.`);
  });
  return m.map((f) => ({ ...f }));
}

/** Offsets {x, y} at lt seconds into the clip. */
export function moveAt(c, lt) {
  const out = { x: 0, y: 0 }; const m = c.move; if (!m?.length) return out;
  for (const k of ['x', 'y']) {
    let p = null, n = null;
    for (const f of m) { if (f[k] == null) continue; if (f.t <= lt) p = f; else { n = f; break; } }
    if (!p && !n) continue; if (!p) { out[k] = n[k]; continue; } if (!n) { out[k] = p[k]; continue; }
    const q = Math.min(1, Math.max(0, (lt - p.t) / Math.max(1e-6, n.t - p.t)));
    out[k] = p[k] + (n[k] - p[k]) * easeProgress(n.e, q);
  }
  return out;
}

/** ffmpeg expression (variable t = output time) for base + offset of key k; t0 = the clip's start in output time. */
export function moveExpr(c, k, base, size, t0) {
  const fs = (c.move || []).filter((f) => f[k] != null);
  if (!fs.length) return String(base);
  const n = (v) => (Math.round(v * 1e4) / 1e4).toString();
  const u = `(t-(${n(t0)}))`;
  let expr = n(base + fs.at(-1)[k] * size);
  for (let i = fs.length - 1; i > 0; i--) {
    const a = fs[i - 1], b = fs[i], q = `clip((${u}-${n(a.t)})/${n(Math.max(1e-6, b.t - a.t))},0,1)`;
    expr = `if(lt(${u},${n(b.t)}),${n(base + a[k] * size)}+(${n((b[k] - a[k]) * size)})*${easeExpression(b.e, q)},${expr})`;
  }
  return `if(lt(${u},${n(fs[0].t)}),${n(base + fs[0][k] * size)},${expr})`;
}
