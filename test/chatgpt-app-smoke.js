// FRAME ChatGPT MCP Apps smoke test. Run with: node test/chatgpt-app-smoke.js
import assert from 'node:assert/strict';
import { startChatGptApp } from '../src/chatgpt-app.js';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
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
 assert.equal(t.annotations.readOnlyHint,false);
 assert.match(t.description,/default/i);
 assert.equal(t._meta.ui.resourceUri,'ui://frame/live-scenes/v2.html');
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
 r=await call('tools/call',{name:t.name,arguments:{prompt:'blue wings',project_id:{bad:true}}});
 assert.equal(r.error.code,-32602);
 r=await call('tools/call',{name:t.name,arguments:{prompt:'blue wings',extra:true}});
 assert.equal(r.error.code,-32602);
 const blocked=await fetch(url,{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'});
 assert.equal(blocked.status,403);
 const badHost=await new Promise((resolve,reject)=>{
   const request=http.request(url,{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)});
   request.on('error',reject);request.end();
 });
 assert.equal(badHost,403);
 assert.equal((await fetch(url)).status,405);
 assert.throws(()=>startChatGptApp({host:'0.0.0.0',port:0}),/Loopback/);
 const oldToken=process.env.FRAME_APP_TOKEN;
 try{
   process.env.FRAME_APP_TOKEN='test-only-secret';
   assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
   assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer incorrect'},body:'{}'})).status,401);
   const authorized=await fetch(url,{method:'POST',headers:{authorization:'Bearer test-only-secret'},body:JSON.stringify({jsonrpc:'2.0',id:90,method:'tools/list'})});
   assert.equal(authorized.status,200);
 }finally{if(oldToken===undefined)delete process.env.FRAME_APP_TOKEN;else process.env.FRAME_APP_TOKEN=oldToken}
 const stdio=spawnSync(process.execPath,['src/chatgpt-app.js','--stdio'],{cwd:new URL('..',import.meta.url),encoding:'utf8',input:[
   {jsonrpc:'2.0',id:1,method:'initialize'},
   {jsonrpc:'2.0',method:'notifications/initialized'},
   {jsonrpc:'2.0',id:2,method:'tools/list'},
   {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'frame_open_visual',arguments:{prompt:'red wings'}}}
 ].map(m=>JSON.stringify(m)+'\n').join('')});
 assert.equal(stdio.status,0,stdio.stderr);
 const replies=stdio.stdout.trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(replies.length,3);
 assert.equal(replies[0].result.serverInfo.name,'frame-chatgpt');
 assert.equal(replies[1].result.tools[0].name,'frame_open_visual');
 assert.equal(replies[2].result.structuredContent.prompt,'red wings');
 console.log('FRAME ChatGPT app smoke: PASS');
}finally{await new Promise(resolve=>srv.close(resolve))}
