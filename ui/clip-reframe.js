// A virtual camera in normalized source coordinates. Both preview and export evaluate
// the same clip-relative curve and clamp the camera to the source at every frame.
import { MOVE_EASES, easeProgress, easeExpression } from './clip-move.js';

export function validateReframe(value) {
  if (value == null) return null;
  const { keyframes, offset = 0 } = value;
  if (!Array.isArray(keyframes) || keyframes.length < 2 || keyframes.length > 8 ||
      !Number.isFinite(offset) || offset < 0) {
    throw new Error('An animated reframe needs 2–8 keyframes and a nonnegative time offset.');
  }
  return { offset, keyframes: keyframes.map((frame, i) => {
    if (!frame || Object.keys(frame).some(k => !['t', 'zoom', 'x', 'y', 'e'].includes(k))) {
      throw new Error('Reframe keyframes accept t, zoom, x, y, and e.');
    }
    const { t, zoom, x, y, e = 'io' } = frame;
    if (!Number.isFinite(t) || t < 0 || (i && t - keyframes[i - 1].t < .001 - 1e-9)) {
      throw new Error('Reframe times must be ordered clip-relative seconds at least 1 ms apart.');
    }
    if (!Number.isFinite(zoom) || zoom < 1 || zoom > 3 ||
        ![x, y].every(v => Number.isFinite(v) && v >= 0 && v <= 1) || !MOVE_EASES.includes(e)) {
      throw new Error(`Each reframe needs zoom 1–3, source x/y 0–1, and an ease from ${MOVE_EASES.join(', ')}.`);
    }
    return { t, zoom, x, y, e };
  }) };
}

export function cameraAt(reframe, localTime) {
  const { keyframes, offset } = reframe;
  const t = localTime + offset;
  const next = keyframes.findIndex(k => k.t > t);
  if (next <= 0) return next === 0 ? keyframes[0] : keyframes.at(-1);
  const a = keyframes[next - 1], b = keyframes[next];
  const q = easeProgress(b.e, (t - a.t) / (b.t - a.t));
  const lerp = key => a[key] + (b[key] - a[key]) * q;
  return { zoom: lerp('zoom'), x: lerp('x'), y: lerp('y') };
}

export function coverSize(sw, sh, w, h) {
  const scale = Math.max(w / sw, h / sh);
  return { w: sw * scale, h: sh * scale };
}

export function coverOffset(point, picture, frame, margin = 2) {
  const room = Math.max(0, (picture - frame) / 2 - margin);
  return Math.max(-room, Math.min(room, (0.5 - point) * picture));
}

export function reframeRect(reframe, localTime, sw, sh, W, H, margin = 2) {
  const camera = cameraAt(reframe, localTime);
  const base = coverSize(sw, sh, W, H);
  const w = base.w * camera.zoom, h = base.h * camera.zoom;
  return { w, h, x: (W - w) / 2 + coverOffset(camera.x, w, W, margin),
    y: (H - h) / 2 + coverOffset(camera.y, h, H, margin) };
}

export function cameraExpression({ keyframes }, key, t) {
  let result = keyframes.at(-1)[key];
  for (let i = keyframes.length - 1; i > 0; i--) {
    const a = keyframes[i - 1], b = keyframes[i];
    const q = `clip((${t}-${a.t})/${b.t - a.t},0,1)`;
    result = `if(lt(${t},${b.t}),${a[key]}+(${b[key] - a[key]})*${easeExpression(b.e, q)},${result})`;
  }
  return result;
}
