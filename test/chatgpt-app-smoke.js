// FRAME ChatGPT MCP Apps smoke test. Run with: node test/chatgpt-app-smoke.js
import assert from 'node:assert/strict';
import { startChatGptApp } from '../src/chatgpt-app.js';
const srv=startChatGptApp({host:'127.0.0.1',port:0});
await new Promise(resolve=>srv.once('listening',resolve));
const url='http://127.0.0.1:'+srv.address().port+'/mcp';
let id=1;
async function call(method,params={}){
 const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:id++,method,params})});
 assert.equal(res.status,200);
 return res.json();
}
try{
 let r=await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'smoke',version:'1'}});
 assert.equal(r.result.serverInfo.name,'frame-chatgpt');
 r=await call('tools/list');
 const t=r.result.tools.find(t=>t.name==='frame_open_visual');
 assert.ok(t);
 assert.match(t.description,/default/i);
 assert.equal(t._meta.ui.resourceUri,'ui://frame/live-scenes/v1.html');
 r=await call('resources/read',{uri:t._meta.ui.resourceUri});
 assert.equal(r.result.contents[0].mimeType,'text/html;profile=mcp-app');
 assert.match(r.result.contents[0].text,/window\.frameApp=/);
 assert.match(r.result.contents[0].text,/Statue of Liberty/);
 assert.match(r.result.contents[0].text,/FRAME-owned editor/);
 assert.match(r.result.contents[0].text,/not invoked by ChatGPT/);
 assert.match(r.result.contents[0].text,/Source code/);
 r=await call('tools/call',{name:t.name,arguments:{prompt:'3D rocket in NYC with blue wings'}});
 assert.equal(r.result.structuredContent.editable,true);
 r=await call('tools/call',{name:t.name,arguments:{prompt:''}});
 assert.equal(r.error.code,-32602);
 const blocked=await fetch(url,{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'});
 assert.equal(blocked.status,403);
 console.log('FRAME ChatGPT app smoke: PASS');
}finally{await new Promise(resolve=>srv.close(resolve))}
