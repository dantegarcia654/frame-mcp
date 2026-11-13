// Frame UI. Shows the daemon's project state live, previews the timeline in real time, and lets the human edit the same timeline.
import { drawText, rasterText, textKey } from './text-draw.js';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tc = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(2).padStart(5, '0')}`; };
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const dur = (c) => (c.out - c.in) / (c.speed || 1);
const end = (c) => c.start + dur(c);
const post = (body) => fetch('/api/ui', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).then((r) => { if (r.error) toast(r.error); return r; });

let P = null;            // project
let lastCallAt = 0;
let T = 0;               // playhead (timeline seconds)
let playing = false, playT0 = 0, playW0 = 0;
let sel = null;          // selected clip id
let pps = 40, autoFit = true;
let known = new Set(), knownFeed = new Set(), firstState = true;
let drag = null;         // in-progress manual drag (overrides server state for one clip)
let renderView = null;   // render id being played
const envCache = {};
const seenUi = new Set();

// ───────────────────────── state stream
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === 'state') onState(m); };
  es.onerror = () => { setStatus('', 'Reconnecting…'); };
}
function onState(m) {
  const switched = !P || !m.project || P.id !== m.project.id;
  P = m.project; lastCallAt = m.lastCallAt || lastCallAt;
  if (switched) { known = new Set(); knownFeed = new Set(); $('#feed').innerHTML = ''; sel = null; T = 0; firstState = true; autoFit = true; renderView = null; showRender(null); }
  renderProjects(m.projects || []);
  $('#empty').hidden = !!(P && (P.clips.length || Object.keys(P.assets).length));
  if (!P) { $('#empty').hidden = false; return; }
  document.title = `${P.name} — Frame`;
  if (sel && !P.clips.some((c) => c.id === sel)) sel = null;
  renderBin(); renderSteps(); renderFeed(); renderTimeline(); renderInspector(); renderStatus(); rasterizeTexts();
  if (m.focus) focus(m.focus);
  if (m.rendered) showRender(m.rendered);
  firstState = false;
}

function renderProjects(list) {
  const s = $('#projects');
  s.innerHTML = list.map((p) => `<option value="${p.id}" ${P && p.id === P.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('') || '<option>No project</option>';
}
$('#projects').onchange = (e) => post({ action: 'open', id: e.target.value });

function setStatus(cls, label) { const s = $('#status'); s.className = cls; s.querySelector('span').textContent = label; }
function renderStatus() {
  if (!P) return setStatus('', 'Waiting for Claude');
  const ago = (Date.now() - lastCallAt) / 1000;
  const r = P.renders.at(-1);
  $('#pause').textContent = P.paused ? 'Resume Claude' : 'Pause Claude';
  const bar = $('#renderBar');
  if (r && r.status === 'rendering') { bar.hidden = false; bar.querySelector('i').style.width = `${Math.round((r.progress || 0) * 100)}%`; bar.querySelector('span').textContent = `RENDERING ${Math.round((r.progress || 0) * 100)}%`; }
  else bar.hidden = true;
  $('#pending').textContent = P.pending ? `${P.pending} item${P.pending > 1 ? 's' : ''} waiting — Claude reads them at its next step.` : 'Claude reads this at its next step.';
  if (P.paused) return setStatus('hold', 'Paused by you');
  if (r && r.status === 'rendering') return setStatus('live', `Rendering ${Math.round((r.progress || 0) * 100)}%`);
  if (P.status.state === 'waiting') return setStatus('hold', 'Claude is waiting for you');
  if (ago < 6) return setStatus('live', 'Claude is editing');
  if (ago < 180) return setStatus('warm', `Claude active · last action ${Math.round(ago)}s ago`);
  setStatus('', lastCallAt ? 'Idle' : 'Waiting for Claude');
}
setInterval(renderStatus, 1000);

