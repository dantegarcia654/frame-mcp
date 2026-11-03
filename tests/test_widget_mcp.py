import base64
import json
import unittest
from unittest.mock import patch, MagicMock
import quick_mcp as mcp
import quick_widget as widget

PID = 'a' * 32


class WidgetProtocol(unittest.TestCase):
    def request(self, method, params=None):
        return mcp.dispatch({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}})

    def test_panel_resource_is_discoverable_and_self_contained(self):
        init = self.request('initialize')['result']
        self.assertIn('resources', init['capabilities'])
        tools = self.request('tools/list')['result']['tools']
        opened = next(t for t in tools if t['name'] == 'open_editor')
        self.assertEqual(opened['_meta']['openai/ui']['entrypoints'], [{'type': 'thread'}])
        uri = opened['_meta']['ui']['resourceUri']
        item = self.request('resources/read', {'uri': uri})['result']['contents'][0]
        self.assertEqual(item['mimeType'], widget.MIME)
        self.assertIn('FRAME', item['text'])
        self.assertNotIn('/* FRAME_WIDGET_SCRIPT */', item['text'])
        self.assertNotIn('<script src=', item['text'])
        self.assertEqual(item['_meta']['ui']['csp']['connectDomains'], [])
        self.assertIn('fullscreen', item['_meta']['openai/ui']['availableDisplayModes'])
        self.assertIn('error', self.request('resources/read', {'uri': 'file:///etc/passwd'}))

    def test_private_video_bytes_never_enter_model_visible_results(self):
        with patch.object(mcp, 'call', return_value={'offset': 0, '_video_base64': 'YWJj'}):
            result = self.request('tools/call', {'name': 'read_video_chunk', 'arguments': {}})['result']
        self.assertEqual(result['_meta']['videoChunk'], 'YWJj')
        self.assertNotIn('YWJj', json.dumps(result['content']))
        self.assertNotIn('_video_base64', result['structuredContent'])

    def test_transport_and_editor_write_tools_are_app_only(self):
        tools = {t['name']: t for t in mcp.tools()}
        for name in ('read_video_chunk', 'update_editor'):
            self.assertEqual(tools[name]['_meta']['ui']['visibility'], ['app'])
        self.assertTrue(tools['read_video_chunk']['annotations']['readOnlyHint'])
        self.assertFalse(tools['update_editor']['annotations']['readOnlyHint'])
        self.assertNotIn('expected_version', tools['read_video_chunk']['inputSchema']['required'])

    def test_download_only_exposes_completed_export_on_configured_loopback(self):
        export = 'b' * 32
        for state in ('queued', 'rendering', 'failed'):
            with self.subTest(state=state), self.assertRaises(ValueError):
                widget.call('prepare_download', {'project_id': PID, 'export_id': export},
                            'http://127.0.0.1:18881', MagicMock(return_value={'exports': [{'id': export, 'status': state}]}))
        result = widget.call('prepare_download', {'project_id': PID, 'export_id': export},
                             'http://127.0.0.1:18881', MagicMock(return_value={'exports': [{'id': export, 'status': 'done'}]}))
        self.assertEqual(result['download_url'], f'http://127.0.0.1:18881/media/{PID}/versions/{export}/edited.mp4?download=1')
        tool = next(t for t in mcp.tools() if t['name'] == 'prepare_download')
        self.assertEqual(tool['_meta']['ui']['visibility'], ['app'])
        self.assertTrue(tool['annotations']['readOnlyHint'])

    def test_editor_does_not_infer_or_open_an_unrequested_project(self):
        existing = MagicMock(return_value=[])
        result = widget.call('open_editor', {}, 'http://127.0.0.1:8876', existing)
        existing.assert_called_once_with('list_projects', {})
        self.assertNotIn('project', result)

    def test_arbitrary_paths_offsets_and_export_ids_rejected(self):
        existing = MagicMock(return_value={'exports': []})
        for args in ({'project_id': '../../etc/passwd', 'offset': 0},
                     {'project_id': PID, 'offset': True}, {'project_id': PID, 'offset': -1},
                     {'project_id': PID, 'offset': widget.MAX_VIDEO},
                     {'project_id': PID, 'offset': 0, 'export_id': 'b' * 32}):
            with self.subTest(args=args), self.assertRaises(ValueError), patch.object(widget.urllib.request, 'urlopen') as url:
                try:
                    widget.call('read_video_chunk', args, 'http://127.0.0.1:8876', existing)
                finally:
                    url.assert_not_called()

    def test_editor_rejects_operation_and_field_injection_before_http(self):
        for action, extra in [('apply_notes', {}), ('add_note', {'path': '/tmp/x'}),
                              ('add_pin', {'instruction': 'injected'}), ('edit_pin', {'operation': 'export_video'})]:
            with self.subTest(action=action), self.assertRaises(ValueError), patch.object(widget.urllib.request, 'urlopen') as url:
                try:
                    widget.call('update_editor', {'project_id': PID, 'expected_version': 1, 'action': action, **extra}, 'http://127.0.0.1:8876', MagicMock())
                finally:
                    url.assert_not_called()

    def test_server_must_honor_range_and_bounded_lengths(self):
        for status, header, payload in [(200, '', b'abc'), (206, 'bytes 0-2/3', b'ab'),
                                        (206, 'bytes 1-3/4', b'abc'),
                                        (206, 'bytes 0-2/999999999', b'abc')]:
            response = MagicMock(status=status, headers={'Content-Range': header})
            response.read.return_value = payload
            opened = MagicMock(); opened.__enter__.return_value = response
            with self.subTest(header=header), patch.object(widget.urllib.request, 'urlopen', return_value=opened), self.assertRaises(ValueError):
                widget.call('read_video_chunk', {'project_id': PID, 'offset': 0}, 'http://127.0.0.1:8876', MagicMock(return_value={}))

    def test_valid_chunk_has_exact_offset_and_bytes(self):
        response = MagicMock(status=206, headers={'Content-Range': 'bytes 0-2/3'})
        response.read.return_value = b'abc'
        opened = MagicMock(); opened.__enter__.return_value = response
        with patch.object(widget.urllib.request, 'urlopen', return_value=opened):
            result = widget.call('read_video_chunk', {'project_id': PID, 'offset': 0}, 'http://127.0.0.1:8876', MagicMock(return_value={}))
        self.assertEqual(base64.b64decode(result['_video_base64']), b'abc')
        self.assertEqual((result['next_offset'], result['total_bytes']), (3, 3))


if __name__ == '__main__':
    unittest.main()
