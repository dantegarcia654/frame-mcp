import { decisionsConfig } from './decide.js';
import { PROPERTY_LABELS } from './revisions.js';
import { isDeepStrictEqual } from 'node:util';
import { uid } from './util.js';
const terminal=new Set(['done','failed','conflict','needs_input','cancelled']);
const same=isDeepStrictEqual;
const copy=x=>JSON.parse(JSON.stringify(x));
const controls={fill:'Card or shape fill color',color:'Text or artwork color',size:'Text size',w:'Artwork width',x:'Horizontal position',y:'Vertical position',radius:'Corner radius',speed:'Animation speed',opacity:'Whole element opacity',weight:'Text weight',text:'Wording of text',none:'No supported graphic control requested'};
const palette={cream:'#f4f0e8',charcoal:'#20201e',terracotta:'#d97757',clay:'#d97757',blue:'#4466cc',green:'#46765a',gold:'#edb36b'};
// A shade request ("a darker clay") moves a named colour, or the element's current one, toward black or white.
const shade=(hex,k)=>'#'+[1,3,5].map(i=>{const v=parseInt(hex.slice(i,i+2),16),t=k<0?0:255;return Math.round(v+(t-v)*Math.abs(k)).toString(16).padStart(2,'0');}).join('');
const colorControl=(n,prop)=>prop==='fill'&&n.fill==null&&n.color!=null?'color':prop==='color'&&n.color==null&&n.fill!=null&&n.kind!=='brand'?'fill':prop;
function candidates(p,a){
 const words=a.prompt.toLowerCase().match(/[a-z]{3,}/g)||[];
 const scored=p.clips.filter(c=>c.effect?.type==='live_graphic'&&c.effect.params.nodes.length===1).map(c=>{
  const n=c.effect.params.nodes[0],label=(c.label+' '+n.id+' '+(n.text||'')).toLowerCase();
  const exact=words.reduce((s,w)=>s+(label.includes(w)?3:0),0),active=(a.playhead??0)>=c.start&&(a.playhead??0)<c.start+c.out-c.in;
  return {clip:copy(c),exact,active:active||c.id===a.clip_id,score:exact*10+(c.id===a.clip_id?15:0)+(active?8:0)};
 }).sort((x,y)=>y.score-x.score);
 // A whole reel repeats element names across levels ("level counter" five times). When the prompt names something on
 // screen at the playhead, only what is on screen is a candidate, so Decisions picks between visible elements.
 const visible=scored.filter(x=>x.active);
 return (visible.some(x=>x.exact>0)?visible:scored).slice(0,24).map(x=>x.clip);
}
function directRoute(prompt,list){
 // Exact "element id: property=value" commands avoid a model call. Natural language uses Decisions.
 const m=prompt.match(/^([\w-]+)\s*:\s*(fill|color|size|w|x|y|radius|speed|opacity|weight|text)\s*=\s*(.+)$/i);
 if(!m)return null;
 const clip=list.find(c=>c.id===m[1]||c.effect.params.nodes[0].id===m[1]);if(!clip)return null;
 const property=colorControl(clip.effect.params.nodes[0],m[2].toLowerCase());let value=m[3].trim();
 if(!['fill','color','text'].includes(property))value=Number(value);
 return {clip_id:clip.id,property,value,provider:'exact-control',api_ms:0};
}
function titleRoute(prompt, clips, playhead) {
 const request = prompt.match(/^change the ([^"“”\r\n]+?\btitle) to (?:"([^"\r\n]+)"|“([^”\r\n]+)”)[.!?]?$/i);
 if (!request || !Number.isFinite(playhead)) return null;
 const label = request[1].toLowerCase(), value = (request[2] ?? request[3]).trim();
 if (!value) return null;
 const matches = clips.filter(clip => {
  const nodes = clip.effect?.type === 'live_graphic' && clip.effect.params.nodes;
  return nodes?.length === 1 && nodes[0].kind === 'text' && typeof nodes[0].text === 'string'
   && clip.label?.trim().toLowerCase() === label && playhead >= clip.start
   && playhead < clip.start + (clip.out - clip.in) / (clip.speed || 1);
 });
 if (matches.length > 1) throw new Error('More than one matching title is on screen. Use an exact element ID.');
 if (!matches.length) return null;
 return { clip_id: matches[0].id, property: 'text', value, provider: 'local-title', api_ms: 0 };
}
async function decide(prompt,list,playhead){
 const cfg=decisionsConfig();if(!cfg.on)throw new Error('Connect Google Decisions, or use element-id: control=value.');
 const start=performance.now();
 const criteria=Object.fromEntries(list.map(c=>[c.id,`${c.label}; ${c.effect.params.nodes[0].kind}; ${c.effect.params.nodes[0].id}; timeline ${c.start.toFixed(1)}s`]));criteria.none='No single matching element, ambiguous, or unsupported request';
 const questions={target:{type:'choice',instructions:'Pick the one existing graphic element the user explicitly wants to revise. If ambiguous choose none.',criteria},property:{type:'choice',instructions:'Which one graphic control is requested? Do not infer other edits.',criteria:controls},direction:{type:'choice',instructions:'Choose the requested numeric direction, or set for a requested exact color, wording or value.',criteria:{increase:'Bigger, faster, right, lower or rounder',decrease:'Smaller, slower, left, higher or sharper',set:'Set a named color, exact number or quoted wording',none:'No clear supported request'}},color:{type:'choice',instructions:'Only pick a color if the user explicitly named it. Otherwise none.',criteria:{...Object.fromEntries(Object.keys(palette).map(k=>[k,k])),none:'No named color'}},tone:{type:'choice',instructions:'Only if the user asks for a darker or lighter shade of a color.',criteria:{darker:'A darker or deeper shade',lighter:'A lighter or paler shade',none:'No shade change requested'}}};
 const response=await fetch(cfg.endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':cfg.key},body:JSON.stringify({model:'gemini-decision-1',input:prompt,questions}),signal:AbortSignal.timeout(3500)});
 if(!response.ok)throw new Error(`Decisions unavailable (${response.status}); no edit applied.`);
 const data=await response.json();const answers=data.answers;
 const choice=key=>{const a=answers?.[key];if(!a||!Number.isFinite(a.confidence)||a.confidence<.7||!Object.hasOwn(questions[key].criteria,a.choice))throw new Error(`Not confident about ${key}. Select the element and name its control.`);return a.choice;};
 const target=choice('target');let property=choice('property');
 const direction=['fill','color','text'].includes(property)?'set':choice('direction');   // a colour or wording change has no numeric direction
 if(target==='none'||property==='none'||direction==='none')throw new Error('Select one element and request one graphic control change.');
 const clip=list.find(c=>c.id===target),node=clip.effect.params.nodes[0];let value;
 property=colorControl(node,property); // a shape's colour is its fill or its color, whichever it has (the toolbar shows the same one)
 // after its highlight time an element shows its accent colour: a colour request changes the colour you see
 if(['fill','color'].includes(property)&&node.accent&&node.highlightAt!=null&&Number.isFinite(playhead)&&playhead-clip.start+(clip.in||0)>=node.highlightAt)property='accent';
 if(['fill','color','accent'].includes(property)){
  value=prompt.match(/#[0-9a-f]{6}\b/i)?.[0];
  if(!value){
   const soft=key=>{const a=answers?.[key];return a&&Number.isFinite(a.confidence)&&a.confidence>=.7&&Object.hasOwn(questions[key].criteria,a.choice)?a.choice:'none';};
   const color=soft('color'),tone=soft('tone'),current=(clip.effect.params.nodes[0])[property];
   const base=color!=='none'?palette[color]:(/^#[0-9a-f]{6}$/i.test(current||'')?current:null);
   if(base)value=tone==='darker'?shade(base,-.22):tone==='lighter'?shade(base,.22):(color!=='none'?base:null);
  }
  if(!value)throw new Error('Name the color or provide its hex value.');
 }else if(property==='text'){
  value=prompt.match(/["“]([^"”]+)["”]/)?.[1];if(!value)throw new Error('Put the new wording in quotes.');
 }else{
  const old=property==='opacity'?(clip.opacity??1):node[property];
  if(!Number.isFinite(old))throw new Error(`This element has no ${property} control.`);
  const number=prompt.match(/(?:to|=)\s*(-?\d+(?:\.\d+)?)(%?)/i);
  if(direction==='set'&&number)value=Number(number[1])/(number[2]?100:1);
  else if(direction!=='set'){
   const sign=direction==='increase'?1:-1;
   const percent=prompt.match(/(\d+(?:\.\d+)?)\s*%/);const factor=percent?Number(percent[1])/100:.2;
   value=['x','y','radius','opacity'].includes(property)?old+sign*({x:.03,y:.03,radius:.005,opacity:.1}[property]):old*(1+sign*factor);
  }else throw new Error('Provide an exact numeric value after “to”.');
 }
 return {clip_id:target,property,value,provider:'google-decision-1',api_ms:Math.round(performance.now()-start),usage:data.usage||null};
}
export function createPromptRunner({publish,commit}){
 function queue(p,a){
  if(typeof a.prompt!=='string'||!a.prompt.trim()||a.prompt.length>2000)throw new Error('Enter a prompt of 1–2000 characters.');
  p.promptJobs||=[];const number=(p.promptSequence||0)+1;p.promptSequence=number;
  const job={id:uid('prompt_'),number,prompt:a.prompt.trim(),status:'routing',createdAt:Date.now(),cursor:/^[a-z][a-z -]{0,23}$/i.test(a.cursor||'') ? a.cursor : `Prompt ${number}`,phase:'Finding the element and control'};
  p.promptJobs.push(job);p.promptJobs=p.promptJobs.filter(j=>!terminal.has(j.status)||j.id===job.id).concat(p.promptJobs.filter(j=>terminal.has(j.status)&&j.id!==job.id).sort((a,b)=>a.number-b.number).slice(-30));
  const list=candidates(p,a);publish(p);
  // Routing runs outside the serialized timeline tool queue. A second prompt starts immediately.
  void (async()=>{
   try{
    const route=directRoute(job.prompt,list)||titleRoute(job.prompt,p.clips,a.playhead)||await decide(job.prompt,list,a.playhead);
    if(job.status==='cancelled')return;
    const clip=(route.provider==='local-title'?p.clips:list).find(c=>c.id===route.clip_id),node=clip.effect.params.nodes[0];
    const property=route.property;if(typeof route.value==='number')route.value=Math.round(route.value*1e6)/1e6;if(['fill','color','accent'].includes(property)&&typeof route.value==='string')route.value=route.value.toLowerCase();
    if(property!=='opacity'&&!(property==='color'&&node.kind==='brand')&&!Object.hasOwn(node,property))throw new Error(`This element has no ${PROPERTY_LABELS[property]||property} control.`);
    job.route=route;job.clip_id=clip.id;job.node_id=node.id;job.element=clip.label||node.id;job.control=PROPERTY_LABELS[property]||property;
    job.before=property==='opacity'?(clip.opacity??1):node[property];job.after=route.value;
    const elapsed=a.playhead-clip.start;
    job.previewTime=Number.isFinite(elapsed)&&elapsed>=0&&elapsed<(clip.out-clip.in)/(clip.speed||1) ? a.playhead : clip.start+Math.min((clip.out-clip.in)*.5,.8);job.status='ready';job.phase='Ready to use the canvas control';job.readyAt=Date.now();publish(p);
   }catch(error){job.status='needs_input';job.phase=error.name==='TimeoutError'?'Decision routing timed out; no edit applied.':error.message;publish(p);}
  })();
  return job;
 }
 function claim(p,id,client){const job=p.promptJobs?.find(j=>j.id===id);if(!job||job.status!=='ready')return {ok:false};job.status='executing';job.client=client;job.phase=`Changing ${job.control}`;job.claimedAt=Date.now();publish(p);return {ok:true,job};}
 function validate(p,b){
  if(!b.prompt_job)return null;
  if(p.paused)throw new Error('Frame is paused.');
  const job=p.promptJobs?.find(j=>j.id===b.prompt_job.id);
  if(!job||job.status!=='executing'||job.client!==b.prompt_job.client)throw new Error('Prompt control claim expired.');
  const clip=p.clips.find(c=>c.id===job.clip_id),node=clip?.effect?.params.nodes.find(n=>n.id===job.node_id);
  const current=job.route.property==='opacity'?(clip?.opacity??1):node?.[job.route.property];
  if(!same(current,job.before)){job.status='conflict';job.phase=`${job.control} changed while this prompt was routing. No overwrite.`;publish(p);throw new Error(job.phase);}
  const op=b.ops?.[0];const expected=job.route.property==='opacity'?{op:'update_clip',id:job.clip_id,opacity:job.after}:{op:'patch_graphic',id:job.clip_id,node_id:job.node_id,patch:{[job.route.property]:job.after}};
  if(b.ops?.length!==1||!same(op,expected))throw new Error('Canvas operation does not match this prompt.');
  return job;
 }
 function done(p,job,revision){if(!job)return;job.status='done';job.phase=`${job.control}: ${String(job.before)} → ${String(job.after)}`;job.revision_id=revision?.id;job.finishedAt=Date.now();}
 function fail(p,id,message){const job=p.promptJobs?.find(j=>j.id===id);if(job&&!terminal.has(job.status)){job.status='failed';job.phase=message;publish(p);}}
 return {queue,claim,validate,done,fail};
}
