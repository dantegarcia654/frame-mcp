"""Versioned non-destructive edits over existing uploads and FFmpeg renderer."""
import copy
import json
import math
import re
import threading
import time
import uuid
from pathlib import Path
from editor import probe, render_timeline, detect_silence, trim_pauses

LOCK = threading.RLock()
ID = r'[a-f0-9]{32}'
OPERATIONS = ['get_project', 'get_timeline', 'split_clip', 'trim_clip', 'delete_segment',
              'move_segment', 'position_clip', 'undo', 'redo', 'export_video', 'tighten_pacing']

class Conflict(ValueError):
    pass

def write(path, data):
    if path.name == 'timeline.json':
        data['saved_at'] = time.time()
        data['source_reference'] = '/media/'+data['project_id']+'/input.mp4'
    temp = path.with_suffix('.tmp')
    with temp.open('w') as f:
        json.dump(data, f, allow_nan=False, indent=2)
        f.flush()
        import os
        os.fsync(f.fileno())
    temp.replace(path)
    import os
    fd = os.open(str(path.parent), os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def clip(a, b):
    return {'id': uuid.uuid4().hex, 'start': a, 'end': b}

def number(v):
    if isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v):
        raise ValueError('Use a finite number for time and position.')
    return float(v)

def load(app, pid):
    data = app.project(pid)  # validates identifier and source existence
    path = app.WORK / pid / 'timeline.json'
    if path.exists():
        doc = json.loads(path.read_text())
        if 'revision_id' not in doc:
            doc.update(revision_id=uuid.uuid4().hex, pins=[], accepted_edits=[], proposals=[], rendered=None)
            write(path, doc)
        import quick_sections
        if quick_sections.initialize(doc): write(path,doc)
        return doc
    info = probe(app.WORK / pid / 'input.mp4')
    segments = data.get('current_segments') or [[0, info['duration']]]
    doc = {'project_id': pid, 'name': data['name'], 'version': 1, 'source_duration': info['duration'],
           'revision_id': uuid.uuid4().hex, 'pins': [], 'accepted_edits': [], 'proposals': [], 'rendered': None,
           'audio': info['audio'], 'clips': [clip(round(a*30)/30, min(round(b*30),math.floor(info['duration']*30+1e-6))/30) for a,b in segments], 'undo': [], 'redo': [], 'exports': []}
    import quick_sections
    quick_sections.initialize(doc)
    write(path, doc)
    return doc

def public(doc):
    return {k: copy.deepcopy(v) for k,v in doc.items() if k not in ('undo','redo')} | {
        'duration': sum(c['end']-c['start'] for c in doc['clips']),
        'can_undo': bool(doc['undo']), 'can_redo': bool(doc['redo']),
        'source_url': '/media/'+doc['project_id']+'/input.mp4'}

def validate(doc):
    if len(doc['clips']) > 48:
        raise ValueError('Maximum 48 segments per project.')
    for c in doc['clips']:
        for axis in ('x','y'):
            value=number(c.get(axis,0))
            if abs(value)>.5:raise ValueError('Keep asset position within 50% of the frame.')
        a,b=number(c['start']),number(c['end'])
        if a < 0 or b > doc['source_duration']+.00001:
            raise ValueError('Trim times must stay inside the source.')
        a,b=round(a*30)/30,min(round(b*30),math.floor(doc['source_duration']*30+1e-6))/30
        c.update(start=a,end=b)
        if a<0 or b>doc['source_duration']+.00001 or b-a<1/30-1e-7:
            raise ValueError('Keep at least one 30 fps frame, inside the original source.')

