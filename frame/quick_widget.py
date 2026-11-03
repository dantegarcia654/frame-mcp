"""MCP App registration and bounded video transport through the existing bridge.

The sandbox never fetches localhost or an external media service. Video bytes
travel only in app-only MCP results, outside model-visible structured content.
"""
import base64
import json
import re
import urllib.request
import urllib.error
from pathlib import Path

URI = 'ui://frame/editor-v4.html'
MIME = 'text/html;profile=mcp-app'
CHUNK = 1024 * 1024
MAX_VIDEO = 700 * 1024 * 1024
CUSTOM_TOOLS = {'open_editor', 'read_video_chunk', 'update_editor'}


def specs(prop, project, version):
    return {
        'open_editor': ({'project_id': project}, [],
                        'Open the FRAME video editor beside this conversation. With no project_id, show saved projects. With a project_id, open that exact project. Use this when the user asks to open Frame.'),
        'read_video_chunk': ({'project_id': project,
                              'export_id': prop('string', 'Completed export identifier; omit for original footage.'),
                              'max_bytes': {'type': 'integer', 'minimum': 1, 'maximum': CHUNK, 'description': 'App transport chunk budget. Older app versions default to 256 KiB.'},
                              'offset': {'type': 'integer', 'minimum': 0}}, ['project_id', 'offset'],
                             'Read a bounded video chunk for playback in the FRAME app. Available to the app only.'),
        'update_editor': ({'project_id': project, 'expected_version': version,
                           'action': {'type': 'string', 'enum': ['add_pin', 'edit_pin', 'delete_pin', 'add_note']},
                           'clip_id': prop('string', 'Current clip ID for a start pin.'),
                           'pin_id': prop('string', 'Existing pin ID.'),
                           'section_id': prop('string', 'Existing complete start/end range ID.'),
                           'time': prop('number', 'Original source seconds.'),
                           'start': prop('number', 'Original source start seconds.'),
                           'end': prop('number', 'Original source end seconds.'),
                           'source_time_ms': prop('integer', 'Original source milliseconds.'),
                           'instruction': {'type': 'string', 'maxLength': 2000}},
                          ['project_id', 'expected_version', 'action'],
                          'Save source-anchored start/end pins or notes from the editor. Notes do not apply video edits.')}


def decorate(tool):
    name = tool['name']
    # Every successful tool returns an object, including list_projects' wrapper.
    tool['outputSchema'] = {'type': 'object', 'additionalProperties': True}
    meta = tool.setdefault('_meta', {})
    if name in ('open_editor', 'import_video', 'import_local_video'):
        meta.update({'ui': {'resourceUri': URI, 'visibility': ['model', 'app']},
                     'openai/outputTemplate': URI,
                     'openai/widgetAccessible': True})
    elif name in ('read_video_chunk', 'update_editor'):
        meta['ui'] = {'visibility': ['app']}
        meta['openai/widgetAccessible'] = True
    else:
        meta['ui'] = {'visibility': ['model', 'app']}
        meta['openai/widgetAccessible'] = True
    if name == 'open_editor':
        tool['title'] = 'Frame'
        meta['openai/ui'] = {'entrypoints': [{'type': 'thread'}]}
    if name in ('open_editor', 'read_video_chunk'):
        tool['annotations']['readOnlyHint'] = True
    return tool


def resource():
    return {'uri': URI, 'name': 'Frame editor', 'mimeType': MIME,
            'description': 'Video playback, timeline edits and saved frame notes beside the chat.'}


def contents():
    return {'uri': URI, 'mimeType': MIME, 'text': Path(__file__).with_name('frame_widget.html').read_text(),
            '_meta': {'ui': {'prefersBorder': False,
                             'csp': {'connectDomains': [], 'resourceDomains': ['blob:']}},
                      'openai/widgetDescription': 'Frame video editor. Project state is saved on the connected computer; notes are editing requests, not applied effects.',
                      'openai/widgetCSP': {'connect_domains': [], 'resource_domains': ['blob:']},
                      'openai/ui': {'availableDisplayModes': ['inline', 'fullscreen'],
                                    'preferredDisplayMode': 'fullscreen'}}}


def valid_id(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{32}', value):
        raise ValueError('Invalid project or export identifier.')
    return value


def call(name, args, base, existing):
    if name == 'open_editor':
        if args.get('project_id'):
            doc = existing('get_project', {'project_id': valid_id(args['project_id'])})
            return {'project': doc, 'project_id': doc['project_id']}
        return {'projects': existing('list_projects', {}), 'status': 'Choose a saved project or attach a video to this conversation.'}
    pid = valid_id(args.get('project_id'))
    if name == 'update_editor':
        action = args.get('action')
        allowed = {'add_pin': {'time', 'clip_id'}, 'edit_pin': {'pin_id', 'start', 'end', 'instruction'},
                   'delete_pin': {'pin_id'}, 'add_note': {'section_id', 'source_time_ms', 'instruction'}}
        if action not in allowed or set(args) - (allowed[action] | {'project_id', 'expected_version', 'action'}):
            raise ValueError('Unsupported editor action or fields.')
        payload = {k: v for k, v in args.items() if k != 'project_id'}
        data = json.dumps(payload).encode()
        if len(data) > 16000:
            raise ValueError('Editor request is too large.')
        req = urllib.request.Request(base + '/api/quick/projects/' + pid + '/revision', data=data,
                                     headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = json.loads(exc.read(16000))
            raise ValueError(detail.get('error', 'The editor rejected this action.')) from exc
    if name != 'read_video_chunk':
        raise ValueError('Unknown editor tool.')
    offset = args.get('offset')
    if type(offset) is not int or not 0 <= offset < MAX_VIDEO:
        raise ValueError('Invalid video byte offset.')
    chunk_size = args.get('max_bytes', 256 * 1024)
    if type(chunk_size) is not int or not 1 <= chunk_size <= CHUNK:
        raise ValueError('Invalid video chunk budget.')
    doc = existing('get_project', {'project_id': pid})
    export_id = args.get('export_id')
    if export_id is not None:
        valid_id(export_id)
        if not any(e['id'] == export_id and e['status'] == 'done' for e in doc.get('exports', [])):
            raise ValueError('Choose a completed export.')
        path = '/media/' + pid + '/versions/' + export_id + '/edited.mp4'
    else:
        path = '/media/' + pid + '/input.mp4'
    req = urllib.request.Request(base + path, headers={'Range': 'bytes=%d-%d' % (offset, offset + chunk_size - 1)})
    with urllib.request.urlopen(req, timeout=30) as response:
        match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
        if response.status != 206 or not match:
            raise ValueError('Video server did not return a bounded byte range.')
        start, end, total = map(int, match.groups())
        if start != offset or not start <= end < total <= MAX_VIDEO or end - start + 1 > chunk_size:
            raise ValueError('Invalid video range response.')
        data = response.read(chunk_size + 1)
        if len(data) != end - start + 1:
            raise ValueError('Video chunk was truncated.')
    return {'project_id': pid, 'offset': start, 'next_offset': end + 1, 'total_bytes': total,
            'export_id': export_id, '_video_base64': base64.b64encode(data).decode()}
