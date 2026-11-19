// Card drawing library. Runs inside headless Chrome (see src/cards.js). Pure canvas, no network.
// window.cardStates(card) → [{ at, png }] : one transparent PNG per visual state of the card, all the same size.
(() => {
  const T = { purple: '#6C5CE7', purpleDeep: '#5443D6', ink: '#111114', paper: '#FFFFFF', mute: '#8B8B98', line: '#E7E6F2' };
  const THEMES = { purple: [T.purple, '#FFFFFF', 'rgba(255,255,255,.72)'], paper: [T.paper, T.ink, T.mute], ink: [T.ink, '#FFFFFF', 'rgba(255,255,255,.6)'] };
  const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  const M = 70; // margin around the card for its shadow
  const font = (c, size, weight = 800) => { c.font = `${weight} ${size}px ${FONT}`; };
  function wrap(c, text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const w of para.split(/\s+/)) { const t = line ? line + ' ' + w : w; if (c.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
      out.push(line);
    }
    return out;
  }
  function box(c, x, y, w, h, r, fill, shadow = true) {
    c.save();
    if (shadow) { c.shadowColor = 'rgba(10,8,30,.38)'; c.shadowBlur = 46; c.shadowOffsetY = 18; }
    c.fillStyle = fill; c.beginPath(); c.roundRect(x, y, w, h, r); c.fill(); c.restore();
  }
  function pill(c, x, y, text, bg, fg, size = 38) {
    font(c, size, 700); const w = c.measureText(text).width + size * 1.3, h = size * 1.75;
    box(c, x, y, w, h, h / 2, bg, false); c.fillStyle = fg; c.textBaseline = 'middle'; c.fillText(text, x + size * 0.65, y + h / 2 + 1); return [w, h];
  }
  function avatar(c, x, y, r, letter, bg, fg) {
    c.fillStyle = bg; c.beginPath(); c.arc(x + r, y + r, r, 0, Math.PI * 2); c.fill();
    font(c, r * 1.05, 800); c.fillStyle = fg; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(letter, x + r, y + r + 1); c.textAlign = 'left';
  }
  function check(c, x, y, r, done, col) {
    c.save(); c.lineWidth = 4;
    if (done) { c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 6; c.lineCap = 'round'; c.lineJoin = 'round'; c.beginPath(); c.moveTo(x - r * .42, y + r * .02); c.lineTo(x - r * .1, y + r * .34); c.lineTo(x + r * .45, y - r * .3); c.stroke(); }
    else { c.strokeStyle = 'rgba(17,17,20,.22)'; c.beginPath(); c.arc(x, y, r - 2, 0, Math.PI * 2); c.stroke(); }
    c.restore();
  }

  // Each layout function draws one state; `s` says how far through the card's reveals this state is.
  const KINDS = {
    // { kind:'title', text, sub?, theme, size? }
    title(c, k, s, W) {
      const [bg, fg, dim] = THEMES[k.theme || 'purple']; const size = k.size || 76, pad = 56;
      font(c, size, 800); const lines = wrap(c, k.upper === false ? k.text : k.text.toUpperCase(), W - pad * 2);
      const tw = Math.max(...lines.map((l) => c.measureText(l).width)); let subW = 0;
      if (k.sub) { font(c, size * 0.42, 600); subW = c.measureText(k.sub).width; }
      const w = Math.max(tw, subW) + pad * 2, h = pad * 2 + lines.length * size * 1.08 + (k.sub ? size * 0.75 : 0) - size * 0.08;
      return (draw) => { if (!draw) return [w, h];
        box(c, M, M, w, h, 40, bg); font(c, size, 800); c.fillStyle = fg; c.textBaseline = 'alphabetic';
        lines.forEach((l, i) => c.fillText(l, M + pad, M + pad + size * 0.86 + i * size * 1.08));
        if (k.sub) { font(c, size * 0.42, 600); c.fillStyle = dim; c.fillText(k.sub, M + pad, M + h - pad + 4); }
      };
    },
    // { kind:'chat', sender, avatar?, text, note?, tag?, tagAt?, theme, side, type? }
    chat(c, k, s, W) {
      const [bg, fg, dim] = THEMES[k.theme || 'paper']; const size = k.size || 56, pad = 48;
      font(c, size, 700); const lines = wrap(c, k.text, W - pad * 2 - 40);
      const tw = Math.max(...lines.map((l) => c.measureText(l).width));
      const w = Math.max(tw + pad * 2, 520), h = pad * 2 + 64 + lines.length * size * 1.18 + (k.note ? 52 : 0);
      return (draw) => { if (!draw) return [w, h + 34];
        box(c, M, M, w, h, 40, bg);
        // tail
        c.fillStyle = bg; c.beginPath(); const tx = k.side === 'right' ? M + w - 90 : M + 60;
        c.moveTo(tx, M + h - 2); c.lineTo(tx + 60, M + h - 2); c.lineTo(k.side === 'right' ? tx + 76 : tx - 16, M + h + 34); c.closePath(); c.fill();
        avatar(c, M + pad, M + pad - 4, 24, (k.avatar || k.sender[0]).toUpperCase(), k.theme === 'ink' ? '#FFFFFF' : T.purple, k.theme === 'ink' ? T.ink : '#FFFFFF');
        font(c, 34, 700); c.fillStyle = fg; c.textBaseline = 'middle'; c.fillText(k.sender, M + pad + 64, M + pad + 20);
        const shown = k.type ? Math.round(s.type * k.text.length) : k.text.length;
        font(c, size, 700); c.fillStyle = fg; c.textBaseline = 'alphabetic';
        let left = shown, lastX = 0, lastY = 0;
        lines.forEach((l, i) => { const part = l.slice(0, Math.max(0, left)); left -= l.length + 1; const y = M + pad + 64 + size * 0.95 + i * size * 1.18; c.fillText(part, M + pad, y); if (part.length || i === 0) { lastX = M + pad + c.measureText(part).width; lastY = y; } });
        if (k.type && s.type < 1) { c.fillStyle = T.purple; c.fillRect(lastX + 6, lastY - size * 0.8, 5, size * 0.95); }
        if (k.note) { font(c, 30, 600); c.fillStyle = dim; c.fillText(k.note, M + pad, M + h - pad + 6); }
        if (k.tag && s.tag) { font(c, 32, 800); const pw = c.measureText(k.tag).width + 44; pill(c, M + w - pw + 10, M - 26, k.tag, T.purple, '#fff', 32); }
      };
    },
    // { kind:'list', title?, rows:[{text, at}], theme }
    list(c, k, s, W) {
      const [bg, fg, dim] = THEMES[k.theme || 'paper']; const size = k.size || 54, pad = 52, rowH = size * 1.9;
      font(c, size, 700); const tw = Math.max(...k.rows.map((r) => c.measureText(r.text).width));
      const w = Math.min(W, tw + pad * 2 + 90), titleH = k.title ? 66 : 0;
      return (draw) => { const n = draw ? s.rows : k.rows.length; const h = pad * 2 + titleH + n * rowH - (n ? size * 0.5 : 0) + 14; if (!draw) return [w, pad * 2 + titleH + k.rows.length * rowH];
        box(c, M, M, w, h, 40, bg);
        if (k.title) { font(c, 30, 800); c.fillStyle = T.purple; c.textBaseline = 'alphabetic'; c.fillText(k.title.toUpperCase(), M + pad, M + pad + 24); }
        for (let i = 0; i < n; i++) { const y = M + pad + titleH + i * rowH + size * 0.62; const done = i < s.checked;
          check(c, M + pad + 26, y, 26, done, T.purple); font(c, size, 700); c.fillStyle = done && i === k.rows.length - 1 ? T.purple : fg; c.textBaseline = 'middle'; c.fillText(k.rows[i].text, M + pad + 82, y + 2); }
        if (k.progress) { c.fillStyle = 'rgba(108,92,231,.18)'; c.fillRect(M + pad, M + h - 22, w - pad * 2, 8); c.fillStyle = T.purple; c.fillRect(M + pad, M + h - 22, (w - pad * 2) * (s.checked / k.rows.length), 8); }
      };
    },
    // { kind:'chip', logo, title, pills:[{text, at}] }
    chip(c, k, s, W) {
      const pad = 48, size = 44; font(c, size, 700); const tw = c.measureText(k.title).width;
      font(c, 40, 700); const pw = Math.max(0, ...k.pills.map((p) => c.measureText(p.text).width + 52));
      const w = Math.max(tw + 130, pw) + pad * 2, rowH = 92;
      return (draw) => { const n = draw ? s.pills : k.pills.length; const h = pad * 2 + 72 + n * rowH; if (!draw) return [w, pad * 2 + 72 + k.pills.length * rowH];
        box(c, M, M, w, h, 40, T.paper);
        box(c, M + pad, M + pad, 72, 72, 20, T.purple, false); font(c, 46, 800); c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(k.logo || 'Z', M + pad + 36, M + pad + 38); c.textAlign = 'left';
        font(c, size, 700); c.fillStyle = T.ink; c.fillText(k.title, M + pad + 100, M + pad + 38);
        for (let i = 0; i < n; i++) pill(c, M + pad, M + pad + 100 + i * rowH, k.pills[i].text, T.purple, '#fff', 40);
      };
    },
  };

  // States: the moments the card's look changes (typing steps, rows, pills, tag).
  function stateList(k) {
    const st = [];
    if (k.kind === 'chat') {
      const td = k.typeDur || 0.9, steps = k.type ? 12 : 0;
      for (let i = 0; i <= steps; i++) st.push({ at: (k.typeAt || 0.15) * (i > 0) + (td * i) / Math.max(1, steps), type: steps ? i / steps : 1, tag: false });
      if (k.tag) st.push({ at: k.tagAt ?? 1.2, type: 1, tag: true });
    } else if (k.kind === 'list') {
      k.rows.forEach((r, i) => { st.push({ at: r.at, rows: i + 1, checked: i }); st.push({ at: r.at + 0.22, rows: i + 1, checked: i + 1 }); });
    } else if (k.kind === 'chip') {
      st.push({ at: 0, pills: 0 }); k.pills.forEach((p, i) => st.push({ at: p.at, pills: i + 1 }));
    } else st.push({ at: 0 });
    st[0].at = 0;
    return st.sort((a, b) => a.at - b.at);
  }

  window.cardStates = (k) => {
    const W = k.maxWidth || 900;
    const c0 = document.createElement('canvas').getContext('2d');
    const size = KINDS[k.kind](c0, k, {}, W)(false);
    const cw = Math.ceil(size[0] + M * 2), ch = Math.ceil(size[1] + M * 2);
    return stateList(k).map((s) => {
      const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch; const c = cv.getContext('2d');
      KINDS[k.kind](c, k, s, W)(true);
      return { at: s.at, w: cw, h: ch, png: cv.toDataURL('image/png') };
    });
  };
  window.__cardsReady = true;
})();