def execute(app, pid, op, args):
    regions = []
    if op == 'tighten_pacing' and args.get('remove_pauses', True):
        with LOCK:
            initial = load(app, pid)
            if args.get('expected_version') != initial['version']:
                raise Conflict('Timeline changed. Reload before measuring pauses.')
        # Audio analysis must not block other projects or timeline reads.
        if initial['audio']:
            regions = detect_silence(app.WORK / pid / 'input.mp4')
    with LOCK:
        doc=load(app,pid)
        if op in ('get_project','get_timeline'):
            return public(doc)
        expected=args.get('expected_version')
        if isinstance(expected,bool) or not isinstance(expected,int) or expected != doc['version']:
            raise Conflict('Timeline changed. Reload and retry with its current expected_version.')
        if op=='export_video':
            if not doc['clips']: raise ValueError('Add a segment before exporting.')
            if sum(e['status']=='working' for e in doc['exports']) >= 2:
                raise ValueError('Two exports are already queued; wait for one to finish.')
            eid=uuid.uuid4().hex
            exp={'id':eid,'timeline_version':doc['version'],'status':'working','created':time.time(),
                 'duration':sum(c['end']-c['start'] for c in doc['clips']),
                 'url':'/media/'+pid+'/versions/'+eid+'/edited.mp4'}
            doc['exports'].append(exp)
            write(app.WORK/pid/'timeline.json',doc)
            threading.Thread(target=export_worker,args=(app,pid,copy.deepcopy(doc),eid),daemon=True).start()
            return public(doc)
        before=copy.deepcopy(doc['clips'])
        if op in ('undo','redo'):
            source,target=('undo','redo') if op=='undo' else ('redo','undo')
            if not doc[source]: raise ValueError('Nothing to '+op+'.')
            doc[target].append(before)
            doc['clips']=doc[source].pop()
        else:
            if op in ('split_clip','trim_clip','delete_segment','move_segment','position_clip'):
                idx=next((i for i,c in enumerate(doc['clips']) if c['id']==args.get('clip_id')),None)
                if idx is None: raise ValueError('Select a current segment.')
                c=doc['clips'][idx]
                if op=='split_clip':
                    at=number(args.get('source_time'))
                    if not c['start']+.04 <= at <= c['end']-.04: raise ValueError('Split inside the selected clip, away from its edges.')
                    doc['clips'][idx:idx+1]=[dict(c,end=at,origin_id=c.get('origin_id',c['id'])),dict(c,id=uuid.uuid4().hex,start=at,origin_id=c.get('origin_id',c['id']))]
                elif op=='trim_clip':
                    a,b=number(args.get('start')),number(args.get('end'))
                    doc['clips'][idx]=dict(c,start=a,end=b)
                elif op=='position_clip':
                    doc['clips'][idx]=dict(c,x=number(args.get('x')),y=number(args.get('y')))
                elif op=='delete_segment':
                    doc['clips'].pop(idx)
                else:
                    pos=args.get('position')
                    if isinstance(pos,bool) or not isinstance(pos,int) or not 0<=pos<len(doc['clips']): raise ValueError('Invalid destination index.')
                    doc['clips'].insert(pos,doc['clips'].pop(idx))
            elif op=='tighten_pacing':
                # Explicit deterministic preset; energy-based silence, not language interpretation.
                cut=number(args.get('cut_first_seconds',0))
                if cut<0: raise ValueError('Opening cut must be nonnegative.')
                keep=[]
                for c in doc['clips']:
                    length=c['end']-c['start']
                    if cut>=length: cut-=length; continue
                    ranges=[[c['start']+cut,c['end']]];cut=0
                    if args.get('remove_pauses',True):ranges=trim_pauses(ranges,regions)
                    for i,(a,b) in enumerate(ranges):
                        keep.append(dict(c,id=c['id'] if i==0 else uuid.uuid4().hex,start=a,end=b))
                if not keep: raise ValueError('Opening cut would remove the entire timeline.')
                doc['clips']=keep
            else: raise ValueError('Unknown operation.')
            validate(doc)
            if before==doc['clips']: return public(doc)
            doc['undo']=(doc['undo']+[before])[-100:]
            doc['redo']=[]
        doc['version']+=1
        doc.setdefault('accepted_edits',[]).append({'id':uuid.uuid4().hex,'provider':'manual','operation':op,'arguments':{k:v for k,v in args.items() if k!='expected_version'},'timeline_version':doc['version'],'accepted_at':time.time()})
        validate(doc)
        write(app.WORK/pid/'timeline.json',doc)
        return public(doc)

def export_worker(app,pid,snapshot,eid):
    folder=app.WORK/pid/'versions'/eid
    try:
        folder.mkdir(parents=True)
        with app.WORKERS:
            duration=render_timeline(app.WORK/pid/'input.mp4',folder,[(c['start'],c['end']) for c in snapshot['clips']],snapshot['audio'],lambda _:None,positions=[(c.get('x',0),c.get('y',0)) for c in snapshot['clips']])
        result={'status':'done','measured_duration':duration}
    except Exception as exc:
        result={'status':'failed','error':str(exc)[-1200:]}
    with LOCK:
        doc=load(app,pid)
        exported=next(e for e in doc['exports'] if e['id']==eid);exported.update(result)
        if result['status']=='done' and doc['version']==snapshot['version']:
            doc['rendered']={'url':exported['url'],'duration':duration,'timeline_version':doc['version'],'proposal_id':eid,'clips':copy.deepcopy(snapshot['clips'])}
            import quick_sections
            quick_sections.checkpoint(doc,'Manual edit export',eid)
        write(app.WORK/pid/'timeline.json',doc)

def recover(app):
    for path in app.WORK.glob('*/timeline.json'):
        with LOCK:
            doc=json.loads(path.read_text())
            for exp in doc['exports']:
                if exp['status']=='working': exp.update(status='failed',error='Server restarted; export again. Your timeline is saved.')
            write(path,doc)

def route(handler, app, method):
    from urllib.parse import urlparse
    path=urlparse(handler.path).path
    if method=='GET' and path=='/api/quick/tools':
        handler.json(200,{'operations':OPERATIONS,'command_endpoint':'/api/quick/projects/{project_id}/commands',
                          'versioning':'Every mutation requires integer expected_version. Conflicts return 409.',
                          'timebase':'clip start/end/source_time use original-source seconds; move position is zero based.'})
        return True
    match=re.fullmatch('/api/quick/projects/('+ID+')(?:/(timeline|commands))?',path)
    if not match:return False
    try:
        if method=='GET' and match[2] in (None,'timeline'):
            with LOCK: result=public(load(app,match[1]))
        elif method=='POST' and match[2]=='commands':
            length=int(handler.headers.get('Content-Length','0'))
            if not 0<length<=16000: raise ValueError('Command must be 1–16000 bytes.')
            handler.connection.settimeout(20)
            body=json.loads(handler.rfile.read(length))
            if not isinstance(body,dict): raise ValueError('Expected a JSON command object.')
            result=execute(app,match[1],body.get('operation'),body)
        else: raise ValueError('Unsupported request.')
        handler.json(200,result)
    except Conflict as exc:handler.json(409,{'error':str(exc)})
    except (ValueError,FileNotFoundError,TypeError,KeyError) as exc:handler.json(400,{'error':str(exc)})
    return True
