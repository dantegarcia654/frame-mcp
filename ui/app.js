import { moveAt } from './clip-move.js';
import { graphicBounds, graphicTransform } from './canvas-geometry.js';
import { PROPERTY_LABELS } from './revision-controls.js';
import { timelineRows } from './timeline-groups.js';
// Frame UI. Shows the daemon's project state live, previews the timeline in real time, and lets the human edit the same timeline.
import { drawText, rasterText, textKey, reflowLines } from './text-draw.js';
import { EFFECTS, drawEffect, trackAt, placeRect, mapBox, effectTime } from './effects.js';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tc = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(2).padStart(5, '0')}`; };
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const dur = (c) => (c.out - c.in) / (c.speed || 1);
const end = (c) => c.start + dur(c);
let activePromptControl=null;
function post(body){
  const job=activePromptControl;
  const payload={...body,...(job?{prompt_job:{id:job.id,client:job.client}}:{})};
  if(new URLSearchParams(location.search).has('automation_check'))payload.test_context='automated-ui-check';
  const promise=fetch('/api/ui',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(r=>r.json()).then(r=>{if(r.error)toast(r.error);return r;});
  if(job)job.completion=promise;return promise;
}

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
  es.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === 'state') onState(m); else if (m.type === 'project_delta') onProjectDelta(m); else if (m.type === 'generating') { GEN = m.jobs || []; renderGen(); } };
  es.onerror = () => { setStatus('', 'Reconnecting…'); };
}
let timelineLayoutKey = "", previewTracks = [];
function onState(m) {
  const switched = !P || !m.project || P.id !== m.project.id;
  P = m.project; lastCallAt = m.lastCallAt || lastCallAt;
  if (switched) { known = new Set(); knownFeed = new Set(); $('#feed').innerHTML = ''; sel = null; T = Math.max(0, Number(new URLSearchParams(location.search).get('t')) || 0); firstState = true; autoFit = true; renderView = null; showRender(null); }
  renderProjects(m.projects || []);
  $('#empty').hidden = !!(P && (P.clips.length || Object.keys(P.assets).length));
  if (!P) { $('#empty').hidden = false; return; }
  document.title = `${P.name} — Frame`;
  if (sel && !P.clips.some((c) => c.id === sel)) sel = null;
  const order = t => (t[0] === 'A' ? -1 : t[0] === 'T' ? 1000 : 0) + Number(t.slice(1));
  const byTrack = new Map(P.tracks.map(track => [track, []]));
  for (const c of P.clips) byTrack.get(c.track)?.push(c);
  previewTracks = [...byTrack].sort(([a],[b]) => order(a)-order(b)).map(([,list])=>list.sort((a,b)=>a.start-b.start));
  const layout = JSON.stringify([P.tracks, P.markers, P.clips.map(c=>[c.id,c.track,c.start,c.in,c.out,c.speed,c.label])]);
  renderBin(); renderGen(); renderSteps(); renderFeed();
  if (switched || layout !== timelineLayoutKey) {
    timelineLayoutKey = layout;
    renderTimeline();
  }
  if (!textEditor) renderInspector();
  renderStatus(); rasterizeTexts();
  if (m.focus) focus(m.focus);
  if (m.focuses) for (const f of m.focuses) focus(f);
  if (m.rendered) showRender(m.rendered);
  renderCanvasTools(); processPromptJobs(P.promptJobs||[]);
  firstState = false;
}

function onProjectDelta(m) {
  if (!P || P.id !== m.id) return;
  lastCallAt = m.lastCallAt || lastCallAt;
  if (m.version != null) P.version = m.version;
  if (m.clips?.length) {
    const byId = new Map(m.clips.map(c=>[c.id,c]));
    P.clips = P.clips.map(c=>byId.get(c.id) || c);
    previewTracks = previewTracks.map(track=>track.map(c=>byId.get(c.id) || c));
  }
  if (m.revisions?.length) P.revisions = [...(P.revisions || []), ...m.revisions].slice(-300);
  if (m.feedEntries?.length) {
    P.feed = [...P.feed, ...m.feedEntries].slice(-800);
    renderFeed();
  }
  for (const f of m.focuses || []) focus(f);
  if (m.clips?.length) {
    renderCanvasTools();
    if (!textEditor && m.clips.some(c => c.id === sel)) renderInspector();
  }
  if (m.promptJobs) {
    P.promptJobs = m.promptJobs;
    processPromptJobs(m.promptJobs);
  }
  renderStatus();
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
  const activeJobs=(P.promptJobs||[]).filter(j=>['routing','ready','executing'].includes(j.status));
  $('#pending').textContent = activeJobs.length ? `${activeJobs.length} prompts running · send another anytime` : 'Canvas changes run immediately. Review shows exact controls and values.';
  if (P.paused) return setStatus('hold', 'Paused by you');
  if (r && r.status === 'rendering') return setStatus('live', `Rendering ${Math.round((r.progress || 0) * 100)}%`);
  if (P.status.state === 'waiting') return setStatus('hold', 'Claude is waiting for you');
  if (activeJobs.length) return setStatus('busy', `${activeJobs.length} prompts running`);
  if (ago < 180) return setStatus('warm', `Last tool call ${Math.round(ago)}s ago`);
  setStatus('', 'Canvas ready');
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
// Effects: every effect Frame can draw. + adds it at the playhead on the track above the footage.
let fxListDone = false;
function renderEffectsList() {
  if (fxListDone) return; fxListDone = true;
  const box = $('#effects'); if (!box) return; $('#fxCount').textContent = Object.values(EFFECTS).filter((fx) => !fx.hidden).length;
  for (const [id, fx] of Object.entries(EFFECTS)) {
    if (fx.hidden) continue;
    const row = el('div', 'pkItem', `<span class="nm">${esc(fx.label)}</span><span class="dim">${fx.needs === 'cutout' ? 'cutout' : ''}</span>`); row.title = fx.about;
    const add = el('button', '', '+'); add.title = `Add ${fx.label} at the playhead`;
    add.onclick = () => { if (!P) return; const top = P.clips.filter((c) => c.kind === 'effect' && c.start < T + 1.5 && end(c) > T).map((c) => Number(c.track.slice(1))); post({ action: 'ops', ops: [{ op: 'add_effect', effect: id, start: Math.round(T * (P.fps || 30)) / (P.fps || 30), duration: 1.5, track: `V${Math.max(1, ...top) + 1}` }] }); };
    row.append(add); box.append(row);
  }
}
// The decision sheet on each clip: the model's guessed role and its confidence. A guess, never shown as a measurement.
const DZ_TRUST = 0.7;
const dzRanked = (ans) => Object.entries(ans?.probabilities || {}).sort((x, y) => y[1] - x[1]);
function decisionBadge(a) {
  const d = a.decisions; if (!d) return null;
  if (d.status === 'pending') return el('div', 'dz busy-dz', 'labeling…');
  if (d.status === 'failed') return el('div', 'dz', 'label failed');
  const [role, conf] = dzRanked(d.answers?.role)[0] || [];
  if (!role) return null;
  const junk = d.answers.camera_junk?.noul >= 0.5;
  // Percentage first so a narrow bin still shows it; an unsure guess is the inverted pill and ends in "?".
  return el('div', `dz${conf < DZ_TRUST ? ' review' : ''}`, esc(`${Math.round(conf * 100)}% ${role.replace(/_/g, ' ')}${conf < DZ_TRUST ? '?' : ''}${junk ? ' · junk?' : ''}`));
}
function decisionTip(a) {
  const d = a.decisions; if (!d) return '';
  if (d.status !== 'done') return d.status === 'failed' ? `\nLabel failed: ${d.error}` : '\nLabeling…';
  const r = dzRanked(d.answers.role).slice(0, 3).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(' · ');
  const x = d.answers, sc = (q) => (q?.score != null ? `${Math.round(q.score * 10) / 10}/2` : '–');
  return `\n${d.model} guess (not measured), pack "${d.pack}": ${r}\nhook ${sc(x.hook_strength)} · steady ${sc(x.stability)} · junk ${Math.round((x.camera_junk?.noul ?? 0) * 100)}%${x.drawing_visible ? ` · drawing visible ${Math.round(x.drawing_visible.noul * 100)}%` : ''}`;
}
function renderBin() {
  loadPacks(); renderEffectsList();
  const bin = $('#bin'); bin.dataset.empty = 'Nothing imported yet.';
  const assets = Object.values(P.assets);
  $('#mediaCount').textContent = assets.length || '';
  bin.innerHTML = '';
  for (const a of assets) {
    const d = el('div', `asset${seenUi.has(a.id) ? '' : ' new'}`); seenUi.add(a.id);
    const th = el('div', 'th');
    if (a.thumbs) { const mid = Math.floor(a.thumbs / 2); th.style.backgroundImage = `url(/thumbs/${P.id}/${a.id})`; th.style.backgroundSize = `${a.thumbs * 100}% 100%`; th.style.backgroundPosition = a.thumbs > 1 ? `${(mid / (a.thumbs - 1)) * 100}% 0` : 'center'; }
    else th.textContent = a.kind === 'audio' ? '♪' : '';
    const busy = a.busy || (a.cutting && `cutting out ${a.cutting}`) || (a.transcribing && 'transcribing');
    if (busy) th.append(el('div', 'busy', esc(busy)));
    const dz = decisionBadge(a); if (dz) th.append(dz);
    d.append(th, el('div', 'nm', esc(a.name)), el('div', 'mt', `${a.id} · ${a.duration ? tc(a.duration) : a.kind}${a.transcript ? ' · words' : ''}${a.cutout ? ' · cutout' : ''}`));
    if (a.kind === 'video' && !a.busy && !a.cutting) { // the person cutout (frame_cutout): run it from here, or see what covers it
      const b = el('button', 'cut', a.cutout ? `Cutout ${tc(a.cutout.from)}–${tc(a.cutout.to)}` : 'Cut out person');
      b.title = a.cutout ? `${a.cutout.engineLabel || a.cutout.engine}, ${a.cutout.quality}: person found in ${a.cutout.withPerson}/${a.cutout.frames} frames, face in ${a.cutout.withFace}. Click to make it again.` : 'Separate the person from the background on every frame of the part the timeline uses (runs on this computer). Effects like Clone row and Text behind need it.';
      b.onclick = (e) => { e.stopPropagation(); post({ action: 'cutout', asset: a.id }); };
      d.append(b);
    }
    d.title = `${a.path}\n${a.width ? `${a.width}×${a.height} · ` : ''}${a.loudness ? `${a.loudness.lufs} LUFS` : ''}${decisionTip(a)}\nDouble-click to add at the end of the timeline`;
    d.ondblclick = () => post({ action: 'ops', ops: [{ op: 'add_clip', asset: a.id }] });
    bin.append(d);
  }
}
$('#addPath').onsubmit = (e) => { e.preventDefault(); const i = e.target.querySelector('input'); const v = i.value.trim().replace(/^['"]|['"]$/g, ''); if (v && P) post({ action: 'import', paths: [v] }).then((r) => { if (!r.error) i.value = ''; }); };

// ───────────────────────── generating: assets still being made outside Frame (renders, composites, AI jobs)
// Each job reports frames done/total and, every few frames, the frame it just composited. A tile per job sits on top of
// the bin; clicking it opens a live view of that job.
let GEN = [], genOpen = null, genShownV = {};
const genPct = (j) => (j.total ? clamp(j.done / j.total, 0, 1) : null);
function genEta(j) {
  const el_ = (j.updatedAt - j.startedAt) / 1000, rate = el_ > 0 ? j.done / el_ : 0;
  return { elapsed: el_, eta: j.total && rate > 0 ? (j.total - j.done) / rate : null };
}
function renderGen() {
  const box = $('#gen'); const jobs = GEN.filter((j) => !P || !j.project_id || j.project_id === P.id);
  box.innerHTML = '';
  for (const j of jobs) {
    const p = genPct(j), d = el('div', 'asset gen');
    const th = el('div', 'th');
    if (j.previewV) th.style.backgroundImage = `url(/api/generating/preview?job_id=${encodeURIComponent(j.job_id)}&v=${j.previewV})`;
    const label = j.status === 'failed' ? 'Failed' : j.status === 'done' ? 'Done' : !j.done && j.note ? 'Preparing…' : `Generating… ${p == null ? '' : `${Math.round(p * 100)}%`}`;
    th.append(el('div', 'gl', esc(label)));
    const bar = el('div', 'gb'); bar.style.width = `${p == null ? 100 : p * 100}%`; if (p == null) bar.classList.add('ind'); th.append(bar);
    const { eta } = genEta(j);
    d.append(th, el('div', 'nm', esc(j.name)), el('div', 'mt', esc(!j.done && j.note ? j.note : `${j.total ? `${j.done}/${j.total}` : j.done || ''} ${j.kind || ''}${eta != null && j.status === 'running' ? ` · ~${Math.ceil(eta)}s left` : ''}`)));
    d.title = `${j.name}\n${j.note || ''}\nClick to watch it being made`;
    d.onclick = () => openGen(j.job_id);
    box.append(d);
  }
  const n = jobs.filter((j) => j.status === 'running').length;
  $('#mediaCount').textContent = `${P ? Object.keys(P.assets).length || '' : ''}${n ? ` · ${n} generating` : ''}`;
  updateGenPanel();
}
function openGen(id) { genOpen = id; $('#genPanel').hidden = false; updateGenPanel(true); }
function updateGenPanel(force) {
  if (!genOpen) return;
  const m = $('#genPanel'), j = GEN.find((x) => x.job_id === genOpen);
  if (!j) { m.querySelector('.meta').textContent = 'Finished. The tile is gone; the result is in the bin if it was imported.'; return; }
  const p = genPct(j), { elapsed, eta } = genEta(j);
  m.querySelector('h2').textContent = j.name;
  m.querySelector('.meta').textContent = `${j.status === 'running' ? 'Generating' : j.status} · ${p == null ? '…' : `${Math.round(p * 100)}%`} · ${j.total ? `frame ${j.done} of ${j.total}` : `${j.done} done`} · ${elapsed.toFixed(1)}s elapsed${eta != null && j.status === 'running' ? ` · ~${Math.ceil(eta)}s left` : ''}`;
  m.querySelector('.gbar i').style.width = `${p == null ? 100 : p * 100}%`;
  m.querySelector('.gnote').textContent = j.note || '';
  const img = m.querySelector('img');
  if (j.previewV && (force || genShownV[j.job_id] !== j.previewV)) { genShownV[j.job_id] = j.previewV; img.src = `/api/generating/preview?job_id=${encodeURIComponent(j.job_id)}&v=${j.previewV}`; }
  img.hidden = !j.previewV;
}
const closeGen = () => { genOpen = null; $('#genPanel').hidden = true; };
$('#closeGen').onclick = closeGen;
$('#genPanel').onclick = (e) => { if (e.target.id === 'genPanel') closeGen(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && genOpen) closeGen(); });


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
  m.querySelectorAll('.revisionBody,.revisionActions').forEach(x=>x.remove());
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
    const who = f.actor === 'user' ? 'You' : (f.agent || (f.actor === 'frame' ? 'Frame' : 'Claude'));
    const tag = { thinking: 'thinking', decision: 'decision', plan: 'plan', question: 'asks you', look: 'looked', render: 'render', step: 'process', op: f.op }[f.kind] || '';
    d.innerHTML = `<div class="who"><span>${esc(who)}${tag ? ' · ' + esc(tag) : ''}</span><span>${new Date(f.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div><div class="tx">${esc(f.text)}</div>${f.why ? `<div class="why">${esc(f.why)}</div>` : ''}`;
    if(f.revisionId){ const b=el('button','reviewChange','Review change'); b.onclick=e=>{e.stopPropagation();openRevision(f.revisionId);};d.append(b); }
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
function sendMessage() { const v = composer.value.trim(); if (!v || !P) return; post({ action: 'prompt', text: v, t: T, clip: sel }); composer.value = ''; }
$('#composer').onsubmit = (e) => { e.preventDefault(); sendMessage(); };
composer.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

// ───────────────────────── timeline
const expandedGraphicGroups = new Set();
const laneH = (t) => (P?.clips.some(c => c.track === t && c.effect?.type === 'live_graphic') ? 40 : t[0] === 'V' ? 50 : t[0] === 'T' ? 26 : 38);
const view = (c) => (drag && drag.id === c.id ? { ...c, ...drag.cur } : textDrag && textDrag.c.id === c.id ? textDrag.c : c); // a caption being dragged in the preview keeps its live position
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
  for (const item of timelineRows(P,expandedGraphicGroups)) {
    if(item.kind === 'track') {
      const t=item.track;
      const h = el('div', '', esc(P.trackLabels?.[t] || ({V1:'Footage',T1:'Captions',A1:'Audio'}[t]) || t)); h.title = `${t} · ${P.trackLabels?.[t] || t}`; h.style.height = `${laneH(t)}px`; heads.append(h);
      const lane = el('div', 'lane'); lane.style.height = `${laneH(t)}px`; lane.dataset.track = t; rows.append(lane);
      for (const raw of P.clips.filter((c) => c.track === t)) lane.append(clipEl(raw, laneH(t)));
    } else {
      const height=item.kind==='graphics'?58:30;
      const h=el('div','groupHead');h.style.height=`${height}px`;
      const toggle=el('button','layerToggle',`${expandedGraphicGroups.has(item.key)?'▾':'▸'} ${esc(item.name)} <small>${item.clips.length}</small>`);
      toggle.setAttribute('aria-expanded',String(expandedGraphicGroups.has(item.key)));
      toggle.onclick=()=>{expandedGraphicGroups.has(item.key)?expandedGraphicGroups.delete(item.key):expandedGraphicGroups.add(item.key);renderTimeline();};h.append(toggle);heads.append(h);
      const lane=el('div','lane graphicSummary');lane.style.height=`${height}px`;lane.dataset.group=item.key;rows.append(lane);
      if(item.kind==='graphics') renderGraphicOverview(lane,item.clips,height);
      else {
        for(const c of item.clips){const bar=el('div','groupElement');bar.style.left=`${c.start*pps}px`;bar.style.width=`${Math.max(2,dur(c)*pps)}px`;bar.title=c.label||c.id;bar.onclick=e=>{e.stopPropagation();select(c.id);seek(c.start+.15);};lane.append(bar);}
      }
    }
  }
  known = new Set(P.clips.map((c) => c.id));
  const mk = $('#markers'); mk.innerHTML = '';
  for (const m of P.markers) { const i = el('i', '', esc(m.label)); i.style.left = `${m.t * pps}px`; mk.append(i); }
  placePlayhead();
}
function renderGraphicOverview(lane,clips,height){
  const cards=clips.filter(c=>c.effect.params.nodes.some(n=>n.id.endsWith('-canvas')));
  for(const c of cards){
    const name=c.effect.params.nodes[0].id.replace('-canvas','');
    const titles={refs:'References',details:'Type & spacing',real:'Real content',options:'Directions',terminal:'Prompt',controls:'Controls',phone:'Phone check',loop:'Recap'};
    const block=el('div','clip graphicCard');block.style.left=`${c.start*pps}px`;block.style.width=`${Math.max(3,dur(c)*pps)}px`;block.dataset.card=name;
    const tile=document.createElement('canvas');tile.width=90;tile.height=160;const g=tile.getContext('2d');g.fillStyle='#35332f';g.fillRect(0,0,90,160);
    const at=c.start+Math.min(dur(c)*.5,1.2);
    const order=t=>Number(t.slice(1));
    for(const part of [...clips].sort((a,b)=>order(a.track)-order(b.track)))if(at>=part.start&&at<end(part)){const {t,d}=effectTime(part,at);drawEffect(g,part,{W:90,H:160,t,d,make:makeCanvas});}
    tile.style.objectFit='contain';block.append(tile,el('span','lb',esc(titles[name]||name)));
    block.title=`${titles[name]||name} — click to inspect; expand Graphics for individual elements`;
    block.onmousedown=e=>e.stopPropagation();
    block.onclick=e=>{e.stopPropagation();if(renderView)showRender(null);seek(at);const part=clips.find(x=>x.effect.params.nodes[0].kind==='text'&&at>=x.start&&at<end(x));if(part)select(part.id);};
    lane.append(block);
  }
}
function clipEl(raw, h) {
  const c = view(raw), a = P.assets[c.asset];
  const d = el('div', `clip ${c.kind}${c.id === sel ? ' sel' : ''}${!known.has(c.id) && !firstState ? ' enter' : ''}`);
  d.dataset.id = c.id;
  const w = Math.max(3, dur(c) * pps);
  d.style.left = `${c.start * pps}px`; d.style.width = `${w}px`;
  if (c.kind === 'text') d.append(el('span', 'lb', esc(c.text.content)));
  else if (c.kind === 'effect') {
    const fx = EFFECTS[c.effect?.type];
    if (c.effect?.type === 'live_graphic') {
      const strip = document.createElement('canvas'); strip.width = Math.min(2400, Math.ceil(w)); strip.height = h - 6;
      const g = strip.getContext('2d'), tileW = (h - 6) * P.width / P.height;
      const count = Math.ceil(strip.width / tileW);
      for (let k = 0; k < count; k++) {
        const sample = (k + .5) / count * dur(c), tile = document.createElement('canvas');
        tile.width = Math.ceil(tileW); tile.height = h - 6;
        const tg = tile.getContext('2d'); tg.fillStyle = '#35332f'; tg.fillRect(0, 0, tile.width, tile.height);
        drawEffect(tg, c, { W:tile.width, H:tile.height, t:c.in + sample, d:c.out, make:makeCanvas });
        for (const caption of P.clips.filter(x=>x.kind==='text' && c.start+sample>=x.start && c.start+sample<end(x))) drawText(tg,caption,tile.width,tile.height);
        g.drawImage(tile,k*tileW,0); g.strokeStyle='#777'; g.strokeRect(k*tileW,0,tileW,strip.height);
      }
      strip.title='Live design thumbnails — scrub here to preview'; d.append(strip);
    }
    d.append(el('span', 'lb', esc(c.label || fx?.label || c.effect?.type)));
    const u = P.clips.find((x) => x.track === (c.source || 'V1') && x.kind === 'video' && x.start < end(c) && end(x) > c.start), a = u && P.assets[u.asset];
    d.append(el('span', 'fx', fx?.needs === 'cutout' && !a?.cutout ? 'NEEDS CUTOUT' : 'FX'));
  } else {
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
  if (raw.kind === 'text') d.ondblclick = (e) => { e.stopPropagation(); select(raw.id); if (T < raw.start || T >= end(raw)) seek(raw.start + Math.min(0.2, dur(raw) / 2)); if (renderView) showRender(null); tick(); openTextEditor(raw.id); }; // draw now so the caption's box is known, and take the keyboard at once
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
function select(id) { sel = id; document.querySelectorAll('.clip').forEach((d) => d.classList.toggle('sel', d.dataset.id === id)); renderInspector(); renderCanvasTools(); }

// manual editing: move / trim
function startDrag(e, raw) {
  if (e.button !== 0) return;
  e.stopPropagation(); select(raw.id);
  // Option/Alt-drag on a footage clip = slip: the clip keeps its place and length, the recording scrolls inside it.
  const slip = e.altKey && ['video', 'audio'].includes(raw.kind) && !e.target.classList.contains('l') && !e.target.classList.contains('r');
  const mode = slip ? 'slip' : e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
  const x0 = e.clientX, a = P.assets[raw.asset]; let moved = false;
  if (slip && (T < raw.start || T >= end(raw))) seek(raw.start + Math.min(0.5, dur(raw) / 2)); // park the playhead in the clip so the preview shows the slip
  const edges = [0, T, ...P.clips.filter((c) => c.id !== raw.id).flatMap((c) => [c.start, end(c)])];
  const snap = (t) => { for (const s of edges) if (Math.abs(s - t) * pps < 7) return s; return t; };
  const stretch = raw.kind === 'text' || raw.kind === 'image' || raw.kind === 'effect';
  const move = (ev) => {
    const dx = (ev.clientX - x0) / pps; if (Math.abs(ev.clientX - x0) > 2) moved = true; if (!moved) return;
    const cur = {};
    if (mode === 'slip') {
      const len = raw.out - raw.in, d = clamp(dx * raw.speed, -raw.in, a.duration - raw.out); // drag right = a later moment of the recording
      cur.in = raw.in + d; cur.out = raw.in + d + len;
      $('#viewMode').textContent = `Slip · source ${tc(cur.in)}–${tc(cur.out)} (${d >= 0 ? '+' : ''}${d.toFixed(2)}s)`;
    } else if (mode === 'move') {
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
    if (mode === 'slip') { $('#viewMode').textContent = 'Live preview'; Object.assign(raw, c); post({ action: 'ops', ops: [{ op: 'slip_clip', id: raw.id, in: r3(c.in) }] }).finally(() => { drag = null; renderTimeline(); }); return; }
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
const roleCursors = new Map();
function focus(f) {
  const role = f.agent || 'Codex';
  let record = roleCursors.get(role);
  if (!record) { const cur = $('#cursor').cloneNode(true); cur.removeAttribute('id'); cur.classList.add('editCursor'); document.body.append(cur); record = { cur, timer:null }; roleCursors.set(role, record); }
  const cur = record.cur; let target = null;
  for (const id of f.clipIds || []) { const d = document.querySelector(`.clip[data-id="${id}"]`); if (d) { d.classList.add('touch'); target ||= d; } }
  if ($('#follow').checked && f.t != null && !playing && !drag) { if (renderView) showRender(null); seek(Math.min(f.t + 0.02, Math.max(0, P.duration - 1 / (P.fps || 30)))); const sc = $('#scroll'); const x = f.t * pps; if (!autoFit && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 80)) sc.scrollLeft = Math.max(0, x - sc.clientWidth / 3); }
  if (f.canvas && $('#follow').checked) {
    tick();
    const hit = graphicHits.findLast(h=>(f.clipIds || []).includes(h.clip_id));
    if (hit) {
      const box = cv.getBoundingClientRect();
      const dx = (hit.x + Math.min(hit.w * .42, 60)) * box.width / cv.width;
      const dy = (hit.y + Math.min(hit.h * .33, 35)) * box.height / cv.height;
      target = { getBoundingClientRect: () => ({left:box.left+dx,top:box.top+dy,width:0,height:0}) };
    }
  }
  if (!target && (f.clipIds||[]).some(id=>P.clips.find(c=>c.id===id)?.effect?.type==='live_graphic')) target=document.querySelector('[data-group="graphics"]');
  if (target?.scrollIntoView && $('#follow').checked) target.scrollIntoView({block:'nearest',inline:'nearest'});
  const r = (target || $('#playhead')).getBoundingClientRect();
  cur.querySelector('span').textContent = f.agent || 'Claude';
  cur.style.opacity = 1; cur.style.transform = `translate(${clamp(r.left + Math.min(r.width / 2, 40), 0, innerWidth - 80)}px, ${r.top + r.height / 2}px)`;
  clearTimeout(record.timer); record.timer = setTimeout(() => (cur.style.opacity = 0), 4000);
}

// ───────────────────────── inspector
const num = (label, key, step = 0.01, get, put) => ({ label, key, step, get, put });
const FIELDS = [
  num('Start', 'start'), num('Source in', 'in'), num('Source out', 'out'), num('Speed', 'speed', 0.05), num('Volume', 'volume', 0.05),
  num('Scale', 'scale', 0.01), num('X', 'x', 0.01), num('Y', 'y', 0.01), num('Opacity', 'opacity', 0.05), num('Fade in', 'fadeIn', 0.05), num('Fade out', 'fadeOut', 0.05),
];
$('#inspector').addEventListener('focusout', () => setTimeout(() => { if (P && !$('#inspector').contains(document.activeElement)) renderInspector(); }, 0)); // catch up on changes skipped while typing
let graphicNodeId = null;
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
      ${r ? `<h3>Saved export</h3><div class="kv"><span>Size</span><span>${r.width}×${r.height}</span></div><div class="kv"><span>Length</span><span>${tc(r.duration)}</span></div>${r.loudness ? `<div class="kv"><span>Loudness</span><span>${r.loudness.lufs} LUFS</span></div>` : ''}<div class="acts"><button id="playLast" class="solid">▶ Play</button><button id="revealLast">Show file</button><button id="approveLast" title="Copy this render to ~/Movies/Frame/Approved (never overwrites)">Approve &amp; save</button></div>` : ''}
      <div class="sec" style="padding-top:16px;text-transform:none;letter-spacing:0;line-height:1.5">Select a clip to see and change exactly what Claude set on it.</div>`;
    if (r) { $('#playLast').onclick = () => showRender(r.id); $('#revealLast').onclick = () => post({ action: 'reveal', id: r.id }); $('#approveLast').onclick = () => post({ action: 'approve', id: r.id }).then((x) => x.file && toast(`Saved: ${x.file}`)); }
    return;
  }
  const a = P.assets[c.asset];
  box.innerHTML = `<h3>${c.kind} clip <span>${c.id}</span></h3>`;
  const row = (label, input) => { const r = el('div', 'row'); r.append(el('label', '', label), input); box.append(r); return input; };
  const send = (props) => post({ action: 'ops', ops: [{ op: 'update_clip', id: c.id, ...props }] });
  const numIn = (v, step, on) => { const i = el('input'); i.type = 'number'; i.step = step; i.value = v ?? ''; i.onchange = () => { if (i.value !== '') on(Number(i.value)); i.blur(); }; return i; };
  if (c.kind === 'effect') {
    const fx = EFFECTS[c.effect.type];
    box.append(el('div', 'sec', esc(fx?.label || c.effect.type)), el('div', 'kv', `<span style="white-space:normal;line-height:1.4;padding:2px 0 4px">${esc(fx?.about || '')}</span>`));
    if (fx?.needs === 'cutout') { const u = P.clips.find((x) => x.track === (c.source || 'V1') && x.kind === 'video' && x.start < end(c) && end(x) > c.start), ua = u && P.assets[u.asset]; box.append(el('div', 'kv', `<span>Cutout</span><span>${ua?.cutout ? 'ready' : ua ? 'needed — Cut out person in Media' : 'no footage under it'}</span>`)); }
    row('Start', numIn(c.start, 0.01, (v) => send({ start: v })));
    row('Duration', numIn(+dur(c).toFixed(3), 0.01, (v) => send({ duration: v })));
    row('Reads', (() => { const i = el('input'); i.value = c.source || 'V1'; i.onchange = () => { send({ source: i.value.trim().toUpperCase() }); i.blur(); }; return i; })());
    if (c.effect.type === 'live_graphic') {
      box.append(el('div', 'sec', 'Graphic layers — changes preview live'));
      const nodes = c.effect.params.nodes;
      const choose = el('select');
      const active = nodes.filter(n => T >= (n.at || 0) && T < (n.until ?? Infinity));
      const list = active.length ? active : nodes;
      if (!list.some(n => n.id === graphicNodeId)) graphicNodeId = list.find(n=>n.kind==='text')?.id || list[0]?.id;
      choose.innerHTML = list.map(n=>`<option value="${esc(n.id)}" ${n.id === graphicNodeId ? 'selected' : ''}>${esc(n.text || n.id)}</option>`).join('');
      choose.onchange = () => { graphicNodeId = choose.value; choose.blur(); renderInspector(); }; row('Layer', choose);
      const node = nodes.find(n=>n.id === graphicNodeId);
      if (node) {
        const patch = change => post({action:'ops', ops:[{op:'patch_graphic',id:c.id,node_id:node.id,patch:change}]});
        if (node.kind === 'text' || node.kind === 'pixtext') { const input=el('input'); input.value=node.text; input.oninput=()=>patch({text:input.value}); row('Text',input); }
        for (const key of ['color','fill','stroke'].filter(key=>node[key])) { const input=el('input'); input.type='color'; input.value=node[key]; input.oninput=()=>patch({[key]:input.value}); row(key === 'fill' ? 'Fill' : key === 'stroke' ? 'Border' : 'Color',input); }
        for(const [key,options] of [['font',['sans','serif','mono']],['weight',[400,700,'italic','italic bold']],['motion',['none','float']],['reveal',['none','type','words']],['align',['left','center','right']]]) if(node[key]!=null){const input=el('select');input.innerHTML=options.map(v=>`<option value="${esc(v)}" ${v===node[key]?'selected':''}>${esc(v)}</option>`).join('');input.onchange=()=>patch({[key]:key==='weight'&&!isNaN(Number(input.value))?Number(input.value):input.value});row(PROPERTY_LABELS[key],input);}
        if(node.kind==='brand'){const input=el('select');const options={'claude-mark':'Claude symbol','claude-wordmark':'Claude wordmark',clawd:'Clawd'};input.innerHTML=Object.entries(options).map(([v,label])=>`<option value="${v}" ${v===node.asset?'selected':''}>${label}</option>`).join('');input.onchange=()=>{const ratio={'claude-mark':1,'claude-wordmark':125/573,clawd:38/47}[input.value];patch({asset:input.value,h:node.w*P.width/P.height*ratio});};row('Artwork',input);}
        if(node.cues){const input=el('input');input.value=node.cues.join(', ');input.onchange=()=>patch({cues:input.value.split(',').map(x=>Number(x.trim()))});row('Word timings',input);}
        for (const [key,label] of [['x','Position X'],['y','Position Y'],['w','Width'],['h','Height'],['size','Type size'],['radius','Corner radius'],['lineWidth','Border width'],['shadow','Shadow'],['fade','Entrance fade'],['speed','Animation speed'],['at','Visible from'],['until','Visible until'],['highlightAt','Highlight time'],['phase','Phase'],['value','Value']].filter(([key])=>node[key]!=null)) row(label,numIn(node[key],.005,v=>patch({[key]:v})));
      }
    }
    box.append(el('div', 'sec', 'Settings'));
    for (const [k, s] of Object.entries(fx?.params || {})) {
      if (c.effect.type === 'live_graphic' && k === 'nodes') continue;
      const v = c.effect.params[k];
      let input;
      if (s.kind === 'number') input = numIn(v, s.step || (s.max - s.min > 20 ? 1 : 0.01), (x) => send({ params: { [k]: x } }));
      else if (s.kind === 'choice') { input = el('select'); input.innerHTML = s.options.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join(''); input.onchange = () => send({ params: { [k]: input.value } }); }
      else if (s.kind === 'list') { input = el('input'); input.value = `${Array.isArray(v) ? v.length : 0} item(s), set by an op`; input.disabled = true; }
      else { input = el('input'); input.value = v ?? ''; input.onchange = () => { send({ params: { [k]: input.value } }); input.blur(); }; }
      input.title = s.about + (s.kind === 'number' ? ` (${s.min}–${s.max})` : ''); row(k, input);
    }
    box.append(el('div', 'sec', 'Layer'));
    for (const f of FIELDS.filter((x) => ['opacity', 'fadeIn', 'fadeOut'].includes(x.key))) row(f.label, numIn(c[f.key] ?? (f.key === 'opacity' ? 1 : 0), f.step, (v) => send({ [f.key]: v })));
  } else if (c.kind === 'text') {
    box.append(el('div', 'sec', 'Text — Enter saves · ⇧Enter new line · Esc cancels · double-click the caption to edit in place'));
    const ta = el('textarea'); ta.rows = 3; ta.value = c.text.content; ta.id = 'textField';
    let cancelled = false; const commit = () => { if (!cancelled && ta.value !== c.text.content && ta.value.trim()) send({ text: ta.value }); cancelled = false; };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelled = true; ta.value = c.text.content; ta.blur(); } };
    ta.onblur = commit; const r = el('div', 'row'); r.append(ta); box.append(r);
    // Lines: reflow the words into exactly N balanced lines (Auto = one paragraph, wrapped by line width again).
    box.append(el('div', 'sec', 'Lines'));
    const lr = el('div', 'acts'); for (const n of ['Auto', 1, 2, 3, 4]) { const x = el('button', '', String(n)); x.dataset.lines = n; x.onclick = () => setLines(c, n); lr.append(x); } box.append(lr);
    box.append(el('div', 'sec', 'Text size — or drag the round handle on the caption; the square handle sets line width'));
    const sr = el('div', 'acts'); for (const [t2, k] of [['A−', 1 / 1.1], ['A+', 1.1]]) { const x = el('button', '', t2); x.onclick = () => send({ style: { size: Math.round(clamp(c.text.size * k, 0.012, 0.25) * 1000) / 1000 } }); sr.append(x); } box.append(sr);
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
  if (c.kind === 'video' || c.kind === 'audio') {
    // Slip: same place, same length, a different moment of the recording.
    const fr = 1 / (P.fps || 30), r3 = (n) => Math.round(n * 1000) / 1000;
    box.append(el('div', 'sec', 'Slip — keeps place and length · or ⌥-drag the clip'));
    const sl = el('div', 'acts'); for (const [t2, d] of [['−1s', -1], ['−5f', -5 * fr], ['−1f', -fr], ['+1f', fr], ['+5f', 5 * fr], ['+1s', 1]]) { const x = el('button', '', t2); x.onclick = () => post({ action: 'ops', ops: [{ op: 'slip_clip', id: c.id, by: r3(d) }] }); sl.append(x); }
    box.append(sl);
  }
  const acts = el('div', 'acts');
  const b = (t, fn) => { const x = el('button', '', t); x.onclick = fn; acts.append(x); };
  b('Split at playhead', splitSel);
  if (c.kind === 'video' || c.kind === 'audio') b('Save to Frame library', () => post({ action: 'save_clip', id: c.id }).then((x) => x.ok && toast(`Saved "${x.label}" to your Frame library${x.duplicate ? ' (already there)' : ''}`)));
  b('Delete', () => delSel(false)); b('Ripple delete', () => delSel(true));
  if (c.kind !== 'audio' && c.kind !== 'text') b(c.muted ? 'Unmute' : 'Mute', () => send({ muted: !c.muted }));
  box.append(acts);
}
function addTextAtPlayhead() { if (!P) return; post({ action: 'ops', ops: [{ op: 'add_text', text: 'Your text', start: Math.round(T * 100) / 100, duration: 2, track: 'T2', style: { y: 0.3 } }] }); }
$('#addText').onclick = addTextAtPlayhead;
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
  else if ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); addTextAtPlayhead(); }
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
// Draws a clip's picture with its placement, grade, key, opacity and fade — onto the viewer, or onto an effect's input canvas.
function drawVisual(src, sw0, sh0, c, t, ctx = cv.getContext('2d'), Wc = cv.width, Hc = cv.height, { grade = true, key = true } = {}) {
  const k = Wc / P.width;
  const s = (c.fit === 'contain' ? Math.min(P.width / sw0, P.height / sh0) : Math.max(P.width / sw0, P.height / sh0)) * (c.scale || 1);
  const mv = moveAt(c, t - c.start), w = sw0 * s * k, h = sh0 * s * k, x = (Wc - w) / 2 + ((c.x || 0) + mv.x) * Wc, y = (Hc - h) / 2 + ((c.y || 0) + mv.y) * Hc;
  const g = grade && c.grade; const filter = g ? `brightness(${g.brightness ?? 1}) contrast(${g.contrast ?? 1}) saturate(${g.saturation ?? 1})` : 'none';
  ctx.globalAlpha = clamp((c.opacity ?? 1) * fadeK(c, t), 0, 1);
  if (key && c.key) {
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
// ───────────────────────── captions in the preview: drag to move, handles to size, double-click to type
let graphicHits=[], graphicDraft=null, graphicDrag=null, graphicInline=null;
let textHits = [], textDrag = null, textEditor = null, selHit = null;
const handleSize = () => Math.max(14, cv.width / 45);
function drawSelection(hit, id) { // the selected caption's box and handles: round corner = text size, square side = line width
  ctx.save(); const hs = handleSize();
  ctx.lineWidth = Math.max(2, cv.width / 400); ctx.setLineDash([10, 8]); ctx.strokeStyle = '#000'; ctx.strokeRect(hit.x, hit.y, hit.w, hit.h);
  ctx.lineDashOffset = 9; ctx.strokeStyle = '#fff'; ctx.strokeRect(hit.x, hit.y, hit.w, hit.h); ctx.setLineDash([]);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
  ctx.fillRect(hit.x + hit.w - hs / 2, hit.y + hit.h / 2 - hs / 2, hs, hs); ctx.strokeRect(hit.x + hit.w - hs / 2, hit.y + hit.h / 2 - hs / 2, hs, hs);
  ctx.beginPath(); ctx.arc(hit.x + hit.w, hit.y + hit.h, hs * 0.7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore(); selHit = { id, ...hit };
}
function onHandle(px, py) {
  if (!selHit || selHit.id !== sel) return null; const r = handleSize() * 1.3, x = selHit.x + selHit.w;
  // On a one-line caption the two handles nearly touch, so the nearer one wins.
  const dSize = Math.hypot(px - x, py - (selHit.y + selHit.h)), dWidth = Math.hypot(px - x, py - (selHit.y + selHit.h / 2));
  if (Math.min(dSize, dWidth) > r) return null;
  return dSize <= dWidth ? 'size' : 'width';
}
// Lines: n balanced lines measured with the caption's own font, at the project's real size.
function setLines(c, n) {
  const g = document.createElement('canvas').getContext('2d');
  const f = reflowLines(c, n, P.width, (str, size) => { g.font = `${c.text.weight} ${size * P.height}px ${c.text.font}`; return g.measureText(str).width; });
  post({ action: 'ops', ops: [{ op: 'update_clip', id: c.id, text: f.text, style: f.style }] });
}
// Type over a caption in place. Enter saves, Shift+Enter adds a line, Esc cancels.
function openTextEditor(id) {
  closeTextEditor(false);
  const c = P?.clips.find((x) => x.id === id); if (!c || renderView) return;
  const wrap = $('#viewerWrap'), wr = wrap.getBoundingClientRect(), cr = cv.getBoundingClientRect();
  const h = textHits.find((x) => x.id === id), k = cr.width / cv.width;
  const box = h || { x: cv.width * 0.05, y: c.text.y * cv.height - 60, w: cv.width * 0.9, h: 120 };
  const ta = document.createElement('textarea'); ta.className = 'textEditor'; ta.value = c.text.content; ta.spellcheck = false;
  Object.assign(ta.style, { left: `${cr.left - wr.left + Math.max(0, box.x) * k}px`, top: `${cr.top - wr.top + Math.max(0, box.y) * k}px`, width: `${Math.min(cv.width, box.w) * k}px`, minHeight: `${box.h * k}px`, fontSize: `${Math.max(12, c.text.size * cv.height * k * 0.8)}px` });
  wrap.append(ta); textEditor = { id, ta, original: c.text.content };
  ta.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeTextEditor(true); } else if (e.key === 'Escape') { e.preventDefault(); closeTextEditor(false); } };
  ta.onblur = () => closeTextEditor(true);
  ta.focus(); ta.select();
}
function closeTextEditor(save) {
  if (!textEditor) return; const { id, ta, original } = textEditor; textEditor = null;
  const v = ta.value; ta.remove();
  if (save && v.trim() && v !== original) post({ action: 'ops', ops: [{ op: 'update_clip', id, text: v }] });
  renderInspector();
}
(() => {
  const pt = (e) => { const r = cv.getBoundingClientRect(); return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height }; };
  const hitAt = (px, py) => [...textHits].reverse().find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
  cv.addEventListener('pointerdown', (e) => {
    if (!P || renderView || playing || e.button !== 0) return; const { fx, fy } = pt(e), px = fx * cv.width, py = fy * cv.height;
    const hm = onHandle(px, py);
    if (hm) { const c = P.clips.find((x) => x.id === selHit.id); if (!c) return; const cx = c.text.x * cv.width, cy = c.text.y * cv.height;
      textDrag = { c, mode: hm, size0: c.text.size, d0: Math.max(1, Math.hypot(px - cx, py - cy)), moved: false }; cv.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    const h = hitAt(px, py); if (!h) return;
    const c = P.clips.find((x) => x.id === h.id); if (!c) return;
    select(c.id); textDrag = { c, mode: 'move', dx: c.text.x - fx, dy: c.text.y - fy, moved: false }; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; e.preventDefault();
  });
  cv.addEventListener('pointermove', (e) => {
    const { fx, fy } = pt(e), px = fx * cv.width, py = fy * cv.height;
    if (!textDrag) { const hm = !playing && onHandle(px, py); cv.style.cursor = hm === 'size' ? 'nwse-resize' : hm === 'width' ? 'ew-resize' : !playing && hitAt(px, py) ? 'grab' : ''; return; }
    textDrag.moved = true; const t = textDrag.c.text;
    if (textDrag.mode === 'size') t.size = clamp(textDrag.size0 * Math.hypot(px - t.x * cv.width, py - t.y * cv.height) / textDrag.d0, 0.012, 0.25);
    else if (textDrag.mode === 'width') t.maxWidth = clamp((2 * Math.abs(px - t.x * cv.width)) / cv.width, 0.12, 1);
    else { t.x = clamp(fx + textDrag.dx, 0, 1); t.y = clamp(fy + textDrag.dy, 0, 1); }
  });
  const done = () => {
    if (!textDrag) return; const { c, moved, mode } = textDrag; textDrag = null; cv.style.cursor = ''; if (!moved) return;
    const r3 = (n) => Math.round(n * 1000) / 1000;
    const style = mode === 'size' ? { size: r3(c.text.size) } : mode === 'width' ? { maxWidth: r3(c.text.maxWidth) } : { x: r3(c.text.x), y: r3(c.text.y) };
    post({ action: 'ops', ops: [{ op: 'update_clip', id: c.id, style }] });
  };
  cv.addEventListener('pointerup', done); cv.addEventListener('pointercancel', done);
  cv.addEventListener('dblclick', (e) => {
    if (!P || renderView) return; const { fx, fy } = pt(e), h = hitAt(fx * cv.width, fy * cv.height);
    if (h) { e.preventDefault(); if (playing) togglePlay(); select(h.id); openTextEditor(h.id); }
  });
})();
// ───────────────────────── effect clips in the preview
// The same ui/effects.js that draws the exported frames, fed with what the viewer has: the picture just drawn on the
// effect's source track, the cutout video played in step with it, and the face/person track.
const under = {};                 // track -> the picture drawn on it this frame
const mattes = new Map();         // asset id -> <video> of its cutout
const trackData = new Map();      // asset/version -> cutout track JSON
const fxCv = { base: document.createElement('canvas'), matte: document.createElement('canvas'), layer: document.createElement('canvas'), plate: document.createElement('canvas') };
let fxApprox = false, matteShown = null;
const makeCanvas = (w, h) => { const e = document.createElement('canvas'); e.width = w; e.height = h; return e; };
function matteEl(a) {
  const src = `/matte/${P.id}/${a.id}?v=${a.cutout.version}`;
  let m = mattes.get(a.id);
  if (!m) { m = document.createElement('video'); m.muted = true; m.preload = 'auto'; m.playsInline = true; mattes.set(a.id, m); }
  if (m.dataset.src !== src) { m.dataset.src = src; m.src = src; }
  m.used = true; return m;
}
function trackFor(a) {
  const k = `${P.id}/${a.id}/${a.cutout.version}`;
  if (!trackData.has(k)) { trackData.set(k, null); fetch(`/track/${P.id}/${a.id}?v=${a.cutout.version}`).then((r) => r.json()).then((j) => trackData.set(k, j)).catch(() => {}); }
  return trackData.get(k);
}
function syncMatte(m, want, rate) {
  if (m.readyState < 1) return;
  want = clamp(want, 0, Math.max(0, (m.duration || 1e9) - 0.001));
  if (playing) { m.playbackRate = rate; if (m.paused) m.play().catch(() => {}); if (!m.seeking && Math.abs(m.currentTime - want) > 0.15) m.currentTime = want; }
  else { if (!m.paused) m.pause(); if (!m.seeking && Math.abs(m.currentTime - want) > 0.5 / (P.fps || 30)) m.currentTime = want; }
}
function drawEffectClip(c) {
  if(graphicDraft?.clip_id===c.id)c={...c,effect:{...c.effect,params:{...c.effect.params,nodes:c.effect.params.nodes.map(n=>n.id===graphicDraft.node_id?{...n,...graphicDraft.patch}:n)}}};
  const fx = EFFECTS[c.effect?.type]; if (!fx) return;
  const W = cv.width, H = cv.height;
  if (fx.input === false) {
    const {t,d}=effectTime(c,T); ctx.save(); ctx.globalAlpha=clamp((c.opacity??1)*fadeK(c,T),0,1);
    try { drawEffect(ctx,c,{W,H,t,d,unit:P.width/W,make:makeCanvas});
      for(const node of c.effect.params.nodes){if(t>=(node.at||0)&&t<(node.until??Infinity))graphicHits.push({clip_id:c.id,node_id:node.id,node,...graphicBounds(ctx,node,W,H,t)});}
    } finally {ctx.restore();}
    return;
  }
  for (const k in fxCv) if (fxCv[k].width !== W || fxCv[k].height !== H) { fxCv[k].width = W; fxCv[k].height = H; matteShown = null; }
  const u = under[c.source || 'V1'], bg = fxCv.base.getContext('2d');
  bg.globalAlpha = 1; bg.fillStyle = '#000'; bg.fillRect(0, 0, W, H);
  if (u) drawVisual(u.src, u.sw, u.sh, u.clip, T, bg, W, H);
  const a = u && P.assets[u.clip.asset];
  let matte = null, face = null, person = null, note = null;
  if ((fx.needs === 'cutout' || fx.uses === 'cutout') && a?.cutout && u.clip.kind === 'video') {
    const s = u.clip.in + (T - u.clip.start) * u.clip.speed, m = matteEl(a);
    syncMatte(m, s - a.cutout.from, u.clip.speed);
    const mg = fxCv.matte.getContext('2d');
    if (m.readyState >= 2) { mg.globalAlpha = 1; mg.fillStyle = '#000'; mg.fillRect(0, 0, W, H); drawVisual(m, a.width, a.height, u.clip, T, mg, W, H, { grade: false, key: false }); matteShown = a.id; }
    if (matteShown === a.id) matte = fxCv.matte; // while the cutout video seeks, keep its last frame
    const tr = trackFor(a);
    if (tr) { const b = trackAt(tr, s), r = placeRect(a.width, a.height, u.clip, W, H); face = mapBox(b.face, r); person = mapBox(b.person, r); }
    if (playing) fxApprox = true;
  } else if (fx.needs === 'cutout') note = a ? `${fx.label} needs a cutout of ${a.name} — use “Cut out person” in Media` : `${fx.label}: no footage under it on ${c.source || 'V1'}`;
  let plate = null;
  const pa = c.effect.params?.plate && P.assets[c.effect.params.plate];
  if (fx.params.plate && u) { // the empty-set shot, placed exactly like the footage it replaces
    if (!pa) note = `${fx.label} needs a plate: a shot of the empty set from the same angle`;
    else {
      let src = images.get(`plate:${pa.id}`), sw = pa.width, sh = pa.height;
      if (!src) { if (pa.kind === 'image') { src = new Image(); src.src = `/media/${P.id}/${pa.id}`; } else { src = document.createElement('video'); src.muted = true; src.preload = 'auto'; src.src = `/media/${P.id}/${pa.id}`; src.addEventListener('loadedmetadata', () => { src.currentTime = (src.duration || 0) / 2; }, { once: true }); } images.set(`plate:${pa.id}`, src); }
      const ready = pa.kind === 'image' ? src.complete && src.naturalWidth : src.readyState >= 2;
      if (ready) { const pg = fxCv.plate.getContext('2d'); pg.globalAlpha = 1; pg.fillStyle = '#000'; pg.fillRect(0, 0, W, H); drawVisual(src, sw, sh, { ...u.clip, opacity: 1, fadeIn: 0, fadeOut: 0 }, T, pg, W, H, { key: false }); plate = fxCv.plate; }
    }
  }
  const lg = fxCv.layer.getContext('2d'); lg.setTransform(1, 0, 0, 1, 0, 0); lg.globalAlpha = 1; lg.clearRect(0, 0, W, H);
  const { t, d } = effectTime(c, T);
  try { if (fx.params.plate && !plate) note ||= `${fx.label}: loading its plate…`; else drawEffect(lg, c, { W, H, t, d, base: fxCv.base, matte, plate, face, person, unit: P.width / W, make: makeCanvas }); }
  catch (e) { note = `${fx.label} could not be drawn: ${e.message}`; }
  ctx.globalAlpha = clamp((c.opacity ?? 1) * fadeK(c, T), 0, 1); ctx.drawImage(fxCv.layer, 0, 0); ctx.globalAlpha = 1;
  if (note) { const fs = Math.max(11, H * 0.016); ctx.font = `600 ${fs}px -apple-system, sans-serif`; const tw = ctx.measureText(note).width; ctx.fillStyle = 'rgba(0,0,0,.8)'; ctx.fillRect(8, 8, tw + fs, fs * 1.8); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(note, 8 + fs / 2, 8 + fs * 0.9); }
}
function tick() {
  if (!P || renderView) return;
  sizeViewer();
  if (playing) { T = playT0 + (performance.now() - playW0) / 1000; if (T >= P.duration) { T = P.duration; playing = false; $('#play').textContent = '▶'; } placePlayhead(); const sc = $('#scroll'), x = T * pps; if (!autoFit && x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - 60; }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  graphicHits=[];textHits = []; selHit = null; fxApprox = false;
  for (const s of slots.values()) s.used = false;
  for (const k of Object.keys(under)) delete under[k];
  for (const m of mattes.values()) m.used = false;
  let stalled = false;
  for (const trackClips of previewTracks) {
    const list = trackClips.map(view);
    list.forEach((c, i) => {
      const active = T >= c.start && T < end(c) - 0.0005, soon = !active && c.start > T && c.start - T < 3;
      if (c.kind === 'text') { if (active) { ctx.globalAlpha = clamp((c.opacity ?? 1) * fadeK(c, T), 0, 1); const hit = drawText(ctx, c, cv.width, cv.height); ctx.globalAlpha = 1; textHits.push({ id: c.id, ...hit }); if (c.id === sel) drawSelection(hit, c.id); } return; }
      if (c.kind === 'effect') { if (active) drawEffectClip(c); return; }
      if (c.kind === 'image') { if (!active) return; let im = images.get(c.asset); if (!im) { im = new Image(); im.src = `/media/${P.id}/${c.asset}`; images.set(c.asset, im); } if (im.complete && im.naturalWidth) { drawVisual(im, im.naturalWidth, im.naturalHeight, c, T); under[c.track] = { src: im, sw: im.naturalWidth, sh: im.naturalHeight, clip: c }; } return; }
      if (!active && !soon) return;
      const m = mediaFor(c, i); syncMedia(m, c, T, active);
      if (active && c.kind === 'video') { if (m.readyState >= 2 && !m.seeking) { const a = P.assets[c.asset]; drawVisual(m, a.width, a.height, c, T); under[c.track] = { src: m, sw: a.width, sh: a.height, clip: c }; } else stalled = true; }
    });
  }
  drawCanvasSelection();
  // A video that is still seeking/loading must not flash black: hold the last complete frame instead.
  if (stalled && lastGood.width) ctx.drawImage(lastGood, 0, 0, cv.width, cv.height);
  else if (!stalled) { if (lastGood.width !== cv.width || lastGood.height !== cv.height) { lastGood.width = cv.width; lastGood.height = cv.height; } lastGood.getContext('2d').drawImage(cv, 0, 0); }
  for (const s of slots.values()) if (!s.used && !s.el.paused) s.el.pause();
  for (const m of mattes.values()) if (!m.used && !m.paused) m.pause();
  if (!drag) { const vm = $('#viewMode'), want = fxApprox ? 'Live preview · cutout effects are approximate while playing — pause, frame_view or render for exact frames' : 'Live preview'; if (vm.textContent !== want && /^Live preview/.test(vm.textContent)) vm.textContent = want; }
}
const lastGood = document.createElement('canvas');
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
window.__frame = { slots, get P() { return P; }, get T() { return T; }, get sel() { return sel; }, get selHit() { return selHit; }, get textHits() { return textHits; }, get graphicHits(){return graphicHits;}, seek, togglePlay, select };

// Shared revision history: real property changes, not a replay of invented mouse actions.
const revisionValue=v=>v===undefined?'Not set':typeof v==='object'?JSON.stringify(v):String(v);
function openChanges(){
  modal('Changes','Select a revision to inspect its controls, compare the element, or revert it.',null);
  const list=el('div','revisionBody changeList');
  const revisions=P?.revisions||[];
  if(!revisions.length)list.textContent='New changes from the inspector and the agent will appear here.';
  for(const r of [...revisions].reverse()){
    const b=el('button','changeItem');b.textContent=`${r.author.name} · ${r.components[0]?.label||r.operation.op} · ${new Date(r.at).toLocaleTimeString()}`;b.onclick=()=>openRevision(r.id);list.append(b);
  }
  $('#modal .sheet').append(list);
}
function openRevision(id){
  const r=P?.revisions?.find(r=>r.id===id);if(!r)return toast('This revision is no longer available.');
  modal('Review change',`${r.author.name} · ${r.method} · ${new Date(r.at).toLocaleTimeString()}`,null);
  const body=el('div','revisionBody');
  for(const part of r.components){
    body.append(el('h3','',esc(part.label)));
    const comparison=el('div','revisionCompare');
    for(const [label,clip] of [['Before',part.before],['After',part.after]]){
      const column=el('div');column.append(el('b','',label));
      if(clip&&(clip.effect?.type==='live_graphic'||clip.kind==='text')){
        const canvas=document.createElement('canvas');canvas.width=270;canvas.height=480;const g=canvas.getContext('2d');g.fillStyle='#40413d';g.fillRect(0,0,270,480);
        if(clip.kind==='text')drawText(g,clip,270,480);
        else {const node=clip.effect.params.nodes[0];const t=Math.min(clip.out-.001,Math.max(clip.in+.25,(node.highlightAt||0)+.1));g.globalAlpha=clip.opacity??1;drawEffect(g,clip,{W:270,H:480,t,d:clip.out,make:makeCanvas});}
        column.append(canvas);
      }else column.append(el('p','',clip?'Timeline element':'Not present'));
      comparison.append(column);
    }
    body.append(comparison,el('small','', 'Element preview. Other scene layers are omitted.'));
    const table=el('table','revisionTable','<thead><tr><th>Control</th><th>Before</th><th>After</th></tr></thead>');
    const tbody=el('tbody');
    for(const ch of part.changes){const property=ch.path.at(-1),percent=part.after?.effect?.type==='live_graphic'&&['size','x','y','w','h','radius'].includes(property);const label=percent?({size:'Size %',x:'X %',y:'Y %',w:'Width %',h:'Height %',radius:'Corners %'}[property]):ch.control||'Element';const value=v=>percent&&typeof v==='number'?String(Math.round(v*1e8)/1e6):revisionValue(v);const row=el('tr');for(const v of [label,value(ch.before),value(ch.after)])row.append(el('td','',esc(v)));tbody.append(row);}
    table.append(tbody);body.append(table);
    const node=part.after?.effect?.params?.nodes?.[0];
    body.append(el('p','manualSteps',`To make this by hand: select <b>${esc(part.label)}</b> on the canvas, or click Inspect element below. Use the controls beneath the canvas to set the After values above. Click More for additional properties.`));
  }
  const actions=el('div','revisionActions');
  const inspect=el('button','','Inspect element');inspect.onclick=()=>{$('#modal').hidden=true;if(renderView)showRender(null);if(r.time!=null)seek(r.time+.2);select(r.components[0].id);};actions.append(inspect);
  const revert=el('button','solid','Revert this change');revert.disabled=!r.revertible||!!r.revertedAt;
  revert.title=r.revertible?'Revert only these properties; preserve other later changes.':'Use timeline Undo for structural revisions.';
  revert.onclick=async()=>{revert.disabled=true;const result=await post({action:'revert_revision',id:r.id});if(result.error){revert.disabled=false;return;}$('#modal').hidden=true;};actions.append(revert);
  const back=el('button','','All changes');back.onclick=openChanges;actions.append(back);
  $('#modal .sheet').append(body,actions);
}
const changesButton=el('button','','Changes');changesButton.id='changes';changesButton.onclick=openChanges;$('#undo').before(changesButton);

// Direct canvas editing. Humans and prompt cursors call the same visible controls and commit path.
const canvasTools=el('div','canvasTools');canvasTools.id='canvasTools';canvasTools.hidden=true;$('#transport').before(canvasTools);
let canvasToolsKey='';
const rounded=v=>Math.round(v*1e6)/1e6;
function commitGraphicChange(c,node,patch){
 const normalized=Object.fromEntries(Object.entries(patch).map(([k,v])=>[k,typeof v==='number'?rounded(v):v]));
 if(c.kind==='text'){const style={...normalized};delete style.text;if(style.font)style.font={serif:'Georgia',sans:'Arial',mono:'Menlo'}[style.font];return post({action:'ops',surface:'canvas',ops:[{op:'update_clip',id:c.id,...(normalized.text!=null?{text:normalized.text}:{}),...(Object.keys(style).length?{style}:{})}]});}
 return post({action:'ops',surface:'canvas',ops:[{op:'patch_graphic',id:c.id,node_id:node.id,patch:normalized}]});
}
function selectedGraphic(){const c=P?.clips.find(c=>c.id===sel);if(c?.kind==='text')return {c,node:{...c.text,id:c.id,kind:'text',text:c.text.content,font:/Georgia/.test(c.text.font)?'serif':/Menlo|Courier/.test(c.text.font)?'mono':'sans'}};return c?.effect?.type==='live_graphic'?{c,node:c.effect.params.nodes[0]}:null;}
function renderCanvasTools(){
 const item=selectedGraphic();if(renderView){canvasTools.hidden=true;canvasToolsKey='';return;}
 if(!item){canvasTools.hidden=false;canvasTools.dataset.empty='true';canvasToolsKey='';canvasTools.textContent='Select an object · drag to move · use a corner to resize · double-click text';return;}
 canvasTools.dataset.empty='false';
 if(canvasTools.contains(document.activeElement))return;
 const {c,node}=item,key=JSON.stringify([c.id,node]);canvasTools.hidden=false;if(key===canvasToolsKey)return;canvasToolsKey=key;canvasTools.replaceChildren();
 const name=el('strong','canvasObjectName',esc(c.label||node.text||node.id));name.title='Selected canvas object';canvasTools.append(name);
 const field=(label,type,value,property,unit)=>{
  const wrap=el('label','canvasField'),caption=el('span','',esc(label)),input=el('input');input.type=type;input.value=value;input.dataset.control=property;if(unit)input.dataset.unit=unit;
  input.setAttribute('aria-label',label);if(type==='number')input.step=unit==='percent'?'.1':'.1';
  input.onchange=()=>commitGraphicChange(c,node,{[property]:type==='number'?Number(input.value)/(unit==='percent'?100:1):input.value});
  wrap.append(caption,input);canvasTools.append(wrap);return input;
 };
 if(node.kind==='text'||node.kind==='pixtext')field('Text','text',node.text,'text');
 // the colour you see: after its highlight time an element shows its accent, so that is the colour control offered
 const lit=node.accent&&node.highlightAt!=null&&T-c.start+(c.in||0)>=node.highlightAt;
 const colorProperty=lit?'accent':node.fill?'fill':'color';field(lit?'Highlight':colorProperty==='fill'?'Fill':'Color','color',node[colorProperty]||'#d97757',colorProperty);
 if(node.kind==='text'){
  field('Size %','number',rounded(node.size*100),'size','percent');
  field('Weight','number',node.weight||400,'weight');
  const wrap=el('label','canvasField'),caption=el('span','','Typeface'),input=el('select');input.dataset.control='font';input.setAttribute('aria-label','Typeface');
  for(const v of ['sans','serif','mono']){const o=el('option','',v);o.value=v;o.selected=node.font===v;input.append(o);}input.onchange=()=>commitGraphicChange(c,node,{font:input.value});wrap.append(caption,input);canvasTools.append(wrap);
 }else if(node.kind==='pixtext'||node.kind==='sprite')field('Size %','number',rounded((node.size??.005)*100),'size','percent');
 else if(node.kind==='slider')field('Speed','number',node.speed||0,'speed');
 else if(node.w!=null)field('Width %','number',rounded(node.w*100),'w','percent');
 if(node.kind==='rect'&&node.h!=null)field('Height %','number',rounded(node.h*100),'h','percent');
 for(const key of ['x','y'])field(key.toUpperCase()+' %','number',rounded(node[key]*100),key,'percent');
 if(node.radius!=null)field('Corners %','number',rounded(node.radius*100),'radius','percent');
 const more=el('button','','More');more.onclick=()=>{renderInspector();$('#inspector').scrollIntoView({block:'nearest'});};canvasTools.append(more);
}
function drawCanvasSelection(){
 const hit=graphicHits.findLast(h=>h.clip_id===sel);if(hit){
  ctx.save();ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.setLineDash([5,3]);ctx.strokeRect(hit.x-3,hit.y-3,hit.w+6,hit.h+6);ctx.setLineDash([]);
  for(const [x,y] of [[hit.x+hit.w,hit.y+hit.h]]){ctx.fillStyle='#fff';ctx.fillRect(x-3,y-3,6,6);ctx.strokeStyle='#000';ctx.strokeRect(x-3,y-3,6,6);}ctx.restore();
 }
 for(const job of P.promptJobs||[]){if(!job.clip_id||Date.now()-(job.finishedAt||Date.now())>12000)continue;
  const h=graphicHits.find(x=>x.clip_id===job.clip_id);if(!h)continue;
  ctx.save();ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.strokeRect(h.x-5,h.y-5,h.w+10,h.h+10);ctx.font='bold 10px Arial';ctx.fillStyle='#000';ctx.fillRect(h.x-5,h.y-17,65,13);ctx.fillStyle='#fff';ctx.fillText(job.cursor,h.x-2,h.y-16);ctx.restore();
 }
}
function openGraphicInline(c,node){
 if(graphicInline)graphicInline.finish(false);
 const hit=graphicHits.find(h=>h.clip_id===c.id);if(!hit)return;
 const cr=cv.getBoundingClientRect(),wr=$('#viewerWrap').getBoundingClientRect(),k=cr.width/cv.width;
 const ta=el('textarea','textEditor');ta.value=node.text;ta.setAttribute('aria-label','Edit graphic text');
 Object.assign(ta.style,{left:`${cr.left-wr.left+hit.x*k}px`,top:`${cr.top-wr.top+hit.y*k}px`,width:`${Math.max(100,hit.w*k+20)}px`,height:`${Math.max(50,hit.h*k+20)}px`,fontSize:`${Math.max(14,node.size*cv.height*k)}px`});
 let closed=false;const finish=save=>{if(closed)return;closed=true;ta.remove();graphicInline=null;if(save&&ta.value!==node.text)commitGraphicChange(c,node,{text:ta.value});};
 graphicInline={ta,finish};ta.onkeydown=e=>{e.stopPropagation();if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();finish(true);}if(e.key==='Escape'){e.preventDefault();finish(false);}};ta.onblur=()=>finish(true);$('#viewerWrap').append(ta);ta.focus();ta.select();
}
const canvasPoint=e=>{const r=cv.getBoundingClientRect();return {x:(e.clientX-r.left)/r.width*cv.width,y:(e.clientY-r.top)/r.height*cv.height};};
const graphicAt=(x,y)=>[...graphicHits].reverse().find(h=>x>=h.x-4&&x<=h.x+h.w+4&&y>=h.y-4&&y<=h.y+h.h+4);
cv.addEventListener('pointerdown',e=>{
 if(!P||renderView||playing||e.button!==0)return;
 const at=canvasPoint(e),selected=graphicHits.findLast(h=>h.clip_id===sel);
 const corner=selected&&Math.hypot(at.x-selected.x-selected.w,at.y-selected.y-selected.h)<12;
 if(!corner&&textHits.some(h=>at.x>=h.x&&at.x<=h.x+h.w&&at.y>=h.y&&at.y<=h.y+h.h))return;
 const hit=corner?selected:graphicAt(at.x,at.y);if(!hit)return;
 e.stopImmediatePropagation();e.preventDefault();select(hit.clip_id);
 graphicDrag={hit,start:at,node:{...hit.node},mode:corner?'resize':'move',moved:false};cv.setPointerCapture(e.pointerId);
},true);
cv.addEventListener('pointermove',e=>{
 const point=canvasPoint(e);
 if(!graphicDrag){if(!playing&&graphicAt(point.x,point.y)){cv.style.cursor='grab';e.stopImmediatePropagation();}return;}
 e.stopImmediatePropagation();const dx=point.x-graphicDrag.start.x,dy=point.y-graphicDrag.start.y;
 if(Math.abs(dx)+Math.abs(dy)<2)return;
 graphicDrag.moved=true;graphicDraft={clip_id:graphicDrag.hit.clip_id,node_id:graphicDrag.hit.node_id,patch:graphicTransform(graphicDrag.node,graphicDrag.hit,graphicDrag.mode,dx,dy,cv.width,cv.height)};
},true);
const finishGraphicDrag=(e,cancel=false)=>{
 if(!graphicDrag)return;e.stopImmediatePropagation();const drag=graphicDrag,draft=graphicDraft;graphicDrag=null;graphicDraft=null;
 if(!cancel&&drag.moved&&draft){const c=P.clips.find(c=>c.id===drag.hit.clip_id);commitGraphicChange(c,drag.node,draft.patch);}
};
cv.addEventListener('pointerup',e=>finishGraphicDrag(e),true);cv.addEventListener('pointercancel',e=>finishGraphicDrag(e,true),true);
cv.addEventListener('dblclick',e=>{const p=canvasPoint(e),h=graphicAt(p.x,p.y);if(h?.node.kind!=='text')return;e.stopImmediatePropagation();e.preventDefault();const c=P.clips.find(c=>c.id===h.clip_id);select(c.id);openGraphicInline(c,h.node);},true);
canvasTools.addEventListener('focusout',()=>queueMicrotask(()=>{renderCanvasTools();processPromptJobs(P?.promptJobs||[]);}));

// Independent prompt cursors. Routing overlaps; actual control commits are short UI turns.
const promptClientId=crypto.randomUUID(),promptInProgress=new Set();
const isAutomationCheck = new URLSearchParams(location.search).has('automation_check');let canvasExecution=Promise.resolve();
const livePrompts=el('div','livePrompts');livePrompts.id='livePrompts';$('#feed').before(livePrompts);
composer.placeholder='Describe a canvas change… Send another prompt while this one runs.';
function promptCursor(job,target){
 let r=roleCursors.get(job.cursor);if(!r){const cur=$('#cursor').cloneNode(true);cur.removeAttribute('id');cur.classList.add('editCursor','promptCursor');document.body.append(cur);r={cur,timer:null};roleCursors.set(job.cursor,r);}
 const box=target.getBoundingClientRect();r.cur.querySelector('span').textContent=`${job.cursor} · ${job.phase}`;r.cur.style.opacity=1;r.cur.style.transform=`translate3d(${clamp(box.left+Math.min(box.width/2,30),0,Math.max(0,innerWidth-185))}px,${clamp(box.top+Math.min(box.height/2,18),0,innerHeight-30)}px,0)`;clearTimeout(r.timer);r.timer=setTimeout(()=>r.cur.style.opacity=0,8000);
}
const seenPromptPhases = new Map();
function aimAtGraphic(job) {
 const hit = graphicHits.find(h => h.clip_id === job.clip_id);
 if (!hit) return;
 // The canvas outline and prompt row already show the result. Keep the changed wording readable.
 if (hit.node.kind === 'text') {
  const cursor = roleCursors.get(job.cursor);
  if (cursor) {
   clearTimeout(cursor.timer);
   cursor.cur.style.opacity = 0;
  }
  return;
 }
 const box = cv.getBoundingClientRect();
 const anchorY = hit.node.kind === 'rect' ? hit.y + hit.h * .65 : hit.y;
 promptCursor(job, { getBoundingClientRect: () => ({
  left: box.left + hit.x * box.width / cv.width,
  top: box.top + anchorY * box.height / cv.height,
  width: hit.w * box.width / cv.width,
  height: 0
 }) });
}
function preparePromptControl(job) {
 if (renderView) showRender(null);
 if (playing) togglePlay();
 if (Math.abs(T - job.previewTime) > .001) seek(job.previewTime);
 graphicNodeId = job.node_id;
 if (sel !== job.clip_id) select(job.clip_id);
 tick();
 renderCanvasTools();
}
function processPromptJobs(jobs){
 const sorted = [...jobs].sort((a,b) => b.number - a.number);
 const active = sorted.filter(j => ['routing','ready','executing'].includes(j.status));
 const listed = [...active, ...sorted.filter(j => !active.includes(j)).slice(0, Math.max(0, 5-active.length))];
 livePrompts.replaceChildren();
 const latest = new Map();
 for (const job of sorted) if (!latest.has(job.cursor)) latest.set(job.cursor, job.id);
 for (const job of listed) {
  const row = el('div','promptRow');
  row.dataset.prompt = job.id;
  row.append(el('b','',esc(job.cursor)),el('span','',esc(job.phase)));
  if (job.revision_id) {
   const review = el('button','','Review');
   review.onclick = () => openRevision(job.revision_id);
   row.append(review);
  }
  livePrompts.append(row);
  const phase = job.id + ':' + job.status;
  if (latest.get(job.cursor) === job.id && seenPromptPhases.get(job.cursor) !== phase) {
   seenPromptPhases.set(job.cursor, phase);
   if (['routing','ready'].includes(job.status) && !roleCursors.has(job.cursor)) promptCursor(job,row);
   if (job.status === 'executing' && job.client !== promptClientId && $('#follow').checked && !playing && !graphicDrag && !graphicInline && !canvasTools.contains(document.activeElement)) {
    preparePromptControl(job);
    const control = canvasTools.querySelector(`[data-control="${job.route.property}"]`);
    if (control) promptCursor({...job,phase:`${job.element} · ${job.control}`}, control);
   }
   if (job.status === 'done' && Date.now() - job.finishedAt < 8000) aimAtGraphic(job);
  }
  if(job.status==='ready'&&!promptInProgress.has(job.id)&&(document.visibilityState==='visible'||isAutomationCheck)){
   promptInProgress.add(job.id);canvasExecution=canvasExecution.then(()=>executeCanvasPrompt(job)).catch(e=>post({action:'prompt_fail',id:job.id,message:e.message}));
  }
 }
}
async function executeCanvasPrompt(job){
 while(canvasTools.contains(document.activeElement)||graphicInline){await new Promise(resolve=>document.addEventListener('focusout',resolve,{once:true}));}
 const claim=await post({action:'claim_prompt',id:job.id,client:promptClientId});if(!claim.ok)return;
 preparePromptControl(job);
 const property=job.route.property;
 let input=canvasTools.querySelector(`[data-control="${property}"]`);
 if(property==='opacity'){
  const wrap=el('label','canvasField');wrap.append(el('span','','Opacity'));input=el('input');input.type='number';input.value=job.before;input.dataset.control='opacity';input.onchange=()=>post({action:'ops',surface:'canvas',ops:[{op:'update_clip',id:job.clip_id,opacity:rounded(Number(input.value))}]});wrap.append(input);canvasTools.append(wrap);
 }
 if(!input)throw new Error(`The selected canvas object has no ${job.control} control.`);
 input.classList.add('promptControl');promptCursor({...job,phase:`Select ${job.element} → ${job.control}`},input);
 if (document.visibilityState === 'visible') await new Promise(resolve => { requestAnimationFrame(resolve); setTimeout(resolve, 45); });
 const token={id:job.id,client:promptClientId};activePromptControl=token;
 try{input.value=input.dataset.unit==='percent'?rounded(job.after*100):String(job.after);input.dispatchEvent(new Event('change',{bubbles:true}));}finally{activePromptControl=null;}
 if(!token.completion)throw new Error('The canvas control did not submit an edit.');
 const result=await token.completion;if(result.error)throw new Error(result.error);
 setTimeout(()=>input.classList.remove('promptControl'),250);
}
document.addEventListener('visibilitychange',()=>processPromptJobs(P?.promptJobs||[]));
