"""Deterministic, frame-based reference motion compositor. No generated footage."""
import json, math, re, subprocess, wave, hashlib
from pathlib import Path
from functools import lru_cache
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from voice import synthesize_narration
FPS=30
STYLES=['slam','stack','stretch','morph','cube','tunnel','generated']
FONTS=Path('/System/Library/Fonts/Supplemental')

def run(args):
    p=subprocess.run(args,capture_output=True,timeout=240)
    if p.returncode: raise RuntimeError(p.stderr.decode(errors='replace')[-900:])
    return p.stdout

def write_json(path,data):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data,indent=2));tmp.replace(path)

def validate(spec):
    if spec.get('fps')!=30: raise ValueError('This preset uses 30 fps.')
    if spec.get('format') not in ['landscape','portrait']: raise ValueError('Unknown aspect ratio.')
    for k in ['accent','paper','ink']:
        if not re.fullmatch(r'#[0-9a-fA-F]{6}',spec[k]): raise ValueError('Use six-digit hex colors.')
    if not 30<=spec['frames']<=1800: raise ValueError('Video must be 1–60 seconds.')
    if not 1<=len(spec['scenes'])<=16: raise ValueError('Use 1–16 scenes.')
    previous=0
    for scene in spec['scenes']:
        if not isinstance(scene['start_frame'],int) or not isinstance(scene['end_frame'],int): raise ValueError('Markers must be whole frames.')
        if scene['start_frame']!=previous or scene['end_frame']-previous<9: raise ValueError('Scenes must be contiguous and at least 9 frames long.')
        previous=scene['end_frame']
        if scene['style'] not in STYLES: raise ValueError('Unknown motion treatment.')
        if not 1<=len(scene['text'])<=180: raise ValueError('Each scene needs 1–180 characters.')
        if len(scene.get('display',''))>180: raise ValueError('Display text must be under 180 characters.')
        if len(scene.get('emphasis',''))>30: raise ValueError('Keep the hero word under 30 characters.')
        for word in scene['words']:
            if not isinstance(word['frame'],int) or not scene['start_frame']<=word['frame']<scene['end_frame']: raise ValueError('Word markers must fall within their scene.')
        if [w['frame'] for w in scene['words']]!=sorted(w['frame'] for w in scene['words']): raise ValueError('Word markers must stay in order.')
    if previous!=spec['frames']: raise ValueError('Last scene must end at the video end.')
    for key in ['sfx','bed']:
        if not 0<=float(spec[key])<=1: raise ValueError('Audio levels must be 0–1.')
    if not .4<=float(spec['energy'])<=1.5: raise ValueError('Motion energy must be 0.4–1.5.')
    if not isinstance(spec['seed'],int): raise ValueError('Seed must be an integer.')
    return spec

