import copy
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import quick_markup as markup
import quick_timeline as timeline
import quick_revision as revision


class MarkupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.pid = 'b' * 32
        root = Path(self.temp.name)
        (root/self.pid).mkdir()
        self.app = types.SimpleNamespace(WORK=root, project=lambda _: {'name':'Markup fixture'})
        probe = patch.object(timeline, 'probe', return_value={'duration':12, 'audio':True})
        probe.start(); self.addCleanup(probe.stop)
        self.doc = timeline.load(self.app, self.pid)
        self.items = [{'kind':'draw','points':[[.1,.2],[.3,.4]]},
                      {'kind':'box','x':.1,'y':.1,'width':.2,'height':.3},
                      {'kind':'text','x':.2,'y':.4,'text':'Move this title'}]

    def save(self, **changes):
        body = {'action':'add_annotation','expected_version':self.doc['version'],
                'source_time_ms':3500,'instruction':'Make this area brighter',
                'annotations':copy.deepcopy(self.items)}
        body.update(changes)
        self.doc = revision.act(self.app, self.pid, body)
        return self.doc

    def test_persists_geometry_timestamp_description_and_auto_section_without_video_edit(self):
        clips = copy.deepcopy(self.doc['clips'])
        self.save()
        saved = timeline.load(self.app, self.pid)
        note, pin = saved['notes'][0], saved['pins'][0]
        self.assertEqual(note['annotations'], self.items)
        self.assertEqual(note['instruction'], 'Make this area brighter')
        self.assertEqual(note['source_time_ms'], 3500)
        self.assertEqual(note['section_id'], pin['id'])
        self.assertLessEqual(pin['start'], 3.5)
        self.assertGreater(pin['end'], 3.5)
        self.assertEqual(saved['clips'], clips)
        self.assertIsNone(saved['rendered'])
        self.assertEqual(saved['accepted_edits'], [])

    def test_uses_covering_section_and_rejects_wrong_section_atomically(self):
        self.save()
        sid = self.doc['pins'][0]['id']
        self.save(source_time_ms=3600, section_id=sid)
        self.assertEqual(len(self.doc['pins']), 1)
        self.assertEqual(self.doc['notes'][-1]['section_id'], sid)
        before = timeline.load(self.app, self.pid)
        with self.assertRaises(ValueError):
            self.save(source_time_ms=8000, section_id=sid)
        self.assertEqual(timeline.load(self.app, self.pid), before)

    def test_invalid_shapes_never_create_notes_or_sections(self):
        bad = [[], [{'kind':'script','text':'x'}], [{'kind':'draw','points':[[0,0],[2,1]]}],
               [{'kind':'draw','points':[[True,0],[1,1]]}],
               [{'kind':'box','x':.9,'y':0,'width':.2,'height':.1}],
               [{'kind':'text','x':0,'y':0,'text':''}],
               [{'kind':'draw','points':[[0,0],[float('nan'),1]]}],
               [{'kind':'draw','points':[[0,0]]*501}]]
        before = timeline.load(self.app, self.pid)
        for items in bad:
            with self.subTest(items=str(items)[:90]), self.assertRaises(ValueError):
                self.save(annotations=items)
            self.assertEqual(timeline.load(self.app, self.pid), before)

    def test_boundaries_and_stale_save_preserve_prior_markup(self):
        self.save(source_time_ms=11990)
        before = timeline.load(self.app, self.pid)
        for changes in [{'source_time_ms':12000}, {'source_time_ms':-1},
                        {'source_time_ms':True}, {'expected_version':1}, {'instruction':''}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.save(**changes)
            self.assertEqual(timeline.load(self.app, self.pid), before)


if __name__ == '__main__':
    unittest.main()
