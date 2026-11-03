"""Bounded split-screen composition for FRAME. Pillow typography, FFmpeg motion/mux.

All timestamps refer to the parent video. Region boxes use canvas fractions;
crop rectangles use source fractions. No model-generated filter or file path runs.
"""
from __future__ import annotations
import copy
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import uuid
from datetime import datetime, timezone
from PIL import Image, ImageDraw, ImageFont

WIDTH,HEIGHT,FPS=1080,1920,30


def object_schema(properties):
    return {'type':'object','properties':properties,'required':list(properties),'additionalProperties':False}


def instruction_schema():
    number={'type':'number'}
    def array(n):return {'type':'array','items':number,'minItems':n,'maxItems':n}
    region=object_schema({'box':array(4),'crop':array(4),'fit':{'type':'string','enum':['contain','cover']},
                          'position':array(2),'scale':number,'background':{'type':'string'}})
    graphic=object_schema({'text':{'type':'string'},'start':number,'end':number,'enter':number,'exit':number,
                           'foreground':{'type':'string'},'accent':{'type':'string'}})
    return object_schema({'schema':{'type':'integer','enum':[1]},'canvas':object_schema({
        'width':{'type':'integer','enum':[WIDTH]},'height':{'type':'integer','enum':[HEIGHT]},
        'fps':{'type':'integer','enum':[FPS]}}),'audio':{'type':'string','enum':['preserve']},
        'top':region,'bottom':region,'graphics':{'type':'array','items':graphic,'minItems':1,'maxItems':8}})


def default_spec(duration,text='1M TOKENS',start=1,end=None):
    end=min(duration-.2,start+4) if end is None else end
    region={'crop':[0,0,1,1],'fit':'cover','position':[.5,.5],'scale':1,'background':'#0A1019'}
    return {'schema':1,'canvas':{'width':WIDTH,'height':HEIGHT,'fps':FPS},'audio':'preserve',
            'top':{**copy.deepcopy(region),'box':[0,0,1,.5],'fit':'contain'},
            'bottom':{**copy.deepcopy(region),'box':[0,.5,1,.5],'position':[.5,0]},
            'graphics':[{'text':text,'start':start,'end':end,'enter':.45,'exit':.4,
                         'foreground':'#F3F8FA','accent':'#84F5C1'}]}


def _number(v,label,low,high):
    if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not low<=v<=high:
        raise ValueError('Invalid split-screen '+label)
    return v


def validate_spec(spec,duration):
    if not isinstance(spec,dict) or set(spec)!={'schema','canvas','audio','top','bottom','graphics'}:
        raise ValueError('Invalid split-screen fields')
    spec=copy.deepcopy(spec)
    if spec['schema']!=1 or spec['canvas']!={'width':WIDTH,'height':HEIGHT,'fps':FPS} or spec['audio']!='preserve':
        raise ValueError('Split-screen requires 1080x1920, 30fps and preserved source audio')
    _number(duration,'duration',.2,180)
    for name in ('top','bottom'):
        r=spec[name]
        if not isinstance(r,dict) or set(r)!={'box','crop','fit','position','scale','background'}:
            raise ValueError('Invalid split-screen region fields')
        for key,length in [('box',4),('crop',4),('position',2)]:
            if not isinstance(r[key],list) or len(r[key])!=length:raise ValueError('Invalid region '+key)
            for v in r[key]:_number(v,key,0,1)
        x,y,w,h=r['box'];l,t,right,b=r['crop']
        if w<.02 or h<.02 or x+w>1.000001 or y+h>1.000001 or not l<right or not t<b:
            raise ValueError('Region box/crop is empty or outside canvas')
        if right-l<.005 or b-t<.005:raise ValueError('Region crop is too thin to decode safely')
        if name=='top' and y+h>.500001 or name=='bottom' and y<.5:
            raise ValueError('Split-screen regions must stay in their respective halves')
        if r['fit'] not in ('cover','contain'):raise ValueError('Invalid region fit')
        _number(r['scale'],'scale',.25,4)
        if not isinstance(r['background'],str) or not re.fullmatch('#[0-9A-Fa-f]{6}',r['background']):raise ValueError('Invalid region background')
    if not isinstance(spec['graphics'],list) or not 1<=len(spec['graphics'])<=8:raise ValueError('Use 1..8 graphics')
    for g in spec['graphics']:
        if not isinstance(g,dict) or set(g)!={'text','start','end','enter','exit','foreground','accent'}:
            raise ValueError('Invalid graphic fields')
        if not isinstance(g['text'],str) or len(g['text'])>256 or any(ord(c)<32 and c not in '\r\n\t' for c in g['text']):
            raise ValueError('Graphic text must be 1..64 printable characters')
        g['text']=' '.join(g['text'].split())
        if not g['text'] or len(g['text'])>64:
            raise ValueError('Graphic text must be 1..64 printable characters')
        a=_number(g['start'],'graphic start',0,duration);b=_number(g['end'],'graphic end',0,duration)
        enter=_number(g['enter'],'enter',.05,2);leave=_number(g['exit'],'exit',.05,2)
        if b-a<enter+leave:raise ValueError('Graphic timing must include entry and exit')
        for key in ('foreground','accent'):
            if not isinstance(g[key],str) or not re.fullmatch('#[0-9A-Fa-f]{6}',g[key]):raise ValueError('Invalid graphic color')
    return copy.deepcopy(spec)


