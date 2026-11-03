const NS='http://www.w3.org/2000/svg';
const node=(tag,attrs={})=>{const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);return e};
export function drawMarkup(svg,items,width=1000,height=562){
 svg.replaceChildren();svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
 for(const item of items){
  if(item.kind==='draw')svg.append(node('polyline',{points:item.points.map(([x,y])=>`${x*width},${y*height}`).join(' '),fill:'none',stroke:'#ffce48','stroke-width':Math.max(2,width*.004),'stroke-linejoin':'round','stroke-linecap':'round'}));
  if(item.kind==='box')svg.append(node('rect',{x:item.x*width,y:item.y*height,width:item.width*width,height:item.height*height,fill:'#ffce4815',stroke:'#ffce48','stroke-width':Math.max(2,width*.004)}));
  if(item.kind==='text'){
   const x=Math.min(item.x,.7)*width,y=Math.min(item.y,.85)*height;
   const foreign=node('foreignObject',{x,y,width:width-x,height:height-y});
   const text=document.createElement('div');text.setAttribute('xmlns','http://www.w3.org/1999/xhtml');text.textContent=item.text;
   Object.assign(text.style,{font:`600 ${Math.max(12,width*.027)}px -apple-system,sans-serif`,color:'#fff',background:'#111d',border:'2px solid #ffce48',borderRadius:'4px',padding:'4px 7px',width:'fit-content',maxWidth:'100%',overflowWrap:'anywhere',whiteSpace:'pre-wrap'});
   foreign.append(text);svg.append(foreign);
  }
 }
}

