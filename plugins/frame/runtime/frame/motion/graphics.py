"""Render generated scene-graph data using trusted primitives, never model code."""
import math
from PIL import Image,ImageDraw
from engine import font,ease,paste_center
from voice_graphics import accent_strength,motion_time

def draw_generated(renderer,frame,scene):
    W,H=renderer.w,renderer.h;spec=renderer.spec;b=scene['graphic'];accent=spec['accent'];paper=spec['paper'];ink=spec['ink']
    imp=b['importance'];energy=b['energy'];absolute_time=frame/30;t=(frame-scene['start_frame'])/30
    policy=scene.get('visual_delivery')
    clock=motion_time(policy,absolute_time) if policy else t
    entrance=policy['entrance_seconds'] if policy else .45-.27*energy
    amplitude=policy['motion_amplitude'] if policy else energy
    slots=policy['motion_slots'] if policy else len(b['nodes'])
    node_anchors=policy.get('node_anchors',[]) if policy else []
    focus_frame=next((cue['peak_frame'] for cue in policy['accents']
                      if cue['word_index']==b['focus_word']),None) if policy else scene['words'][b['focus_word']]['frame']
    ft=(frame-focus_frame)/30 if focus_frame is not None else -1
    enter=ease(clock/entrance)
    # The visual apex is the selected spoken-word frame, not the end of an
    # entrance that starts at that frame. Text then remains readable at rest.
    focus_accent=accent_strength(policy,absolute_time) if policy else max(0,1-ft/.3)
    if frame==focus_frame:focus_accent=1
    im=Image.new('RGBA',(W,H),ink);d=ImageDraw.Draw(im);unit=min(W,H)
    # A generated composition has a consistent title, focal word, diagram and captions.
    headline=renderer.txt(b['headline'],W*.86,H*.075,paper,'condensed')
    paste_center(im,headline,W*.5,H*.09,alpha=enter*.85)
    if ft>=0:
        hero=renderer.txt(scene['words'][b['focus_word']]['text'],W*.86,H*(.14+.17*imp),paper)
        maximum_overshoot=.025 if b['motion']=='settle' else .12*amplitude
        overshoot=focus_accent*maximum_overshoot
        # Fit the *largest animated box*, including font padding, between the
        # headline and cue. Short high-priority words must not overrun either.
        base_scale=min(1.,W*.86/(hero.width*(1+maximum_overshoot)),
                       H*.21/(hero.height*(1+maximum_overshoot)))
        scale=base_scale*(1+overshoot)
        paste_center(im,hero,W*.5,H*.25,scale,scale,1)
        # Attention cue lands on the selected spoken word; importance controls its width.
        width=W*(.12+.50*imp)
        d=ImageDraw.Draw(im);d.rounded_rectangle((W*.5-width/2,H*.375,W*.5+width/2,H*.375+max(3,unit*.006)),radius=2,fill=accent)
    # Shared diagram safe area, separately adapted for portrait and landscape.
    left,top,dw,dh=W*.06,H*.45,W*.88,H*.35
    nodes=b['nodes'];positions=[]
    ranked=sorted(range(len(nodes)),key=lambda j:(
        not (j<len(node_anchors) and node_anchors[j]==b['focus_word']),
        nodes[j]['color']!='accent',j))
    lively=set(ranked[:slots])
    for j,node in enumerate(nodes):
        word_index=node_anchors[j] if j<len(node_anchors) else None
        if word_index is not None:
            # Full visibility lands exactly on the associated word. Do not give
            # an unspoken label a guessed acoustic timestamp.
            word_start=policy['words'][word_index]['start']
            word_frame=math.ceil(word_start*30-1e-8) if word_start is not None else scene['words'][word_index]['frame']
            p=1.0 if frame>=word_frame else 0.0
        else:
            nt=max(0,clock-j*.055);p=ease(nt/entrance)
        x=left+node['x']*dw;y=top+node['y']*dh
        if node['motion']=='rise' and j in lively:y+=(1-p)*dh*.12*amplitude
        if b['motion']=='flow' and j in lively:y+=math.sin(clock*1.2+j)*dh*.016*amplitude
        scale=(.92+.08*p)
        if node['motion']=='pulse' and j in lively:scale+=.025*amplitude*math.sin(clock*3+j)
        w,h=node['w']*dw*scale,node['h']*dh*scale
        if node['shape'] in ['circle','ring']:
            w=h=min(w,h)
            if len(nodes)==1:w=h=min(dw*.4,dh*(.55+.25*imp))*scale
        x=min(left+dw-w/2,max(left+w/2,x));y=min(top+dh-h/2,max(top+h/2,y))
        positions.append((x,y,w,h,p))
    for edge in b['edges']:
        x1,y1,_,_,p1=positions[edge['from']];x2,y2,tw,th,p2=positions[edge['to']]
        if min(p1,p2)<=0:continue
        dx,dy=x2-x1,y2-y1;length=max(1,math.hypot(dx,dy));ux,uy=dx/length,dy/length
        reach=min(tw/2/max(abs(ux),1e-6),th/2/max(abs(uy),1e-6))+4
        target_x,target_y=x2-ux*reach,y2-uy*reach
        prog=min(p1,p2,ease(clock/max(.3,entrance)));ex=x1+(target_x-x1)*prog;ey=y1+(target_y-y1)*prog
        d.line((x1,y1,ex,ey),fill='#7b817a',width=max(2,int(unit*.003)))
        if prog>.9:
            size=unit*.012
            d.polygon([(ex,ey),(ex-ux*size-uy*size*.5,ey-uy*size+ux*size*.5),(ex-ux*size+uy*size*.5,ey-uy*size-ux*size*.5)],fill=paper)
        if edge['label']:
            label=renderer.txt(edge['label'],dw*.18,dh*.08,paper,'condensed')
            # Backplate ensures labels remain readable over connector lines.
            midx,midy=(x1+x2)/2,(y1+y2)/2-dh*.07
            d.rectangle((midx-label.width/2-4,midy-label.height/2-2,midx+label.width/2+4,midy+label.height/2+2),fill=ink)
            paste_center(im,label,midx,midy,alpha=prog)
    for node,(x,y,w,h,p) in zip(nodes,positions):
        color={'accent':accent,'paper':paper,'muted':'#414a44'}[node['color']]
        fg=ink if node['color']=='paper' else paper
        node_im=Image.new('RGBA',(W,H));nd=ImageDraw.Draw(node_im);box=(x-w/2,y-h/2,x+w/2,y+h/2)
        if node['shape']=='box':nd.rounded_rectangle(box,radius=min(w,h)*.16,fill=color)
        elif node['shape']=='circle':nd.ellipse(box,fill=color)
        elif node['shape']=='diamond':nd.polygon([(x,y-h/2),(x+w/2,y),(x,y+h/2),(x-w/2,y)],fill=color)
        elif node['shape']=='ring':
            if node['motion']=='draw':nd.arc(box,-90,-90+360*p,fill=color,width=max(3,int(unit*.008)))
            else:nd.ellipse(box,outline=color,width=max(3,int(unit*.008)))
            fg=paper
        else:fg=color
        factor=.62 if node['shape'] in ['circle','diamond','ring'] else .83
        label=renderer.txt(node['label'],max(16,w*factor),max(12,h*.58),fg,'condensed')
        paste_center(node_im,label,x,y)
        if p<1:node_im.putalpha(node_im.getchannel('A').point(lambda a:int(a*p)))
        im=Image.alpha_composite(im,node_im);d=ImageDraw.Draw(im)
    visible=[w['text'] for w in scene['words'] if frame>=w['frame']]
    # Keep the spoken caption at a readable size as longer scenes progress.
    caption=renderer.txt(' '.join(visible[-8:]),W*.88,H*.078,paper,'condensed')
    paste_center(im,caption,W*.5,H*.91,alpha=.80)
    d=ImageDraw.Draw(im);d.line((W*.06,H*.97,W*.94,H*.97),fill='#323a33',width=1)
    d.line((W*.06,H*.97,W*.06+W*.88*(frame+1)/spec['frames'],H*.97),fill=accent,width=3)
    # Grain follows the same decorative clock so a silent hold is actually still.
    texture_frame=round(clock*30) if policy else frame
    im=Image.alpha_composite(im,renderer.textures[texture_frame%4])
    return im.convert('RGB')
