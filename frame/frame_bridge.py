"""Katana delegates composition to the existing FRAME engine, not another renderer."""
import functools
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def core_directory():
    return Path(os.environ.get('FRAME_CORE_DIR', str(Path(__file__).resolve().parent / 'frame_core'))).resolve()


@functools.lru_cache(maxsize=1)
def module():
    path=core_directory()/'split_screen.py'
    if not path.is_file():raise RuntimeError('FRAME engine is unavailable. Set FRAME_CORE_DIR to the existing work/frame-core directory.')
    spec=importlib.util.spec_from_file_location('frame_split_screen_schema',path)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result)
    return result


def operation_schema():return module().instruction_schema()
def validate_operation(value,duration):return module().validate_spec(value,duration)


def compose(folder,revision,proposal,data,stage):
    selected=next((v for v in data['versions'] if v['id']==proposal['base_version']),None)
    if proposal.get('start_from_original') or not selected:
        source=folder/'input.mp4';project=None
    elif selected.get('frame_project'):
        project=Path(selected['frame_project']);source=project/'source.mp4'
    else:
        source=folder/'versions'/selected['id']/'edited.mp4';project=None
    if project is None:
        key=hashlib.sha256(str(source.resolve()).encode()).hexdigest()[:16]
        project=folder/'frame-projects'/key
    instruction={'operation':'create_split_screen','value':proposal['split_screen'],
                 'rationale':proposal['message'],'parent':'source','idempotency_key':proposal['id']}
    request=revision/'frame-instruction.json';request.write_text(json.dumps(instruction,indent=2))
    env=os.environ.copy();env['FRAME_LOCAL_IMPORT_ROOTS']=str(folder.resolve())
    stage('FRAME is rendering the approved split-screen and playable preview')
    process=subprocess.run([sys.executable,str(core_directory()/'frame_operations.py'),'--project',str(project),
                            '--source',str(source),'--instruction',str(request)],env=env,capture_output=True,text=True,timeout=1200)
    if process.returncode:raise RuntimeError('FRAME composition failed: '+process.stderr[-1600:])
    result=json.loads(process.stdout);checkpoint=result['checkpoint']
    for field,name in [('file','edited.mp4'),('preview_file','preview.mp4')]:
        origin=project/checkpoint[field];target=revision/name
        try:os.link(origin,target)
        except FileExistsError:pass
        except OSError:shutil.copy2(origin,target)
    (revision/'frame-result.json').write_text(json.dumps(result,indent=2))
    return checkpoint,project
