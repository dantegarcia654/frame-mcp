"""Durability, approval boundaries, failed render rollback and stale commits."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
import quick_timeline as q
import quick_revision as r

class RevisionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.pid='b'*32;root=Path(self.temp.name);(root/self.pid).mkdir()
        self.app=types.SimpleNamespace(WORK=root,WORKERS=threading.Semaphore(1),project=lambda _: {'name':'Fixture','current_segments':None})
        mock=patch.object(q,'probe',return_value={'duration':14,'audio':True});mock.start();self.addCleanup(mock.stop)
        self.doc=q.load(self.app,self.pid);self.cid=self.doc['clips'][0]['id']
    def act(self,action,**args):
        self.doc=r.act(self.app,self.pid,dict(action=action,expected_version=self.doc['version'],**args));return self.doc
    @staticmethod
    def fake_render(source,folder,*args,**kwargs):
        (folder/'edited.mp4').write_bytes(b'unit-test-only; decoder is mocked')
        return 7
    def proposal(self):
        self.act('add_pin',time=3,clip_id=self.cid,instruction='Keep only source seconds 1 to 8')
        self.act('edit_pin',pin_id=self.doc['pins'][0]['id'],start=0,end=14)
        operation={'operation':'trim_clip','clip_id':self.cid,'start':1,'end':8,'x':0,'y':0,'message':'Keep 1–8 s'}
        with patch.object(r.threading,'Thread'):
            self.act('propose',pin_id=self.doc['pins'][0]['id'])
        d=q.load(self.app,self.pid);d['proposals'][-1].update(status='pending',operation=operation);r.persist(self.app,self.pid,d)
        self.doc=q.public(d);return d['proposals'][-1]
    def test_pins_edit_delete_and_stable_revision(self):
        rid=self.doc['revision_id']
        for t in [1,2,3]: self.act('add_pin',time=t,clip_id=self.cid)
        p=self.doc['pins'][0]['id'];self.act('edit_pin',pin_id=p,instruction='trim')
        self.assertEqual(q.load(self.app,self.pid)['pins'][0]['instruction'],'trim')
        self.act('delete_pin',pin_id=p);self.act('save')
        reloaded=q.load(self.app,self.pid)
        self.assertEqual(len(reloaded['pins']),2);self.assertEqual(reloaded['revision_id'],rid)
        self.assertEqual(reloaded['project_id'],self.pid);self.assertGreater(reloaded['saved_at'],0)
    def test_invalid_pin_and_stale_edit_preserve_file(self):
        path=self.app.WORK/self.pid/'timeline.json';before=path.read_bytes()
        for t in [-1,float('nan'),True,15]:
            with self.assertRaises(ValueError):self.act('add_pin',time=t,clip_id=self.cid)
        self.assertEqual(path.read_bytes(),before)
        with self.assertRaises(q.Conflict):r.act(self.app,self.pid,{'action':'add_pin','expected_version':0})
    def test_propose_does_not_apply_and_stale_approval_rejected(self):
        p=self.proposal();self.assertEqual(self.doc['clips'][0]['start'],0)
        self.assertEqual(self.doc['accepted_edits'],[])
        self.act('edit_pin',pin_id=self.doc['pins'][0]['id'],instruction='different')
        with self.assertRaises(q.Conflict):self.act('approve',proposal_id=p['id'])
    def test_reject_never_renders(self):
        p=self.proposal()
        with patch.object(r,'render_timeline') as render:self.act('reject',proposal_id=p['id'])
        render.assert_not_called();self.assertEqual(q.load(self.app,self.pid)['accepted_edits'],[])
    def test_success_atomically_commits_same_revision_with_latest_pins(self):
        p=self.proposal();before=q.load(self.app,self.pid);snapshot=r.candidate(before,p['operation'])
        with patch.object(r,'render_timeline',side_effect=self.fake_render),patch.object(r.subprocess,'run'):
            r.render_worker(self.app,self.pid,snapshot,p)
        d=q.load(self.app,self.pid);self.assertEqual(d['revision_id'],before['revision_id'])
        self.assertEqual(d['pins'],before['pins']);self.assertEqual(d['clips'][0]['start'],1)
        self.assertEqual(len(d['accepted_edits']),1);self.assertEqual(d['rendered']['duration'],7)
        r.recover(self.app);self.assertEqual(q.load(self.app,self.pid),d)
    def test_failed_render_preserves_previous_working_revision(self):
        p=self.proposal();d=q.load(self.app,self.pid);d['rendered']={'url':'previous.mp4'};r.persist(self.app,self.pid,d)
        with patch.object(r,'render_timeline',side_effect=RuntimeError('encoder failed')):
            r.render_worker(self.app,self.pid,r.candidate(d,p['operation']),p)
        after=q.load(self.app,self.pid)
        for key in ['revision_id','version','clips','pins','accepted_edits','rendered']:self.assertEqual(after[key],d[key])
        self.assertEqual(after['proposals'][-1]['status'],'failed')
    def test_decode_failure_prevents_commit(self):
        p=self.proposal();before=q.load(self.app,self.pid)
        with patch.object(r,'render_timeline',side_effect=self.fake_render),patch.object(r.subprocess,'run',side_effect=RuntimeError('bad decode')):
            r.render_worker(self.app,self.pid,r.candidate(before,p['operation']),p)
        self.assertEqual(q.load(self.app,self.pid)['clips'],before['clips'])
        self.assertIsNone(q.load(self.app,self.pid)['rendered'])
    def test_edit_during_render_cannot_overwrite_new_changes(self):
        p=self.proposal();snapshot=r.candidate(q.load(self.app,self.pid),p['operation'])
        self.act('edit_pin',pin_id=self.doc['pins'][0]['id'],instruction='new instruction')
        with patch.object(r,'render_timeline',side_effect=self.fake_render),patch.object(r.subprocess,'run'):
            r.render_worker(self.app,self.pid,snapshot,p)
        d=q.load(self.app,self.pid);self.assertEqual(d['pins'][0]['instruction'],'new instruction')
        self.assertEqual(d['accepted_edits'],[]);self.assertEqual(d['clips'][0]['start'],0)
    def test_restart_marks_interrupted_jobs_failed(self):
        p=self.proposal();d=q.load(self.app,self.pid);d['proposals'][-1]['status']='rendering';r.persist(self.app,self.pid,d)
        r.recover(self.app);d=q.load(self.app,self.pid)
        self.assertEqual(d['proposals'][-1]['status'],'failed');self.assertEqual(d['clips'][0]['start'],0)
    def test_allowlist_and_numeric_validation(self):
        for change in [{'operation':'eval'},{'start':-1},{'start':float('nan')},{'end':20},{'operation':'position_clip','x':.6},{'operation':'position_clip','x':True}]:
            p=dict(operation='trim_clip',clip_id=self.cid,start=1,end=8,x=0,y=0);p.update(change)
            with self.assertRaises(ValueError):r.candidate(self.doc,p)
    def test_canvas_drag_only_proposes_and_requires_approval(self):
        self.act('add_pin',time=2,clip_id=self.cid)
        pin=self.doc['pins'][0]
        self.act('edit_pin',pin_id=pin['id'],start=2,end=4)
        self.act('propose_position',pin_id=pin['id'],x=.1,y=0)
        proposal=self.doc['proposals'][-1]
        self.assertEqual(proposal['status'],'pending')
        self.assertEqual(proposal['operation']['provider'],'canvas')
        self.assertEqual((proposal['operation']['range_start'],proposal['operation']['range_end']),(2,4))
        self.assertEqual(self.doc['clips'][0].get('x',0),0)
        self.assertEqual(self.doc['accepted_edits'],[])
        with self.assertRaises(ValueError):self.act('propose_position',pin_id=pin['id'],x=.6,y=0)
    def test_start_end_range_is_validated_persisted_and_stable(self):
        rid=self.doc['revision_id']
        self.act('add_pin',time=2,clip_id=self.cid)
        pin=self.doc['pins'][0]
        with self.assertRaises(ValueError):self.act('propose',pin_id=pin['id'])
        self.act('edit_pin',pin_id=pin['id'],start=2,end=4,instruction='move right')
        saved=q.load(self.app,self.pid)
        self.assertEqual((saved['pins'][0]['start'],saved['pins'][0]['end']),(2,4))
        self.assertEqual(saved['revision_id'],rid)
        for a,b in [(4,2),(2,2),(-1,2),(2,15),(2,float('nan'))]:
            with self.assertRaises(ValueError):self.act('edit_pin',pin_id=pin['id'],start=a,end=b)
        self.assertEqual(q.load(self.app,self.pid)['pins'],saved['pins'])
    def range_operation(self,operation,**args):
        return dict(operation=operation,clip_id=self.cid,range_start=2,range_end=4,start=2,end=4,x=.1,y=0,**args)
    def test_position_changes_only_between_start_end_pins(self):
        result=r.candidate(self.doc,self.range_operation('position_clip'))
        self.assertEqual([(c['start'],c['end'],c.get('x',0)) for c in result['clips']],[(0,2,0),(2,4,.1),(4,14,0)])
        # Further ranges keep their source lineage after the renderer splits clips.
        op=self.range_operation('position_clip');op.update(range_start=3,range_end=5,x=.2)
        result=r.candidate(result,op)
        self.assertEqual([(c['start'],c['end'],c.get('x',0)) for c in result['clips']],[(0,2,0),(2,3,.1),(3,4,.2),(4,5,.2),(5,14,0)])
    def test_remove_range_preserves_surrounding_footage(self):
        result=r.candidate(self.doc,self.range_operation('delete_range'))
        self.assertEqual([(c['start'],c['end']) for c in result['clips']],[(0,2),(4,14)])
        with self.assertRaises(ValueError):r.candidate(result,self.range_operation('position_clip'))
    def test_trim_range_preserves_unselected_footage(self):
        op=self.range_operation('trim_clip');op.update(start=2.5,end=3.5)
        result=r.candidate(self.doc,op)
        self.assertEqual([(c['start'],c['end']) for c in result['clips']],[(0,2),(2.5,3.5),(4,14)])
        op.update(start=1)
        with self.assertRaises(ValueError):r.candidate(self.doc,op)
    def test_legacy_timeline_migrates_without_losing_data(self):
        d=copy.deepcopy(self.doc)
        for k in ['revision_id','pins','accepted_edits','proposals','rendered']:d.pop(k)
        q.write(self.app.WORK/self.pid/'timeline.json',d)
        migrated=q.load(self.app,self.pid)
        self.assertEqual(migrated['clips'],d['clips']);self.assertEqual(migrated['version'],d['version'])
        self.assertEqual(q.load(self.app,self.pid)['revision_id'],migrated['revision_id'])

if __name__=='__main__':unittest.main()