// ───────────────────────── bin + steps
// Audio packs: sounds and soundtracks saved inside Frame. Click ▶ to hear one, + to add it to the project's bin.
let packsBusy = 0, packsSig = '', previewAudio = null;
async function loadPacks() {
  if (Date.now() - packsBusy < 1500) return; packsBusy = Date.now();
  let r; try { r = await (await fetch('/api/packs')).json(); } catch { return; }
  const sig = JSON.stringify(r.packs.map((p) => [p.id, p.updatedAt])); if (sig === packsSig) return; packsSig = sig;
  const box = $('#packs'); if (!box) return; box.innerHTML = ''; $('#packCount').textContent = r.packs.reduce((n, p) => n + p.items.length, 0) || '';
  for (const pk of r.packs) {
    const h = el('div', 'pk', `<b>${esc(pk.name)}</b> <span class="dim">${pk.items.length}</span>`); box.append(h);
    for (const it of pk.items) {
      const row = el('div', 'pkItem', `<span class="nm">${esc(it.name)}</span><span class="dim">${it.kind} · ${it.duration}s</span>`); row.title = it.desc || it.source || '';
      const play = el('button', '', '▶'), add = el('button', '', '+');
      play.onclick = () => { previewAudio?.pause(); previewAudio = new Audio(`/pack/${encodeURIComponent(pk.id)}/${encodeURIComponent(it.file)}`); previewAudio.volume = 0.6; previewAudio.play().catch(() => {}); };
      add.onclick = () => post({ action: 'pack_use', pack: pk.id, item: it.id });
      row.append(play, add); box.append(row);
    }
  }
}
function renderBin() {
  loadPacks();
  const bin = $('#bin'); bin.dataset.empty = 'Nothing imported yet.';
  const assets = Object.values(P.assets);
  $('#mediaCount').textContent = assets.length || '';
  bin.innerHTML = '';
  for (const a of assets) {
    const d = el('div', `asset${seenUi.has(a.id) ? '' : ' new'}`); seenUi.add(a.id);
    const th = el('div', 'th');
    if (a.thumbs) { const mid = Math.floor(a.thumbs / 2); th.style.backgroundImage = `url(/thumbs/${P.id}/${a.id})`; th.style.backgroundSize = `${a.thumbs * 100}% 100%`; th.style.backgroundPosition = a.thumbs > 1 ? `${(mid / (a.thumbs - 1)) * 100}% 0` : 'center'; }
    else th.textContent = a.kind === 'audio' ? '♪' : '';
    if (a.busy) th.append(el('div', 'busy', esc(a.busy)));
    d.append(th, el('div', 'nm', esc(a.name)), el('div', 'mt', `${a.id} · ${a.duration ? tc(a.duration) : a.kind}${a.transcript ? ' · words' : ''}`));
    d.title = `${a.path}\n${a.width ? `${a.width}×${a.height} · ` : ''}${a.loudness ? `${a.loudness.lufs} LUFS` : ''}\nDouble-click to add at the end of the timeline`;
    d.ondblclick = () => post({ action: 'ops', ops: [{ op: 'add_clip', asset: a.id }] });
    bin.append(d);
  }
}
$('#addPath').onsubmit = (e) => { e.preventDefault(); const i = e.target.querySelector('input'); const v = i.value.trim().replace(/^['"]|['"]$/g, ''); if (v && P) post({ action: 'import', paths: [v] }).then((r) => { if (!r.error) i.value = ''; }); };

function renderSteps() {
  const box = $('#steps'); box.dataset.empty = 'Scripts, generations and other work Claude does outside the timeline show up here, with the exact code.';
  $('#stepCount').textContent = P.steps.length || '';
  box.innerHTML = '';
  for (const s of P.steps) {
    const d = el('div', `step ${s.status}${seenUi.has(s.id) ? '' : ' new'}`, `<b>${esc(s.title || 'Process')}</b><small>${esc(s.tool || '')}${s.tool ? ' · ' : ''}${s.status}${s.endedAt ? ` · ${((s.endedAt - s.startedAt) / 1000).toFixed(1)}s` : ''}</small>`);
    seenUi.add(s.id); d.onclick = () => openStep(s.id); box.append(d);
  }
}
function openStep(id) {
  const s = P.steps.find((x) => x.id === id); if (!s) return;
  modal(s.title || 'Process', `${s.tool || 'process'} · ${s.status}${s.note ? `\n${s.note}` : ''}${s.outputs?.length ? `\nOutputs: ${s.outputs.map((o) => P.assets[o]?.name || o).join(', ')}` : ''}`, s.code || '(no code recorded)');
}
function modal(title, meta, code, img) {
  const m = $('#modal'); m.hidden = false;
  m.querySelector('h2').textContent = title; m.querySelector('.meta').textContent = meta || '';
  const pre = m.querySelector('pre'); pre.hidden = !code; pre.textContent = code || '';
  m.querySelector('img')?.remove(); if (img) { const i = el('img'); i.src = img; m.querySelector('.sheet').append(i); }
}
$('#closeModal').onclick = () => ($('#modal').hidden = true);
$('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; };

// ───────────────────────── feed
function renderFeed() {
  const box = $('#feed');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  for (const f of P.feed) {
    if (knownFeed.has(f.id)) continue; knownFeed.add(f.id);
    const d = el('div', `f ${f.kind} ${f.actor === 'user' ? 'user' : ''}`);
    const who = f.actor === 'user' ? 'You' : f.actor === 'frame' ? 'Frame' : (f.agent || 'Claude');
    const tag = { thinking: 'thinking', decision: 'decision', plan: 'plan', question: 'asks you', look: 'looked', render: 'render', step: 'process', op: f.op }[f.kind] || '';
    d.innerHTML = `<div class="who"><span>${esc(who)}${tag ? ' · ' + esc(tag) : ''}</span><span>${new Date(f.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div><div class="tx">${esc(f.text)}</div>${f.why ? `<div class="why">${esc(f.why)}</div>` : ''}`;
    if (f.img) { const i = el('img'); i.src = f.img; i.onclick = (e) => { e.stopPropagation(); modal(f.text, f.why, null, f.img); }; d.append(i); }
    if (f.kind === 'op' || f.kind === 'look') d.onclick = () => { if (f.t != null) seek(f.t); if (f.clipIds?.length && P.clips.some((c) => c.id === f.clipIds[0])) select(f.clipIds[0]); };
    if (f.kind === 'step') d.onclick = () => openStep(f.stepId);
    if (f.kind === 'render' && f.done) {
      const b = el('div', 'btns'); const play = el('button', 'solid', '▶ Play render'); const rev = el('button', '', 'Show file');
      play.onclick = () => showRender(f.renderId); rev.onclick = () => post({ action: 'reveal', id: f.renderId }); b.append(play, rev); d.append(b);
    }
    if (firstState) d.style.animation = 'none';
    box.append(d);
  }
  if (stick || firstState) box.scrollTop = box.scrollHeight;
}
const composer = $('#composer textarea');
function sendMessage() { const v = composer.value.trim(); if (!v || !P) return; post({ action: 'message', text: v, t: T, clip: sel }); composer.value = ''; }
$('#composer').onsubmit = (e) => { e.preventDefault(); sendMessage(); };
composer.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

// ───────────────────────── timeline
const laneH = (t) => (t[0] === 'V' ? 50 : t[0] === 'T' ? 26 : 38);
const view = (c) => (drag && drag.id === c.id ? { ...c, ...drag.cur } : c);
function fitPps() { const w = $('#scroll').clientWidth - 30; return clamp(w / Math.max(P?.duration || 0, 8), 4, 400); }
function renderTimeline() {
  if (autoFit) pps = fitPps();
  const total = Math.max(P.duration, 8) + 4;
  const lanes = $('#lanes'); lanes.style.width = `${total * pps + 60}px`;
  $('#tlinfo').textContent = `${tc(P.duration)} · ${P.clips.length} clips · ${P.width}×${P.height} · ${P.fps} fps`;
  $('#dur').textContent = tc(P.duration);
  // ruler
  const ruler = $('#ruler'); ruler.innerHTML = '';
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pps >= 64) || 300;
  for (let t = 0; t <= total; t += step) { const i = el('i', '', tc(t).replace(/\.00$/, '')); i.style.left = `${t * pps}px`; ruler.append(i); }
  // lanes
  const heads = $('#heads'), rows = $('#rows'); heads.innerHTML = ''; rows.innerHTML = '';
  for (const t of P.tracks) {
    const h = el('div', '', t); h.style.height = `${laneH(t)}px`; heads.append(h);
    const lane = el('div', 'lane'); lane.style.height = `${laneH(t)}px`; lane.dataset.track = t; rows.append(lane);
    for (const raw of P.clips.filter((c) => c.track === t)) lane.append(clipEl(raw, laneH(t)));
  }
  known = new Set(P.clips.map((c) => c.id));
  const mk = $('#markers'); mk.innerHTML = '';
  for (const m of P.markers) { const i = el('i', '', esc(m.label)); i.style.left = `${m.t * pps}px`; mk.append(i); }
  placePlayhead();
}
function clipEl(raw, h) {
  const c = view(raw), a = P.assets[c.asset];
  const d = el('div', `clip ${c.kind}${c.id === sel ? ' sel' : ''}${!known.has(c.id) && !firstState ? ' enter' : ''}`);
  d.dataset.id = c.id;
  const w = Math.max(3, dur(c) * pps);
  d.style.left = `${c.start * pps}px`; d.style.width = `${w}px`;
  if (c.kind === 'text') d.append(el('span', 'lb', esc(c.text.content)));
  else {
    if (a?.thumbs) {
      const tiles = el('div', 'tiles'); const n = clamp(Math.ceil(w / (h * 0.62)), 1, 40);
      for (let k = 0; k < n; k++) {
        const i = el('i'); const t = c.kind === 'image' ? 0 : c.in + ((k + 0.5) / n) * (c.out - c.in);
        const idx = a.thumbs > 1 ? clamp(Math.floor((t / a.duration) * a.thumbs), 0, a.thumbs - 1) : 0;
        i.style.backgroundImage = `url(/thumbs/${P.id}/${a.id})`; i.style.backgroundSize = `${a.thumbs * 100}% 100%`; i.style.backgroundPosition = a.thumbs > 1 ? `${(idx / (a.thumbs - 1)) * 100}% 0` : 'center';
        if (c.kind === 'image') i.style.backgroundSize = 'cover';
        tiles.append(i);
      }
      d.append(tiles);
    }
    if (a?.hasEnv && !c.muted) { const cv = el('canvas'); cv.height = c.kind === 'audio' ? h - 8 : 14; cv.style.height = `${cv.height}px`; cv.width = clamp(Math.round(w), 2, 4000); d.append(cv); drawWave(cv, c, a); }
    d.append(el('span', 'lb', esc(c.label || a?.name || c.id)));
    const fx = [c.key && 'KEY', c.grade && 'GRADE', c.speed !== 1 && `${c.speed}×`, c.muted && 'MUTE', (c.fadeIn || c.fadeOut) && 'FADE', c.scale && c.scale !== 1 && 'SCALE'].filter(Boolean);
    if (fx.length) d.append(el('span', 'fx', fx.join(' ')));
  }
  d.append(el('div', 'h l'), el('div', 'h r'));
  d.onmousedown = (e) => startDrag(e, raw);
  return d;
}
async function drawWave(cv, c, a) {
  const key = `${P.id}/${a.id}`;
  envCache[key] ||= fetch(`/env/${key}`).then((r) => r.json()).catch(() => null);
  const env = await envCache[key]; if (!env) return;
  const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
  if (c.kind !== 'audio') { g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(0, 0, cv.width, cv.height); }
  g.fillStyle = '#fff';
  for (let x = 0; x < cv.width; x++) {
    const t0 = c.in + (x / cv.width) * (c.out - c.in), t1 = c.in + ((x + 1) / cv.width) * (c.out - c.in);
    let pk = 0; for (let i = Math.floor(t0 * env.rate); i <= Math.floor(t1 * env.rate); i++) pk = Math.max(pk, env.peaks[i] || 0);
    const hh = Math.max(1, (pk / 255) * cv.height * Math.min(1.4, c.volume ?? 1));
    g.fillRect(x, (cv.height - hh) / (c.kind === 'audio' ? 2 : 1), 1, hh);
  }
}
function placePlayhead() { $('#playhead').style.left = `${T * pps}px`; $('#tc').textContent = tc(T); }
function select(id) { sel = id; document.querySelectorAll('.clip').forEach((d) => d.classList.toggle('sel', d.dataset.id === id)); renderInspector(); }

// manual editing: move / trim
function startDrag(e, raw) {
  if (e.button !== 0) return;
  e.stopPropagation(); select(raw.id);
  const mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
  const x0 = e.clientX, a = P.assets[raw.asset]; let moved = false;
  const edges = [0, T, ...P.clips.filter((c) => c.id !== raw.id).flatMap((c) => [c.start, end(c)])];
  const snap = (t) => { for (const s of edges) if (Math.abs(s - t) * pps < 7) return s; return t; };
  const stretch = raw.kind === 'text' || raw.kind === 'image';
  const move = (ev) => {
    const dx = (ev.clientX - x0) / pps; if (Math.abs(ev.clientX - x0) > 2) moved = true; if (!moved) return;
    const cur = {};
    if (mode === 'move') {
      let s = snap(raw.start + dx); if (s === raw.start + dx) { const e2 = snap(raw.start + dx + dur(raw)); if (e2 !== raw.start + dx + dur(raw)) s = e2 - dur(raw); }
      cur.start = Math.max(0, s);
      const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.lane');
      if (lane && lane.dataset.track[0] === raw.track[0]) cur.track = lane.dataset.track;
    } else if (mode === 'l') {
      let s = clamp(snap(raw.start + dx), stretch ? 0 : raw.start - raw.in / raw.speed, end(raw) - 0.1); s = Math.max(0, s);
      cur.start = s; if (stretch) cur.out = raw.out - (s - raw.start); else cur.in = raw.in + (s - raw.start) * raw.speed;
    } else {
      const maxEnd = stretch ? Infinity : raw.start + (a.duration - raw.in) / raw.speed;
      const e2 = clamp(snap(end(raw) + dx), raw.start + 0.1, maxEnd);
      cur.out = raw.in + (e2 - raw.start) * raw.speed;
    }
    drag = { id: raw.id, cur }; renderTimeline();
  };
  const up = () => {
    removeEventListener('mousemove', move); removeEventListener('mouseup', up);
    if (!drag) return;
    const c = drag.cur, r3 = (n) => Math.round(n * 1000) / 1000;
    const op = { op: 'update_clip', id: raw.id };
    if (c.start != null && c.start !== raw.start) op.start = r3(c.start);
    if (c.track && c.track !== raw.track) op.track = c.track;
    if (c.in != null) op.in = r3(c.in);
    if (c.out != null) { if (stretch) op.duration = r3(c.out); else op.out = r3(c.out); }
    Object.assign(raw, c);
    post({ action: 'ops', ops: [op] }).finally(() => { drag = null; renderTimeline(); }); // re-render: the server may have rippled the timeline differently from the drop position
  };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
}
$('#lanes').onmousedown = (e) => {
  if (e.target.closest('.clip')) return;
  if (renderView) showRender(null);
  const scrub = (ev) => { const r = $('#lanes').getBoundingClientRect(); seek(Math.max(0, (ev.clientX - r.left) / pps)); };
  scrub(e); if (!e.target.closest('#ruler')) select(null);
  const up = () => { removeEventListener('mousemove', scrub); removeEventListener('mouseup', up); };
  addEventListener('mousemove', scrub); addEventListener('mouseup', up);
};
$('#zoom').oninput = (e) => { autoFit = false; const f = fitPps(); pps = f * Math.pow(400 / f, e.target.value / 100); renderTimeline(); $('#scroll').scrollLeft = T * pps - $('#scroll').clientWidth / 2; };
$('#fit').onclick = () => { autoFit = true; $('#zoom').value = 0; renderTimeline(); };
addEventListener('resize', () => { if (P) renderTimeline(); sizeViewer(); });

// Claude's cursor: fly to whatever it just changed.
let cursorTimer;
function focus(f) {
  const cur = $('#cursor'); let target = null;
  for (const id of f.clipIds || []) { const d = document.querySelector(`.clip[data-id="${id}"]`); if (d) { d.classList.add('touch'); target ||= d; } }
  if ($('#follow').checked && f.t != null && !playing && !drag) { if (renderView) showRender(null); seek(f.t + 0.02); const sc = $('#scroll'); const x = f.t * pps; if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 80) sc.scrollLeft = Math.max(0, x - sc.clientWidth / 3); }
  const r = (target || $('#playhead')).getBoundingClientRect();
  cur.querySelector('span').textContent = f.agent || 'Claude';
  cur.style.opacity = 1; cur.style.transform = `translate(${clamp(r.left + Math.min(r.width / 2, 40), 0, innerWidth - 80)}px, ${r.top + r.height / 2}px)`;
  clearTimeout(cursorTimer); cursorTimer = setTimeout(() => (cur.style.opacity = 0), 2600);
}

// ───────────────────────── inspector
const num = (label, key, step = 0.01, get, put) => ({ label, key, step, get, put });
const FIELDS = [
  num('Start', 'start'), num('Source in', 'in'), num('Source out', 'out'), num('Speed', 'speed', 0.05), num('Volume', 'volume', 0.05),
  num('Scale', 'scale', 0.01), num('X', 'x', 0.01), num('Y', 'y', 0.01), num('Opacity', 'opacity', 0.05), num('Fade in', 'fadeIn', 0.05), num('Fade out', 'fadeOut', 0.05),
];
function renderInspector() {
  const box = $('#inspector'); const ae = document.activeElement;
  if (ae && box.contains(ae) && ae.tagName !== 'BUTTON') return; // don't rebuild while typing
  const c = P?.clips.find((x) => x.id === sel);
  if (!P) { box.innerHTML = ''; return; }
  if (!c) {
    const r = P.renders.filter((x) => x.status === 'done').at(-1);
    box.innerHTML = `<h3>Scope <span>luma, live</span></h3><canvas id="scope" width="184" height="64"></canvas><h3>Project</h3>
      <div class="kv"><span>Canvas</span><span>${P.width}×${P.height}</span></div><div class="kv"><span>Frame rate</span><span>${P.fps}</span></div>
      <div class="kv"><span>Duration</span><span>${tc(P.duration)}</span></div><div class="kv"><span>Clips</span><span>${P.clips.length}</span></div>
      <div class="kv"><span>Timeline version</span><span>${P.version}</span></div>
      ${r ? `<h3>Last render</h3><div class="kv"><span>Size</span><span>${r.width}×${r.height}</span></div><div class="kv"><span>Length</span><span>${tc(r.duration)}</span></div>${r.loudness ? `<div class="kv"><span>Loudness</span><span>${r.loudness.lufs} LUFS</span></div>` : ''}<div class="acts"><button id="playLast" class="solid">▶ Play</button><button id="revealLast">Show file</button></div>` : ''}
      <div class="sec" style="padding-top:16px;text-transform:none;letter-spacing:0;line-height:1.5">Select a clip to see and change exactly what Claude set on it.</div>`;
    if (r) { $('#playLast').onclick = () => showRender(r.id); $('#revealLast').onclick = () => post({ action: 'reveal', id: r.id }); }
    return;
  }
  const a = P.assets[c.asset];
  box.innerHTML = `<h3>${c.kind} clip <span>${c.id}</span></h3>`;
  const row = (label, input) => { const r = el('div', 'row'); r.append(el('label', '', label), input); box.append(r); return input; };
  const send = (props) => post({ action: 'ops', ops: [{ op: 'update_clip', id: c.id, ...props }] });
  const numIn = (v, step, on) => { const i = el('input'); i.type = 'number'; i.step = step; i.value = v ?? ''; i.onchange = () => { if (i.value !== '') on(Number(i.value)); i.blur(); }; return i; };
  if (c.kind === 'text') {
    const ta = el('textarea'); ta.rows = 2; ta.value = c.text.content; ta.onchange = () => { send({ text: ta.value }); ta.blur(); }; const r = el('div', 'row'); r.append(ta); box.append(r);
    row('Start', numIn(c.start, 0.01, (v) => send({ start: v })));
    row('Duration', numIn(+dur(c).toFixed(3), 0.01, (v) => send({ duration: v })));
    box.append(el('div', 'sec', 'Style'));
    for (const [l, k, s] of [['Size', 'size', 0.005], ['Position X', 'x', 0.01], ['Position Y', 'y', 0.01], ['Max width', 'maxWidth', 0.02], ['Outline', 'strokeWidth', 0.02], ['Weight', 'weight', 100]]) row(l, numIn(c.text[k], s, (v) => send({ style: { [k]: v } })));
    for (const [l, k] of [['Colour', 'color'], ['Outline col.', 'stroke'], ['Box', 'bg']]) { const i = el('input'); i.value = c.text[k] || ''; i.placeholder = 'none'; i.onchange = () => { send({ style: { [k]: i.value || null } }); i.blur(); }; row(l, i); }
  } else {
    box.append(el('div', 'kv', `<span>Source</span><span>${esc((a?.name || '').slice(0, 18))}</span>`));
    for (const f of FIELDS) { if (c.kind === 'audio' && ['scale', 'x', 'y', 'opacity'].includes(f.key)) continue; if (c.kind === 'image' && ['in', 'out', 'speed', 'volume'].includes(f.key)) continue; row(f.label, numIn(c[f.key] ?? (['fadeIn', 'fadeOut', 'x', 'y'].includes(f.key) ? 0 : 1), f.step, (v) => send({ [f.key]: v }))); }
    if (c.kind === 'image') row('Duration', numIn(+dur(c).toFixed(3), 0.01, (v) => send({ duration: v })));
    if (c.kind !== 'audio') {
      box.append(el('div', 'sec', 'Grade'));
      for (const k of ['brightness', 'contrast', 'saturation']) row(k[0].toUpperCase() + k.slice(1), numIn(c.grade?.[k] ?? 1, 0.05, (v) => send({ grade: { [k]: v } })));
      box.append(el('div', 'sec', 'Chroma key'));
      const on = el('select'); on.innerHTML = '<option value="0">Off</option><option value="1">On</option>'; on.value = c.key ? '1' : '0'; on.onchange = () => send({ key: on.value === '1' ? {} : null }); row('Key', on);
      if (c.key) { const col = el('input'); col.value = c.key.color; col.onchange = () => send({ key: { color: col.value } }); row('Colour', col); row('Similarity', numIn(c.key.similarity, 0.01, (v) => send({ key: { similarity: v } }))); row('Blend', numIn(c.key.blend, 0.01, (v) => send({ key: { blend: v } }))); }
    }
  }
  const acts = el('div', 'acts');
  const b = (t, fn) => { const x = el('button', '', t); x.onclick = fn; acts.append(x); };
  b('Split at playhead', splitSel); b('Delete', () => delSel(false)); b('Ripple delete', () => delSel(true));
  if (c.kind !== 'audio' && c.kind !== 'text') b(c.muted ? 'Unmute' : 'Mute', () => send({ muted: !c.muted }));
  box.append(acts);
}
function splitSel() { const c = P.clips.find((x) => x.id === sel) || P.clips.find((x) => x.track === 'V1' && T > x.start && T < end(x)); if (c && T > c.start && T < end(c)) post({ action: 'ops', ops: [{ op: 'split_clip', id: c.id, at: Math.round(T * 1000) / 1000 }] }); }
function delSel(ripple) { if (sel) post({ action: 'ops', ops: [{ op: 'delete_clip', id: sel, ripple }] }); }

// ───────────────────────── header actions + keys
$('#pause').onclick = () => P && post({ action: P.paused ? 'resume' : 'pause' });
$('#undo').onclick = () => post({ action: 'undo' }); $('#redo').onclick = () => post({ action: 'redo' });
$('#render').onclick = () => P && post({ action: 'render', quality: 'final' });
$('#play').onclick = () => togglePlay();
$('#backToTimeline').onclick = () => showRender(null);
addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 's' || e.key === 'S') splitSel();
  else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); delSel(e.shiftKey); }
  else if (e.key === 'ArrowLeft') seek(Math.max(0, T - (e.shiftKey ? 1 : 1 / (P?.fps || 30))));
  else if (e.key === 'ArrowRight') seek(T + (e.shiftKey ? 1 : 1 / (P?.fps || 30)));
  else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post({ action: e.shiftKey ? 'redo' : 'undo' }); }
  else if (e.key === 'Escape') { $('#modal').hidden = true; select(null); }
});
let toastT; function toast(msg) { let t = $('#toast'); if (!t) { t = el('div'); t.id = 'toast'; t.style.cssText = 'position:fixed;left:50%;top:54px;transform:translateX(-50%);background:#fff;color:#000;padding:7px 14px;border-radius:3px;z-index:70;font-weight:600;max-width:70vw'; document.body.append(t); } t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 4200); }

