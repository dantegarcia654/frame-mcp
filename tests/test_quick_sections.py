"""Frozen note sets, explicit approval, conflicts, lineage and nondestructive restore."""
import copy
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
import quick_timeline as q
import quick_revision as r
import quick_sections as s

class SectionTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.pid='c'*32;root=Path(temp.name);(root/self.pid).mkdir()
        self.app=types.SimpleNamespace(WORK=root,WORKERS=threading.Semaphore(1),project=lambda _: {'name':'Fixture','current_segments':None})
        mock=patch.object(q,'probe',return_value={'duration':14,'audio':True});mock.start();self.addCleanup(mock.stop)
        self.doc=q.load(self.app,self.pid);self.cid=self.doc['clips'][0]['id']
        self.act('add_pin',time=2,clip_id=self.cid);self.sid=self.doc['pins'][0]['id']
        self.act('edit_pin',pin_id=self.sid,start=2,end=6)
    def act(self,action,**args):
        self.doc=r.act(self.app,self.pid,dict(action=action,expected_version=self.doc['version'],**args));return self.doc
    def note(self,t=3000,text='move right'):
        self.act('add_note',section_id=self.sid,source_time_ms=t,instruction=text)
        return self.doc['notes'][-1]
    def operation(self,x=.1):
        return dict(operation='position_clip',clip_id=self.cid,range_start=2,range_end=6,start=2,end=6,x=x,y=0,message='Move selected section')
    def plan(self,side_effect):
        with patch.object(s.threading,'Thread'):self.act('apply_notes',request_id='test-token-123')
        doc=q.load(self.app,self.pid);p=doc['proposals'][-1]
        with patch.object(r,'interpret',side_effect=side_effect):s.plan_set(self.app,self.pid,copy.deepcopy(doc),p['id'])
        self.doc=q.public(q.load(self.app,self.pid));return self.doc['proposals'][-1]
    def test_source_millisecond_anchors_order_and_persistence(self):
        self.note(3001);self.note(4507,'another note')
        d=q.load(self.app,self.pid)
        self.assertEqual([n['source_time_ms'] for n in d['notes']],[3001,4507])
        self.assertEqual([n['order'] for n in d['notes']],[1,2])
        self.assertEqual(d['notes'][0]['section_id'],self.sid)
        self.assertEqual(d['notes'][0]['project_id'],self.pid)
        self.assertEqual(d['notes'][0]['revision_set_id'],d['notes'][1]['revision_set_id'])
        for t in [1999,6000,7000,True,float('nan')]:
            with self.assertRaises(ValueError):self.note(t)
    def test_adjust_remove_keep_preserves_note_history(self):
        n=self.note();self.act('edit_note',note_id=n['id'],instruction='adjusted')
        self.act('remove_note',note_id=n['id']);self.assertEqual(self.doc['notes'][0]['status'],'removed')
        self.act('keep_note',note_id=n['id']);self.assertTrue(self.doc['notes'][0]['included'])
        self.assertEqual(self.doc['notes'][0]['instruction'],'adjusted')
    def test_frozen_set_and_duplicate_request_are_idempotent(self):
        self.note();self.note(4000,'second')
        with patch.object(s.threading,'Thread') as thread:
            self.act('apply_notes',request_id='duplicate-token')
            frozen=copy.deepcopy(self.doc['proposals'][-1]['frozen_notes'])
            r.act(self.app,self.pid,{'action':'apply_notes','expected_version':-10,'request_id':'duplicate-token'})
            self.assertEqual(thread.call_count,1)
        self.assertEqual(len(q.load(self.app,self.pid)['proposals']),1)
        with self.assertRaises(ValueError):self.act('edit_note',note_id=frozen[0]['id'],instruction='changed')
    def test_supported_and_unsupported_notes_produce_one_reviewable_set(self):
        self.note();self.note(4500,'generate confetti')
        p=self.plan([self.operation(),r.Unsupported('Confetti is unsupported')])
        self.assertEqual(p['status'],'pending');self.assertEqual(len(p['operation']['operations']),1)
        self.assertEqual([n['status'] for n in p['note_results']],['supported','unsupported'])
        self.assertEqual(self.doc['accepted_edits'],[]);self.assertIsNone(self.doc['rendered'])
        self.assertEqual(self.doc['notes'][1]['status'],'unsupported')
    def test_conflicting_notes_fail_without_render(self):
        self.note();self.note(4500,'move left')
        p=self.plan([self.operation(.1),self.operation(-.1)])
        self.assertEqual(p['status'],'failed');self.assertIn('Conflicting',p['error'])
        self.assertIsNone(self.doc['rendered']);self.assertEqual(self.doc['accepted_edits'],[])
    def test_duplicate_moves_are_explicitly_grouped(self):
        self.note();self.note(4500,'same move')
        p=self.plan([self.operation(),self.operation()])
        self.assertEqual(len(p['operation']['operations']),1)
        self.assertIn('shared',p['note_results'][1]['message'])
    def test_provider_failure_never_masquerades_as_unsupported(self):
        self.note();p=self.plan([ValueError('Claude unavailable')])
        self.assertEqual(p['status'],'failed');self.assertIn('unavailable',p['error'])
        self.assertEqual(self.doc['notes'][0]['status'],'queued')
    def test_approve_single_render_checkpoint_and_restore_keeps_journal(self):
        self.note();self.note(4500,'unsupported');p=self.plan([self.operation(),r.Unsupported('unsupported')])
        before=q.load(self.app,self.pid);snapshot=r.candidate(before,p['operation'])
        def render(source,folder,*args,**kw):(folder/'edited.mp4').write_bytes(b'unit fixture');return 14
        with patch.object(r,'render_timeline',side_effect=render) as renderer,patch.object(r.subprocess,'run'):
            r.render_worker(self.app,self.pid,snapshot,p)
        renderer.assert_called_once();self.doc=q.public(q.load(self.app,self.pid));saved=copy.deepcopy(self.doc)
        self.assertEqual(len(self.doc['checkpoints']),2);self.assertEqual(self.doc['checkpoints'][-1]['parent_id'],'source')
        self.assertEqual([n['status'] for n in self.doc['notes']],['applied','unsupported'])
        self.assertNotEqual(saved['active_revision_set_id'],before['active_revision_set_id'])
        self.act('restore_checkpoint',checkpoint_id='source')
        self.assertIsNone(self.doc['rendered']);self.assertEqual(self.doc['clips'][0]['end'],14)
        self.assertEqual(self.doc['accepted_edits'],saved['accepted_edits']);self.assertEqual(self.doc['notes'],saved['notes'])
        self.act('restore_checkpoint',checkpoint_id=p['id']);self.assertEqual(self.doc['rendered'],saved['rendered'])
        self.assertEqual(self.doc['revision_id'],before['revision_id'])
    def test_repeated_edits_on_millisecond_section_share_frame_boundaries(self):
        operation=self.operation();operation.update(range_start=2.125,range_end=6.375)
        first=r.candidate(self.doc,operation)
        operation['x']=.15
        second=r.candidate(first,operation)
        self.assertEqual([(c['start'],c['end']) for c in first['clips']],[(c['start'],c['end']) for c in second['clips']])
        self.assertEqual(second['clips'][1]['x'],.15)
    def test_restarted_set_fails_but_preserves_notes_and_checkpoints(self):
        self.note()
        with patch.object(s.threading,'Thread'):self.act('apply_notes',request_id='restart-token')
        before=copy.deepcopy(self.doc);r.recover(self.app);d=q.load(self.app,self.pid)
        self.assertEqual(d['proposals'][-1]['status'],'failed');self.assertEqual(d['notes'],before['notes'])
        self.assertEqual(d['checkpoints'],before['checkpoints'])

if __name__=='__main__':unittest.main()