export function createMarkup({video,getDoc,getPoint,getSelected,save,onChange,say}){
 const $=id=>document.getElementById(id),svg=$('markupCanvas');
 let active=false,saving=false,tool='draw',items=[],gesture=null,anchor=null;
 const dimensions=()=>[video.videoWidth||1000,video.videoHeight||562];
 function position(){
  const stage=video.parentElement.getBoundingClientRect(),r=video.getBoundingClientRect(),[w,h]=dimensions();
  const scale=Math.min(r.width/w,r.height/h),width=w*scale,height=h*scale;
  Object.assign(svg.style,{left:(r.left-stage.left+(r.width-width)/2)+'px',top:(r.top-stage.top+(r.height-height)/2)+'px',width:width+'px',height:height+'px'});
 }
 function render(){
  position();const visible=active?items:(getDoc()?.notes||[]).filter(n=>n.annotations&&Math.abs(n.source_time_ms/1000-getPoint().time)<.034).flatMap(n=>n.annotations);
  svg.toggleAttribute('hidden',!active&&!visible.length);svg.classList.toggle('editing',active&&!saving);drawMarkup(svg,visible,...dimensions());
  $('saveMarkup').disabled=saving||!items.length;$('undoMarkup').disabled=saving||!items.length;
 }
 function select(next){tool=next;for(const name of ['draw','box','text'])$(name+'Tool').setAttribute('aria-pressed',String(tool===name));$('markupText').hidden=tool!=='text';$('markupHint').textContent=tool==='text'?'Type your text, then click the picture to place it.':tool==='box'?'Drag to mark an area of the picture.':'Draw directly on the paused picture.'}
 function finish(){active=false;gesture=null;items=[];anchor=null;$('markupTools').hidden=true;$('annotate').hidden=false;render();onChange()}
 function start(){
  if(active||!getDoc()||video.readyState<2)return;video.pause();const point=getPoint();
  if(!point.clip)return say('Choose a frame inside a retained section.');
  const ms=Math.round(point.time*1000),t=ms/1000;if(t<point.clip.start||t>=point.clip.end)return say('Move back one frame to annotate this clip.');
  const pins=getDoc().pins||[],chosen=pins.find(p=>p.id===getSelected()&&p.end!=null&&p.start<=t&&t<p.end)||pins.find(p=>p.end!=null&&p.start<=t&&t<p.end);
  anchor={project:getDoc().project_id,time:ms,section:chosen?.id};items=[];active=true;$('markupTools').hidden=false;$('annotate').hidden=true;$('markupDescription').value='';$('markupText').value='';select('draw');render();onChange();say(`Annotating ${t.toFixed(3)}s. Save your marks to its section.`);
 }
 const point=e=>{const r=svg.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))].map(x=>Math.round(x*10000)/10000)};
 const countPoints=()=>items.reduce((n,i)=>n+(i.points?.length||0),0);
 svg.onpointerdown=e=>{
  if(!active||saving||e.button!==0)return;e.preventDefault();
  if(items.length>=24)return say('Save these marks before adding more.');const [x,y]=point(e);
  if(tool==='text'){const text=$('markupText').value.trim();if(!text){$('markupText').focus();return}items.push({kind:'text',x:Math.min(x,.7),y:Math.min(y,.85),text});render();return}
  if(tool==='draw'&&countPoints()>=498)return say('Save this drawing before adding more strokes.');
  gesture={pointer:e.pointerId,start:[x,y],kind:tool};items.push(tool==='draw'?{kind:'draw',points:[[x,y]]}:{kind:'box',x,y,width:0,height:0});svg.setPointerCapture(e.pointerId);render();
 };
 svg.onpointermove=e=>{
  if(!gesture||gesture.pointer!==e.pointerId)return;const [x,y]=point(e),last=items.at(-1);
  if(gesture.kind==='draw'){const previous=last.points.at(-1);if(countPoints()<500&&Math.hypot(x-previous[0],y-previous[1])>.003)last.points.push([x,y])}
  else {const [a,b]=gesture.start;Object.assign(last,{x:Math.min(x,a),y:Math.min(y,b),width:Math.abs(x-a),height:Math.abs(y-b)})}render();
 };
 function release(e){if(!gesture||gesture.pointer!==e.pointerId)return;const last=items.at(-1);if(last.kind==='draw'&&last.points.length<2||last.kind==='box'&&(!last.width||!last.height))items.pop();gesture=null;if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);render()}
 svg.onpointerup=release;svg.onpointercancel=release;
 $('annotate').onclick=start;for(const name of ['draw','box','text'])$(name+'Tool').onclick=()=>select(name);
 $('undoMarkup').onclick=()=>{if(!saving){items.pop();render()}};$('cancelMarkup').onclick=()=>{if(!saving)finish()};
 $('saveMarkup').onclick=async()=>{
  if(!active||saving||!items.length||gesture)return;
  saving=true;render();for(const id of ['cancelMarkup','drawTool','boxTool','textTool'])$(id).disabled=true;
  try{
   const counts=items.reduce((acc,i)=>(acc[i.kind]=(acc[i.kind]||0)+1,acc),{});
   const summary=Object.entries(counts).map(([kind,n])=>`${n} ${kind==='draw'?'drawing stroke':kind==='box'?'box':'text annotation'}${n===1?'':'s'}`).join(', ');
   const texts=items.filter(i=>i.kind==='text').map(i=>i.text).join(' · ');
   const instruction=[$('markupDescription').value.trim(),`Frame markup at ${(anchor.time/1000).toFixed(3)}s: ${summary}.`,texts].filter(Boolean).join('\n').slice(0,2000);
   const result=await save({action:'add_annotation',source_time_ms:anchor.time,...anchor.section?{section_id:anchor.section}:{},instruction,annotations:structuredClone(items)});
   if(result){finish();say('Frame markup and description saved to the section.')}else say('Markup was not saved. Your drawing is still here; try again.',true);
  }finally{saving=false;for(const id of ['cancelMarkup','drawTool','boxTool','textTool'])$(id).disabled=false;render();onChange()}
 };
 new ResizeObserver(render).observe(video.parentElement);
 return {get active(){return active},render,reset:finish};
}
