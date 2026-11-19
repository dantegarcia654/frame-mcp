import { animAt, nodeBox } from './live-graphics.js';
// Where a graphic node sits on the canvas at time t (after its keyframed motion), so a click lands on what you see.
export function graphicBounds(g,node,W,H,t=0){
 let {x,y,w,h}=nodeBox(g,node,W,H);
 if(node.kind==='brand'&&node.motion==='float')y+=Math.sin((t-(node.at||0))*2.8)*H*.005;
 const m=animAt(node,t);
 if(m.s!==1){const cx=x+w/2,cy=y+h/2;w*=m.s;h*=m.s;x=cx-w/2;y=cy-h/2;}
 x+=m.x*W;y+=m.y*H;
 return {x,y,w:Math.max(w,6),h:Math.max(h,6)};
}
export function graphicTransform(node,bounds,mode,dx,dy,W,H){
 if(mode==='move')return {x:Math.round((node.x+dx/W)*10000)/10000,y:Math.round((node.y+dy/H)*10000)/10000};
 if(node.kind==='text'||node.kind==='pixtext'||node.kind==='sprite'){const lo=node.kind==='text'?.008:.001;return {size:Math.max(lo,Math.min(.3,(node.size??.005)*Math.max(.2,(bounds.w+dx)/bounds.w)))};}
 if(node.kind==='brand'){const scale=Math.max(.2,(bounds.w+dx)/bounds.w);return {w:node.w*scale,h:node.h*scale};}
 const patch={w:Math.max(.008,Math.min(2,(bounds.w+dx)/W))};if(node.h!=null)patch.h=Math.max(.008,Math.min(2,(bounds.h+dy)/H));return patch;
}
