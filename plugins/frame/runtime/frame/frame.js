(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const activeStates = new Set(['planning', 'rendering']);
  const STORAGE = 'frame-product-state-v1';
  const text = (selector, value) => { $(selector).textContent = value == null ? '' : String(value); };
  const node = (tag, className, content) => { const element = document.createElement(tag); if (className) element.className = className; if (content != null) element.textContent = String(content); return element; };
  let config = null, current = null, pending = false, selectedVersionId = null, selectionPinned = false;
  let timer = null, quoteTimer = null, epoch = 0, failedPolls = 0, requestRecovery = null, connectionMode = null;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE) || '{}') || {}; } catch {}
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
  const uuid = () => window.crypto?.randomUUID ? window.crypto.randomUUID().replace(/-/g, '') : Date.now().toString(16).padStart(12, '0') + Array.from({length:20}, () => Math.floor(Math.random()*16).toString(16)).join('');
  const versions = () => Array.isArray(current?.versions) ? current.versions : [];
  const activeVersion = () => versions().find(v => v.id === current?.active_version_id) || versions().at(-1) || null;
  const completeVersions = () => versions().filter(v => v.status === 'complete' && v.result?.url);
  const selectedVersion = () => completeVersions().find(v => v.id === selectedVersionId) || completeVersions().find(v => v.id === current?.current_version_id) || completeVersions().at(-1) || null;
  const projectBusy = () => activeStates.has(current?.status) || activeStates.has(activeVersion()?.status);
  const locked = () => pending || projectBusy() || !!requestRecovery;
  const limit = () => Number.isInteger(config?.limits?.script_chars) ? config.limits.script_chars : 1800;
  const wordLimit = () => Number.isInteger(config?.limits?.script_words) ? config.limits.script_words : 80;
  const wordCount = value => value.trim() ? value.trim().split(/\s+/u).length : 0;

  function remember() {
    const value = {draft:{idea:$('#idea').value,script:$('#script').value,provider:$('#provider').value},project_id:current?.id || null,request:requestRecovery,selected_version:selectedVersionId};
    try { localStorage.setItem(STORAGE, JSON.stringify(value)); } catch {}
  }
  function error(message = '') { text('#globalError', message); $('#globalError').hidden = !message; }
  function connection(message = '', mode = null, detail = '') {
    connectionMode = mode; text('#connectionTitle', message); text('#connectionDetail', detail);
    $('#connectionNotice').hidden = !message;
    text('#reconnectButton', mode === 'request' ? 'Recover this request' : mode === 'project' ? 'Check saved progress' : 'Reconnect');
  }
  async function api(url, options = {}) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, {...options,signal:controller.signal,cache:'no-store'});
      let data;
      try { data = await response.json(); }
      catch { const issue = new Error('Frame could not read the response. Your saved work is still here.'); issue.uncertain = true; throw issue; }
      if (!response.ok) { const issue = new Error(data?.error || 'The request could not finish. Please try again.'); issue.status = response.status; throw issue; }
      return data;
    } catch (issue) {
      if (!issue.status) issue.uncertain = true;
      if (issue.name === 'AbortError') { const timedOut = new Error('The connection timed out. The request may still be running.'); timedOut.uncertain = true; throw timedOut; }
      throw issue;
    } finally { clearTimeout(timeout); }
  }
  const post = (url, body) => api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  function safeMedia(value) {
    try {
      if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
      const url = new URL(value, location.origin);
      return url.origin === location.origin && /^\/(frame-media|studio-media)\//.test(url.pathname) ? url.href : null;
    } catch { return null; }
  }
  function clearPlayer() {
    const video = $('#video');
    video.pause(); video.removeAttribute('src'); video.removeAttribute('poster'); delete video.dataset.source; video.load();
  }
  function requireProject(project) {
    if (!project || !validId(project.id) || !Array.isArray(project.versions)) {
      const issue = new Error('Frame returned an incomplete saved project. Check the connection before trying again.');
      issue.uncertain = true; throw issue;
    }
  }
  function formatDuration(value) { return Number.isFinite(value) ? `${value.toFixed(1)}s` : ''; }
  function quoteExpiry(quote) {
    if (!quote) return NaN;
    if (typeof quote.expires_at === 'number') return quote.expires_at*(quote.expires_at < 1e12 ? 1000 : 1);
    if (typeof quote.expires_at === 'string') return Date.parse(quote.expires_at);
    if (typeof quote.created_at === 'number') return quote.created_at*(quote.created_at < 1e12 ? 1000 : 1)+900000;
    return NaN;
  }
  function quoteReady(quote) {
    return !!quote?.quote_id && Number.isFinite(quote.total_credits) && quote.total_credits >= 0 && quote.has_sufficient_balance === true && quoteExpiry(quote) > Date.now();
  }
  function controls() {
    const busy = locked(), active = activeVersion(), complete = selectedVersion();
    $('#idea').disabled = !!current || busy;
    $('#script').disabled = !!current || busy;
    $('#provider').disabled = !!current || busy;
    $('#createActions').hidden = !!current;
    $('#lockedBriefNote').hidden = !current;
    $('#newProject').disabled = pending || !!requestRecovery;
    $('#generateButton').disabled = busy || !config || ($('#provider').value === 'fish-mcp' && !config.fish_ready);
    $('#demoButton').disabled = busy || !config;
    $('#feedback').disabled = busy || !complete || active?.status === 'awaiting_quote';
    $('#reviseButton').disabled = busy || !complete || !$('#feedback').value.trim() || active?.status === 'awaiting_quote';
    $('#confirmRender').disabled = busy || active?.status !== 'awaiting_quote' || !quoteReady(active?.quote);
    $('#refreshQuote').disabled = busy || active?.status !== 'awaiting_quote';
    $('#retryButton').disabled = busy || active?.status !== 'failed';
    $('#reconnectButton').disabled = pending;
    $('#versionSelect').disabled = pending || completeVersions().length < 2;
    document.querySelectorAll('.project-link').forEach(element => { element.disabled = pending || !!requestRecovery; });
    text('#scriptCount', `${wordCount($('#script').value)} / ${wordLimit()} words`);
    text('#scriptHelp', `The exact words your video will say. Up to ${wordLimit()} words, under a minute.`);
    $('#script').maxLength = limit();
    voiceView();
  }
  function voiceView() {
    const edge = $('#provider').value === 'edge';
    const ready = !!config && (edge || config.fish_ready);
    $('#voiceDot').classList.toggle('ready', ready);
    text('#voiceLabel', !config ? 'Checking your narrator…' : edge ? 'Edge preview voice · different delivery' : config.fish_ready ? `${config.voice_name || 'Your narrator'} · Fish Audio connected` : 'Connect Fish Audio to give your video a voice');
    $('#connectFish').hidden = !config || edge || config.fish_ready;
    text('#costNote', edge ? 'Uses the Edge speech service. This preview does not spend Fish Audio credits.' : 'You’ll see the Fish Audio credit cost before narration is generated.');
  }
  function stageView() {
    const active = activeVersion(), status = active?.status || current?.status;
    $('#progressRegion').hidden = !activeStates.has(status);
    text('#stageTitle', current?.stage || active?.stage || (status === 'planning' ? 'Finding the direction' : 'Bringing your video together'));
    text('#stageDetail', selectedVersion() ? 'Your earlier cut is below. This version will appear here when it is ready.' : 'You can leave this page and come back. Your progress is saved.');
    const stage = (current?.stage || active?.stage || '').toLowerCase();
    const step = status === 'planning' ? 0 : /voice|narrat|speech|fish|audio|measur/.test(stage) ? 1 : /check|verif|encod/.test(stage) ? 3 : 2;
    ['#directionStep','#voiceStep','#visualStep','#readyStep'].forEach((selector,i) => { $(selector).classList.toggle('done',i < step); $(selector).classList.toggle('active',i === step); });
    $('#failurePanel').hidden = status !== 'failed';
    text('#failureDetail', active?.error || current?.error || 'This step could not finish. Retry it to continue from the saved work.');
  }
  function quoteView() {
    clearTimeout(quoteTimer); quoteTimer = null;
    const active = activeVersion(), quote = active?.quote;
    $('#quotePanel').hidden = active?.status !== 'awaiting_quote';
    if (active?.status !== 'awaiting_quote') return;
    text('#quoteSummary', 'Your script and vocal direction are ready. Confirm the narration cost to continue. Frame will compose the visuals around the finished voice.');
    const hasQuote = !!quote?.quote_id && Number.isFinite(quote.total_credits);
    text('#creditCost', hasQuote ? `${quote.total_credits.toLocaleString()} credits` : 'Checking the narration cost');
    text('#creditBalance', Number.isFinite(quote?.available_credits) ? `${quote.available_credits.toLocaleString()} credits available in Fish Audio` : 'Your connected Fish Audio account');
    const fresh = quoteExpiry(quote) > Date.now();
    text('#quoteDetail', !hasQuote ? 'Refresh the quote to see the exact cost. No narration has been generated.' : !fresh ? 'This quote has expired. Refresh it to see the current cost.' : quote.has_sufficient_balance !== true ? 'Your Fish Audio balance does not cover this narration.' : 'Confirming uses this many Fish Audio credits. Visual revisions reuse the same narration.');
    text('#confirmRender', hasQuote ? `Generate video · ${quote.total_credits.toLocaleString()} credits` : 'Generate with Fish Audio');
    if (fresh) quoteTimer = setTimeout(() => { quoteView(); controls(); },Math.min(quoteExpiry(quote)-Date.now()+100,2147483647));
  }
  function resultView() {
    const chosen = selectedVersion(), all = completeVersions();
    $('#resultPanel').hidden = !chosen;
    if (!chosen) { if ($('#video').hasAttribute('src')) clearPlayer(); return; }
    selectedVersionId = chosen.id;
    const select = $('#versionSelect');
    const options = all.map((version,index) => { const option = node('option',null,`Version ${version.number || index+1}`); option.value = version.id; return option; });
    select.replaceChildren(...options); select.value = chosen.id;
    text('#resultLabel', chosen.feedback ? 'Your revised cut' : 'Your first cut');
    const result = chosen.result || {}, video = $('#video'), url = safeMedia(result.url), poster = safeMedia(result.poster_url);
    if (url && video.dataset.source !== url) {
      video.pause(); video.src = url; video.dataset.source = url;
      if (poster) video.poster = poster; else video.removeAttribute('poster');
      video.load();
    }
    const download = $('#downloadLink');
    if (url) { download.href = url; download.download = `frame-${current.id.slice(0,8)}-v${chosen.number || all.indexOf(chosen)+1}.mp4`; download.removeAttribute('aria-disabled'); }
    else { clearPlayer(); download.removeAttribute('href'); download.setAttribute('aria-disabled','true'); error('The saved video link could not be opened. Check the saved project before downloading.'); }
    const provider = result.voice_provider || current.voice?.provider || '';
    const voice = /fish/i.test(provider) ? 'Fish Audio' : /edge|neural/i.test(provider) ? 'Edge preview' : /record/i.test(provider) ? 'Original recording' : 'Narrated video';
    const dimensions = result.width && result.height ? `${result.width} × ${result.height}` : '';
    text('#videoMeta', [formatDuration(result.duration),dimensions,voice].filter(Boolean).join(' · '));
    const summary = chosen.summary || result.summary || '';
    $('#directionNote').hidden = !summary; text('#directionSummary', summary);
    const warnings = Array.isArray(result.warnings) ? result.warnings.filter(v => typeof v === 'string') : [];
    const warningBox = $('#warnings');
    const notesOpen = warningBox.dataset.version === chosen.id && warningBox.querySelector('details')?.open === true;
    const needsReview = message => /(?:speech|captions?|narration|transcript|spoken words).*?(?:differ|mismatch|does not match|do not match|missing|incomplete)|(?:differ|mismatch).*?script|clipped audio/i.test(message);
    const visible = warnings.filter(needsReview), notes = warnings.filter(message => !needsReview(message));
    const content = visible.map(message => node('p','review-warning',message));
    if (notes.length) {
      const disclosure = node('details','narration-notes'); disclosure.open = notesOpen;
      disclosure.append(node('summary',null,'Narration notes'),...notes.map(message => node('p',null,message)));
      content.push(disclosure);
    }
    warningBox.replaceChildren(...content); warningBox.dataset.version = chosen.id;
    $('#warnings').hidden = !warnings.length;
    text('#revisionNote', `Version ${(chosen.number || all.indexOf(chosen)+1)} is your starting point. Earlier cuts stay saved.`);
  }
  function render() {
    $('#emptyState').hidden = !!current; $('#projectState').hidden = !current;
    if (current) { stageView(); quoteView(); resultView(); }
    controls();
  }
  function setProject(project, {open=false} = {}) {
    requireProject(project);
    const switched = current?.id !== project.id;
    current = project;
    if (open || switched) { selectedVersionId = null; selectionPinned = false; $('#feedback').value = ''; }
    if (!selectionPinned) selectedVersionId = completeVersions().find(v => v.id === project.current_version_id)?.id || completeVersions().at(-1)?.id || null;
    $('#idea').value = project.idea || ''; $('#script').value = project.script || '';
    const url = new URL(location.href); url.searchParams.set('project',project.id); history.replaceState(null,'',url.pathname+url.search+url.hash);
    error(); render(); remember();
    if (projectBusy()) schedulePoll(); else { clearTimeout(timer); timer = null; }
  }
  function schedulePoll(delay = 1400) {
    clearTimeout(timer);
    const token = epoch, pid = current?.id;
    if (!pid) return;
    timer = setTimeout(async () => {
      if (token !== epoch || current?.id !== pid) return;
      try {
        const project = await api(`/api/frame/projects/${pid}`);
        if (token !== epoch || current?.id !== pid) return;
        failedPolls = 0; if (connectionMode === 'project') connection();
        const wasBusy = projectBusy(); setProject(project);
        if (wasBusy && !projectBusy()) await refreshRecent();
      } catch (issue) {
        if (token !== epoch || current?.id !== pid) return;
        failedPolls++;
        connection('We lost the connection to this video.','project',failedPolls < 5 ? 'Frame is checking again. Your saved work will resume here.' : 'Automatic checks paused. Reconnect to see the current saved progress.');
        if (failedPolls < 5 && issue.status !== 404) schedulePoll(Math.min(1500*2**failedPolls,15000));
      }
    }, delay);
  }
  async function refreshRecent() {
    try {
      const data = await api('/api/frame/projects');
      const rows = Array.isArray(data) ? data : data.projects;
      if (!Array.isArray(rows)) return;
      $('#recentProjects').replaceChildren(...rows.filter(row => validId(row.id)).slice(0,6).map(row => {
        const button = node('button','project-link'); button.type='button'; button.classList.toggle('active',current?.id === row.id);
        const copy = node('span','project-copy'); copy.append(node('span','project-name',row.name || 'Untitled video'));
        const status = {complete:'Ready to watch',planning:'Finding the direction',rendering:'Creating video',awaiting_quote:'Ready for your credit confirmation',failed:'Saved · needs another try'}[row.status] || 'Saved project';
        copy.append(node('span','project-status',status)); button.append(copy,node('span','project-arrow','↗'));
        button.addEventListener('click',() => openProject(row.id)); return button;
      }));
      $('#recentSection').hidden = !$('#recentProjects').children.length; controls();
    } catch { /* Existing projects remain available through their saved links. */ }
  }
  async function openProject(pid) {
    if (!validId(pid) || pending || requestRecovery) return;
    const token = ++epoch; clearTimeout(timer); pending = true; controls(); error(); connection();
    try { const project = await api(`/api/frame/projects/${pid}`); if (token === epoch) { failedPolls = 0; setProject(project,{open:true}); await refreshRecent(); } }
    catch (issue) { if (token === epoch) { error(issue.message); if (current && projectBusy()) schedulePoll(); } }
    finally { if (token === epoch) { pending = false; controls(); } }
  }
  async function performRequest(request) {
    if (pending) return;
    pending = true; requestRecovery = request; remember(); error(); connection(); controls();
    const token = ++epoch; clearTimeout(timer);
    try {
      const project = await post(request.path,request.body);
      if (token !== epoch) return;
      requireProject(project);
      requestRecovery = null; failedPolls = 0; selectionPinned = false;
      if (request.kind === 'revise') $('#feedback').value = '';
      setProject(project,{open:request.kind !== 'revise'}); await refreshRecent();
    } catch (issue) {
      if (token !== epoch) return;
      if (issue.uncertain) connection('The connection ended before confirmation.','request','Your request may already be running. Recover it to check or continue the same request.');
      else { requestRecovery = null; error(issue.message); if (current && projectBusy()) schedulePoll(); }
    } finally { if (token === epoch) { pending = false; remember(); controls(); } }
  }
  async function projectAction(action, body) {
    if (locked() || !current) return;
    pending = true; controls(); error(); connection();
    const pid = current.id, token = ++epoch; clearTimeout(timer);
    try {
      const project = await post(`/api/frame/projects/${pid}/${action}`,body);
      if (token !== epoch) return;
      failedPolls = 0; selectionPinned = false; setProject(project); await refreshRecent();
    } catch (issue) {
      if (token !== epoch) return;
      if (issue.uncertain) {
        connection('Checking what was saved.','project','The request was not sent again. Check saved progress before taking another action.');
        // A lost paid-render response must only trigger a status read, never another render.
        try { const project = await api(`/api/frame/projects/${pid}`); if (token === epoch) { setProject(project); connection(); } }
        catch { if (token === epoch) connection('The connection is still unavailable.','project','The request was not sent again. Check your saved progress when Frame reconnects.'); }
      } else error(issue.message);
    } finally { if (token === epoch) { pending = false; controls(); } }
  }
  function newProject() {
    if (pending || requestRecovery) return;
    ++epoch; clearTimeout(timer); clearTimeout(quoteTimer); current = null; selectedVersionId = null; selectionPinned = false; failedPolls = 0;
    clearPlayer();
    $('#idea').value=''; $('#script').value=''; $('#feedback').value='';
    $('#provider').value='edge';
    const url = new URL(location.href); url.searchParams.delete('project'); history.replaceState(null,'',url.pathname+url.search);
    error(); connection(); render(); remember(); refreshRecent(); $('#idea').focus();
  }
  async function initialize() {
    const draft = saved.draft && typeof saved.draft === 'object' ? saved.draft : {};
    $('#idea').value = typeof draft.idea === 'string' ? draft.idea.slice(0,1800) : '';
    $('#script').value = typeof draft.script === 'string' ? draft.script : '';
    $('#provider').value = draft.provider === 'fish-mcp' ? 'fish-mcp' : 'edge';
    if (draft.provider === 'edge') $('#voiceOptions').open = true;
    const recovery = saved.request;
    if (recovery && ['generate','import','revise'].includes(recovery.kind) && typeof recovery.path === 'string' && /^\/api\/frame\/(generate|import|projects\/[a-f0-9]{32}\/revise)$/.test(recovery.path) && recovery.body && typeof recovery.body === 'object' && validId(recovery.body.request_id)) requestRecovery = recovery;
    controls();
    await loadConfig();
    const fromURL = new URL(location.href).searchParams.get('project');
    const pid = validId(fromURL) ? fromURL : validId(saved.project_id) ? saved.project_id : null;
    if (pid) {
      try { const project = await api(`/api/frame/projects/${pid}`); setProject(project,{open:true}); if (validId(saved.selected_version)) { selectedVersionId=saved.selected_version; selectionPinned=true; render(); } }
      catch (issue) { error(issue.message); }
    }
    if (requestRecovery) connection('A request is waiting to be recovered.','request','Recover the same request to find its saved progress. It will not create a duplicate video.');
    await refreshRecent(); controls();
  }
  async function loadConfig() {
    try {
      config = await api('/api/frame/config');
      const candidates = Array.isArray(config.existing_studio) ? config.existing_studio : [];
      if (!validId(config.demo_studio_id)) config.demo_studio_id = candidates.find(row => validId(row.id))?.id || null;
      $('#demoButton').hidden = !validId(config.demo_studio_id); controls();
      if (connectionMode === 'config') connection();
    } catch (issue) { config = null; connection('Frame is not connected yet.','config',issue.message); controls(); }
  }

  $('#briefForm').addEventListener('submit', event => {
    event.preventDefault(); if (locked() || current || !config) return;
    const script = $('#script').value.trim(), idea = $('#idea').value.trim(), provider = $('#provider').value;
    if (!script || script.length > limit()) return error(`Add a script between 1 and ${limit().toLocaleString()} characters.`);
    if (wordCount(script) > wordLimit()) return error(`Keep this video to ${wordLimit()} words or fewer so it fits within a minute.`);
    if (idea.length > 1800) return error('Keep the idea under 1,800 characters.');
    if (provider === 'fish-mcp' && !config.fish_ready) return error('Connect Fish Audio, or explicitly choose the Edge preview voice in Voice options.');
    performRequest({kind:'generate',path:'/api/frame/generate',body:{idea,script,provider,request_id:uuid()}});
  });
  $('#demoButton').addEventListener('click', () => { if (!locked() && validId(config?.demo_studio_id)) performRequest({kind:'import',path:'/api/frame/import',body:{studio_id:config.demo_studio_id,request_id:uuid()}}); });
  $('#revisionForm').addEventListener('submit', event => {
    event.preventDefault(); const version = selectedVersion(), feedback = $('#feedback').value.trim();
    if (locked() || !version || !feedback || activeVersion()?.status === 'awaiting_quote') return;
    if (feedback.length > 1800) return error('Describe the visual change in 1,800 characters or fewer.');
    performRequest({kind:'revise',path:`/api/frame/projects/${current.id}/revise`,body:{feedback,base_version_id:version.id,request_id:uuid()}});
  });
  $('#confirmRender').addEventListener('click', () => { const version = activeVersion(); if (!locked() && version?.status === 'awaiting_quote' && quoteReady(version.quote)) projectAction('render',{version_id:version.id,quote_id:version.quote.quote_id}); });
  $('#refreshQuote').addEventListener('click', () => { const version = activeVersion(); if (!locked() && version?.status === 'awaiting_quote') projectAction('quote',{version_id:version.id}); });
  $('#retryButton').addEventListener('click', () => { const version = activeVersion(); if (!locked() && version?.status === 'failed') projectAction('retry',{version_id:version.id}); });
  $('#versionSelect').addEventListener('change', () => { if (completeVersions().some(v => v.id === $('#versionSelect').value)) { selectedVersionId=$('#versionSelect').value; selectionPinned=true; resultView(); controls(); remember(); } });
  $('#newProject').addEventListener('click',newProject);
  $('#reconnectButton').addEventListener('click', async () => {
    if (pending) return;
    if (requestRecovery) return performRequest(requestRecovery);
    if (connectionMode === 'project' && current) return openProject(current.id);
    await loadConfig(); await refreshRecent();
  });
  ['#idea','#script','#provider'].forEach(selector => $(selector).addEventListener(selector === '#provider' ? 'change' : 'input',() => { controls(); remember(); }));
  $('#feedback').addEventListener('input',controls);
  window.addEventListener('beforeunload',remember);
  window.addEventListener('popstate',() => { const pid=new URL(location.href).searchParams.get('project'); if (validId(pid)) openProject(pid); });
  initialize().catch(issue => { error(issue.message || 'Frame could not start. Reload to reconnect.'); controls(); });
})();
