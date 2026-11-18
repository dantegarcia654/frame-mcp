// Synthetic DOM/host contract test. This is NOT browser, iOS, or ChatGPT host evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { startChatGptApp } from '../src/chatgpt-app.js';
function editor(denyStorage=false, storage=new Map()){
 const elements=new Map();
 const context=new Proxy({}, {get:(_,key)=>key==='createLinearGradient'||key==='createRadialGradient'?()=>({addColorStop(){}}):()=>{},set:()=>true});
 const element=()=>({value:'',style:{},append(){},replaceChildren(){},addEventListener(){},getContext:()=>context});
 const document={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},createElement:element};
 const sandbox={document,localStorage:{getItem(k){if(denyStorage)throw Error('SecurityError');return storage.get(k)||null},setItem(k,v){if(denyStorage)throw Error('SecurityError');storage.set(k,v)}},performance:{now:()=>1},requestAnimationFrame(){},console};
 sandbox.window=sandbox;
 vm.createContext(sandbox);
 const html=fs.readFileSync(new URL('../mobile/index.html',import.meta.url),'utf8');
 vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],sandbox);
 return {sandbox,elements,storage};
}
const e=editor(true); // Must work even when iframe storage is denied.
e.sandbox.frameApp.apply('red wings',{source:'mcp',project_id:'demo-17'});
assert.equal(e.sandbox.frameApp.snapshot().blue,false);
e.elements.get('title').oninput({target:{value:'HOST CHECK 17'}});
e.elements.get('zoom').oninput({target:{value:'150'}});
e.sandbox.frameApp.apply('blue wings',{source:'mcp',project_id:'demo-17'});
let s=e.sandbox.frameApp.snapshot();
assert.equal(s.blue,true);
assert.equal(s.scenes[0].title,'HOST CHECK 17');
assert.equal(s.scenes[0].zoom,1.5);
// Known boundary: same ID in a new widget does not restore authoritative state.
const fresh=editor(true);
fresh.sandbox.frameApp.apply('blue wings',{source:'mcp',project_id:'demo-17'});
assert.notEqual(fresh.sandbox.frameApp.snapshot().scenes[0].title,'HOST CHECK 17');
// Local storage can restore a browser-local copy, independently of project_id.
const local=editor();
local.elements.get('title').oninput({target:{value:'LOCAL COPY'}});
assert.equal(editor(false,local.storage).sandbox.frameApp.snapshot().scenes[0].title,'LOCAL COPY');
const server=startChatGptApp({host:'127.0.0.1',port:0});
await new Promise(r=>server.once('listening',r));
try{
 const r=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:'ui://frame/live-scenes/v2.html'}})});
 const html=(await r.json()).result.contents[0].text;
 const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
 let receive;const applied=[],sent=[];const parent={postMessage:m=>sent.push(m)};
 const window={parent,frameApp:{apply:(...args)=>applied.push(args)},addEventListener:(_,fn)=>receive=fn,setTimeout:fn=>fn()};
 vm.runInNewContext(scripts.at(-1)[1],{window});
 const input={method:'ui/notifications/tool-input',params:{arguments:{prompt:'red wings'}}};
 receive({source:{},data:input});assert.equal(applied.length,0);
 receive({source:parent,data:input});assert.equal(applied.length,0);
 receive({source:parent,data:{id:'frame-init',result:{}}});
 receive({source:parent,data:input});
 receive({source:parent,data:{method:'ui/notifications/tool-result',params:{structuredContent:{prompt:'red wings',project_id:null,mode:'interactive-procedural-preview',editable:true}}}});
 assert.equal(applied.length,1,'input + result must not apply the same edit twice');
 assert.ok(sent.some(m=>m.method==='ui/notifications/initialized'));
 console.log('Widget contract: PASS (synthetic only; cross-widget server persistence absent)');
}finally{await new Promise(r=>server.close(r))}
