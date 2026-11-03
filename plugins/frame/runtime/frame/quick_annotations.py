"""Source-frame comments for a connected assistant; never changes exported pixels."""
import io
import json
import re
import subprocess
import time
import uuid
from urllib.parse import urlparse
from PIL import Image, ImageDraw
import quick_timeline as timeline


def read(app, pid):
    timeline.load(app, pid)  # Validate project before touching paths.
    path = app.WORK / pid / 'frame-comments.json'
    return json.loads(path.read_text()) if path.exists() else []


def create(app, pid, body):
    with timeline.LOCK:
        doc = timeline.load(app, pid)
        if type(body.get('expected_version')) is not int or body['expected_version'] != doc['version']:
            raise timeline.Conflict('The timeline changed. Select the area again on the current video.')
        clip = next((c for c in doc['clips'] if c['id'] == body.get('clip_id')), None)
        moment = timeline.number(body.get('source_time'))
        if not clip or not clip['start'] <= moment < clip['end']:
            raise ValueError('Select a frame inside the current clip.')
        box = body.get('region')
        if not isinstance(box, dict) or set(box) != {'x', 'y', 'width', 'height'}:
            raise ValueError('Draw a rectangle on the video first.')
        box = {k: timeline.number(v) for k, v in box.items()}
        if not (0 <= box['x'] < 1 and 0 <= box['y'] < 1 and .005 <= box['width'] <= 1 and .005 <= box['height'] <= 1
                and box['x'] + box['width'] <= 1.000001 and box['y'] + box['height'] <= 1.000001):
            raise ValueError('The selected area must fit inside the picture.')
        note = body.get('note')
        if not isinstance(note, str) or not 1 <= len(note.strip()) <= 2000:
            raise ValueError('Describe the change in 1–2000 characters.')
        comments = read(app, pid)
        if len(comments) >= 100:
            raise ValueError('This project already has 100 frame comments.')
        cid = uuid.uuid4().hex
        folder = app.WORK / pid / 'frame-comments'
        folder.mkdir(exist_ok=True)
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(moment), '-i',
            str(app.WORK / pid / 'input.mp4'), '-frames:v', '1', '-vf',
            'scale=960:960:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'png', '-'],
            capture_output=True, timeout=30)
        if raw.returncode or not raw.stdout:
            raise ValueError('Could not capture that frame. Move back one frame and try again.')
        image = Image.open(io.BytesIO(raw.stdout)).convert('RGB')
        x, y, w, h = (box[k] for k in ('x', 'y', 'width', 'height'))
        dx,dy=clip.get('x',0),clip.get('y',0)
        if dx or dy:
            shifted=Image.new('RGB',image.size,'black');shifted.paste(image,(round(dx*image.width),round(dy*image.height)));image=shifted
        left,top=round(x*image.width),round(y*image.height)
        right=max(left,min(image.width-1,round((x+w)*image.width)-1))
        bottom=max(top,min(image.height-1,round((y+h)*image.height)-1))
        ImageDraw.Draw(image).rectangle((left,top,right,bottom), outline='#d87954', width=4)
        image.save(folder / (cid + '.png'))
        comment = {'id': cid, 'project_id': pid, 'timeline_version': doc['version'],
                   'clip_id': clip['id'], 'asset_position':{'x':clip.get('x',0),'y':clip.get('y',0)}, 'source_time': moment, 'region': box, 'note': note.strip(),
                   'created': time.time(), 'status': 'comment_saved', 'video_changed': False,
                   'image_url': '/api/quick/projects/'+pid+'/frame-comments/'+cid+'/image'}
        comments.append(comment)
        timeline.write(app.WORK / pid / 'frame-comments.json', comments)
        return comment


def route(handler, app, method):
    match = re.fullmatch('/api/quick/projects/('+timeline.ID+')/frame-comments(?:/('+timeline.ID+')(?:/(image))?)?',
                         urlparse(handler.path).path)
    if not match:
        return False
    pid, cid, image = match.groups()
    try:
        if method == 'POST' and cid is None:
            length = int(handler.headers.get('Content-Length', '0'))
            if not 0 < length <= 16000:
                raise ValueError('Invalid comment size.')
            handler.connection.settimeout(20)
            body = json.loads(handler.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('Expected a comment object.')
            result = create(app, pid, body)
        elif method == 'GET':
            with timeline.LOCK:
                comments = read(app, pid)
            if cid:
                result = next((c for c in comments if c['id'] == cid), None)
                if result is None:
                    return handler.json(404, {'error': 'Frame comment not found.'}) or True
                if image:
                    handler.media(app.WORK / pid / 'frame-comments' / (cid+'.png'), 'image/png')
                    return True
            else:
                result = {'comments': comments, 'capability': 'annotation_only',
                          'video_changed': False,
                          'instruction': 'These are source-frame change requests, not applied edits. Inspect the image before responding; do not claim a visual change was rendered.'}
        else:
            raise ValueError('Unsupported frame comment request.')
        handler.json(200, result)
    except timeline.Conflict as exc:
        handler.json(409, {'error': str(exc)})
    except (ValueError, FileNotFoundError, TypeError, KeyError, subprocess.TimeoutExpired) as exc:
        handler.json(400, {'error': str(exc)})
    return True