def _font(size):
    for name in ['/System/Library/Fonts/Supplemental/Arial Bold.ttf','DejaVuSans-Bold.ttf']:
        try:return ImageFont.truetype(name,size)
        except OSError:pass
    raise RuntimeError('A TrueType sans-serif font is required for split-screen typography')


def _card(path,g):
    im=Image.new('RGBA',(WIDTH,HEIGHT//2));d=ImageDraw.Draw(im)
    words=g['text'].upper().split();first=words[0] if len(words)>1 else g['text'].upper()
    second=' '.join(words[1:]) if len(words)>1 else ''
    def centered(text,y,size,color):
        font=_font(size)
        while d.textbbox((0,0),text,font=font)[2]>880 and size>24:size-=2;font=_font(size)
        box=d.textbbox((0,0),text,font=font)
        d.text(((WIDTH-(box[2]-box[0]))/2,y-box[1]),text,font=font,fill=color)
    d.rounded_rectangle((488,216,592,222),radius=3,fill=g['accent'])
    centered(first,294,280,g['foreground'])
    if second:centered(second,574,108,g['accent'])
    accent=tuple(int(g['accent'][i:i+2],16) for i in (1,3,5))
    d.line((190,752,890,752),fill=(*accent,70),width=2)
    for x in (190,890):d.ellipse((x-4,748,x+4,756),fill=g['accent'])
    im.save(path)


def _transform(label,region,target,alpha=False):
    x,y,w,h=region['box'];rw=max(2,round(w*WIDTH)//2*2);rh=max(2,round(h*HEIGHT)//2*2)
    l,t,r,b=region['crop'];px,py=region['position'];zoom=region['scale']
    factor='max' if region['fit']=='cover' else 'min'
    fit=f'{zoom}*{factor}({rw}/iw,{rh}/ih)'
    color='0x00000000' if alpha else region['background'].replace('#','0x')
    aspect=(f"crop=w='max(2,trunc(min(iw,ih*{rw/rh})/2)*2)':"
            f"h='max(2,trunc(min(ih,iw*{rh/rw})/2)*2)':x='(iw-ow)*{px}':y='(ih-oh)*{py}',") if region['fit']=='cover' else ''
    return (f'{label}format=rgba,scale=w=trunc(iw*sar/2)*2:h=ih,setsar=1,'
            f'crop=w=iw*{r-l}:h=ih*{b-t}:x=iw*{l}:y=ih*{t},'+aspect+
            f"scale=w='max(2,trunc(iw*({fit})/2)*2)':h='max(2,trunc(ih*({fit})/2)*2)',"
            f"crop=w='min(iw,{rw})':h='min(ih,{rh})':x='max(0,iw-{rw})*{px}':y='max(0,ih-{rh})*{py}',"
            f"pad={rw}:{rh}:x='(ow-iw)*{px}':y='(oh-ih)*{py}':color={color}[{target}]"),rw,rh


def render_files(source,folder,spec):
    from frame_core import run,validate
    from media_assets import require_storage
    metadata=validate(source);duration=float(metadata['format']['duration'])
    spec=validate_spec(spec,duration)
    details=json.loads(__import__('subprocess').check_output(['ffprobe','-v','error','-show_streams','-of','json',str(source)]))
    video=next(s for s in details['streams'] if s['codec_type']=='video')
    from fractions import Fraction
    sar=float(Fraction(video.get('sample_aspect_ratio','1:1').replace(':','/'))) if video.get('sample_aspect_ratio','1:1')!='N/A' else 1
    if not .05<=sar<=20 or video['width']*video['height']*max(1,sar)>40_000_000:
        raise ValueError('Source display dimensions exceed split-screen decode budget')
    require_storage(folder.parent,int(duration*2_000_000)+32*1024**2)
    folder.mkdir(parents=True,exist_ok=True)
    base=Image.new('RGB',(WIDTH,HEIGHT),spec['bottom']['background']);d=ImageDraw.Draw(base)
    d.rectangle((0,0,WIDTH,HEIGHT//2),fill=spec['top']['background'])
    for x in range(60,WIDTH,80):
        for y in range(60,HEIGHT//2,80):d.ellipse((x,y,x+2,y+2),fill='#18232B')
    d.line((0,HEIGHT//2-1,WIDTH,HEIGHT//2-1),fill='#34433F',width=2)
    base.save(folder/'background.png')
    command=['ffmpeg','-y','-v','error','-i',str(source),'-loop','1','-framerate',str(FPS),'-i',str(folder/'background.png')]
    for i,g in enumerate(spec['graphics']):
        file=folder/f'graphic-{i}.png';_card(file,g)
        command+=['-loop','1','-framerate',str(FPS),'-i',str(file)]
    graph=['[1:v]split=2[bt][bb]','[bt]crop=1080:960:0:0[top0]','[bb]crop=1080:960:0:960[bottom0]']
    transform,_,_=_transform('[0:v]',spec['bottom'],'speaker');graph.append(transform)
    bx,by,_,_=spec['bottom']['box']
    graph.append(f'[bottom0][speaker]overlay=x={round(bx*WIDTH)}:y={round((by-.5)*HEIGHT)}:shortest=1:eof_action=endall[bottom]')
    for i,g in enumerate(spec['graphics']):
        transform,rw,rh=_transform(f'[{i+2}:v]',spec['top'],f'card{i}',True);graph.append(transform)
        ease=f"(1-pow(1-clip((t-{g['start']})/{g['enter']},0,1),3))"
        leave=f"clip((t-{g['end']-g['exit']})/{g['exit']},0,1)"
        scale=f'(.94+.06*{ease}-.02*{leave})'
        graph.append(f"[card{i}]scale=w='max(2,trunc(iw*{scale}/2)*2)':h='max(2,trunc(ih*{scale}/2)*2)':eval=frame,"
                     f"fade=t=in:st={g['start']}:d={g['enter']}:alpha=1,fade=t=out:st={g['end']-g['exit']}:d={g['exit']}:alpha=1[animated{i}]")
        tx,ty,_,_=spec['top']['box']
        graph.append(f"[top{i}][animated{i}]overlay=x='{tx*WIDTH}+({rw}-overlay_w)/2':"
                     f"y='{ty*HEIGHT}+({rh}-overlay_h)/2+54*(1-{ease})-32*{leave}':"
                     f"enable='gte(t,{g['start']})*lt(t,{g['end']})':shortest=1:eof_action=endall[top{i+1}]")
    graph.append(f"[top{len(spec['graphics'])}][bottom]vstack=inputs=2:shortest=1,format=yuv420p[composed]")
    # Keep the source track untouched whenever it can be carried in MP4.
    audio=next(s for s in details['streams'] if s['codec_type']=='audio')
    mode='copy' if audio['codec_name']=='aac' else 'aac_transcode'
    options=['-c:a','copy'] if mode=='copy' else ['-c:a','aac','-b:a','192k']
    final=folder/'final.mp4';preview=folder/'preview.mp4'
    run(*(command+['-filter_complex_threads','1','-filter_complex',';'.join(graph),'-map','[composed]','-map','0:a:0',
                   '-c:v','libx264','-preset','veryfast','-crf','20','-r',str(FPS),'-threads','4']+options+
          ['-t',str(duration),'-movflags','+faststart',str(final)]))
    run('ffmpeg','-y','-v','error','-i',str(final),'-vf','scale=540:960','-c:v','libx264','-preset','veryfast',
        '-crf','24','-threads','2','-c:a','copy','-movflags','+faststart',str(preview))
    for file in (final,preview):
        info=validate(file)
        if abs(float(info['format']['duration'])-duration)>1/FPS+.025:raise RuntimeError('Split-screen changed source duration')
    return {'final':final,'preview':preview,'audio_mode':mode,'spec':spec}


def checkpoint(project,data,source,parent,phase,identity,spec,instruction,pre_publish=None):
    """Publish only after both real videos validate; leave every prior checkpoint intact."""
    from frame_core import save,validate
    from reference_media import check_guard
    from cancellation import check
    folder=project/f'split-{identity}';final=project/f'v{phase}-{identity}.mp4';preview=project/f'preview-{identity}.mp4'
    from media_assets import digest_file
    before=digest_file(source)
    try:
        result=render_files(source,folder,spec);check();check_guard(project)
        if digest_file(source)!=before:raise ValueError('Source changed during split-screen composition')
        if pre_publish:pre_publish()
        result['final'].replace(final);result['preview'].replace(preview)
        info=validate(final)
        item={'id':identity,'phase':phase,'name':'split_screen','parent':parent,'file':final.name,
              'preview_file':preview.name,'caption':None,'instruction':instruction,'split_screen':result['spec'],
              'duration':float(info['format']['duration']),'bytes':final.stat().st_size,
              'audio_mode':result['audio_mode'],'source_sha256':before,
              'created_at':datetime.now(timezone.utc).isoformat()}
        data['checkpoints'].append(item);data['active']=identity
        save(project,data)
        return item
    except Exception:
        # New, unpublished outputs only. Never touch existing project media/checkpoints.
        final.unlink(missing_ok=True);preview.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(folder,ignore_errors=True)