// ───────────────────────── real-time preview engine
const cv = $('#viewer'), ctx = cv.getContext('2d');
const slots = new Map(), images = new Map();
const keyCv = document.createElement('canvas'), keyCtx = keyCv.getContext('2d', { willReadFrequently: true });
function sizeViewer() {
  if (!P) return;
  const k = Math.min(1, 960 / Math.max(P.width, P.height));
  const w = Math.round(P.width * k), h = Math.round(P.height * k);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const wrap = $('#viewerWrap'), aw = wrap.clientWidth - 28, ah = wrap.clientHeight - 28, s = Math.min(aw / w, ah / h);
  for (const e of [cv, $('#renderPlayer')]) { e.style.width = `${Math.floor(w * s)}px`; e.style.height = `${Math.floor(h * s)}px`; }
}
function seek(t) { T = Math.max(0, t); if (playing) { playT0 = T; playW0 = performance.now(); } placePlayhead(); }
function togglePlay() {
  if (renderView) { const v = $('#renderPlayer'); v.paused ? v.play() : v.pause(); return; }
  if (!P || !P.duration) return;
  playing = !playing; $('#play').textContent = playing ? '❚❚' : '▶';
  if (playing) { if (T >= P.duration - 0.05) T = 0; playT0 = T; playW0 = performance.now(); }
}
function fadeK(c, t) { const lt = t - c.start, d = dur(c); let k = 1; if (c.fadeIn && lt < c.fadeIn) k *= Math.max(0, lt / c.fadeIn); if (c.fadeOut && lt > d - c.fadeOut) k *= Math.max(0, (d - lt) / c.fadeOut); return k; }
function mediaFor(c, idx) {
  const key = `${c.track}:${idx % 2}`; let s = slots.get(key);
  if (!s) { s = { el: document.createElement(c.kind === 'audio' ? 'audio' : 'video') }; s.el.preload = 'auto'; s.el.playsInline = true; slots.set(key, s); }
  const src = `/media/${P.id}/${c.asset}`;
  if (s.src !== src) { s.src = src; s.el.src = src; }
  s.used = true; return s.el;
}
function syncMedia(m, c, t, active) {
  const want = c.in + clamp(t - c.start, 0, dur(c)) * c.speed;
  if (!active) { if (!m.paused) m.pause(); if (Math.abs(m.currentTime - c.in) > 0.05 && m.readyState >= 1 && !m.seeking) m.currentTime = c.in; return; } // pre-roll the next clip
  m.playbackRate = c.speed; m.muted = !!c.muted || !playing; m.volume = clamp((c.volume ?? 1) * fadeK(c, t), 0, 1);
  const drift = Math.abs(m.currentTime - want);
  if (m.readyState >= 1 && !m.seeking && drift > (playing ? 0.3 : 0.02)) m.currentTime = want;
  if (playing && m.paused) m.play().catch(() => {}); else if (!playing && !m.paused) m.pause();
}
function drawVisual(src, sw0, sh0, c, t) {
  const k = cv.width / P.width;
  const s = (c.fit === 'contain' ? Math.min(P.width / sw0, P.height / sh0) : Math.max(P.width / sw0, P.height / sh0)) * (c.scale || 1);
  const w = sw0 * s * k, h = sh0 * s * k, x = (cv.width - w) / 2 + (c.x || 0) * cv.width, y = (cv.height - h) / 2 + (c.y || 0) * cv.height;
  const g = c.grade; const filter = g ? `brightness(${g.brightness ?? 1}) contrast(${g.contrast ?? 1}) saturate(${g.saturation ?? 1})` : 'none';
  ctx.globalAlpha = clamp((c.opacity ?? 1) * fadeK(c, t), 0, 1);
  if (c.key) {
    const kw = Math.max(2, Math.min(Math.round(w), 540)), kh = Math.max(2, Math.round(kw * (h / w)));
    if (keyCv.width !== kw || keyCv.height !== kh) { keyCv.width = kw; keyCv.height = kh; }
    keyCtx.filter = filter; keyCtx.clearRect(0, 0, kw, kh); keyCtx.drawImage(src, 0, 0, kw, kh);
    try {
      const im = keyCtx.getImageData(0, 0, kw, kh), d = im.data, n = parseInt(c.key.color.replace('#', ''), 16);
      const kr = (n >> 16) & 255, kg = (n >> 8) & 255, kb = n & 255;
      const ku = -0.169 * kr - 0.331 * kg + 0.5 * kb, kv = 0.5 * kr - 0.419 * kg - 0.081 * kb, sim = c.key.similarity, bl = c.key.blend;
      for (let i = 0; i < d.length; i += 4) {
        const du = -0.169 * d[i] - 0.331 * d[i + 1] + 0.5 * d[i + 2] - ku, dv = 0.5 * d[i] - 0.419 * d[i + 1] - 0.081 * d[i + 2] - kv;
        const diff = Math.sqrt((du * du + dv * dv) / 130050);
        d[i + 3] = bl > 0.0001 ? clamp((diff - sim) / bl, 0, 1) * 255 : diff > sim ? 255 : 0;
      }
      keyCtx.putImageData(im, 0, 0);
    } catch {}
    ctx.filter = 'none'; ctx.drawImage(keyCv, x, y, w, h);
  } else { ctx.filter = filter; ctx.drawImage(src, x, y, w, h); }
  ctx.filter = 'none'; ctx.globalAlpha = 1;
}
function tick() {
  if (!P || renderView) return;
  sizeViewer();
  if (playing) { T = playT0 + (performance.now() - playW0) / 1000; if (T >= P.duration) { T = P.duration; playing = false; $('#play').textContent = '▶'; } placePlayhead(); const sc = $('#scroll'), x = T * pps; if (x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - 60; }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  for (const s of slots.values()) s.used = false;
  const order = (t) => (t[0] === 'A' ? -1 : t[0] === 'T' ? 1000 : 0) + Number(t.slice(1));
  for (const track of [...P.tracks].sort((a, b) => order(a) - order(b))) {
    const list = P.clips.filter((c) => c.track === track).map(view).sort((a, b) => a.start - b.start);
    list.forEach((c, i) => {
      const active = T >= c.start && T < end(c) - 0.0005, soon = !active && c.start > T && c.start - T < 1.5;
      if (c.kind === 'text') { if (active) { ctx.globalAlpha = clamp((c.opacity ?? 1) * fadeK(c, T), 0, 1); drawText(ctx, c, cv.width, cv.height); ctx.globalAlpha = 1; } return; }
      if (c.kind === 'image') { if (!active) return; let im = images.get(c.asset); if (!im) { im = new Image(); im.src = `/media/${P.id}/${c.asset}`; images.set(c.asset, im); } if (im.complete && im.naturalWidth) drawVisual(im, im.naturalWidth, im.naturalHeight, c, T); return; }
      if (!active && !soon) return;
      const m = mediaFor(c, i); syncMedia(m, c, T, active);
      if (active && c.kind === 'video' && m.readyState >= 2) { const a = P.assets[c.asset]; drawVisual(m, a.width, a.height, c, T); }
    });
  }
  for (const s of slots.values()) if (!s.used && !s.el.paused) s.el.pause();
}
function showRender(id) {
  const v = $('#renderPlayer'); renderView = id;
  if (id) { playing = false; $('#play').textContent = '▶'; for (const s of slots.values()) s.el.pause(); v.src = `/render/${P.id}/${id}?v=${Date.now()}`; v.hidden = false; cv.style.visibility = 'hidden'; sizeViewer(); v.play().catch(() => {}); }
  else { v.pause(); v.hidden = true; cv.style.visibility = ''; }
  $('#backToTimeline').hidden = !id; $('#viewMode').textContent = id ? `Rendered file · ${id}` : 'Live preview';
}
// luma histogram of what is on screen
setInterval(() => {
  const sc = $('#scope'); if (!sc || !P || renderView) return;
  const w = 48, h = Math.round((48 * cv.height) / cv.width) || 48;
  keyCv.width = w; keyCv.height = h; keyCtx.filter = 'none'; keyCtx.drawImage(cv, 0, 0, w, h);
  let d; try { d = keyCtx.getImageData(0, 0, w, h).data; } catch { return; }
  const bins = new Array(46).fill(0);
  for (let i = 0; i < d.length; i += 4) bins[Math.min(45, Math.floor(((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 256) * 46))]++;
  const g = sc.getContext('2d'), mx = Math.max(...bins.slice(1)) || 1; g.clearRect(0, 0, sc.width, sc.height); g.fillStyle = '#fff';
  bins.forEach((b, i) => { const hh = Math.min(sc.height, (b / mx) * sc.height); g.fillRect(i * 4, sc.height - hh, 3, hh); });
}, 300);

// Text is rasterised here (ui/text-draw.js) and uploaded, so the render uses exactly the pixels you previewed.
// With no window open, the service draws the same file in headless Chrome instead (src/text.js).
const rasterBusy = new Set();
async function rasterizeTexts() {
  for (const c of P.clips) {
    if (c.kind !== 'text') continue;
    const hash = textKey(c, P.width, P.height);
    if (P.rasters?.[c.id]?.hash === hash || rasterBusy.has(c.id + hash)) continue;
    rasterBusy.add(c.id + hash);
    const { x, y, canvas } = rasterText(c, P.width, P.height, (w, h) => new OffscreenCanvas(w, h));
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    fetch(`/api/raster?project=${P.id}&clip=${c.id}&x=${x}&y=${y}`, { method: 'POST', headers: { 'X-Frame-Text-Key': encodeURIComponent(hash) }, body: blob }).finally(() => setTimeout(() => rasterBusy.delete(c.id + hash), 3000));
  }
}

// Animation frames stop when the window is hidden; a timer keeps the preview and audio in step anyway.
let lastRaf = 0;
const loop = () => { lastRaf = performance.now(); tick(); requestAnimationFrame(loop); };
setInterval(() => { if (performance.now() - lastRaf > 250) tick(); }, 60);
connect(); requestAnimationFrame(loop);
window.__frame = { slots, get P() { return P; }, get T() { return T; }, seek, togglePlay };
