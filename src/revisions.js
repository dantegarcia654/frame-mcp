// Humans and agents share this executor and these revision records.
import { applyOp } from './project.js';
import { uid } from './util.js';
const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
import { PROPERTY_LABELS } from '../ui/revision-controls.js';
export { PROPERTY_LABELS };
function diff(a,b,path=[],out=[]){
  if(same(a,b))return out;
  const objects=a&&b&&typeof a==='object'&&typeof b==='object';
  if(objects&&(!Array.isArray(a)&&!Array.isArray(b)||Array.isArray(a)&&Array.isArray(b)&&a.length===b.length)){
    for(const k of new Set([...Object.keys(a),...Object.keys(b)]))diff(a[k],b[k],[...path,k],out);
  }else out.push({path,before:clone(a),after:clone(b),control:PROPERTY_LABELS[path.at(-1)]||PROPERTY_LABELS[path.at(-2)]||path.at(-1)});
  return out;
}
const get=(o,path)=>path.reduce((v,k)=>v?.[k],o);
function put(o,path,value){let q=o;for(const k of path.slice(0,-1))q=q[k]??=(/^\d+$/.test(k)?[]:{});const key=path.at(-1);if(value===undefined)delete q[key];else q[key]=clone(value);}
export function applyRevision(p,op,context={},author={type:'agent',name:'Agent'}){
  const targets=op.id?[op.id]:op.ids||[];
  const before=new Map((targets.length?p.clips.filter(c=>targets.includes(c.id)):p.clips).map(c=>[c.id,clone(c)]));
  const result=applyOp(p,op,context),ids=new Set([...targets,...(result.clipIds||[])]);
  const components=[];
  for(const id of ids){const a=before.get(id),b=p.clips.find(c=>c.id===id);if(same(a,b))continue;
    components.push({id,label:b?.label||b?.text?.content||a?.label||a?.text?.content||id,track:b?.track||a?.track,before:a,after:clone(b),changes:diff(a,b)});
  }
  if(!components.length)return result;
  const revision={id:uid('rev_'),at:Date.now(),author,method:author.method||(author.type==='human'?'Inspector / timeline':'Frame edit API'),operation:clone(op),summary:result.text,components,time:result.t,revertible:['patch_graphic','update_clip'].includes(op.op)&&!['start','in','out','duration','track','speed'].some(k=>op[k]!==undefined)&&components.every(c=>c.before&&c.after&&c.before.kind===c.after.kind&&c.before.asset===c.after.asset)};
  p.revisions||=[];p.revisions.push(revision);if(p.revisions.length>300)p.revisions.splice(0,p.revisions.length-300);
  return {...result,revision};
}
export function revertRevision(p,id,context={},author={type:'agent',name:'Agent'}){
  const revision=p.revisions?.find(r=>r.id===id);if(!revision)throw new Error('This revision is not available.');
  if(!revision.revertible)throw new Error('This structural revision uses timeline Undo.');
  const ops=[];
  // Check every changed property before changing anything; preserve unrelated later edits.
  for(const part of revision.components){
    const current=p.clips.find(c=>c.id===part.id);if(!current)throw new Error('The revised element has been removed.');
    const restored=clone(current);
    for(const ch of part.changes){if(!same(get(current,ch.path),ch.after))throw new Error(`${ch.control} changed again after this revision. Review the newer change first.`);put(restored,ch.path,ch.before);}
    const op={op:'update_clip',id:current.id,ripple:false};
    for(const key of new Set(part.changes.map(ch=>ch.path[0]))){
      if(key==='effect')op.params=restored.effect.params;
      else if(key==='text'){op.text=restored.text.content;op.style={...restored.text};delete op.style.content;}
      else if(['id','kind','asset'].includes(key))throw new Error('Use timeline Undo for a structural change.');
      else op[key]=restored[key]??null;
    }
    ops.push(op);
  }
  context.beforeApply?.();
  const results=ops.map(op=>applyRevision(p,op,context,author));
  revision.revertedBy=results.map(r=>r.revision?.id).filter(Boolean);revision.revertedAt=Date.now();
  return results;
}
