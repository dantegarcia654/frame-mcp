import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {MOVE_EASES,easeProgress,easeExpression} from '../ui/clip-move.js';
import {newProject,applyOp} from '../src/project.js';
import {buildGraph,ffmpegArgs} from '../src/render.js';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'frame-motion-export-'));
const ff=args=>{const r=spawnSync('ffmpeg',['-v','error','-y',...args],{maxBuffer:10e6});assert.equal(r.status,0,r.stderr.toString());return r.stdout;};
try {
  const source=path.join(tmp,'source.mp4');ff(['-f','lavfi','-i','testsrc2=s=320x180:r=25:d=1','-c:v','libx264',source]);
  for(const ease of MOVE_EASES){
    // Evaluate the export expression in FFmpeg itself, at five progress points.
    // Extract raw luma (no limited-range conversion).
    const luma=ff(['-f','lavfi','-i',`nullsrc=s=6x2,geq=lum='255*${easeExpression(ease,'(X/5)')}':cb=128:cr=128`,'-frames:v','1','-pix_fmt','yuv420p','-f','rawvideo','-']);
    for(let x=0;x<6;x++)assert(Math.abs(luma[x]-255*easeProgress(ease,x/5))<=1,`${ease} at ${x/5}`);
    for(const mode of ['reframe','move']){
      const p=newProject({aspect:'16:9',fps:25});p.width=320;p.height=180;
      p.assets.a1={id:'a1',kind:'video',name:'source',width:320,height:180,duration:1,hasAudio:false};
      applyOp(p,{op:'add_clip',asset:'a1',in:0,out:1});const c=p.clips[0];
      const motion=mode==='reframe'?{reframe:{keyframes:[{t:0,zoom:1,x:.5,y:.5},{t:1,zoom:1.2,x:.5,y:.5,e:ease}]}}:{move:[{t:0,x:0,y:0},{t:1,x:.1,y:.1,e:ease}]};
      applyOp(p,{op:'update_clip',id:c.id,...motion});
      const graph=buildGraph(p,{assetPath:()=>source});assert(!graph.filters.join(';').includes('undefined'));
      const out=path.join(tmp,`${mode}-${ease}.mp4`);ff(ffmpegArgs(graph,out,{quality:'draft'}));
      ff(['-xerror','-i',out,'-f','null','-']);
    }
  }
  console.log(`PASS: ${MOVE_EASES.length} easing curves match FFmpeg at six points; all 10 reframe/move exports fully decode`);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
