if (typeof document !== 'undefined') {
  var previewKind='kept',sourceParts=[],scrubSession=null;
  var slicePreview = new SlicePreview(document.querySelector('#slicePlayer'),document.querySelector('#previewLabel'),requestAnimationFrame,cancelAnimationFrame,renderPlayback);
  function sourceDuration(p){return current.source_duration||Math.max(p.original_duration,...p.baseline.flat(),...p.segments.flat(),...p.cuts.map(c=>c.end))}
  function classifySource(source){return sourceParts.find(part=>source>=part.start&&source<part.end)||sourceParts.at(-1)}
  function paintActiveTimeline(){
    const track=$('#activeChunks');track.replaceChildren();
    const entries=previewKind==='source'?sourceParts.map(p=>({...p,width:p.end-p.start})):slicePreview.map.entries.map(e=>({...e,kind:classifySource((e.start+e.end)/2)?.kind||'keep',width:e.end-e.start}));
    for(const e of entries){const el=document.createElement('div');el.className=e.kind;el.style.width=`${100*e.width/slicePreview.map.duration}%`;el.title=`${e.kind} ${e.start.toFixed(3)}–${e.end.toFixed(3)}s`;track.append(el)}
  }
  function renderPlayback(state){
    const scrubber=document.querySelector('#previewScrubber');if(!scrubber)return;
    scrubber.max=String(state.duration);if(!scrubSession)scrubber.value=String(state.position);
    scrubber.disabled=!state.duration;
    $('#previewClock').textContent=`${state.position.toFixed(3)} / ${state.duration.toFixed(3)}s`;
    $('#sourceClock').textContent=`Source ${state.source.toFixed(3)}s`;
    $('#playPause').textContent=state.playing?'❚❚ Pause':'▶ Play';$('#playPause').setAttribute('aria-label',state.playing?'Pause preview':'Play preview');
    const part=classifySource(state.source);
    $('#sourcePlayhead').hidden=!state.duration;
    const p=current?.pending_proposal;if(p)$('#sourcePlayhead').style.left=`${Math.max(0,Math.min(100,100*state.source/sourceDuration(p)))}%`;
    $('#activeChunkLabel').textContent=part?`${part.kind==='keep'?'KEEP':part.kind==='cut'?'REMOVE':'ALREADY EXCLUDED'} · source ${part.start.toFixed(3)}–${part.end.toFixed(3)}s · preview chunk ${state.index+1}/${slicePreview.map.entries.length}`:'';
    $('#activeChunkLabel').classList.toggle('removed',part?.kind==='cut');
    scrubber.setAttribute('aria-valuetext',`${state.title} ${state.position.toFixed(3)} seconds; source ${state.source.toFixed(3)} seconds; ${part?.kind||''}`);
    document.querySelectorAll('[data-preview-kind]').forEach(el=>{
      const a=Number(el.dataset.start),b=Number(el.dataset.end);el.classList.toggle('active-chunk',!!state.duration&&state.source>=a&&state.source<b);
    });
  }
  async function setPreview(ranges,title,autoplay=true,kind='selection',position=0){
    const p=current?.pending_proposal;if(!p||!ranges.length)return;
    previewKind=kind;$('#previewMode').value=kind;$('#previewMode option[value=selection]').hidden=kind!=='selection';
    document.querySelectorAll('video').forEach(v=>{if(v!==slicePreview.video)v.pause()});
    scrubSession=null;
    const promise=slicePreview.start(current.source_url,ranges,title,autoplay,position);
    paintActiveTimeline();await promise;
  }
  async function selectPreviewMode(kind,autoplay=false,position=null){
    const p=current?.pending_proposal;if(!p)return;
    if(kind==='removed'&&!p.cuts.length){status('This proposal has no removed chunks to preview.');$('#previewMode').value=previewKind;return}
    const ranges=kind==='source'?[[0,sourceDuration(p)]]:kind==='removed'?p.cuts.map(c=>[c.start,c.end]):p.segments;
    if(position===null){
      const source=slicePreview.map.at(slicePreview.position)?.source??0,map=new CutTimeline(ranges);
      const mapped=map.fromSource(source);
      if(mapped)position=mapped.position;
      else{const next=[...map.entries].sort((a,b)=>a.start-b.start).find(e=>e.start>=source);position=next?next.offset:map.duration}
    }
    await setPreview(ranges,kind==='source'?'Full source':kind==='removed'?'Removed chunks':'Proposed cut',autoplay,kind,position);
  }
  function reviewElement(tag, cls, text) { const el=document.createElement(tag);el.className=cls;if(text)el.textContent=text;return el; }
  function reviewButton(text, ranges, title) {
    const b=reviewElement('button','minor',text);b.type='button';
    b.onclick=()=>setPreview(ranges,title,true,'selection');return b;
  }
  function displayProposal() {
    slicePreview.clear();sourceParts=[];scrubSession=null;
    const p=current?.pending_proposal;
    $('#proposalPanel').hidden=!p;
    if (!p) return;
    $('#proposalMessage').textContent=p.message;
    $('#proposalMetrics').textContent=`${p.estimated_duration}s proposed · ${p.removed_duration}s removed from your current selection · source times shown below`;
    $('#proposalWarnings').replaceChildren();
    for (const text of p.warnings) $('#proposalWarnings').append(reviewElement('p','warning',text));
    if(p.error)$('#proposalWarnings').append(reviewElement('p','warning',p.error));
    $('#cutCards').replaceChildren();
    if(p.operation==='create_split_screen'){
      p.split_screen.graphics.forEach((g,i)=>{const card=reviewElement('div','cut-card');card.append(reviewElement('h3','',`Graphic ${i+1}: ${g.text}`),reviewElement('p','reason',`Above your footage from ${g.start.toFixed(2)}s to ${g.end.toFixed(2)}s. Enter ${g.enter}s → hold → exit ${g.exit}s. Audio stays intact.`));$('#cutCards').append(card)});
    }
    if(!p.cuts.length&&p.operation!=='create_split_screen')$('#cutCards').append(reviewElement('p','hint','This proposal changes the sequence or restores material. Review the kept sections and play the proposed sequence.'));
    p.cuts.forEach((c,i)=>{
      const card=reviewElement('div','cut-card');card.dataset.previewKind='cut';card.dataset.start=c.start;card.dataset.end=c.end;
      card.append(reviewElement('h3','',`Cut ${i+1} · ${c.start.toFixed(2)}s → ${c.end.toFixed(2)}s (${(c.end-c.start).toFixed(2)}s)`),
        reviewElement('p','reason',`Because: ${c.reason}`),reviewElement('blockquote','',c.text||'No spoken words were transcribed in this slice.'));
      const controls=reviewElement('div','review-actions');
      controls.append(reviewButton('▶ Play only this removed slice',[[c.start,c.end]],`Removed slice ${i+1} (${c.start.toFixed(3)}–${c.end.toFixed(3)}s)`));
      // A join preview plays the retained footage on each side of this source gap.
      const sorted=p.segments.every((r,j)=>j===0||r[0]>=p.segments[j-1][1]);
      if(sorted){const before=p.segments.filter(r=>r[1]<=c.start+.04).at(-1);const after=p.segments.find(r=>r[0]>=c.end-.04);
        if(before&&after)controls.append(reviewButton('▶ Hear the proposed join',[[Math.max(before[0],before[1]-1.5),before[1]],[after[0],Math.min(after[1],after[0]+1.5)]],'Proposed join'));}
      card.append(controls);$('#cutCards').append(card);
    });
    $('#keepCards').replaceChildren();
    p.sections.forEach((s,i)=>{const card=reviewElement('div','thought');card.dataset.previewKind='keep';card.dataset.start=s.start;card.dataset.end=s.end;card.append(reviewElement('strong','',`${i+1}. Keep ${s.start.toFixed(2)}–${s.end.toFixed(2)}s`),reviewElement('p','',s.reason),reviewElement('span','',s.text||'No transcribed speech.'));card.append(reviewButton('▶ Play only this kept slice',[[s.start,s.end]],`Kept slice ${i+1} (${s.start.toFixed(3)}–${s.end.toFixed(3)}s)`));$('#keepCards').append(card)});
    $('#thoughtCards').replaceChildren();
    if(!p.thoughts.length)$('#thoughtCards').append(reviewElement('p','hint','No usable speech transcript; this proposal uses timestamps or visual samples.'));
    p.thoughts.forEach(t=>{const card=reviewElement('div','thought');card.append(reviewElement('strong','',`${t.start.toFixed(2)}–${t.end.toFixed(2)}s · ${t.complete?'Complete thought':'Unfinished in source'} · ${t.selected?'kept':'not kept in full'}`),reviewElement('p','',t.summary),reviewElement('span','',t.text));if(t.depends_on.length)card.append(reviewElement('span','',`Needs context from ${t.depends_on.join(', ')}`));$('#thoughtCards').append(card)});
    const total=sourceDuration(p);
    const boundaries=[...new Set([0,total,...p.segments.flat(),...p.baseline.flat()])].filter(v=>v>=0&&v<=total).sort((a,b)=>a-b);
    $('#sourceStrip').replaceChildren();
    boundaries.slice(0,-1).forEach((a,i)=>{const b=boundaries[i+1],mid=(a+b)/2;if(b<=a)return;
      const kept=p.segments.some(([s,e])=>s<=mid&&e>mid),inBase=p.baseline.some(([s,e])=>s<=mid&&e>mid),kind=kept?'keep':inBase?'cut':'absent';
      sourceParts.push({start:a,end:b,kind});
      const button=reviewElement('button',kind);button.type='button';button.style.flexGrow=String(b-a);
      button.title=`${kept?'Keep':inBase?'Remove':'Already excluded'} ${a.toFixed(3)}–${b.toFixed(3)}s`;button.setAttribute('aria-label',button.title);
      button.onclick=e=>{const rect=button.getBoundingClientRect(),fraction=e.detail?Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)):0;selectPreviewMode('source',false,a+fraction*(b-a))};
      $('#sourceStrip').append(button);
    });
    $('#approve').disabled=busy||p.status!=='pending';$('#reject').disabled=busy||p.status!=='pending';
    $('#approve').textContent=p.status==='rendering'?'Rendering approved cut…':'Approve & render';
    selectPreviewMode('kept',false,0);
  }
  document.querySelector('#previewAll').onclick=()=>selectPreviewMode('kept',true,0);
  document.querySelector('#stopPreview').onclick=()=>slicePreview.pause();
  document.querySelector('#previewMode').onchange=e=>{if(e.target.value!=='selection')selectPreviewMode(e.target.value,slicePreview.playing)};
  document.querySelector('#playPause').onclick=()=>slicePreview.toggle();
  document.querySelector('#slicePlayer').onclick=()=>slicePreview.toggle();
  document.querySelector('#previousChunk').onclick=()=>slicePreview.jumpChunk(-1);
  document.querySelector('#nextChunk').onclick=()=>slicePreview.jumpChunk(1);
  document.querySelector('#stepBack').onclick=()=>slicePreview.seekTo(slicePreview.position-.1,false);
  document.querySelector('#stepForward').onclick=()=>slicePreview.seekTo(slicePreview.position+.1,false);
  document.querySelector('#playbackRate').onchange=e=>slicePreview.setRate(Number(e.target.value));
  const scrubber=document.querySelector('#previewScrubber');
  const beginScrub=()=>{if(scrubSession===null){scrubSession={resume:slicePreview.playing};slicePreview.pause()}};
  const finishScrub=()=>{if(scrubSession===null)return;const resume=scrubSession.resume,time=Number(scrubber.value);scrubSession=null;slicePreview.seekTo(time,resume)};
  scrubber.onpointerdown=beginScrub;
  scrubber.oninput=()=>{beginScrub();slicePreview.seekTo(Number(scrubber.value),false)};
  scrubber.onchange=finishScrub;
  scrubber.onpointerup=finishScrub;
  scrubber.onpointercancel=finishScrub;
  scrubber.onblur=finishScrub;
  window.addEventListener('pointerup',finishScrub);
  document.querySelectorAll('video').forEach(video=>video.addEventListener('play',()=>{
    if(video!==slicePreview.video)slicePreview.pause();
    document.querySelectorAll('video').forEach(other=>{if(other!==video)other.pause()});
  }));
  document.querySelector('#previewTransport').onkeydown=e=>{
    if(['SELECT','BUTTON'].includes(e.target.tagName))return;
    if(e.code==='Space'){e.preventDefault();slicePreview.toggle()}
    if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();slicePreview.seekTo(slicePreview.position+(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?1:.1),false)}
    if(e.key==='Home'||e.key==='End'){e.preventDefault();slicePreview.seekTo(e.key==='Home'?0:slicePreview.map.duration,false)}
  };

  function handlePlaybackCommand(text){
    const command=text.trim().replace(/[.!?]+$/,'');
    const direct=/^(?:please )?(pause|stop playback|resume|play|play (?:the )?(?:proposal|proposed cut)|(?:play|show|preview) (?:the )?(?:source|removed chunks))(?: please)?$/i.exec(command);
    const chunk=/^(?:please )?(play|show|preview) (?:the )?(removed|kept)?\s*(?:cut|chunk|section)\s*(\d+)$/i.exec(command);
    const seek=/^(?:please )?(?:seek|jump|go) to\s+(?:(source)\s+)?(\d+(?::\d{1,2})?(?:\.\d+)?)\s*(?:s|seconds)?$/i.exec(command);
    if(!direct&&!chunk&&!seek)return false;
    if(!current?.pending_proposal){status('Open a proposal first to control its preview.',true);return true}
    if(chunk){
      const kind=(chunk[2]||'removed').toLowerCase(),index=Number(chunk[3])-1,p=current.pending_proposal;
      const ranges=kind==='kept'?p.segments:p.cuts.map(c=>[c.start,c.end]);
      if(!ranges[index]){status(`There is no ${kind} chunk ${index+1}.`,true);return true}
      setPreview([ranges[index]],`${kind==='kept'?'Kept':'Removed'} chunk ${index+1}`,chunk[1].toLowerCase()!=='show');
    }else if(seek){
      const parts=seek[2].split(':').map(Number),seconds=parts.length===2?parts[0]*60+parts[1]:parts[0];
      if(seek[1])selectPreviewMode('source',false,seconds);else slicePreview.seekTo(seconds,false);
    }else{
      const action=direct[1].toLowerCase();
      if(action==='pause'||action==='stop playback')slicePreview.pause();
      else if(action==='resume'||action==='play')slicePreview.play();
      else selectPreviewMode(action.includes('source')?'source':action.includes('removed')?'removed':'kept',!action.startsWith('show'));
    }
    status('Playback command applied to the preview. The proposal is unchanged.');return true;
  }
  document.querySelector('#approve').onclick=async()=>{
    const p=current?.pending_proposal;if(!p||busy)return;
    setBusy(true);slicePreview.stop();
    try{status('Rendering the proposal you approved…');const t=await api('/api/projects/'+current.id+'/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proposal:p.id})});localStorage.setItem('katana-task',JSON.stringify({id:t.id,project:current.id}));await poll(t.id)}
    catch(e){status(e.message,true)}finally{setBusy(false)}
  };
  document.querySelector('#reject').onclick=async()=>{
    const p=current?.pending_proposal;if(!p||busy)return;setBusy(true);slicePreview.stop();
    try{showProject(await api('/api/projects/'+current.id+'/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proposal:p.id})}));status('Proposal rejected. Your current cut is unchanged.');$('#prompt').focus()}
    catch(e){status(e.message,true)}finally{setBusy(false)}
  };
}
