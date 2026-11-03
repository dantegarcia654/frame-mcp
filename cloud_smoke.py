"""Synthetic editing/export acceptance; never uses personal media."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
config = ROOT / 'runtime.json'
if config.exists():
    os.environ.setdefault('FRAME_URL', json.loads(config.read_text())['base_url'])
sys.path.insert(0, str(ROOT / 'frame'))
# A separately installed instance is required: this test creates one small project.
import quick_mcp
import quick_runtime


def call(name, values):
    result = quick_mcp.call(name, values)
    return result


def main():
    quick_runtime.ensure_server(quick_mcp.BASE)
    checks = []
    with tempfile.TemporaryDirectory(prefix='frame-cloud-smoke-') as tmp:
        source = Path(tmp) / 'synthetic.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(source)], check=True)
        checks.append('synthetic H264/AAC source created')
        project = call('import_local_video', {'source_path': str(source)})
        pid = project['project_id']
        project = call('get_project', {'project_id': pid})
        project = call('trim_clip', {'project_id': pid, 'expected_version': project['version'],
                                    'clip_id': project['clips'][0]['id'], 'start': .5, 'end': 2.5})
        assert abs(project['duration'] - 2) < .05
        checks.append('versioned trim from 3 to 2 seconds')
        call('export_video', {'project_id': pid, 'expected_version': project['version']})
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            project = call('get_project', {'project_id': pid})
            export = project['exports'][-1]
            if export['status'] != 'working':
                break
            time.sleep(.25)
        assert export['status'] == 'done', export
        checks.append('MP4 export completed')
        target = ROOT / 'frame/jobs' / pid / 'versions' / export['id'] / 'edited.mp4'
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
                          'format=duration:stream=codec_name', '-of', 'json', str(target)]))
        assert abs(float(info['format']['duration']) - 2) < .08
        assert {'h264', 'aac'} <= {s['codec_name'] for s in info['streams']}
        subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(target), '-f', 'null', '-'], check=True)
        checks.extend(['measured 2 second H264/AAC export', 'full audiovisual decode'])
    receipt = {'status': 'pass', 'checks': checks, 'project_id': pid, 'export': str(target),
               'platform': sys.platform, 'cloud_provider': 'not inferred; confirm task environment'}
    (ROOT / 'SMOKE-RESULT.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
