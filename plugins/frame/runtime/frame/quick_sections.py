"""Ordered source-anchored review notes over the existing revision transaction."""
import copy
import re
import threading
import time
import uuid
import quick_timeline as timeline
import quick_revision as revision

ACTIONS={'add_note','add_annotation','edit_note','remove_note','keep_note','apply_notes','restore_checkpoint','manual_range_edit'}


def initialize(doc):
    changed=False
    for key,value in {'notes':[],'active_revision_set_id':uuid.uuid4().hex,'checkpoints':[]}.items():
        if key not in doc:doc[key]=value;changed=True
    if not doc['checkpoints']:
        root=doc['clips'][0].get('origin_id',doc['clips'][0]['id']) if doc['clips'] else uuid.uuid4().hex
        doc['checkpoints'].append({'id':'source','parent_id':None,'label':'Original upload','created_at':doc.get('saved_at',time.time()),
            'clips':[{'id':root,'start':0,'end':int(doc['source_duration']*30+1e-6)/30}],
            'rendered':None,'accepted_edits':[]})
        if doc.get('rendered'):
            checkpoint(doc,'Existing saved result')
        else:doc['current_checkpoint_id']='source'
        changed=True
    return changed


def checkpoint(doc,label,identifier=None):
    cid=identifier or uuid.uuid4().hex
    doc['checkpoints'].append({'id':cid,'parent_id':doc.get('current_checkpoint_id','source'),
        'label':label,'created_at':time.time(),'clips':copy.deepcopy(doc['clips']),
        'rendered':copy.deepcopy(doc['rendered']),'accepted_edits':copy.deepcopy(doc['accepted_edits'])})
    doc['current_checkpoint_id']=cid
    return cid


def section(doc,sid):
    pin=next((p for p in doc['pins'] if p['id']==sid),None)
    if not pin:raise ValueError('Select an existing section with start/end pins.')
    revision.bounds(doc,pin)
    return pin


def act(app,pid,body):
    action=body.get('action')
    with timeline.LOCK:
        doc=timeline.load(app,pid)
        # A repeated request token resumes exactly the original frozen set, even after completion.
        if action=='apply_notes':
            token=body.get('request_id','')
            if not isinstance(token,str) or not re.fullmatch('[a-zA-Z0-9_-]{8,80}',token):raise ValueError('Supply a stable request_id to apply this revision set.')
            if any(p.get('request_id')==token for p in doc['proposals']):return timeline.public(doc)
        if type(body.get('expected_version')) is not int or body['expected_version']!=doc['version']:
            raise timeline.Conflict('Revision changed. Reload the note list before applying.')
        if action=='manual_range_edit':
            pin=section(doc,body.get('section_id'));a,b=revision.bounds(doc,pin)
            before=copy.deepcopy(doc['clips'])
            if body.get('operation')=='cut':
                doc=revision.candidate(doc,{'operation':'delete_range','clip_id':pin['clip_id'],'range_start':a,'range_end':b})
            elif body.get('operation')=='keep':
                a,b=round(a*30)/30,round(b*30)/30
                doc['clips']=[dict(c,start=max(a,c['start']),end=min(b,c['end'])) for c in doc['clips'] if c.get('origin_id',c['id'])==pin['clip_id'] and min(b,c['end'])>max(a,c['start'])]
                timeline.validate(doc)
                if not doc['clips']:raise ValueError('This section is no longer retained.')
            else:raise ValueError('Use Cut section or Keep section.')
            if doc['clips']==before:raise ValueError('This section already matches the current edit.')
            doc['undo']=(doc['undo']+[before])[-100:];doc['redo']=[];doc['version']+=1
            doc['accepted_edits'].append({'id':uuid.uuid4().hex,'provider':'manual','operation':body['operation']+'_section','source_start':a,'source_end':b,'accepted_at':time.time()})
            revision.persist(app,pid,doc);return timeline.public(doc)
        if action=='restore_checkpoint':
            target=next((c for c in doc['checkpoints'] if c['id']==body.get('checkpoint_id')),None)
            if not target:raise ValueError('Saved version not found.')
            if any(p['status'] in ('planning','rendering') for p in doc['proposals']):raise ValueError('Wait for the current proposal or render before restoring.')
            doc['undo']=(doc['undo']+[copy.deepcopy(doc['clips'])])[-100:];doc['redo']=[]
            doc['clips']=copy.deepcopy(target['clips']);doc['rendered']=copy.deepcopy(target['rendered'])
            # Preserve the complete accepted-operation journal and every playable checkpoint.
            doc['current_checkpoint_id']=target['id'];doc['version']+=1
            revision.persist(app,pid,doc);return timeline.public(doc)
        if action in ('add_note','add_annotation'):
            if len(doc['notes'])>=300:raise ValueError('Maximum 300 review notes per project.')
            text=body.get('instruction','')
            validate_text(text)
            annotations=None
            if action=='add_annotation':
                import quick_markup
                pin,anchor,annotations=quick_markup.prepare(doc,body)
            else:
                pin=section(doc,body.get('section_id'));a,b=revision.bounds(doc,pin)
                anchor=timeline.number(body.get('source_time_ms'))
                if int(anchor)!=anchor or not a*1000<=anchor<b*1000:raise ValueError('The note playhead must be inside the section (end excluded).')
            note={'id':uuid.uuid4().hex,'project_id':pid,'section_id':pin['id'],
                  'revision_set_id':doc['active_revision_set_id'],'source_time_ms':int(anchor),
                  'base_version_id':doc.get('current_checkpoint_id','source'),
                  'output_time_ms':body.get('output_time_ms') if type(body.get('output_time_ms')) is int else None,
                  'order':max((n['order'] for n in doc['notes']),default=0)+1,'created_at':time.time(),
                  'status':'queued','included':True}
            note['instruction']=text
            if annotations is not None:note['annotations']=annotations
            doc['notes'].append(note)
        elif action in ('edit_note','remove_note','keep_note'):
            note=next((n for n in doc['notes'] if n['id']==body.get('note_id')),None)
            if not note:raise ValueError('Review note not found.')
            if any(note['id'] in [n['id'] for n in p.get('frozen_notes',[])] and p['status'] in ('planning','rendering') for p in doc['proposals']):
                raise ValueError('This note is in an active frozen revision set. Wait for it to finish.')
            if action=='edit_note':validate_text(body.get('instruction'));note['instruction']=body['instruction']
            note.update(included=action!='remove_note',status='removed' if action=='remove_note' else 'queued',revision_set_id=doc['active_revision_set_id'])
            note.pop('error',None)
        elif action=='apply_notes':
            if any(p['status'] in ('planning','rendering') for p in doc['proposals']):raise ValueError('A revision set is already being planned or rendered.')
            notes=sorted((copy.deepcopy(n) for n in doc['notes'] if n['included'] and n['status'] in ('queued','unsupported','failed')),key=lambda n:n['order'])
            if not notes:raise ValueError('Add or keep at least one queued revision note.')
            if len(notes)>20:raise ValueError('Apply at most 20 notes in one set.')
            for n in notes:section(doc,n['section_id'])
            proposal={'id':uuid.uuid4().hex,'base_version':doc['version'],'status':'planning','created_at':time.time(),
                      'request_id':token,'revision_set_id':doc['active_revision_set_id'],'frozen_notes':notes,
                      'note_results':[],'base_checkpoint_id':doc.get('current_checkpoint_id','source')}
            doc['proposals'].append(proposal);revision.persist(app,pid,doc)
            threading.Thread(target=plan_set,args=(app,pid,copy.deepcopy(doc),proposal['id']),daemon=True).start()
            return timeline.public(doc)
        else:raise ValueError('Unsupported note action.')
        doc['version']+=1;revision.persist(app,pid,doc);return timeline.public(doc)


