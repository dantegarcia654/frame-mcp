/* Half-open source intervals [start, end). This map is also used by the scrubber. */
class CutTimeline {
  constructor(ranges) {
    let offset=0;
    this.entries=ranges.map(([start,end],index)=>{
      if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)throw Error('Invalid preview interval.');
      const entry={index,start,end,offset,limit:offset+(end-start)};offset=entry.limit;return entry;
    });
    this.duration=offset;
  }
  at(time) {
    if(!this.entries.length) return null;
    const position=Math.max(0,Math.min(this.duration,Number(time)||0));
    const entry=this.entries.find(e=>position<e.limit)||this.entries.at(-1);
    const source=entry.start+position-entry.offset;
    // At the terminal endpoint, display the final included source sample, never the next chunk.
    return {...entry,position,source:Math.min(source,entry.end-1e-6)};
  }
  fromSource(source,indexHint=-1) {
    const hint=this.entries[indexHint];
    const entry=(hint&&source>=hint.start&&source<hint.end?hint:null)||this.entries.find(e=>source>=e.start&&source<e.end);
    if(entry)return {entry,position:entry.offset+source-entry.start};
    return null;
  }
}

class SlicePreview {
  constructor(video,label,schedule=requestAnimationFrame,cancel=cancelAnimationFrame,onChange=()=>{}) {
    this.video=video;this.label=label;this.schedule=schedule.bind(globalThis);this.cancel=cancel.bind(globalThis);this.onChange=onChange;
    this.map=new CutTimeline([]);this.position=0;this.index=0;this.operation=0;this.frame=null;
    this.playing=false;this.moving=false;this.title='Preview';this.error='';this.rate=1;this.boundaryTimer=null;
    video.addEventListener('play',()=>{
      if(this.moving||video.paused)return;
      if(!this.map.entries.length){video.pause();return}
      this.playing=true;this.watch();this.emit();
    });
    // Media events are queued. An old pause event must not cancel the guard for a new play.
    video.addEventListener('pause',()=>{if(!this.moving&&video.paused){this.playing=false;this.cancelWatch();this.cancelBoundary();this.sync();this.emit()}});
    video.addEventListener('ended',()=>{
      const entry=this.map.entries[this.index];
      if(!this.moving&&entry&&video.currentTime>=entry.end-1e-6)this.advance();
    });
    video.addEventListener('timeupdate',()=>{
      if(this.checkBounds()||this.moving||video.paused)return;
      if(this.frame===null)this.watch();else this.armBoundary();
    });
    video.addEventListener('seeking',()=>{
      if(this.moving||!this.map.entries.length)return;
      const mapped=this.map.fromSource(video.currentTime,this.index);
      if(mapped){this.position=mapped.position;this.index=mapped.entry.index;this.emit()}
      else this.seekTo(this.position,this.playing);
    });
    video.addEventListener('ratechange',()=>{this.rate=video.playbackRate;this.armBoundary();this.emit()});
    video.addEventListener('error',()=>{this.error='Source playback failed. Try another video format.';this.pause();this.emit()});
  }
  cancelWatch(){if(this.frame!==null)this.cancel(this.frame);this.frame=null}
  cancelBoundary(){if(this.boundaryTimer!==null)clearTimeout(this.boundaryTimer);this.boundaryTimer=null}
  armBoundary(){
    this.cancelBoundary();
    const entry=this.map.entries[this.index];if(!entry||this.moving||this.video.paused)return;
    const token=this.operation;
    const remaining=Math.max(0,entry.end-this.video.currentTime)/Math.max(.1,this.video.playbackRate||1);
    this.boundaryTimer=setTimeout(()=>{
      this.boundaryTimer=null;if(token!==this.operation||this.moving||this.video.paused)return;
      if(!this.checkBounds())this.armBoundary();
    },Math.max(16,remaining*1000));
  }
  checkBounds(){
    if(this.moving||this.video.paused)return false;
    const entry=this.map.entries[this.index];
    if(!entry){this.video.pause();return true}
    this.playing=true;
    if(this.video.currentTime>=entry.end){this.advance();return true}
    if(this.video.currentTime<entry.start){this.seekTo(entry.offset,true);return true}
    this.sync();this.emit();return false;
  }
  stop(message){this.operation++;this.moving=false;this.playing=false;this.cancelWatch();this.cancelBoundary();this.video.pause();if(message)this.error=message;this.emit()}
  clear(){this.stop();this.map=new CutTimeline([]);this.position=0;this.error='';this.emit()}
  emit(){
    const at=this.map.at(this.position);
    this.label.textContent=this.error||(at?`${this.title} · preview ${this.position.toFixed(3)} / ${this.map.duration.toFixed(3)}s · source ${at.source.toFixed(3)}s · chunk ${at.index+1}/${this.map.entries.length}`:'Choose a preview mode.');
    this.onChange({position:this.position,duration:this.map.duration,index:this.index,source:at?.source??0,
      playing:this.playing,moving:this.moving,title:this.title,rate:this.rate,error:this.error});
  }
  event(name){
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);this.video.removeEventListener(name,done);this.video.removeEventListener('error',failed)};
      const done=()=>{cleanup();resolve()};const failed=()=>{cleanup();reject(Error('Video could not be loaded.'))};
      const timer=setTimeout(()=>{cleanup();reject(Error('Video seek timed out.'))},10000);
      this.video.addEventListener(name,done,{once:true});this.video.addEventListener('error',failed,{once:true});
    });
  }
  async start(url,ranges,title,autoplay=true,position=0){
    this.stop();this.error='';this.map=new CutTimeline(ranges);this.position=0;this.title=title;
    this.emit();
    const token=this.operation;
    try{
      if(this.video.getAttribute('src')!==url){this.video.src=url;this.video.load()}
      if(this.video.readyState<1)await this.event('loadedmetadata');
      if(token!==this.operation)return;
      await this.seekTo(position,autoplay);
    }catch(e){if(token===this.operation){this.error=e.message;this.pause();this.emit()}}
  }
  async seekTo(time,resume=this.playing){
    const at=this.map.at(time);if(!at)return;
    const token=++this.operation;this.moving=true;this.cancelWatch();this.cancelBoundary();this.video.pause();
    this.position=at.position;this.index=at.index;this.error='';this.playing=false;this.emit();
    try{
      if(this.video.readyState<1)await this.event('loadedmetadata');
      if(token!==this.operation)return;
      if(Math.abs(this.video.currentTime-at.source)>1e-7){const ready=this.event('seeked');this.video.currentTime=at.source;await ready}
      if(token!==this.operation)return;
      this.moving=false;
      if(resume&&this.position<this.map.duration){
        this.playing=true;await this.video.play();
        if(token!==this.operation)return;
        this.watch();
      }
      this.emit();
    }catch(e){if(token===this.operation){this.moving=false;this.playing=false;this.error=e.message;this.emit()}}
  }
  sync(){
    if(this.moving)return;
    const entry=this.map.entries[this.index];if(!entry)return;
    this.position=Math.max(entry.offset,Math.min(entry.limit,entry.offset+this.video.currentTime-entry.start));
  }
  async play(){if(!this.map.entries.length)return;return this.seekTo(this.position>=this.map.duration?0:this.position,true)}
  pause(){this.sync();this.stop()}
  async toggle(){if(this.playing)this.pause();else await this.play()}
  async advance(){
    if(this.moving||!this.map.entries.length)return;
    const next=this.map.entries[this.index+1];
    if(next)return this.seekTo(next.offset,true);
    return this.seekTo(this.map.duration,false);
  }
  watch(){
    this.cancelWatch();this.armBoundary();
    const tick=()=>{
      this.frame=null;if(!this.playing||this.moving||this.video.paused)return;
      if(this.checkBounds())return;
      this.frame=this.schedule(tick);
    };
    this.frame=this.schedule(tick);
  }
  setRate(rate){this.video.playbackRate=rate;this.rate=rate;this.emit()}
  async jumpChunk(delta){const entry=this.map.entries[Math.max(0,Math.min(this.map.entries.length-1,this.index+delta))];if(entry)await this.seekTo(entry.offset,this.playing)}
}
if(typeof module!=='undefined')module.exports={CutTimeline,SlicePreview};
