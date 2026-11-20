// A scratch service verifies that preparation never queues a ready-material edit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-preparation-'));
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const pause = ms => new Promise(r => setTimeout(r, ms));
let service;
async function post(route, body) { const r = await fetch(base + route, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return r.json(); }
async function call(name, args) { const r = await post('/api/call', {name,arguments:args}); assert.ok(!r.isError, JSON.stringify(r)); return r; }
try {
  const clip = path.join(tmp, 'ready.mp4');
  assert.equal(spawnSync('ffmpeg', ['-v','error','-y','-f','lavfi','-i','color=c=gray:s=320x180:r=30:d=2','-c:v','libx264',clip]).status, 0);
  service = spawn(process.execPath, [path.join(root,'bin/frame.js'),'serve'], {env:{...process.env,FRAME_PORT:String(port),FRAME_HOME:path.join(tmp,'home'),FRAME_NO_OPEN:'1',FRAME_PACE:'0'},stdio:'ignore'});
  let online = false;
  for(let i=0;i<100;i++) { try { online = (await fetch(base+'/api/ping')).ok; } catch {} if(online) break; await pause(50); }
  assert.ok(online, 'Scratch service did not start');
  await call('frame_start', {name:'Preparation regression',aspect:'16:9'});
  const projectId = JSON.parse(fs.readFileSync(path.join(tmp,'home','state.json'),'utf8')).current;
  await call('frame_import', {project_id:projectId,paths:[clip],prepare:false,decide:false});
  const files = Array.from({length:16},(_,i)=>{const f=path.join(tmp,`preparing-${i}.mp4`);fs.copyFileSync(clip,f);return f;});
  let prepared = false;
  const pending = call('frame_import',{project_id:projectId,paths:files,prepare:false,decide:false}).then(r=>{prepared=true;return r;});
  await pause(100);
  const started = performance.now();
  const edited = await call('frame_edit',{project_id:projectId,fast:true,ops:[{op:'add_clip',asset:'a1'}]});
  assert.match(edited.content[0].text,/✓/);
  assert.ok(!prepared,'Import should still be in progress when the edit finishes');
  assert.ok(performance.now()-started<750,'Ready edit was delayed by preparation');
  await pending;
  console.log('PASS: ready edit completes while import is still running');
  await post('/api/generating',{job_id:'failed',project_id:projectId,name:'Failed generation',status:'failed',note:'Source unavailable'});
  await pause(5500);
  let jobs = (await (await fetch(base+'/api/generating')).json()).jobs;
  assert.ok(jobs.some(j=>j.job_id==='failed'),'Failure vanished without resolution');
  await post('/api/generating',{job_id:'bad-output',project_id:projectId,name:'Missing output',status:'done',path:path.join(tmp,'missing.mp4'),auto_import:true});
  for(let i=0;i<40;i++) {jobs=(await (await fetch(base+'/api/generating')).json()).jobs;if(jobs.find(j=>j.job_id==='bad-output')?.status==='failed')break;await pause(50);}
  assert.equal(jobs.find(j=>j.job_id==='bad-output')?.status,'failed');
  assert.match(jobs.find(j=>j.job_id==='bad-output').note,/could not be imported/);
  console.log('PASS: failed generation and failed auto-import remain explicit');
  await post('/api/generating',{job_id:'interrupted',project_id:projectId,name:'Long generation',done:2,total:100});
  await pause(300);
  service.kill(); await new Promise(resolve=>service.once('exit',resolve));
  service = spawn(process.execPath, [path.join(root,'bin/frame.js'),'serve'], {env:{...process.env,FRAME_PORT:String(port),FRAME_HOME:path.join(tmp,'home'),FRAME_NO_OPEN:'1',FRAME_PACE:'0'},stdio:'ignore'});
  let recovered;
  for(let i=0;i<100;i++) {try {recovered=(await (await fetch(base+'/api/generating')).json()).jobs;break;}catch{} await pause(50);}
  assert.equal(recovered.find(j=>j.job_id==='interrupted')?.status,'disconnected');
  assert.equal(recovered.find(j=>j.job_id==='failed')?.status,'failed');
  console.log('PASS: unfinished jobs survive restart with an explicit reconnect state');

} finally {
  if(service) {service.kill(); await new Promise(resolve=>service.exitCode!==null?resolve():service.once('exit',resolve));}
  fs.rmSync(tmp,{recursive:true,force:true});
}