def validate_text(text):
    if not isinstance(text,str) or not text.strip() or len(text)>2000:raise ValueError('Write a revision note using 1–2000 characters.')


def overlapping(a,b):
    return a['clip_id']==b['clip_id'] and min(a['range_end'],b['range_end'])>max(a['range_start'],b['range_start'])


def plan_set(app,pid,snapshot,proposal_id):
    frozen=next(p for p in snapshot['proposals'] if p['id']==proposal_id)
    operations=[];results=[]
    try:
        for n in frozen['frozen_notes']:
            pin=copy.deepcopy(section(snapshot,n['section_id']))
            pin.update(instruction=n['instruction'],note_source_time_ms=n['source_time_ms'])
            try:
                operation=revision.interpret(snapshot,pin)
                duplicate=False
                for prior in operations:
                    if not overlapping(prior,operation):continue
                    if prior['operation']==operation['operation']=='position_clip' and prior['x']==operation['x'] and prior['y']==operation['y']:
                        if (prior['range_start'],prior['range_end'])==(operation['range_start'],operation['range_end']):duplicate=True
                        continue
                    raise ValueError('Conflicting notes target overlapping footage. Adjust or remove one note before applying; no render was started.')
                if not duplicate:operations.append(operation)
                results.append({'note_id':n['id'],'status':'supported','operation':operation,
                                'message':'Same operation as an earlier note; shared in the combined render.' if duplicate else operation['message']})
            except revision.Unsupported as exc:
                results.append({'note_id':n['id'],'status':'unsupported','message':str(exc)})
            with timeline.LOCK:
                doc=timeline.load(app,pid);p=next(p for p in doc['proposals'] if p['id']==proposal_id)
                p['note_results']=copy.deepcopy(results);revision.persist(app,pid,doc)
        if not operations:raise ValueError('None of these notes can be executed. Review the unsupported explanations; no video was changed.')
        operation={'operation':'batch','operations':operations,'provider':'claude',
                   'message':'One render for the supported notes, in creation order. Unsupported notes remain visible and unchanged.'}
        revision.candidate(snapshot,operation)
        result={'status':'pending','operation':operation,'note_results':results,
                'warning':'Transcript is unavailable for this review flow. Cuts may remove speech or context; inspect exact source intervals before approval.'}
    except Exception as exc:result={'status':'failed','error':str(exc)[-1200:],'note_results':results}
    with timeline.LOCK:
        doc=timeline.load(app,pid);p=next(p for p in doc['proposals'] if p['id']==proposal_id);p.update(result)
        for n in doc['notes']:
            r=next((r for r in results if r['note_id']==n['id']),None)
            if r and r['status']=='unsupported':n.update(status='unsupported',error=r['message'])
        revision.persist(app,pid,doc)


def mark_applied(doc,proposal):
    for n in doc['notes']:
        result=next((r for r in proposal.get('note_results',[]) if r['note_id']==n['id']),None)
        if result:
            n.update(status='applied' if result['status']=='supported' else 'unsupported',applied_checkpoint_id=proposal['id'])
            if result['status']=='unsupported':n['error']=result['message']
    if 'frozen_notes' in proposal:doc['active_revision_set_id']=uuid.uuid4().hex