def create_plan(folder,script,options,upload=None,stage=lambda x:None):
    lines=[s.strip() for s in script.splitlines() if s.strip()]
    if upload:
        stage('Transcribing your voice locally')
        probe=json.loads(run(['ffprobe','-v','error','-show_format','-of','json',str(upload)]))
        if float(probe['format']['duration'])>60: raise ValueError('Voiceover exceeds 60 seconds. Please trim it before uploading.')
        run(['ffmpeg','-v','error','-y','-i',str(upload),'-vn','-ac','1','-ar','48000',str(folder/'narration.wav')])
        from faster_whisper import WhisperModel
        model=WhisperModel('small.en',device='cpu',compute_type='int8',cpu_threads=4,local_files_only=True)
        segments,_=model.transcribe(str(folder/'narration.wav'),word_timestamps=True,vad_filter=True,beam_size=3)
        raw=[{'start':s.start,'end':s.end,'text':s.text.strip(),'words':[{'text':w.word.strip(),'start':w.start,'end':w.end} for w in s.words or []]} for s in segments]
        write_json(folder/'transcript.raw.json',raw)
        with wave.open(str(folder/'narration.wav'),'rb') as w: duration=w.getnframes()/w.getframerate()
        if not raw: raise ValueError('No speech found. Use a clear English voiceover.')
        # Split long segments into manageable 3–6 word compositional beats.
        chunks=[];group=[]
        all_words=[w for segment in raw for w in segment['words']]
        for j,word in enumerate(all_words):
            group.append(word)
            pause=(all_words[j+1]['start']-word['end']) if j+1<len(all_words) else 1
            boundary=(len(group)>=3 and (re.search(r'[,.!?;:]$',word['text']) or pause>.25))
            if boundary or len(group)>=6 or j==len(all_words)-1:
                chunks.append({'narration':' '.join(w['text'] for w in group),'words':group});group=[]
        if len(chunks)>16: raise ValueError('This MVP supports up to 16 beats. Please upload a shorter voiceover.')
        total=math.ceil(duration*FPS)
        audio={'provider':'Local faster-whisper small.en alignment; user supplied voice','frames':total,'fps':FPS,'scenes':[]}
        for i,s in enumerate(chunks):
            start=0 if i==0 else round(s['words'][0]['start']*FPS)
            end=total if i==len(chunks)-1 else round(chunks[i+1]['words'][0]['start']*FPS)
            audio['scenes'].append({**s,'start_frame':start,'end_frame':end})
        # Frame-aligned padding, preserving every source sample.
        run(['ffmpeg','-v','error','-y','-i',str(folder/'narration.wav'),'-af',f'apad=whole_dur={total/FPS}','-t',str(total/FPS),str(folder/'padded.wav')])
        (folder/'padded.wav').replace(folder/'narration.wav')
    else:
        if not lines or len(lines)>16 or len(script)>1500: raise ValueError('Enter 1–16 short lines, up to 1,500 characters.')
        audio=synthesize_narration(folder,[{'narration':x,'energy':.8} for x in lines],{'voice':options.get('voice','confident'),'pace':1.04,'motion':'punchy'},stage,FPS)
    write_json(folder/'alignment.json',audio)
    scenes=[]
    for i,s in enumerate(audio['scenes']):
        words=[{'text':w['text'].strip(),'frame':max(s['start_frame'],min(s['end_frame']-1,round(w['start']*FPS))),'raw_start':w['start'],'raw_end':w['end']} for w in s['words']]
        text=s['narration']
        emphasis=re.sub(r'[^\w -]','',text.split()[-1]).upper()
        scenes.append({'id':f'beat-{i+1:02d}','text':text,'emphasis':emphasis,'style':STYLES[i%6],'start_frame':s['start_frame'],'end_frame':s['end_frame'],'words':words,'light':i%4==2})
    spec={'schema':1,'fps':FPS,'frames':audio['frames'],'format':options.get('format','landscape'),'accent':options.get('accent','#ff281c'),'paper':'#eeeeda','ink':'#101112','seed':7,'energy':1.0,'sfx':.3,'bed':.12,'voice_provider':audio['provider'],'scenes':scenes}
    return validate(spec)

@lru_cache(maxsize=200)
def font(size,kind='heavy'):
    names={'heavy':'Arial Black.ttf','condensed':'Arial Narrow Bold.ttf','thin':'Arial Narrow.ttf','serif':'Baskerville.ttc'}
    return ImageFont.truetype(str(FONTS/names[kind]),max(8,int(size)))

def ease(x):
    x=max(0,min(1,x));return 1-(1-x)**4

def text_layer(text,max_w,max_h,fill,kind='heavy',stroke=False):
    # Search actual wrapping at each font size, avoiding tiny single-word columns.
    text=text.upper();words=text.split();size=int(max_h*.9)
    while True:
        f=font(size,kind);lines=[];line=''
        for word in words:
            candidate=(line+' '+word).strip()
            if f.getlength(candidate)>max_w and line:lines.append(line);line=word
            else:line=candidate
        if line:lines.append(line)
        if not lines:lines=[' ']
        if (max(f.getlength(l) for l in lines)<=max_w and len(lines)*size*1.12<=max_h) or size<=8:break
        size=max(8,int(size*.94))
    width=max(1,int(max(f.getlength(l) for l in lines))+12);height=max(1,int(len(lines)*size*1.12)+12)
    layer=Image.new('RGBA',(width,height));d=ImageDraw.Draw(layer)
    for j,l in enumerate(lines):
        d.text((width/2,6+j*size*1.08),l,font=f,anchor='mt',fill=(0,0,0,0) if stroke else fill,stroke_width=1 if stroke else 0,stroke_fill=fill)
    return layer

def paste_center(im,layer,x,y,sx=1,sy=1,alpha=1):
    sx=max(.01,min(sx,6));sy=max(.01,min(sy,6))
    if sx!=1 or sy!=1:layer=layer.resize((max(1,int(layer.width*sx)),max(1,int(layer.height*sy))),Image.Resampling.BICUBIC)
    if alpha<1:layer=layer.copy();layer.putalpha(layer.getchannel('A').point(lambda v:int(v*max(0,alpha))))
    im.alpha_composite(layer,(int(x-layer.width/2),int(y-layer.height/2)))

