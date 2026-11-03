import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { createMarkup, drawMarkup } from './markup.js';
import { createSectionTimeline, sectionColors } from './section-timeline.js';

const app = new App({name:'Frame',version:'1.1.0'}, {availableDisplayModes:['inline','fullscreen']});
function theme(context){if(context?.theme)applyDocumentTheme(context.theme);if(context?.styles?.variables)applyHostStyleVariables(context.styles.variables)}
const $=id=>document.getElementById(id), video=$('video');
let downloadBlob=null,downloadBusy=false;
let doc=null, connected=false, hostReady=false, busy=false, polling=false, loadingMedia=false, rpcQueue=Promise.resolve(), mediaGeneration=0, mediaKey='', mediaUrl='', resultMode=false, selectedPin=null, sheetKind='', sheetClip=null, noteTime=0, savedNote=null, opening=null, latestInput={}, pendingResult=null;
const fmt=t=>`${Math.floor((t||0)/60)}:${Math.floor((t||0)%60).toString().padStart(2,'0')}`;
const commentaryDrafts=new Map();
let markersKey='';
let markupUI=null;
let sectionTimeline=null;
const say=(s,error=false)=>{$('status').textContent=s;$('status').classList.toggle('error',error)};
const health=ok=>{connected=ok;$('connection').textContent=ok?'Connected · saved locally':'Connection unavailable';controls()};
function controls(){
 for(const id of ['trim','split','pin','note','export'])$(id).disabled=!connected||!doc||busy;
 $('undo').disabled=!connected||!doc?.can_undo||busy;$('redo').disabled=!connected||!doc?.can_redo||busy;
 $('play').disabled=video.readyState<2;$('scrub').disabled=video.readyState<2;
 $('view').disabled=!doc?.rendered||busy;$('view').textContent=resultMode?'Edited':'Original';
 $('pin').textContent=doc?.pins.find(p=>p.id===selectedPin)?.end==null&&selectedPin?'End section':'Start section';
 for(const button of document.querySelectorAll('[data-save-comment]'))button.disabled=!connected||busy;
 for(const button of document.querySelectorAll('.section-card button'))button.disabled=!connected||busy||!!markupUI?.active;
 $('projects').disabled=busy;$('saveSheet').disabled=busy;$('sendNote').disabled=busy||!savedNote;
 $('split').disabled ||= resultMode;
 $('annotate').disabled=!connected||!doc||busy||video.readyState<2;
 if(markupUI?.active){for(const id of ['play','scrub','pin','view','projects','trim','split','export','undo','redo','note'])$(id).disabled=true}
 if(connected&&doc)$('connection').textContent='Connected · v'+doc.version+(resultMode&&doc.rendered?.timeline_version!==doc.version?' · preview needs export':'');
 sectionTimeline?.render(video.currentTime||0);
}
function rpc(name,args){
 const task=rpcQueue.then(async()=>{
  const attempts=['list_projects','get_project','read_video_chunk'].includes(name)?3:1;
  for(let attempt=0;attempt<attempts;attempt++)try{const r=await app.callServerTool({name,arguments:args});if(r.isError)throw Error(r.content?.find(c=>c.type==='text')?.text||'The operation failed.');health(true);return r}
  catch(e){if(attempt+1<attempts&&/not initialized/i.test(e.message)){await new Promise(resolve=>setTimeout(resolve,400));continue}if(/fetch|connect|timeout|closed|unavailable|not initialized/i.test(e.message))health(false);throw e}
 });rpcQueue=task.catch(()=>{});return task;
}
function data(r){return r.structuredContent||{}}
async function list(){const r=data(await rpc('list_projects',{}));const items=r.projects||[];const chosen=doc?.project_id||'';$('projects').replaceChildren(new Option('Choose a project…',''));for(const p of items)$('projects').append(new Option(p.name,p.id));$('projects').value=chosen}
function sourcePoint(){let t=video.currentTime||0;if(!resultMode)return {time:t,clip:doc?.clips.find(c=>c.start<=t&&t<c.end)};const rendered=doc?.rendered;for(const c of rendered?.clips||[]){const length=c.end-c.start;if(t<length)return {time:c.start+t,clip:doc.clips.find(n=>n.id===c.id)||c};t-=length}return {time:doc?.source_duration||0,clip:null}}
function timeInView(t){if(!resultMode)return t;let offset=0;for(const c of doc.rendered?.clips||[]){if(c.start<=t&&t<c.end)return offset+t-c.start;offset+=c.end-c.start}return null}
function markers(){
 const key=JSON.stringify([doc?.project_id,doc?.pins,doc?.notes,selectedPin]);
 if(key===markersKey)return;markersKey=key;
 const box=$('markers');box.replaceChildren();
 if(!doc?.pins?.length){const empty=document.createElement('p');empty.className='section-empty';empty.textContent='Your selected sections will appear here, with room for commentary on each one.';box.append(empty);return}
 for(const [index,pin] of doc.pins.entries()){
  const card=document.createElement('article');card.className='section-card';card.dataset.selected=String(pin.id===selectedPin);card.dataset.sectionId=pin.id;
  card.style.setProperty('--section-color',sectionColors[index%sectionColors.length]);
  const row=document.createElement('div');row.className='row';const title=document.createElement('h3');title.textContent=`Section ${index+1} · ${pin.start.toFixed(2)}${pin.end==null?'s → choose end':'–'+pin.end.toFixed(2)+'s'}`;
  const select=document.createElement('button');select.textContent=pin.end==null?'Set end':'View section';select.onclick=()=>{selectedPin=pin.id;const t=timeInView(pin.start);if(t!==null){video.pause();video.currentTime=t}markers();controls()};row.append(title,select);card.append(row);
  const state=document.createElement('span');state.className='pin-state'+(pin.end==null?' pending':'');state.textContent=pin.end==null?'Start pinned · choose an end':'Pinned section';card.append(state);
  const notes=(doc.notes||[]).filter(n=>n.section_id===pin.id);
  if(notes.length){const list=document.createElement('ol');for(const note of notes){const item=document.createElement('li'),text=document.createElement('span'),meta=document.createElement('span');text.className='commentary-text';text.textContent=note.instruction;meta.className='comment-meta';meta.textContent=`${(note.source_time_ms/1000).toFixed(2)}s · ${note.status||'saved'}`;item.append(text,meta);
   if(note.annotations?.length){const preview=document.createElementNS('http://www.w3.org/2000/svg','svg');preview.classList.add('markup-preview');preview.setAttribute('role','img');preview.setAttribute('aria-label','Saved frame markup');drawMarkup(preview,note.annotations,video.videoWidth||1000,video.videoHeight||562);const view=document.createElement('button');view.className='markup-review';view.textContent='View marked frame';view.onclick=()=>{if(markupUI?.active)return;const t=timeInView(note.source_time_ms/1000);if(t===null)return say('This frame is outside the edited preview. Switch to Original to view it.');selectedPin=pin.id;video.pause();video.currentTime=t;markupUI?.render();video.scrollIntoView({behavior:'smooth',block:'center'});markers();controls()};item.append(preview,view)}
   list.append(item)}card.append(list)}
  if(pin.end!=null){
   const form=document.createElement('form'),label=document.createElement('label'),input=document.createElement('textarea'),save=document.createElement('button');
   const draftKey=doc.project_id+':'+pin.id;input.id='comment-'+pin.id;input.maxLength=2000;input.required=true;input.placeholder='What should change in this section?';input.value=commentaryDrafts.get(draftKey)||'';input.oninput=()=>commentaryDrafts.set(draftKey,input.value);label.htmlFor=input.id;label.textContent='Commentary for this section';save.textContent='Save commentary';save.type='submit';save.dataset.saveComment=pin.id;
   form.onsubmit=async event=>{event.preventDefault();const instruction=input.value.trim();if(!instruction)return;selectedPin=pin.id;const point=sourcePoint().time;const sourceTime=point>=pin.start&&point<pin.end?point:pin.start;const next=await update({action:'add_note',section_id:pin.id,source_time_ms:Math.round(sourceTime*1000),instruction});if(next){commentaryDrafts.delete(draftKey);markersKey='';markers();controls();say('Commentary saved to this section. Ask the chat to read your Frame notes.')}};
   form.append(label,input,save);card.append(form);
  }
  box.append(card);
 }
}
function accept(next){
 if(!next?.project_id)return;
 if(doc?.project_id!==next.project_id){markupUI?.reset();markersKey='';selectedPin=null;savedNote=null;resultMode=!!next.rendered;$('sheet').close()}
 doc=next;markers();controls();markupUI?.render();$('projects').value=doc.project_id;
}
function currentExport(){return resultMode&&doc?.rendered?doc.rendered.proposal_id:null}
async function loadVideo(){
 if(!doc)return;const project=doc.project_id,exportId=currentExport(),key=project+':'+(exportId||'source');
 if(key===mediaKey)return;mediaKey=key;const generation=++mediaGeneration;loadingMedia=true;downloadBlob=null;video.pause();$('download').hidden=true;
 try{
  let offset=0,total=null;const chunks=[];say('Loading video…');
  do{
   const r=await rpc('read_video_chunk',{project_id:project,offset,max_bytes:1048576,...(exportId?{export_id:exportId}:{})});if(generation!==mediaGeneration)return;
   const d=data(r),raw=r._meta?.videoChunk;if(typeof raw!=='string'||d.offset!==offset||d.project_id!==project||d.export_id!==(exportId||null))throw Error('Video chunk did not match this project.');
   if(total!==null&&total!==d.total_bytes)throw Error('Video changed while loading. Refresh to retry.');total=d.total_bytes;
   const bytes=Uint8Array.from(atob(raw),c=>c.charCodeAt(0));if(bytes.length!==d.next_offset-offset||!bytes.length||bytes.length>1048576||!Number.isSafeInteger(total)||total>734003200||d.next_offset>total)throw Error('Invalid video chunk.');
   chunks.push(bytes);offset=d.next_offset;say(`Loading video · ${Math.round(offset/total*100)}%`);
  }while(offset<total);
  if(generation!==mediaGeneration)return;
  const blob=new Blob(chunks,{type:'video/mp4'}),url=URL.createObjectURL(blob);const previous=mediaUrl;mediaUrl=url;downloadBlob=exportId?blob:null;video.src=url;video.hidden=false;$('empty').hidden=true;video.load();if(previous)URL.revokeObjectURL(previous);
  if(exportId){$('download').href=url;$('download').download='frame-edit-'+project.slice(0,6)+'.mp4';$('download').hidden=false}
  say(exportId?'Rendered edit loaded. Play to review, or download the MP4.':'Original loaded. Timeline changes appear after Export.');
 }catch(e){if(generation!==mediaGeneration)return;mediaKey='';say('Video unavailable. '+e.message+' Use Refresh to retry.',true)}finally{if(generation===mediaGeneration)loadingMedia=false}
}
async function openProject(pid){if(!pid)return;video.pause();++mediaGeneration;mediaKey='';video.hidden=true;$('empty').hidden=false;const request=Symbol();opening=request;try{const next=data(await rpc('get_project',{project_id:pid}));if(opening!==request)return;accept(next);await list();await loadVideo()}catch(e){say(e.message,true)}finally{if(opening===request)opening=null}}
async function mutate(name,args){if(!doc||busy)return null;busy=true;video.pause();controls();const pid=doc.project_id;try{const next=data(await rpc(name,{project_id:pid,expected_version:doc.version,...args}));if(doc.project_id!==pid)return null;accept(next);return next}catch(e){say(e.message,true);try{accept(data(await rpc('get_project',{project_id:pid})))}catch{}return null}finally{busy=false;controls()}}
function update(args){return mutate('update_editor',args)}
function command(name,args={}){return mutate(name,args)}
markupUI=createMarkup({video,getDoc:()=>doc,getPoint:sourcePoint,getSelected:()=>selectedPin,save:update,onChange:controls,say});
sectionTimeline=createSectionTimeline({video,getDoc:()=>doc,getSelected:()=>selectedPin,isEdited:()=>resultMode,onSelect:pin=>{if(busy||markupUI?.active)return;selectedPin=pin.id;const t=timeInView(pin.start);if(t!==null){video.pause();video.currentTime=t}markers();controls()}});
$('projects').onchange=()=>openProject($('projects').value);
$('refresh').onclick=async()=>{if(busy)return;try{if(!hostReady){await app.connect();hostReady=true;theme(app.getHostContext())}await list();if(doc){accept(data(await rpc('get_project',{project_id:doc.project_id})));await loadVideo()}else say('Connected. Choose a project or attach a video in chat.')}catch(e){health(false);say('Frame is unavailable. Keep the Frame service and connector running, then refresh.',true)}};
$('expand').onclick=async()=>{try{await app.requestDisplayMode({mode:app.getHostContext()?.displayMode==='fullscreen'?'inline':'fullscreen'})}catch{say('This host controls the panel size.')}};
$('play').onclick=async()=>{try{if(video.paused)await video.play();else video.pause()}catch(e){say('Playback failed. '+e.message,true)}};
let scrubFrame=0;
$('scrub').oninput=()=>{video.pause();const time=Number($('scrub').value);sectionTimeline?.updatePlayhead(time);cancelAnimationFrame(scrubFrame);scrubFrame=requestAnimationFrame(()=>{video.currentTime=time})};
function scrubAt(event){const r=$('scrub').getBoundingClientRect();$('scrub').value=Math.max(0,Math.min(1,(event.clientX-r.left)/r.width))*Number($('scrub').max);$('scrub').oninput()}
$('scrub').onpointerdown=event=>{if(event.button!==0||$('scrub').disabled)return;event.preventDefault();$('scrub').focus({preventScroll:true});$('scrub').setPointerCapture(event.pointerId);scrubAt(event)};
$('scrub').onpointermove=event=>{if($('scrub').hasPointerCapture(event.pointerId))scrubAt(event)};
$('scrub').onpointerup=event=>{if($('scrub').hasPointerCapture(event.pointerId)){$('scrub').releasePointerCapture(event.pointerId);scrubAt(event)}};
video.ontimeupdate=()=>{$('scrub').value=video.currentTime;$('clock').textContent=`${fmt(video.currentTime)} / ${fmt(video.duration)}`;markupUI?.render();sectionTimeline?.render(video.currentTime||0)};
video.onloadedmetadata=()=>{$('scrub').max=video.duration;video.ontimeupdate();controls()};video.onloadeddata=controls;
video.onplay=()=>{$('play').textContent='Pause'};video.onpause=()=>{$('play').textContent='Play'};
video.onerror=()=>{mediaKey='';say('The video could not be decoded. Use an H.264/AAC MP4 and refresh.',true);controls()};
video.onclick=()=>{$('play').click()};
$('view').onclick=()=>{resultMode=!resultMode;controls();void loadVideo()};
$('undo').onclick=async()=>{if(await command('undo'))say('Undo saved. Export to review the changed timeline.')};
$('redo').onclick=async()=>{if(await command('redo'))say('Redo saved. Export to review the changed timeline.')};
$('split').onclick=async()=>{const {time,clip}=sourcePoint();if(!clip||time<=clip.start||time>=clip.end)return say('Seek inside a retained clip to split.');if(await command('split_clip',{clip_id:clip.id,source_time:time}))say('Split saved. Export to review the edited timeline.')};
$('trim').onclick=()=>{video.pause();const point=sourcePoint(),clip=doc?.clips.find(c=>c.id===point.clip?.id)||doc?.clips[0];if(!clip)return;sheetKind='trim';sheetClip=clip;$('sheetTitle').textContent='Trim segment';$('trimFields').hidden=false;$('noteFields').hidden=true;$('sendNote').hidden=true;$('saveSheet').textContent='Save trim';$('start').value=clip.start;$('end').value=clip.end;$('sheet').showModal()};
$('pin').onclick=async()=>{const {time,clip}=sourcePoint(),pin=doc.pins.find(p=>p.id===selectedPin);if(pin&&pin.end==null){if(time<=pin.start)return say('Seek after the section start, then choose End section.');if(await update({action:'edit_pin',pin_id:pin.id,start:pin.start,end:time})){say('Section saved. Add commentary below.');const input=$('comment-'+pin.id);input?.scrollIntoView({behavior:'smooth',block:'center'});input?.focus({preventScroll:true})}return}if(!clip)return say('Seek inside a retained clip to set a start pin.');const next=await update({action:'add_pin',clip_id:clip.id,time});if(next){selectedPin=next.pins.at(-1).id;markers();controls();say('Section start saved. Seek forward, then choose End section.')}};
$('note').onclick=()=>{video.pause();const point=sourcePoint();const pin=doc.pins.find(p=>p.id===selectedPin&&p.end!=null&&p.start<=point.time&&point.time<p.end);if(!pin)return say('Set a start and end pin, then seek inside that range to leave a note.');sheetKind='note';noteTime=point.time;savedNote=null;$('sheetTitle').textContent='Note at '+noteTime.toFixed(3)+' seconds';$('trimFields').hidden=true;$('noteFields').hidden=false;$('noteAnchor').textContent='Anchored to the original source frame.';$('instruction').value='';$('sendNote').hidden=true;$('saveSheet').textContent='Save note';$('sheet').showModal();$('instruction').focus()};
$('closeSheet').onclick=()=>$('sheet').close();
$('saveSheet').onclick=async()=>{if(sheetKind==='trim'){const next=await command('trim_clip',{clip_id:sheetClip.id,start:Number($('start').value),end:Number($('end').value)});if(next){$('sheet').close();say('Trim saved. Choose Export to render and review.')}}else{const next=await update({action:'add_note',section_id:selectedPin,source_time_ms:Math.round(noteTime*1000),instruction:$('instruction').value});if(next){savedNote=next.notes.at(-1);$('sendNote').hidden=false;$('instruction').readOnly=true;$('saveSheet').hidden=true;controls();say('Note saved. Send it to the chat when ready.')}}};
$('sheet').addEventListener('close',()=>{$('instruction').readOnly=false;$('saveSheet').hidden=false});
$('sendNote').onclick=async()=>{if(!savedNote)return;try{const r=await app.sendMessage({role:'user',content:[{type:'text',text:'Read Frame project '+doc.project_id+' and saved note '+savedNote.id+' at source '+(savedNote.source_time_ms/1000).toFixed(3)+' seconds. Explain the requested change and supported options before applying anything.'}]});if(r.isError)throw Error('Chat rejected the message.');$('sheet').close();say('Saved note sent to this chat.')}catch{say('Note remains saved. In chat, ask: “Read the notes in Frame project '+doc.project_id+'.”',true)}};
$('export').onclick=async()=>{if(await command('export_video'))say('Rendering MP4… Your previous output remains saved.')};
$('download').onclick=async event=>{
 event.preventDefault();if(!downloadBlob||downloadBusy)return;downloadBusy=true;
 try{
  say('Preparing MP4 download…');const blob=downloadBlob,filename=$('download').download,project_id=doc.project_id,export_id=currentExport();
  if(app.getHostCapabilities()?.downloadFile){
   const encoded=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Could not prepare the saved MP4.'));reader.readAsDataURL(blob)});
   try{const result=await app.downloadFile({contents:[{type:'resource',resource:{uri:'file:///'+encodeURIComponent(filename),mimeType:'video/mp4',blob:encoded}}]});if(result.isError)throw Error('The download was cancelled or denied.');say('MP4 sent to ChatGPT for download. Your export remains saved.');return}catch(e){if(!/method not found/i.test(e.message))throw e}
  }
  const result=data(await rpc('prepare_download',{project_id,export_id}));
  if(typeof window.openai?.openExternal==='function')await window.openai.openExternal({href:result.download_url,redirectUrl:false});
  else await app.openLink({url:result.download_url});
  say('MP4 download opened on the computer running Frame. Your export remains saved.');
 }catch(e){say('Download could not finish. Your export remains saved in Frame. '+e.message,true)}finally{downloadBusy=false}
};
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!['INPUT','TEXTAREA','SELECT','BUTTON'].includes(e.target.tagName)&&!$('sheet').open&&!markupUI?.active){e.preventDefault();$('play').click()}});
async function receive(r){try{if(r.isError)throw Error(r.content?.find(c=>c.type==='text')?.text||'Frame could not open this project.');const v=data(r);if(v.project){accept(v.project);await list();await loadVideo()}else if(v.project_id){await openProject(v.project_id)}else if(v.projects){await list()}}catch(e){say(e.message,true)}}
app.ontoolinput=({arguments:args})=>{latestInput=args||{}};
app.ontoolresult=r=>{if(connected)void receive(r);else pendingResult=r};
app.ontoolcancelled=()=>say('Opening was cancelled. Choose a saved project or refresh to try again.');
app.onhostcontextchanged=theme;
try{await app.connect();hostReady=true;theme(app.getHostContext());health(true);if(pendingResult)await receive(pendingResult);else if(latestInput.project_id)await openProject(latestInput.project_id);else await list()}catch(e){health(false);say('Frame could not connect to this chat. Keep the connector running and use Refresh to retry. '+e.message,true)}
setInterval(async()=>{if(!connected||!doc||busy||polling||loadingMedia||opening||document.hidden)return;polling=true;const pid=doc.project_id;try{const next=data(await rpc('get_project',{project_id:pid}));if(doc.project_id!==pid)return;const previous=doc.rendered?.proposal_id;accept(next);if(next.exports?.at(-1)?.status==='failed')say(next.exports.at(-1).error||'Export failed. Your previous output remains saved.',true);if(next.rendered?.proposal_id&&next.rendered.proposal_id!==previous){resultMode=true;await loadVideo()}else if(next.exports?.at(-1)?.status==='rendering'||next.exports?.at(-1)?.status==='queued')say('Rendering MP4…')}catch(e){health(false);say('Sync failed. Saved work remains on the connected computer. Use Refresh to reconnect. '+e.message,true)}finally{polling=false}},2500);
window.addEventListener('pagehide',()=>{++mediaGeneration;if(mediaUrl)URL.revokeObjectURL(mediaUrl)});
