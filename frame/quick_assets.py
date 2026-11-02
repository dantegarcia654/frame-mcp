"""Preserve creative uploads byte-for-byte and export portable project bundles."""
import hashlib
import json
import mimetypes
import os
import re
import shutil
import tempfile
import time
import uuid
import zipfile
from urllib.parse import unquote, urlparse
import quick_timeline as timeline


def bundle(app,pid):
    with timeline.LOCK:
        doc=timeline.load(app,pid)
        snapshot=json.loads(json.dumps(doc))
        folder=app.WORK/pid
        fd,name=tempfile.mkstemp(suffix='.frameproj');os.close(fd)
        try:
            with zipfile.ZipFile(name,'w',compression=zipfile.ZIP_STORED) as archive:
                archive.writestr('project.frameproj.json',json.dumps({'format':'frame-project/1','project_id':pid,'revision':snapshot},indent=2))
                archive.writestr('timeline.json',json.dumps(snapshot,indent=2))
                # Only the canonical owned project folder; symlinks are never followed.
                for path in folder.rglob('*'):
                    if path.is_file() and not path.is_symlink() and not any(parent.is_symlink() for parent in path.parents if parent==folder or folder in parent.parents):
                        if path.name=='timeline.json' or (path.parent==folder and path.name in ('timeline.tmp','project.tmp')):continue
                        if path.relative_to(folder).parts[0]=='assets' and path.relative_to(folder).as_posix() not in {a['path'] for a in snapshot.get('assets',[])}:continue
                        archive.write(path,path.relative_to(folder).as_posix())
            return name
        except Exception:
            os.unlink(name);raise


def upload(handler,app,pid):
    with timeline.LOCK:timeline.load(app,pid)
    length=int(handler.headers.get('Content-Length','0'))
    if not 0<length<=app.MAX_UPLOAD:raise ValueError('Creative upload must be 1 byte to 700 MB.')
    original=unquote(handler.headers.get('X-Filename','creative-file'))
    name=original.replace('\\','/').split('/')[-1].strip()[:180]
    if not name or name in ('.','..'):name='creative-file'
    aid=uuid.uuid4().hex;folder=app.WORK/pid/'assets'/aid;folder.mkdir(parents=True)
    target=folder/name;temporary=folder/'upload.tmp';digest=hashlib.sha256();remaining=length
    handler.connection.settimeout(90)
    try:
        with temporary.open('wb') as f:
            while remaining:
                chunk=handler.rfile.read(min(1024*1024,remaining))
                if not chunk:raise ValueError('Creative upload was interrupted; previous project data is unchanged.')
                f.write(chunk);digest.update(chunk);remaining-=len(chunk)
            f.flush();os.fsync(f.fileno())
        temporary.replace(target)
        fd=os.open(str(folder),os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
        asset={'id':aid,'name':name,'path':'assets/'+aid+'/'+name,'size':length,'sha256':digest.hexdigest(),
               'mime_type':mimetypes.guess_type(name)[0] or 'application/octet-stream','created_at':time.time(),
               'url':'/api/quick/projects/'+pid+'/assets/'+aid+'/download'}
        with timeline.LOCK:
            doc=timeline.load(app,pid);doc.setdefault('assets',[]).append(asset);doc['version']+=1
            timeline.write(app.WORK/pid/'timeline.json',doc)
        return timeline.public(doc)
    except Exception:
        shutil.rmtree(folder);raise


def route(handler,app,method):
    path=urlparse(handler.path).path
    match=re.fullmatch('/api/quick/projects/('+timeline.ID+')/(bundle|assets)(?:/('+timeline.ID+')/download)?',path)
    if not match:return False
    pid,kind,aid=match.groups()
    try:
        if method=='POST' and kind=='assets' and aid is None:handler.json(200,upload(handler,app,pid))
        elif method=='GET' and kind=='assets' and aid:
            with timeline.LOCK:
                doc=timeline.load(app,pid);asset=next((a for a in doc.get('assets',[]) if a['id']==aid),None)
            if not asset:raise ValueError('Creative file not found.')
            handler.media(app.WORK/pid/asset['path'],'application/octet-stream')
        elif method=='GET' and kind=='bundle' and aid is None:
            name=bundle(app,pid)
            try:
                size=os.path.getsize(name);handler.send_response(200)
                handler.send_header('Content-Type','application/zip');handler.send_header('Content-Length',str(size))
                handler.send_header('Content-Disposition','attachment; filename="'+pid+'.frameproj"')
                handler.send_header('Cache-Control','no-store');handler.end_headers()
                with open(name,'rb') as source:shutil.copyfileobj(source,handler.wfile,1024*1024)
            finally:os.unlink(name)
        else:raise ValueError('Unsupported creative storage request.')
    except (ValueError,FileNotFoundError,TypeError,KeyError) as exc:handler.json(400,{'error':str(exc)})
    return True
