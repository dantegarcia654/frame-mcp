(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  let current = null, assets = [], pending = false, uploading = false, timer = null, epoch = 0;
  let capabilities = { fish: { configured: false, default_voice_configured: false }, recording: true, edge: true };
  let voiceMode = 'recording', narratorProvider = 'fish', voiceRecords = { recording: null, clone: null };
  let voiceUploading = false, voiceTimer = null, voiceEpoch = 0, recorder = null, microphone = null, micPending = false, micClock = null, micEpoch = 0;
  let mcpStatus = {authorized:false,connected:false,pending:false,tool_count:0}, mcpWorking = false;
  let chosenMcpVoice = null, chosenMcpModel = 'drama-3', quoteTimer = null, narratorExplicit = false;
  const LOGIN_DRAFT = 'frame-studio-fish-login-draft';
  const activeStates = new Set(['planning', 'rendering']);
  const safeHex = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
  const text = (selector, value) => { $(selector).textContent = value == null ? '' : String(value); };
  const el = (tag, className, content) => { const node = document.createElement(tag); if (className) node.className = className; if (content != null) node.textContent = String(content); return node; };
  const coreBusy = () => pending || uploading || activeStates.has(current?.status);
  const micActive = () => micPending || !!recorder;
  const busy = () => coreBusy() || voiceUploading || micActive();
  const selectedRecording = () => voiceRecords[voiceMode] || null;
  const voiceConfig = () => ({mode:voiceMode,recording_id:voiceMode === 'ai' ? null : selectedRecording()?.id || null,provider:voiceMode === 'clone' || voiceMode === 'recording' && narratorProvider === 'fish-mcp' ? 'fish' : narratorProvider,...(voiceMode === 'ai' && narratorProvider === 'fish-mcp' ? {voice_id:chosenMcpVoice?.id || null,voice_name:chosenMcpVoice?.name || '',model:chosenMcpModel} : {})});
  const normalizedVoice = config => ({mode:config?.mode || 'ai',recording_id:config?.recording_id || null,provider:config?.provider || 'edge',...(config?.mode === 'ai' && config?.provider === 'fish-mcp' ? {voice_id:config.voice_id || null,voice_name:config.voice_name || '',model:config.model || 'drama-3'} : {})});
  const mcpNarrationReady = () => mcpStatus.connected === true && mcpStatus.narration?.ready === true && !!chosenMcpVoice?.id;
  const voiceReady = () => voiceMode === 'ai' ? narratorProvider === 'edge' || (narratorProvider === 'fish-mcp' ? mcpNarrationReady() : !!(capabilities.fish?.configured && capabilities.fish?.default_voice_configured)) : selectedRecording()?.status === 'ready' && (voiceMode !== 'clone' || !!capabilities.fish?.configured && $('#voiceConsent').checked);
  const needsQuote = () => current?.voice?.mode === 'ai' && current?.voice?.provider === 'fish-mcp';
  const quoteTime = quote => typeof quote?.created_at === 'number' ? quote.created_at * (quote.created_at > 1e12 ? 1 : 1000) : Date.parse(quote?.created_at || '');
  const freshQuote = () => { const q = current?.narration_quote, age = Date.now()-quoteTime(q); return !!q?.quote_id && Number.isFinite(age) && age >= -5000 && age <= 15*60*1000; };
  const usableQuote = () => freshQuote() && current.narration_quote.has_sufficient_balance === true && Number.isFinite(current.narration_quote.total_credits) && current.narration_quote.total_credits >= 0;
  const dirty = () => !!current && ($('#script').value.trim() !== (current.script || '').trim() || $('#direction').value.trim() !== (current.direction || '').trim() || JSON.stringify(assets.map(a => a.id)) !== JSON.stringify((current.assets || []).map(a => typeof a === 'string' ? a : a.id)) || JSON.stringify(voiceConfig()) !== JSON.stringify(normalizedVoice(current.voice)));
  const savedId = () => { try { return localStorage.getItem('frame-studio-project'); } catch { return null; } };
  function remember(id) { try { id ? localStorage.setItem('frame-studio-project', id) : localStorage.removeItem('frame-studio-project'); } catch {} }
  async function api(url, options) {
    const response = await fetch(url, options);
    let data;
    try { data = await response.json(); } catch { throw Error('The studio could not read the server response. Please reconnect and try again.'); }
    if (!response.ok) throw Error(data.error || 'The request did not finish. Please try again.');
    return data;
  }
  const post = (url, data) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  function banner(message, error = false, detail = '') {
    $('#stateBanner').hidden = !message;
    $('#stateBanner').classList.toggle('error', error);
    $('#stateBanner').classList.toggle('is-working', !error && busy());
    text('#statusText', message);
    text('#statusDetail', detail);
    $('#statusDetail').hidden = !detail;
  }
  function controls() {
    const locked = busy();
    ['#script', '#direction', '#assetRole', '#assetFile', '#refinement', '#refineButton'].forEach(s => { $(s).disabled = locked; });
    $('#newProject').disabled = coreBusy() || voiceUploading;
    $('#planButton').disabled = locked || !voiceReady();
    $('#refineButton').disabled = locked || !voiceReady();
    document.querySelectorAll('.example, .remove').forEach(n => { n.disabled = locked; });
    $('#renderButton').disabled = locked || current?.status !== 'ready' || dirty() || !voiceReady() || needsQuote() && !usableQuote();
    $('#historySelect').disabled = pending || uploading || voiceUploading || micActive();
    const captureBlocked = locked || voiceMode === 'clone' && (!capabilities.fish?.configured || !$('#voiceConsent').checked);
    $('#recordStart').disabled = captureBlocked;
    $('#voiceFile').disabled = captureBlocked;
    $('#recordStart').hidden = !!recorder;
    $('#recordStop').hidden = !recorder;
    $('#recordClock').hidden = !recorder;
    $('#recordStop').disabled = !recorder;
    ['#voiceConsent','#voiceProvider','#fishApiKey','#fishVoiceId','#saveFish','#useTranscript'].forEach(s => { $(s).disabled = locked; });
    ['#fishMcpConnect','#fishMcpVerify','#fishMcpDisconnect'].forEach(s => { $(s).disabled = locked || mcpWorking; });
    ['#mcpVoiceQuery','#mcpOwnVoices','#mcpVoiceSearch'].forEach(s => { $(s).disabled = locked || mcpWorking || !mcpStatus.connected; });
    document.querySelectorAll('.choose-mcp-voice').forEach(n => { n.disabled = locked || mcpWorking || !mcpStatus.connected; });
    document.querySelectorAll('input[name="voiceMode"]').forEach(n => { n.disabled = locked; });
    $('#planButton span').textContent = current?.status === 'planning' ? 'Finding your direction…' : current ? 'Create a new direction' : 'Find my creative direction';
    $('#renderButton span').textContent = current?.status === 'rendering' ? 'Creating your video…' : dirty() ? 'Update creative direction first' : needsQuote() && usableQuote() ? `Generate video · ${current.narration_quote.total_credits} credits` : 'Generate video';
    quoteView(locked);
    $('#stateBanner').classList.toggle('is-working', locked && !$('#stateBanner').classList.contains('error'));
  }
  const clockText = duration => `${Math.floor(duration/60)}:${String(Math.floor(duration%60)).padStart(2,'0')}`;
  function voiceMessage(message, error = false) { text('#voiceStatus',message); $('#voiceStatus').hidden = !message; $('#voiceStatus').classList.toggle('error',error); }
  function mcpMessage(message,error = false) { text('#fishMcpStatus',message); $('#fishMcpStatus').hidden = !message; $('#fishMcpStatus').classList.toggle('error',error); }
  function setMcpStatus(value) {
    const data = value && typeof value === 'object' ? value : {};
    const narration = data.authorized === true ? data.narration || mcpStatus.narration || null : null;
    mcpStatus = {authorized:data.authorized === true,connected:data.authorized === true && data.connected === true,pending:data.pending === true,tool_count:Number.isFinite(data.tool_count) ? data.tool_count : 0,error:typeof data.error === 'string' ? data.error : '',narration};
    if (!chosenMcpVoice && narration?.selected_voice) { chosenMcpVoice = {...narration.selected_voice}; chosenMcpModel = narration.model || 'drama-3'; }
  }
  function useDefaultNarrator() {
    if (mcpStatus.connected && mcpStatus.narration?.ready && mcpStatus.narration.selected_voice?.id) { narratorProvider = 'fish-mcp'; chosenMcpVoice = {...mcpStatus.narration.selected_voice}; chosenMcpModel = mcpStatus.narration.model || 'drama-3'; }
    else narratorProvider = 'fish';
  }
  function quoteView(locked = busy()) {
    clearTimeout(quoteTimer); quoteTimer = null;
    $('#narrationQuote').hidden = !needsQuote(); if (!needsQuote()) return;
    const quote = current.narration_quote, clean = !dirty();
    $('#quoteButton').disabled = locked || current.status !== 'ready' || !clean || !voiceReady();
    text('#quoteButton',quote ? 'Refresh generation cost' : 'Review generation cost');
    if (!clean) { text('#quoteCost','Update the creative direction to quote these changes.'); text('#quoteDetail','The quote is tied to the reviewed script and selected voice.'); }
    else if (!quote) { text('#quoteCost','Review the exact account credit cost before generating.'); text('#quoteDetail','Requesting a quote does not generate audio or spend credits.'); }
    else {
      text('#quoteCost',`${quote.total_credits} credits · ${quote.available_credits} credits available`);
      text('#quoteDetail',!freshQuote() ? 'This quote expired. Refresh it before generating.' : quote.has_sufficient_balance !== true ? 'Your account balance is too low for this generation.' : 'This quote is valid for 15 minutes. Generate video confirms this credit cost.');
      if (freshQuote()) quoteTimer = setTimeout(controls,Math.max(100,quoteTime(quote)+15*60*1000-Date.now()+50));
    }
    $('#narrationQuote').classList.toggle('error',!!quote && clean && (!freshQuote() || quote.has_sufficient_balance !== true));
  }
  function invalidateQuote() { if (needsQuote()) current.narration_quote = null; }
  function safeSampleUrl(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
  }
  async function chooseMcpNarrator(voice) {
    if (busy() || mcpWorking || !mcpStatus.connected) return;
    pending = true; mcpWorking = true; controls(); text('#mcpVoiceSearchStatus','Selecting this narrator…'); $('#mcpVoiceSearchStatus').hidden = false;
    try {
      capabilities = await post('/api/studio/fish-mcp/narrator',{voice_id:voice.id}); setMcpStatus(capabilities.fish_mcp);
      const selected = mcpStatus.narration?.selected_voice; if (!selected?.id) throw Error('The voice selection was not saved. Please choose it again.');
      chosenMcpVoice = {...selected}; chosenMcpModel = mcpStatus.narration.model || 'drama-3'; narratorProvider = 'fish-mcp'; narratorExplicit = true; invalidateQuote();
      voiceView(); text('#mcpVoiceSearchStatus',`${selected.name || 'Voice'} selected. Review a new direction before generating.`);
    } catch (error) { text('#mcpVoiceSearchStatus',error.message); }
    finally { pending = false; mcpWorking = false; controls(); }
  }
  async function searchMcpVoices() {
    if (busy() || mcpWorking || !mcpStatus.connected) return;
    mcpWorking = true; controls(); text('#mcpVoiceSearchStatus','Searching your Fish voice catalog…'); $('#mcpVoiceSearchStatus').hidden = false;
    try {
      const result = await post('/api/studio/fish-mcp/voices',{query:$('#mcpVoiceQuery').value.trim(),own:$('#mcpOwnVoices').checked}); $('#mcpVoiceResults').replaceChildren();
      const voices = Array.isArray(result.voices) ? result.voices : [];
      voices.forEach(voice => {
        if (!voice?.id) return;
        const card = el('div','mcp-voice-result'); card.append(el('strong','',voice.name || 'Fish narrator')); if (voice.description) card.append(el('p','',voice.description));
        const sample = safeSampleUrl(voice.sample_url || voice.sample_audio); if (sample) { const audio = el('audio'); audio.controls = true; audio.preload = 'none'; audio.src = sample; audio.setAttribute('aria-label',`Preview ${voice.name || 'voice'}`); card.append(audio); }
        const choose = el('button','secondary choose-mcp-voice','Use this voice'); choose.type = 'button'; choose.addEventListener('click',() => chooseMcpNarrator(voice)); card.append(choose); $('#mcpVoiceResults').append(card);
      });
      text('#mcpVoiceSearchStatus',voices.length ? `${voices.length} voice${voices.length === 1 ? '' : 's'} found.${result.has_next ? ' Narrow your search for more specific results.' : ''} Previewing or selecting does not generate narration.` : 'No voices found. Try another name or description.');
    } catch (error) { text('#mcpVoiceSearchStatus',error.message); }
    finally { mcpWorking = false; controls(); }
  }
  function connectionView() {
    const fish = capabilities.fish || {}, keyConfigured = fish.api_key_configured ?? fish.configured ?? false;
    const apiReady = keyConfigured && fish.default_voice_configured && (fish.configured ?? fish.clone_ready ?? true);
    text('#openFishSettings',mcpStatus.authorized || keyConfigured ? 'Fish Audio settings' : 'Connect Fish Audio');
    text('#fishConnectionStatus',mcpStatus.connected ? mcpStatus.narration?.ready ? 'MCP connected · Ready to generate' : 'MCP connected' : mcpStatus.authorized ? 'Check connection' : mcpStatus.pending ? 'Sign-in in progress' : apiReady ? 'Developer API configured' : keyConfigured && !fish.default_voice_configured ? 'Voice ID needed' : 'Needs connection');
    $('#fishConnectionStatus').classList.toggle('ready',mcpStatus.connected === true);
    text('#fishConfigurationNote',mcpStatus.connected ? mcpStatus.narration?.ready ? 'Your signed-in Fish account is ready for narration. Review the credit cost before each generation.' : 'MCP connected · narration integration being checked. This connection has not generated audio.' : mcpStatus.authorized ? 'Sign-in is saved. Check the connection to verify account access.' : mcpStatus.pending ? 'Complete sign-in with Fish Audio, then return here to check the connection.' : apiReady ? 'Developer API settings are saved locally. Account sign-in below is a separate connection; credentials are checked when generating.' : 'Sign in with your Fish Audio account below. Connecting does not generate audio.');
    text('#fishMcpConnect span',mcpStatus.authorized ? 'Reconnect Fish Audio' : 'Sign in with Fish Audio');
    $('#fishMcpVerify').hidden = !mcpStatus.authorized; $('#fishMcpDisconnect').hidden = !mcpStatus.authorized;
    $('#mcpVoicePicker').hidden = !mcpStatus.connected;
    text('#mcpSelectedVoice',chosenMcpVoice?.id ? `Narrator for this brief: ${chosenMcpVoice.name || chosenMcpVoice.id}. Changing the voice requires a new creative direction and quote.` : 'Choose a narrator for your next video.');
  }
  function preserveLoginDraft() {
    const draft = {project_id:current?.id || null,script:$('#script').value,direction:$('#direction').value,refinement:$('#refinement').value,assets,voice:voiceConfig(),voice_consent:$('#voiceConsent').checked};
    try { sessionStorage.setItem(LOGIN_DRAFT,JSON.stringify(draft)); }
    catch { throw Error('This browser could not preserve your brief for sign-in. Keep this page open and enable site storage before trying again.'); }
  }
  function readLoginDraft() {
    try { const raw = sessionStorage.getItem(LOGIN_DRAFT); if (!raw) return null; const draft = JSON.parse(raw); return typeof draft.script === 'string' && typeof draft.direction === 'string' ? draft : null; } catch { return null; }
  }
  function restoreLoginDraft(draft) {
    if (!draft) return;
    $('#script').value = draft.script.slice(0,6000); $('#direction').value = draft.direction.slice(0,2000); $('#refinement').value = String(draft.refinement || '').slice(0,1500);
    setAssets(Array.isArray(draft.assets) ? draft.assets.slice(0,6) : []); restoreVoice(draft.voice); $('#voiceConsent').checked = draft.voice_consent === true; countScript(); controls();
    try { sessionStorage.removeItem(LOGIN_DRAFT); } catch {}
  }
  async function refreshMcpStatus() {
    try { setMcpStatus(await api('/api/studio/fish-mcp/status')); voiceView(); if (mcpStatus.error) mcpMessage(mcpStatus.error,true); }
    catch (error) { mcpMessage(error.message,true); }
  }
  function transcriptText(recording) {
    if (typeof recording?.transcript === 'string') return recording.transcript;
    if (recording?.transcript?.text) return recording.transcript.text;
    if (Array.isArray(recording?.transcript)) return recording.transcript.map(s => s.text || s.word || '').join(' ').trim();
    return '';
  }
  function voiceView() {
    text('#renderVoiceHint',voiceMode === 'recording' ? 'Use your original recording and sync the scenes to your delivery.' : 'Generate the narration, sync the scenes, and compose your video.');
    document.querySelectorAll('input[name="voiceMode"]').forEach(n => { n.checked = n.value === voiceMode; });
    $('#voiceCapture').hidden = voiceMode === 'ai'; $('#narratorControls').hidden = voiceMode !== 'ai'; $('#voiceConsentWrap').hidden = voiceMode !== 'clone';
    text('#voiceExplanation', voiceMode === 'recording' ? 'Record your full script. Your delivery and timing become the foundation of the video.' : voiceMode === 'clone' ? 'Record 10–30 seconds of clean speech. AI will use your voice to read the script below.' : 'Write the script and let a neural narrator bring it to life.');
    text('#scriptHelp', voiceMode === 'recording' ? 'Use the reviewed transcript for your script. Your original audio stays intact; record a new take to change spoken words. English transcription · 1080p vertical' : voiceMode === 'clone' ? 'Write the words AI should say in your voice. The sample establishes the voice; this script becomes the narration. English narration · 1080p vertical' : 'Your script becomes the narration. Start with a short idea and let the scenes follow its meaning. English narration · 1080p vertical');
    text('#recordStart', voiceMode === 'clone' ? '● Record a voice sample' : '● Record my script');
    text('#voiceLimits', voiceMode === 'clone' ? '10–30 seconds recommended · up to 2 minutes · 20 MB' : 'Up to 5 minutes · 20 MB · microphone starts only when you press Record.');
    const fish = capabilities.fish || {};
    connectionView();
    const fishOption = $('#voiceProvider option[value="fish"]'); fishOption.disabled = false; fishOption.textContent = fish.configured && fish.default_voice_configured ? 'Fish Audio · developer API voice' : 'Fish Audio · developer API setup required';
    $('#voiceProvider').value = narratorProvider;
    $('#voiceSetup').hidden = !(voiceMode === 'clone' && !fish.configured || voiceMode === 'ai' && (narratorProvider === 'fish-mcp' ? !mcpNarrationReady() : narratorProvider === 'fish' && (!fish.configured || !fish.default_voice_configured)));
    text('#voiceSetup', voiceMode === 'clone' ? 'Set up the developer API under Advanced to generate with your voice sample. Your original recording works without a connection.' : narratorProvider === 'fish-mcp' ? 'Sign in to Fish Audio and select a narrator below. Generation becomes available once the account narration connection is ready.' : 'Set up the developer API under Advanced, or choose Fish Audio · signed-in account. Microsoft Edge is also available for a technical preview.');
    text('#voicePrivacy', voiceMode === 'recording' ? 'Recordings are transcribed locally. Your transcript, timing and delivery measurements, script, and reference previews go to OpenAI for creative planning. Your original recording provides the final narration.' : voiceMode === 'clone' ? 'The voice sample is transcribed locally. Its transcript and delivery measurements go to OpenAI for planning. Your sample audio and script go to Fish Audio only when you generate narration.' : narratorProvider === 'fish-mcp' ? 'Your script and reference previews go to OpenAI for planning. Narration uses your signed-in Fish Audio account and plan credits. You review the exact credit cost before generating.' : `Your script and reference previews go to OpenAI for creative planning. Your script goes to ${narratorProvider === 'fish' ? 'Fish Audio' : 'Microsoft Edge’s neural speech service'} when you generate narration.`);
    const record = selectedRecording(); const transcript = transcriptText(record);
    const playable = record?.status === 'ready' && record?.url;
    $('#voiceAudio').hidden = !playable; $('#voiceTranscript').hidden = !transcript; text('#transcriptText',transcript);
    if (playable) { if ($('#voiceAudio').getAttribute('src') !== record.url) { $('#voiceAudio').src = record.url; $('#voiceAudio').load(); } }
    else { $('#voiceAudio').pause(); $('#voiceAudio').removeAttribute('src'); }
    $('#voiceDetails').hidden = !record?.duration;
    const delivery = record?.delivery || {};
    const wpm = delivery.words_per_minute_overall ?? delivery.words_per_minute ?? delivery.wpm;
    text('#voiceDetails', record?.duration ? `${Number(record.duration).toFixed(1)} seconds${Number.isFinite(Number(wpm)) && wpm ? ` · ${Math.round(Number(wpm))} words/minute` : ''}${voiceMode === 'recording' ? ' · original performance and timing preserved' : ' · voice sample only'}` : '');
    if (!micActive() && !voiceUploading) {
      if (record?.status === 'analyzing') voiceMessage('Transcribing locally and reading your delivery…');
      else if (record?.status === 'failed') voiceMessage(record.error || 'This recording could not be analyzed. Please record or upload another take.',true);
      else if (record?.status === 'ready') voiceMessage(voiceMode === 'recording' ? 'Recording ready. Review the transcript before planning.' : 'Voice sample ready. Write the script you want AI to read.');
      else voiceMessage('');
    }
    controls();
  }
  function cancelVoicePoll() { clearTimeout(voiceTimer); voiceTimer = null; voiceEpoch++; $('#retryVoice').hidden = true; }
  function useTranscript() {
    const transcript = transcriptText(selectedRecording());
    if (transcript.length > 6000) { voiceMessage('This transcript exceeds 6,000 characters. Use a shorter recording for this video.',true); return; }
    $('#script').value = transcript; invalidateQuote(); countScript(); controls();
  }
  function acceptRecording(record, purpose, token) {
    if (token !== voiceEpoch) return;
    voiceRecords[purpose] = record;
    if (voiceMode === purpose) {
      if (record.status === 'ready' && purpose === 'recording' && !$('#script').value.trim()) useTranscript();
      voiceView();
    }
  }
  function pollVoice(id,purpose,token = voiceEpoch,immediate = false) {
    clearTimeout(voiceTimer);
    voiceTimer = setTimeout(async () => {
      if (token !== voiceEpoch) return;
      try { const record = await api(`/api/studio/voice/${id}`); if (token !== voiceEpoch) return; acceptRecording(record,purpose,token); $('#retryVoice').hidden = true; if (record.status === 'analyzing') pollVoice(id,purpose,token); }
      catch (error) { if (token !== voiceEpoch) return; voiceMessage(error.message,true); $('#retryVoice').hidden = false; }
    }, immediate ? 0 : 1200);
  }
  function restoreVoice(config) {
    cancelVoicePoll(); const v = normalizedVoice(config); voiceMode = v.mode; narratorProvider = v.provider; narratorExplicit = true;
    if (v.provider === 'fish-mcp') { chosenMcpVoice = v.voice_id ? {id:v.voice_id,name:v.voice_name} : null; chosenMcpModel = v.model || 'drama-3'; }
    $('#voiceConsent').checked = v.mode === 'clone' && !!v.recording_id;
    if (v.recording_id && voiceMode !== 'ai') {
      if (voiceRecords[voiceMode]?.id !== v.recording_id) voiceRecords[voiceMode] = {id:v.recording_id,status:'analyzing',purpose:voiceMode};
      pollVoice(v.recording_id,voiceMode,voiceEpoch,true);
    }
    voiceView();
  }
  function stopMicrophone(discard = false) {
    if (discard) micEpoch++;
    micPending = false; clearInterval(micClock); micClock = null;
    const active = recorder; recorder = null;
    if (active && active.state !== 'inactive') { try { active.stop(); } catch {} }
    if (microphone) microphone.getTracks().forEach(track => track.stop()); microphone = null;
    controls();
  }
  async function uploadVoice(file,purpose) {
    if (file.size < 1 || file.size > 20*1024*1024) { voiceMessage('Choose an audio file between 1 byte and 20 MB.',true); return; }
    if (purpose === 'clone' && (!capabilities.fish?.configured || !$('#voiceConsent').checked)) { voiceMessage('Connect Fish Audio and confirm that you have permission to use this voice first.',true); return; }
    cancelVoicePoll(); const token = voiceEpoch; voiceUploading = true; controls(); voiceMessage('Saving your recording for local analysis…');
    let received = false;
    try {
      const headers = {'Content-Type': file.type || 'audio/webm','X-Filename':encodeURIComponent(file.name || 'recording.webm')};
      if (purpose === 'clone') headers['X-Voice-Consent'] = 'true';
      const record = await api(`/api/studio/voice?purpose=${purpose}`,{method:'POST',headers,body:file});
      if (token !== voiceEpoch) return;
      acceptRecording(record,purpose,token); received = true; if (record.status === 'analyzing') pollVoice(record.id,purpose,token);
    } catch (error) { if (token === voiceEpoch) voiceMessage(error.message,true); }
    finally { voiceUploading = false; if (received && token === voiceEpoch) voiceView(); else controls(); }
  }
  async function startRecording() {
    if (busy() || voiceMode === 'ai') return;
    const purpose = voiceMode;
    if (purpose === 'clone' && (!capabilities.fish?.configured || !$('#voiceConsent').checked)) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { voiceMessage('Microphone recording is unavailable in this browser. Upload an audio recording instead.',true); return; }
    const token = ++micEpoch; micPending = true; controls(); voiceMessage('Allow microphone access in your browser to begin.'); $('#voiceAudio').pause();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      if (token !== micEpoch) { stream.getTracks().forEach(t => t.stop()); return; }
      microphone = stream;
      const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(type => MediaRecorder.isTypeSupported?.(type));
      const active = new MediaRecorder(stream,mimeType ? {mimeType} : undefined);
      const chunks = []; let size = 0; const began = Date.now(); const maximum = purpose === 'clone' ? 120 : 300;
      recorder = active; micPending = false;
      active.ondataavailable = event => { if (token !== micEpoch || !event.data?.size) return; chunks.push(event.data); size += event.data.size; if (size >= 20*1024*1024 && active.state !== 'inactive') stopMicrophone(); };
      active.onerror = () => { stopMicrophone(true); voiceMessage('The microphone stopped unexpectedly. Please try another recording or upload audio.',true); };
      active.onstop = () => {
        clearInterval(micClock); micClock = null; stream.getTracks().forEach(t => t.stop());
        if (token !== micEpoch) return;
        recorder = null; microphone = null; micPending = false;
        const type = active.mimeType || mimeType || 'audio/webm'; const extension = type.includes('mp4') ? 'm4a' : 'webm';
        const file = new File(chunks,`${purpose}-${Date.now()}.${extension}`,{type});
        controls(); uploadVoice(file,purpose);
      };
      active.start(250); text('#recordClock','0:00'); voiceMessage(purpose === 'clone' ? 'Recording your voice sample. Speak naturally in a quiet room.' : 'Recording your script. Let your natural pacing and emphasis come through.');
      micClock = setInterval(() => { if (token !== micEpoch) return; const elapsed = (Date.now()-began)/1000; text('#recordClock',clockText(elapsed)); if (elapsed >= maximum) stopMicrophone(); },250);
      controls();
    } catch (error) { if (token !== micEpoch) return; stopMicrophone(true); voiceMessage(error.name === 'NotAllowedError' ? 'Microphone access was not allowed. Enable it for this site in browser settings, or upload an audio file.' : error.name === 'NotFoundError' ? 'No microphone was found. Connect one or upload an audio file.' : 'The microphone could not start. Check that another app is not using it, or upload audio.',true); }
  }
  function countScript() { text('#scriptCount', `${$('#script').value.length.toLocaleString()} / 6,000`); }
  function assetList() {
    $('#assetList').replaceChildren();
    assets.forEach((asset, index) => {
      const row = el('div', 'asset-item');
      row.append(el('span', 'asset-icon', asset.kind === 'video' ? 'VID' : 'IMG'), el('span', 'asset-name', asset.name || asset.id), el('span', 'asset-role', asset.role));
      const remove = el('button', 'remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${asset.name || 'asset'} from this brief`); remove.disabled = busy();
      remove.addEventListener('click', () => { assets.splice(index, 1); assetList(); controls(); });
      row.append(remove); $('#assetList').append(row);
    });
  }
  function setAssets(raw) {
    assets = Array.isArray(raw) ? raw.map(a => typeof a === 'string' ? { id: a, name: 'Saved visual', role: 'reference', kind: 'image' } : a) : [];
    assetList();
  }
  function emphasizeSpeech(node, speech, emphasis) {
    const spans = [];
    for (const phrase of Array.isArray(emphasis) ? emphasis : []) {
      if (typeof phrase !== 'string' || !phrase.length) continue;
      let start = speech.indexOf(phrase);
      while (start !== -1) { spans.push([start,start+phrase.length]); start = speech.indexOf(phrase,start+phrase.length); }
    }
    spans.sort((a,b) => a[0]-b[0] || b[1]-a[1]);
    const merged = [];
    for (const span of spans) { const previous = merged[merged.length-1]; if (previous && span[0] < previous[1]) previous[1] = Math.max(previous[1],span[1]); else merged.push([...span]); }
    let cursor = 0;
    for (const [start,end] of merged) {
      if (start > cursor) node.append(document.createTextNode(speech.slice(cursor,start)));
      node.append(el('mark','',speech.slice(start,end))); cursor = end;
    }
    if (cursor < speech.length) node.append(document.createTextNode(speech.slice(cursor)));
  }
  function drawDelivery(delivery) {
    const beats = Array.isArray(delivery?.beats) ? delivery.beats : [];
    $('#deliveryReview').hidden = !delivery || !beats.length;
    $('#deliverySummary').replaceChildren(); $('#deliveryBeats').replaceChildren();
    if (!delivery || !beats.length) return;
    for (const [label,value] of [['Intent',delivery.intent],['Personality',delivery.persona],['Emotional arc',delivery.arc]]) {
      if (!value) continue;
      const line = el('p'); line.append(el('strong','',`${label}: `),document.createTextNode(String(value))); $('#deliverySummary').append(line);
    }
    text('#deliveryNote', current?.voice?.mode === 'recording' ? 'Your performance stays unchanged; this plan guides visual emphasis.' : 'Tone and pacing follow this direction; exact emphasis depends on the selected voice service.');
    const roles = {hook:'Opening',setup:'Set the scene',contrast:'Contrast',payoff:'The payoff',invitation:'Invitation',explanation:'Explain'};
    beats.forEach((beat,index) => {
      const item = el('li','delivery-beat'); const head = el('div','delivery-beat-head');
      head.append(el('span','delivery-role',`${String(index+1).padStart(2,'0')} · ${roles[beat.role] || 'Thought'}`));
      const pace = Number(beat.pace), pause = Number(beat.pause_after_ms);
      const paceText = Number.isFinite(pace) ? pace < .95 ? 'measured pace' : pace > 1.05 ? 'brisk pace' : 'natural pace' : '';
      const pauseText = Number.isFinite(pause) && pause > 0 ? `${(pause/1000).toFixed(1).replace(/\.0$/,'')}s pause` : 'continuous delivery';
      const tone = typeof beat.tone === 'string' ? beat.tone.charAt(0).toUpperCase()+beat.tone.slice(1) : '';
      head.append(el('span','delivery-cues',[tone,paceText,pauseText].filter(Boolean).join(' · ')));
      const speech = el('p','delivery-text'); emphasizeSpeech(speech,String(beat.text || ''),beat.emphasis);
      item.append(head,speech); if (beat.reason) item.append(el('p','delivery-reason',beat.reason)); $('#deliveryBeats').append(item);
    });
    text('#deliveryReference',delivery.reference_note || ''); $('#deliveryReference').hidden = !delivery.reference_note;
  }
  function drawPlan(plan) {
    drawDelivery(plan?.delivery);
    $('#planView').hidden = !plan; $('#emptyState').hidden = !!plan;
    if (!plan) return;
    const identity = plan.identity || {};
    text('#identityName', identity.name || 'Your creative direction');
    text('#identityRationale', identity.rationale);
    text('#intent', identity.intent); text('#audience', identity.audience); text('#feeling', identity.feeling);
    const pace = Number(identity.pace);
    text('#voice', current?.voice?.mode === 'recording' ? 'Your recording · original delivery' : `${identity.voice || 'Natural'}${Number.isFinite(pace) ? ` · ${pace < .95 ? 'unhurried' : pace > 1.05 ? 'brisk' : 'natural'} delivery` : ''}`);
    $('#palette').replaceChildren();
    ['background', 'foreground', 'accent'].forEach((key, index) => { const swatch = el('span', 'swatch'); const color = safeHex(identity[key], ['#101112', '#f2f1eb', '#d4fa7c'][index]); swatch.style.backgroundColor = color; swatch.title = `${key}: ${color}`; $('#palette').append(swatch); });
    $('#directionTags').replaceChildren();
    [identity.style, identity.motion && `${identity.motion} motion`].filter(Boolean).forEach(tag => $('#directionTags').append(el('span', 'tag', tag)));
    const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
    text('#sceneCount', `${scenes.length} scene${scenes.length === 1 ? '' : 's'}`); $('#sceneList').replaceChildren();
    scenes.forEach((scene, index) => {
      const card = el('article', 'scene');
      const visual = el('div', 'scene-visual'); visual.style.backgroundColor = safeHex(identity.background, '#101112'); visual.style.color = safeHex(identity.foreground, '#f2f1eb'); visual.style.setProperty('--scene-accent', safeHex(identity.accent, '#d4fa7c'));
      visual.append(el('span', 'scene-number', String(index + 1).padStart(2, '0')), el('div', 'scene-headline', scene.headline));
      const content = el('div', 'scene-content'); content.append(el('p', 'scene-narration', scene.narration), el('p', 'scene-reason', scene.rationale));
      const meta = el('div', 'scene-meta'); meta.append(el('span', '', scene.visual || 'motion'));
      const energy = el('span', 'energy'); const level = Math.max(0, Math.min(5, Math.round(Number(scene.energy || 0) * 5))); energy.setAttribute('aria-label', `Energy ${level} of 5`); energy.title = `Energy ${level} of 5`;
      for (let i = 0; i < 5; i++) energy.append(el('i', i < level ? 'on' : ''));
      meta.append(energy); content.append(meta); card.append(visual, content); $('#sceneList').append(card);
    });
  }
  function show(project, populate = false) {
    current = project; remember(project.id); $('#retryConnection').hidden = true;
    if (populate) { $('#script').value = project.script || ''; $('#direction').value = project.direction || ''; setAssets(project.assets); countScript(); restoreVoice(project.voice); }
    drawPlan(project.plan);
    const result = project.result;
    $('#result').hidden = !result?.url;
    if (result?.url) {
      const videoUrl = result.preview_url || result.url;
      if ($('#video').getAttribute('src') !== videoUrl) { $('#video').src = videoUrl; $('#video').load(); }
      $('#download').href = result.url; $('#download').download = `frame-${project.id.slice(0, 8)}.mp4`;
      text('#resultDuration', `${Number(result.duration || 0).toFixed(1)} seconds · Vertical video`);
      text('#resultVoice', result.voice_provider ? `Voice: ${result.voice_provider === 'edge-neural' ? 'Microsoft Edge neural' : result.voice_provider}` : 'Generated narration');
      text('#resultWarnings', Array.isArray(result.warnings) ? result.warnings.join(' ') : result.warnings || '');
    } else { $('#video').pause(); $('#video').removeAttribute('src'); }
    $('#renderActions').hidden = !project.plan || project.status === 'complete';
    $('#refinePanel').hidden = !project.plan;
    const review = project.review;
    text('#reviewNote', typeof review === 'string' ? review : review?.summary || '');
    $('#reviewNote').hidden = !$('#reviewNote').textContent;
    $('#stepIntent').classList.toggle('active', !project.plan);
    $('#stepDirection').classList.toggle('active', !!project.plan && !['rendering', 'complete'].includes(project.status));
    $('#stepVideo').classList.toggle('active', ['rendering', 'complete'].includes(project.status));
    text('#outputStep', project.status === 'complete' ? '03 / Your video' : project.status === 'rendering' ? '03 / Creating' : '02 / Shape it');
    const labels = { planning: 'Reading your intent and shaping the direction.', ready: 'Your direction is ready. Take a look, then bring it to life.', rendering: 'Generating your voice and composing the scenes.', complete: 'Your video is ready.', failed: 'This generation could not finish.' };
    banner(project.status === 'failed' ? project.error || labels.failed : project.stage || labels[project.status] || 'Project loaded.', project.status === 'failed', project.status === 'failed' ? 'Your brief is preserved. You can adjust it and create a new direction.' : '');
    $('#historySelect').value = project.id; controls();
  }
  async function history() {
    const projects = await api('/api/studio/projects');
    const list = Array.isArray(projects) ? projects : projects.projects || [];
    const placeholder = el('option','','Choose a project…'); placeholder.value = ''; $('#historySelect').replaceChildren(placeholder);
    list.forEach(p => { const label = p.name || p.title || p.plan?.identity?.name || p.script?.slice(0, 65) || `Idea ${p.id.slice(0, 8)}`; const option = el('option','',`${label} · ${p.status || 'saved'}`); option.value = p.id; $('#historySelect').append(option); });
    $('#historyWrap').hidden = !list.length; if (current) $('#historySelect').value = current.id;
    return list;
  }
  function stopPolling() { clearTimeout(timer); timer = null; epoch++; }
  function poll(id, token = epoch) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (token !== epoch || current?.id !== id) return;
      try {
        const project = await api(`/api/studio/projects/${id}`);
        if (token !== epoch || current?.id !== id) return;
        show(project);
        if (activeStates.has(project.status)) poll(id, token); else history().catch(() => {});
      } catch (error) { if (token !== epoch) return; banner(error.message, true, 'The project stays saved on this computer. Reconnect to check its progress.'); $('#retryConnection').hidden = false; }
    }, 1500);
  }
  async function load(id) {
    stopMicrophone(true); cancelVoicePoll(); stopPolling(); const token = epoch; pending = true; controls();
    try { const project = await api(`/api/studio/projects/${id}`); if (token !== epoch) return; show(project, true); if (activeStates.has(project.status)) poll(id, token); }
    catch (error) { banner(error.message, true); }
    finally { if (token === epoch) { pending = false; controls(); } }
  }
  async function create(direction) {
    if (busy()) return;
    if (!voiceReady()) { voiceMessage(voiceMode === 'clone' ? 'Connect Fish Audio, confirm voice permission, and add a voice sample before planning.' : voiceMode === 'recording' ? 'Record or upload your script and wait for local analysis before planning.' : 'Choose an available narrator before planning.',true); return; }
    const script = $('#script').value.trim(); if (!script) { $('#script').focus(); $('#script').reportValidity(); return; }
    if (direction.length > 2000) { banner('Keep the creative direction under 2,000 characters. Edit the direction field to make room for your changes.', true); return; }
    stopPolling(); pending = true; controls(); banner('Sending your brief to Katana…');
    try {
      const payload = { script, direction, assets: assets.map(a => a.id), voice:voiceConfig() }; if (current?.id) payload.parent_id = current.id;
      const response = await post('/api/studio/plan', payload);
      const project = response.status ? response : await api(`/api/studio/projects/${response.id}`);
      show(project, true); $('#refinement').value = ''; $('#refinePanel').open = false;
      await history().catch(() => {}); if (activeStates.has(project.status)) poll(project.id);
    } catch (error) { banner(error.message, true); }
    finally { pending = false; controls(); }
  }
  $('#script').addEventListener('input', () => { invalidateQuote(); countScript(); controls(); });
  document.querySelectorAll('input[name="voiceMode"]').forEach(input => input.addEventListener('change', () => {
    if (!input.checked || busy()) return; invalidateQuote(); cancelVoicePoll(); $('#voiceAudio').pause(); voiceMode = input.value; voiceView();
    const record = selectedRecording(); if (record?.status === 'analyzing') pollVoice(record.id,voiceMode,voiceEpoch,true);
  }));
  $('#voiceProvider').addEventListener('change', () => { invalidateQuote(); narratorProvider = $('#voiceProvider').value; narratorExplicit = true; voiceView(); });
  $('#mcpVoiceSearch').addEventListener('click',searchMcpVoices);
  $('#mcpVoiceQuery').addEventListener('keydown',event => { if (event.key === 'Enter') { event.preventDefault(); searchMcpVoices(); } });
  $('#openFishSettings').addEventListener('click', () => {
    $('#fishSettings').open = true;
    if (location.hash !== '#fishSettings') window.history.replaceState(null,'','#fishSettings');
    $('#fishSettings').scrollIntoView({block:'center',behavior:'auto'});
    const target = mcpStatus.connected ? $('#fishMcpVerify') : $('#fishMcpConnect');
    (target.disabled ? $('#fishSettings summary') : target).focus({preventScroll:true});
  });
  $('#fishMcpConnect').addEventListener('click', async () => {
    if (busy() || mcpWorking) return;
    pending = true; mcpWorking = true; controls(); mcpMessage('Opening secure Fish Audio sign-in…');
    try {
      preserveLoginDraft();
      const response = await post('/api/studio/fish-mcp/connect',{});
      let url; try { url = new URL(response.authorization_url); } catch { throw Error('Fish Audio returned an invalid sign-in address. Your brief is still here.'); }
      if (url.origin !== 'https://fish.audio' || url.pathname !== '/oauth/authorize' || url.username || url.password) throw Error('Fish Audio returned an unexpected sign-in address. Your brief is still here.');
      window.location.assign(url.href);
    } catch (error) { try { sessionStorage.removeItem(LOGIN_DRAFT); } catch {} mcpMessage(error.message,true); }
    finally { pending = false; mcpWorking = false; controls(); }
  });
  async function mcpAction(action) {
    if (busy() || mcpWorking) return;
    pending = true; mcpWorking = true; controls(); mcpMessage(action === 'verify' ? 'Checking your Fish Audio connection…' : 'Disconnecting Fish Audio…');
    try {
      setMcpStatus(await post(`/api/studio/fish-mcp/${action}`,{}));
      capabilities = await api('/api/studio/capabilities'); if (capabilities.fish_mcp) setMcpStatus(capabilities.fish_mcp); if (!current && !narratorExplicit) useDefaultNarrator(); voiceView();
      mcpMessage(mcpStatus.error || (mcpStatus.connected ? mcpStatus.narration?.ready ? 'Account connection verified. Signed-in narration is ready.' : 'Account connection verified. Narration integration is being checked.' : mcpStatus.authorized ? 'Sign-in is saved, but the connection has not been verified yet.' : 'Fish Audio account disconnected.'),!!mcpStatus.error);
    } catch (error) { mcpMessage(error.message,true); }
    finally { pending = false; mcpWorking = false; controls(); }
  }
  $('#fishMcpVerify').addEventListener('click', () => mcpAction('verify'));
  $('#fishMcpDisconnect').addEventListener('click', () => mcpAction('disconnect'));
  $('#voiceConsent').addEventListener('change', controls);
  $('#recordStart').addEventListener('click', startRecording);
  $('#recordStop').addEventListener('click', () => stopMicrophone());
  $('#voiceFile').addEventListener('change', async () => { const file = $('#voiceFile').files?.[0]; $('#voiceFile').value = ''; if (file && !busy()) await uploadVoice(file,voiceMode); });
  $('#useTranscript').addEventListener('click', useTranscript);
  $('#retryVoice').addEventListener('click', () => { const record = selectedRecording(); if (record) { $('#retryVoice').hidden = true; pollVoice(record.id,voiceMode,voiceEpoch,true); } });
  $('#saveFish').addEventListener('click', async () => {
    if (busy()) return; const apiKey = $('#fishApiKey').value.trim(); const voiceId = $('#fishVoiceId').value.trim();
    if (!apiKey && !voiceId) { text('#fishStatus','Enter an API key or a stock voice ID to update the connection.'); $('#fishStatus').hidden = false; return; }
    pending = true; controls(); text('#fishStatus','Saving your local connection…'); $('#fishStatus').hidden = false; $('#fishStatus').classList.remove('error');
    try {
      capabilities = await post('/api/studio/provider',{api_key:apiKey,voice_id:voiceId}); $('#fishApiKey').value = ''; $('#fishVoiceId').value = '';
      if (capabilities.fish?.configured && capabilities.fish?.default_voice_configured) { invalidateQuote(); narratorProvider = 'fish'; narratorExplicit = true; }
      text('#fishStatus',capabilities.fish?.configured ? 'Fish Audio settings saved on this computer. Credentials will be checked when you generate.' : 'Settings saved. Add a valid Fish Audio API key to enable generation.'); voiceView();
    } catch (error) { text('#fishStatus',error.message); $('#fishStatus').classList.add('error'); }
    finally { pending = false; controls(); }
  });
  $('#direction').addEventListener('input', () => { invalidateQuote(); controls(); });
  $('#briefForm').addEventListener('submit', event => { event.preventDefault(); create($('#direction').value.trim()); });
  $('#refineForm').addEventListener('submit', event => { event.preventDefault(); const feedback = $('#refinement').value.trim(); if (!feedback) return; create([$('#direction').value.trim(), `Revision: ${feedback}`].filter(Boolean).join('\n\n')); });
  document.querySelectorAll('.example').forEach(button => button.addEventListener('click', () => { $('#direction').value = button.dataset.direction; invalidateQuote(); controls(); $('#direction').focus(); }));
  $('#assetFile').addEventListener('change', async () => {
    const files = Array.from($('#assetFile').files || []); if (!files.length || busy()) return;
    uploading = true; controls(); const role = $('#assetRole').value; const errors = [];
    $('#assetFeedback').hidden = false; $('#assetFeedback').classList.remove('error');
    for (const file of files) {
      if (assets.length >= 6) { errors.push('Use up to six visuals. Remove one before adding another.'); break; }
      if (!file.size || file.size > 20 * 1024 * 1024) { errors.push(`${file.name}: choose a file between 1 byte and 20 MB.`); continue; }
      text('#assetFeedback', `Uploading ${file.name}…`);
      try { const response = await api('/api/studio/assets', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), 'X-Role': role }, body: file }); const asset = response.asset || response; assets.push({ ...asset, name: asset.name || file.name, role: asset.role || role }); assetList(); }
      catch (error) { errors.push(`${file.name}: ${error.message}`); }
    }
    uploading = false; $('#assetFile').value = ''; controls();
    text('#assetFeedback', errors.length ? errors.join(' ') : `${files.length} visual${files.length === 1 ? '' : 's'} added to your brief.`); $('#assetFeedback').classList.toggle('error', !!errors.length);
  });
  $('#quoteButton').addEventListener('click',async () => {
    if (busy() || current?.status !== 'ready' || dirty() || !voiceReady() || !needsQuote()) return;
    pending = true; current.narration_quote = null; controls(); text('#quoteDetail','Checking the exact cost and current account balance…');
    try { current.narration_quote = await post(`/api/studio/projects/${current.id}/quote`,{}); }
    catch (error) { banner(error.message,true); }
    finally { pending = false; controls(); }
  });
  $('#renderButton').addEventListener('click', async () => {
    if (busy() || current?.status !== 'ready' || dirty() || !voiceReady() || needsQuote() && !usableQuote()) return;
    pending = true; controls(); banner('Starting your generation…');
    try { await post(`/api/studio/projects/${current.id}/render`, needsQuote() ? {quote_id:current.narration_quote.quote_id} : {}); const project = await api(`/api/studio/projects/${current.id}`); show(project); if (activeStates.has(project.status)) poll(project.id); }
    catch (error) { invalidateQuote(); banner(error.message, true); }
    finally { pending = false; controls(); }
  });
  $('#historySelect').addEventListener('change', () => { if ($('#historySelect').value) load($('#historySelect').value); });
  $('#retryConnection').addEventListener('click', () => { if (current) load(current.id); });
  $('#newProject').addEventListener('click', () => {
    if (coreBusy() || voiceUploading) return; stopMicrophone(true); cancelVoicePoll(); stopPolling(); current = null; assets = []; voiceRecords = {recording:null,clone:null}; voiceMode = 'recording'; narratorExplicit = false; useDefaultNarrator(); remember(null); $('#briefForm').reset(); $('#refineForm').reset(); assetList(); countScript(); drawPlan(null); voiceView(); $('#voiceTranscript').open = false; $('#fishSettings').open = true; $('#fishStatus').hidden = true; $('#video').pause(); $('#video').removeAttribute('src'); $('#result').hidden = true; $('#stateBanner').hidden = true; $('#assetFeedback').hidden = true; $('#historySelect').value = ''; $('#refinePanel').open = false;
    $('#stepIntent').classList.add('active'); $('#stepDirection').classList.remove('active'); $('#stepVideo').classList.remove('active'); text('#outputStep', '02 / Shape it'); controls(); $('#script').focus();
  });
  async function init() {
    const loginDraft = readLoginDraft(); countScript(); voiceView();
    try { capabilities = await api('/api/studio/capabilities'); if (capabilities.fish_mcp) setMcpStatus(capabilities.fish_mcp); useDefaultNarrator(); voiceView(); }
    catch { text('#fishStatus','Could not check Fish Audio setup. The built-in narrator is available; reconnect Fish to enable voice cloning.'); $('#fishStatus').hidden = false; }
    try { const projects = await history(); const id = loginDraft?.project_id || new URLSearchParams(location.search).get('project') || savedId(); if (id && projects.some(p => p.id === id)) await load(id); }
    catch (error) { banner(error.message, true, 'Check that the local Katana server is running, then reload this page.'); }
    restoreLoginDraft(loginDraft); await refreshMcpStatus();
  }
  window.addEventListener('pagehide', () => { stopMicrophone(true); cancelVoicePoll(); stopPolling(); clearTimeout(quoteTimer); $('#voiceAudio').pause(); document.querySelectorAll('#mcpVoiceResults audio').forEach(audio => audio.pause()); $('#fishApiKey').value = ''; });
  init();
})();
