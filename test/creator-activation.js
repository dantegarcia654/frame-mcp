import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'frame-activation-test-'));
const script=new URL('../scripts/creator-activation.mjs',import.meta.url).pathname;
const ff=args=>{const r=spawnSync('ffmpeg',['-v','error','-y',...args]);assert.equal(r.status,0,r.stderr.toString());};
try{
 const audio=path.join(tmp,'audio.m4a');ff(['-f','lavfi','-i','sine=duration=3','-c:a','aac',audio]);
 const output=path.join(tmp,'results');
 const gate=source=>spawnSync(process.execPath,[script,source,output],{encoding:'utf8',timeout:120000});
 assert.equal(gate(audio).status,2,'Audio-only input must be rejected before starting Frame');
 assert(!fs.existsSync(output));
 const video=path.join(tmp,'video.mp4');ff(['-f','lavfi','-i','testsrc2=s=160x90:r=25:d=3','-i',audio,'-c:v','libx264','-c:a','copy',video]);
 const r=gate(video);assert.equal(r.status,0,r.stderr+r.stdout);
 const first=JSON.parse(fs.readFileSync(path.join(output,'creator-activation-evidence.json')));
 assert.equal(first.export.fullyDecoded,true);assert.equal(first.export.expectedSeconds,2.5);
 const bytes=fs.readFileSync(first.export.path);
 const rerun=gate(video);assert.equal(rerun.status,0,rerun.stderr+rerun.stdout);
 const second=JSON.parse(fs.readFileSync(path.join(output,'creator-activation-evidence.json')));
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.renderDirectory,'creator-activation-evidence.json'))),first);
 assert.notEqual(first.export.path,second.export.path);assert.deepEqual(fs.readFileSync(first.export.path),bytes);
 console.log('PASS: audio-only input rejected; two full editing journeys decode and preserve earlier exports');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