class Renderer:
    def __init__(self,spec):
        self.spec=validate(spec);self.w,self.h=(1280,720) if spec['format']=='landscape' else (720,1280)
        self.cache={};self.textures=[]
        rng=np.random.default_rng(spec['seed'])
        # Fixed seed and frame-indexed textures guarantee repeatable visuals.
        for _ in range(4):
            a=np.zeros((self.h,self.w,4),dtype=np.uint8);a[:,:,:3]=rng.integers(70,180,(self.h,self.w,1),dtype=np.uint8);a[:,:,3]=9
            self.textures.append(Image.fromarray(a))
    def txt(self,text,mw,mh,color,kind='heavy',stroke=False):
        key=(text,int(mw),int(mh),color,kind,stroke)
        if key not in self.cache:self.cache[key]=text_layer(text,int(mw),int(mh),color,kind,stroke)
        return self.cache[key]
    def scene_at(self,frame):
        for i,s in enumerate(self.spec['scenes']):
            if frame<s['end_frame']: return i,s
        return len(self.spec['scenes'])-1,self.spec['scenes'][-1]
    def frame(self,frame,texture=True):
        sp=self.spec;W,H=self.w,self.h;i,s=self.scene_at(frame)
        if s['style']=='generated':
            from graphics import draw_generated
            return draw_generated(self,frame,s)
        t=(frame-s['start_frame'])/FPS;duration=(s['end_frame']-s['start_frame'])/FPS
        p=max(0,min(1,t/duration));intro=ease(t/(.24/sp['energy']));out=ease(max(0,t-duration+.16)/.16) if i<len(sp['scenes'])-1 else 0
        bg,fg=(sp['paper'],sp['ink']) if s['light'] else (sp['ink'],sp['paper'])
        if s['style']=='stretch' and p>.52:bg,fg=sp['accent'],sp['ink']
        im=Image.new('RGBA',(W,H),bg);d=ImageDraw.Draw(im)
        accent=sp['accent'];cy=H*.50;cx=W*.5
        # Barely visible registration grid and frame corner marks.
        grid=('#d71e14' if s['style']=='stretch' and p>.52 else '#d7d7c5') if s['light'] else '#202124'
        for x in range(0,W,max(60,W//10)):d.line((x,0,x,H),fill=grid,width=1)
        d.line((0,H*.5,W,H*.5),fill=grid,width=1)
        unit=min(W,H);margin=unit*.07
        d.text((margin,margin*.5),f'MOTION STUDY / {i+1:02d}',font=font(unit*.015,'condensed'),fill=fg)
        d.text((W-margin,margin*.5),'TYPE × FORM',anchor='ra',font=font(unit*.015,'condensed'),fill=fg)
        visible=[w['text'] for w in s['words'] if frame>=w['frame']]
        spoken=' '.join(visible) if s['words'] else s['text']
        # Override text supported: full supplied display copy, otherwise word build.
        display=s.get('display') or spoken
        hero=s['emphasis'];style=s['style']
        hero_layer=self.txt(hero,W*.86,H*.30,fg)
        if style=='slam':
            # Overshoot, moving red bar, huge word at its own narration marker.
            full=display.upper();layer=self.txt(full,W*.9,H*.52,fg)
            sc=1+(.62*(1-intro))+.015*math.sin(t*2)
            d.rectangle((W*(1-intro),H*.73,W,H*.76),fill=accent)
            paste_center(im,layer,cx+W*.12*(1-intro)-W*.8*out,cy,sc,sc)
        elif style=='stack':
            layer=self.txt(display,W*.86,H*.53,fg,'condensed')
            d.rounded_rectangle((W*.58,H*.24,W*.87,H*.68),radius=unit*.08,fill=accent)
            paste_center(im,layer,cx,cy+H*.25*(1-intro)-H*.65*out,1,1)
        elif style=='stretch':
            layer=self.txt(display,W*.86,H*.48,fg,'condensed')
            sy=.1+.9*intro+.12*math.sin(p*math.pi)
            for shift in [14,8]:paste_center(im,layer,cx+shift,cy,1,sy,.10)
            paste_center(im,layer,cx-W*out,cy,1,sy)
            d=ImageDraw.Draw(im);d.line((W*.04,H*.80,W*.96,H*.80),fill=accent,width=max(2,int(unit*.008)))
        elif style=='morph':
            radius=unit*.29*intro;shape=[]
            # Continuous interpolation from burst to circle, matched point count.
            morph=ease(max(0,t-.45)/max(.4,duration*.6))
            for k in range(48):
                a=k*math.tau/48+t*.22;r=radius*(1 if k%2==0 else .46+.54*morph)
                shape.append((W*.67+math.cos(a)*r,cy+math.sin(a)*r))
            d.polygon(shape,fill=accent)
            layer=self.txt(display,W*.61,H*.58,fg,'condensed')
            paste_center(im,layer,W*.36-W*.5*out,cy,1,1)
        elif style=='cube':
            # Real projected 3-D vertices, sorted faces, rotating in one space.
            angle=t*.85;ca,sa=math.cos(angle),math.sin(angle);cb,sb=math.cos(.5),math.sin(.5)
            vertices=[]
            for x,y,z in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]:
                xx=x*ca+z*sa;zz=-x*sa+z*ca;yy=y*cb-zz*sb;zz=y*sb+zz*cb
                scale=unit*.21*intro*3.5/(4+zz);vertices.append((W*.75+xx*scale,cy+yy*scale,zz))
            faces=[(0,1,2,3),(4,5,6,7),(0,1,5,4),(2,3,7,6),(0,3,7,4),(1,2,6,5)]
            rgb=tuple(int(accent[k:k+2],16) for k in (1,3,5))
            for face in sorted(faces,key=lambda a:sum(vertices[k][2] for k in a),reverse=True):
                shade=.5+.5*(faces.index(face)/5);color=tuple(int(v*shade) for v in rgb)
                d.polygon([(vertices[k][0],vertices[k][1]) for k in face],fill=color,outline=accent)
            layer=self.txt(display,W*.53,H*.48,fg,'condensed');paste_center(im,layer,W*.30-W*.5*out,cy)
        elif style=='tunnel':
            for k in range(7,0,-1):
                scale=.10+k*.14+(p*.12)% .14
                layer=self.txt(hero,W*.78,H*.23,fg)
                paste_center(im,layer,cx,cy+(k-4)*H*.077,scale,scale,.08+k*.035)
            layer=self.txt(display,W*.87,H*.34,fg)
            paste_center(im,layer,cx,cy, .85+.15*intro+.04*p, .85+.15*intro+.04*p)
            d=ImageDraw.Draw(im);d.ellipse((W*.83,H*.76,W*.83+unit*.035,H*.76+unit*.035),fill=accent)
        # Secondary hero line only where it does not duplicate the live typography.
        d=ImageDraw.Draw(im)
        d.line((margin,H-margin,W-margin,H-margin),fill=grid,width=2)
        progress=(frame+1)/sp['frames'];d.line((margin,H-margin,margin+(W-2*margin)*progress,H-margin),fill=accent,width=3)
        if texture:im=Image.alpha_composite(im,self.textures[int(frame)%4])
        return im.convert('RGB')
    def output_frame(self,f):
        i,s=self.scene_at(f);local=f-s['start_frame'];tail=s['end_frame']-f
        im=self.frame(f)
        if s['style']=='generated':
            # Blending neighboring word states ghosts reflowing captions.
            return im
        if local<7 or tail<5 or any(0<=f-w['frame']<3 for w in s['words']):
            # Multi-sample shutter blur from previous sub-frame states.
            im=Image.blend(self.frame(max(s['start_frame'],f-.55)),im,.7)
        return im

def mix_audio(folder,spec):
    sr=48000;n=spec['frames']*(sr//FPS)
    with wave.open(str(folder/'narration.wav'),'rb') as w:
        voice=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').astype(np.float64)/32768
    voice=np.pad(voice,(0,max(0,n-len(voice))))[:n]
    effects=np.zeros(n);bed=np.zeros(n);rng=np.random.default_rng(spec['seed']);cues=[]
    def add(sig,frame,kind,gain):
        start=max(0,frame)*(sr//FPS);count=min(len(sig),n-start)
        if count>0:effects[start:start+count]+=sig[:count]*gain;cues.append({'kind':kind,'frame':frame,'sample':start,'gain':gain})
    for i,s in enumerate(spec['scenes']):
        t=np.arange(int(sr*.22))/sr
        impact=np.sin(2*np.pi*(70*t-90*t*t))*np.exp(-t*24)*np.minimum(t/.003,1)
        if s.get('style')=='generated':
            focus=s['words'][s['focus_word']]['frame'];importance=s['importance'];intensity=s['intensity']
            add(impact,focus,'focus_impact',(.10+.45*importance)*(.25+.75*intensity))
        else:add(impact,s['start_frame'],'impact',.50)
        if i:
            t=np.arange(int(sr*.14))/sr
            noise=rng.normal(0,.24,len(t));noise=np.convolve(noise,np.ones(5)/5,mode='same')
            swish=noise*np.sin(np.pi*t/.14)**2
            add(swish,max(0,s['start_frame']-4),'whoosh',.40*(s.get('intensity',1)))
        for word in s['words']:
            t=np.arange(int(sr*.025))/sr;tick=np.sin(2*np.pi*1100*t)*np.exp(-t*190)*np.minimum(t/.002,1)
            add(tick,word['frame'],'word_tick',.02+.05*s.get('intensity',1))
    # Optional original two-note pulse bed, not the reference soundtrack.
    t=np.arange(n)/sr
    beat=(t%(60/110))/(60/110);env=np.exp(-beat*13)*np.minimum(beat/.015,1)
    bed=(np.sin(2*np.pi*55*t)+.3*np.sin(2*np.pi*82.4069*t))*env*.16
    fade=np.minimum(t/.08,1)*np.minimum((n/sr-t)/.2,1)
    voice*=min(1.5,.75/max(.01,np.max(np.abs(voice))))
    mixed=voice+(effects*spec['sfx']+bed*spec['bed'])*fade
    mixed-=mixed.mean();peak=max(.01,float(np.max(np.abs(mixed))));gain=min(1,.89/peak);mixed*=gain
    def save(name,a):
        with wave.open(str(folder/name),'wb') as w:w.setparams((1,2,sr,0,'NONE','not compressed'));w.writeframes((np.clip(a,-1,1)*32767).astype('<i2').tobytes())
    save('mix.wav',mixed);save('effects.wav',effects*spec['sfx']);save('bed.wav',bed*spec['bed'])
    bins=1000; padded=np.pad(voice,(0,(-len(voice))%bins));peaks=np.max(np.abs(padded.reshape(bins,-1)),axis=1)
    write_json(folder/'waveform.json',{'duration':n/sr,'peaks':peaks.round(4).tolist()})
    write_json(folder/'audio-cues.json',{'sample_rate':sr,'samples':n,'peak_dbfs':20*math.log10(max(.00001,np.max(np.abs(mixed)))),'limiting_gain':gain,'cues':cues})

def render(folder,spec,stage=lambda x:None):
    validate(spec);write_json(folder/'timeline.json',spec);mix_audio(folder,spec)
    r=Renderer(spec);stage('Rendering frame 0')
    command=['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{r.w}x{r.h}','-r','30','-i','-','-i',str(folder/'mix.wav'),'-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-t',str(spec['frames']/FPS),'-movflags','+faststart',str(folder/'video.mp4')]
    with open(folder/'render.log','wb') as log:
        p=subprocess.Popen(command,stdin=subprocess.PIPE,stderr=log)
        try:
            for f in range(spec['frames']):
                p.stdin.write(r.output_frame(f).tobytes())
                if f%30==0:stage(f'Rendering {f//30}s / {spec["frames"]/30:.1f}s')
            p.stdin.close()
            if p.wait(timeout=120):raise RuntimeError((folder/'render.log').read_text()[-700:])
        except Exception:
            p.kill();p.wait();raise
    stage('Checking exported video and audio')
    run(['ffmpeg','-v','error','-i',str(folder/'video.mp4'),'-f','null','-'])
    info=json.loads(run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(folder/'video.mp4')]))
    v=next(x for x in info['streams'] if x['codec_type']=='video')
    if int(v['nb_frames'])!=spec['frames']:raise RuntimeError('Encoded frame count mismatch.')
    r.output_frame(min(spec['frames']-1,20)).save(folder/'poster.jpg',quality=92)
    write_json(folder/'verification.json',{'decode':'passed','frames':int(v['nb_frames']),'duration':float(info['format']['duration']),'width':r.w,'height':r.h,'sha256':hashlib.sha256((folder/'video.mp4').read_bytes()).hexdigest(),'perceptual_audio_review':'not yet reviewed by user'})
    return info
