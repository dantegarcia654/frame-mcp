// Frame Live: a pop-up that shows what Claude is doing right now.
// Events come from Claude Code hooks (bin/live-hook.js) → POST /api/live → this page over /api/live/events.
// Everything shown is a real event with its real time; gaps between tool calls are shown as "Thinking", with a clock.
(() => {
  const standalone = document.body.classList.contains('live-standalone');
  const css = `
  #fl{position:fixed;z-index:9999;top:14px;left:50%;transform:translateX(-50%) translateY(-12px);width:min(560px,94vw);max-height:72vh;display:flex;flex-direction:column;
    background:#000;color:#fff;border:1px solid #fff;border-radius:4px;box-shadow:0 18px 60px rgba(0,0,0,.85);font:12px/1.45 -apple-system,"Inter","Helvetica Neue",Arial,sans-serif;
    opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}
  #fl.on{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}
  .live-standalone #fl{position:static;transform:none;width:auto;max-height:none;height:100vh;border:0;border-radius:0;box-shadow:none;opacity:1;pointer-events:auto}
  #fl .hd{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #232323}
  #fl .lg{width:16px;height:16px;flex:none}
  #fl .ttl{font-weight:700;letter-spacing:.14em;font-size:11px;text-transform:uppercase}
  #fl .st{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8c8c8c}
  #fl .clk{margin-left:auto;font:600 20px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.02em}
  #fl .x{background:none;border:1px solid #3a3a3a;color:#fff;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px}
  #fl .x:hover{border-color:#fff}
  #fl .pr{padding:8px 12px;color:#8c8c8c;border-bottom:1px solid #232323;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  #fl .now{display:flex;align-items:center;gap:10px;padding:12px;border-bottom:1px solid #232323;font-size:15px;font-weight:600}
  #fl .now .t{margin-left:auto;font:500 13px ui-monospace,"SF Mono",Menlo,monospace;color:#8c8c8c}
  #fl .dot{width:8px;height:8px;border-radius:50%;background:#fff;flex:none;animation:flp .9s infinite}
  #fl.done .dot{animation:none}
  @keyframes flp{50%{opacity:.15}}
  #fl .ls{overflow:auto;padding:6px 0;font:11.5px/1.5 ui-monospace,"SF Mono",Menlo,monospace}
  #fl .r{display:grid;grid-template-columns:56px 14px 1fr auto;gap:8px;padding:3px 12px;align-items:baseline}
  #fl .r .a{color:#5a5a5a}
  #fl .r .k{color:#8c8c8c;text-transform:uppercase;font-size:9.5px;letter-spacing:.1em;margin-right:6px}
  #fl .r .d{color:#5a5a5a;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #fl .r .du{color:#8c8c8c}
  #fl .r.run{background:#0b0b0b}
  #fl .r.think .l{color:#8c8c8c;font-style:italic}
  #fl .r.bad .l{text-decoration:line-through;color:#8c8c8c}
  #fl .empty{padding:18px 12px;color:#5a5a5a}
  #flpill{position:fixed;z-index:9999;top:10px;right:10px;display:none;align-items:center;gap:8px;padding:5px 10px;background:#000;color:#fff;border:1px solid #fff;border-radius:3px;
    font:600 11px ui-monospace,"SF Mono",Menlo,monospace;cursor:pointer}
  #flpill.on{display:flex}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const el = document.createElement('div'); el.id = 'fl';
  el.innerHTML = `<div class="hd"><svg class="lg" viewBox="0 0 20 20"><path d="M1 6V1h5M14 1h5v5M19 14v5h-5M6 19H1v-5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="7" y="7" width="6" height="6" fill="currentColor"/></svg>
    <div><div class="ttl">Frame · Live</div><div class="st">Waiting for a prompt</div></div><div class="clk">00:00.0</div>${standalone ? '' : '<button class="x" title="Hide (it comes back on the next prompt)">Hide</button>'}</div>
    <div class="pr" hidden></div><div class="now" hidden><i class="dot"></i><span class="nl"></span><span class="t"></span></div><div class="ls"><div class="empty">Send Claude a prompt. Every step shows up here as it happens.</div></div>`;
  const pill = document.createElement('div'); pill.id = 'flpill';
  document.body.append(el, pill);
  const $ = (s) => el.querySelector(s);
  const fmt = (ms) => { const s = Math.max(0, ms) / 1000; const m = Math.floor(s / 60); return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
  const dur = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let run = null, hidden = false;
  const reset = (at, text) => { run = { start: at, text, rows: [], open: new Map(), last: at, done: null }; };
  function apply(e) {
    if (e.kind === 'prompt') { reset(e.at, e.text); hidden = false; return; }
    if (!run) reset(e.at, '');
    if (e.kind === 'tool_start') {
      if (e.at - run.last > 400) run.rows.push({ think: true, start: run.last, end: e.at });
      const row = { id: e.id, kind: e.group, label: e.label, detail: e.detail, start: e.at, end: null, ok: true };
      run.rows.push(row); run.open.set(e.id || `#${run.rows.length}`, row);
    } else if (e.kind === 'tool_end') {
      let row = e.id && run.open.get(e.id);
      if (!row) row = [...run.open.values()].find((r) => r.label === e.label) || [...run.open.values()][0];
      if (row) { row.end = e.at; row.ok = e.ok !== false; run.open.delete([...run.open.entries()].find(([, r]) => r === row)?.[0]); }
      run.last = e.at;
    } else if (e.kind === 'note') {
      run.rows.push({ kind: 'Claude', label: e.text, start: e.at, end: e.at, ok: true, note: true }); run.last = e.at;
    } else if (e.kind === 'stop') {
      if (e.at - run.last > 400 && !run.open.size) run.rows.push({ think: true, start: run.last, end: e.at, final: true });
      run.done = e.at;
    }
  }
  function draw() {
    const now = Date.now();
    if (!run) return;
    const busy = [...run.open.values()].pop();
    el.classList.toggle('done', !!run.done);
    $('.st').textContent = run.done ? `Done · ${run.rows.filter((r) => !r.think).length} steps` : busy ? 'Working' : 'Thinking';
    $('.clk').textContent = fmt((run.done || now) - run.start);
    const pr = $('.pr'); pr.hidden = !run.text; pr.textContent = run.text ? `“${run.text}”` : '';
    const nw = $('.now'); nw.hidden = false;
    $('.nl').textContent = run.done ? 'Finished' : busy ? `${busy.kind ? busy.kind + ' · ' : ''}${busy.label}` : (run.rows.length ? 'Thinking about the next step' : 'Reading your prompt');
    $('.t').textContent = run.done ? '' : dur(now - (busy ? busy.start : run.last));
    const rows = [...run.rows];
    const html = rows.map((r) => {
      const end = r.end ?? now;
      if (r.think) return `<div class="r think"><span class="a">${fmt(r.start - run.start)}</span><span>·</span><span class="l">thinking</span><span class="du">${dur(r.end - r.start)}</span></div>`;
      const mark = r.end == null ? '<i class="dot" style="width:7px;height:7px;margin-top:4px"></i>' : r.ok ? '✓' : '✗';
      return `<div class="r${r.end == null ? ' run' : ''}${r.ok ? '' : ' bad'}"><span class="a">${fmt(r.start - run.start)}</span><span>${mark}</span><span><span class="l"><span class="k">${esc(r.kind || '')}</span>${esc(r.label)}</span>${r.detail ? `<span class="d">${esc(r.detail)}</span>` : ''}</span><span class="du">${r.note ? '' : dur(end - r.start)}</span></div>`;
    }).join('');
    const ls = $('.ls'); const stick = ls.scrollTop + ls.clientHeight >= ls.scrollHeight - 30;
    if (ls._h !== html) { ls.innerHTML = html || '<div class="empty">Prompt received. Waiting for Claude’s first step…</div>'; ls._h = html; if (stick) ls.scrollTop = ls.scrollHeight; }
    const show = standalone || !hidden;
    el.classList.toggle('on', show);
    pill.classList.toggle('on', !standalone && hidden);
    pill.textContent = `CLAUDE · ${fmt((run.done || now) - run.start)} · ${run.done ? 'done' : busy ? busy.label.slice(0, 28) : 'thinking'}`;
  }
  el.querySelector('.x')?.addEventListener('click', () => { hidden = true; draw(); });
  pill.addEventListener('click', () => { hidden = false; draw(); });
  if (standalone) el.classList.add('on');

  function connect() {
    const es = new EventSource('/api/live/events');
    es.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.type === 'backlog') { run = null; for (const e of d.events) apply(e); if (run && run.done) hidden = !standalone; }
      else if (d.type === 'live') apply(d.event);
      draw();
    };
    es.onerror = () => { es.close(); setTimeout(connect, 1500); };
  }
  connect();
  setInterval(draw, 100);
})();
