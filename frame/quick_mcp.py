#!/usr/bin/env python3
"""Dependency-free MCP stdio bridge to the loopback Quick Edit API.

Run with the same Python as the editor. FRAME_URL defaults to localhost:8876.
No footage or service is published by this bridge.
"""
import json
import base64
import os
import re
import sys
import urllib.request
import urllib.error
import quick_widget
import quick_runtime

BASE=os.environ.get('FRAME_URL','http://127.0.0.1:8876').rstrip('/')
if not re.fullmatch(r'http://(?:127\.0\.0\.1|localhost):\d+',BASE):
    raise SystemExit('FRAME_URL must be loopback HTTP.')

def prop(kind,description):return {'type':kind,'description':description}
P=prop('string','Stable project identifier returned by upload or list_projects.')
V=prop('integer','Current timeline version; required for mutations. Re-read after a conflict.')
C=prop('string','Stable segment id returned by get_timeline.')
FILE={'type':'object','properties':{key:prop('string',description) for key,description in {
 'download_url':'Fresh HTTPS URL supplied by the conversation host. Never invent a URL.',
 'file_id':'Conversation attachment identifier.', 'mime_type':'Video MIME type if supplied.',
 'file_name':'Original filename if supplied.'}.items()},'required':['download_url','file_id'],'additionalProperties':False}
SPECS={
 'import_video':({'file':FILE},['file'],'Import video footage attached to the current conversation into FRAME. Call when a user attaches footage for editing. Use the host-provided file handoff. The result opens the Frame app for this project. Use editor_url only as a fallback in hosts without MCP Apps UI; no second upload is needed.'),
 'import_local_video':({'source_path':prop('string','Absolute path to video footage made available by the conversation host on this laptop.')},['source_path'],'Import conversation footage when the local host exposes an absolute video file path instead of a download URL. Return the Frame app for this exact imported project, with an editor URL fallback for hosts without UI.'),
 'get_frame_comments':({'project_id':P},['project_id'],'Read saved mouse-selected frame comments and requested visual changes. Comments are not applied edits.'),
 'get_frame_comment':({'project_id':P,'comment_id':prop('string','Frame comment identifier from get_frame_comments.')},['project_id','comment_id'],'Read one frame comment and its source-frame image with the selected area outlined. Visual pixel edits are not implemented by this tool.'),
 'list_projects':({},[],'List locally imported projects.'),
 'get_project':({'project_id':P},['project_id'],'Read the complete current FRAME revision, including source-anchored user notes, start/end pins, proposed edits, accepted operations, saved checkpoints and render status. Use this to receive edits left on the FRAME canvas in this chat. Reading does not apply edits.'),
 'get_timeline':({'project_id':P},['project_id'],'Read ordered clips with original-source times and version.'),
 'position_clip':({'clip_id':C,'x':prop('number','Horizontal offset as frame fraction: .01 = 1% right, -.01 = 1% left. Range -.5 to .5.'),'y':prop('number','Vertical offset as frame fraction: .01 = 1% down. Range -.5 to .5.')},['clip_id','x','y'],'Move the selected video asset slightly within the frame. Saved, previewed, undoable, and included in MP4 export. Does not move individual objects baked into video.'),
 'split_clip':({'clip_id':C,'source_time':prop('number','Split at original-source seconds.')},['clip_id','source_time'],'Split a clip without rendering.'),
 'trim_clip':({'clip_id':C,'start':prop('number','New source in seconds.'),'end':prop('number','New source out seconds.')},['clip_id','start','end'],'Trim a clip inside source bounds.'),
 'delete_segment':({'clip_id':C},['clip_id'],'Remove a segment; undo restores it.'),
 'move_segment':({'clip_id':C,'position':prop('integer','Destination index, zero based.')},['clip_id','position'],'Reorder a timeline segment.'),
 'undo':({},[],'Undo the previous timeline edit.'),
 'redo':({},[],'Redo an undone timeline edit.'),
 'export_video':({},[],'Queue a versioned FFmpeg MP4 export; poll get_project for status.'),
 'tighten_pacing':({'cut_first_seconds':prop('number','Seconds to cut from the edited timeline opening; use 3 for the sprint scenario.'),'remove_pauses':prop('boolean','Whether to remove measured low-energy pauses. Defaults true.')},[],'Cut opening and remove long low-energy pauses, retaining padding. Review and undo if necessary.')}
SPECS.update(quick_widget.specs(prop, P, V))

def tools():
    result=[]
    for name,(properties,required,description) in SPECS.items():
        properties=dict(properties);required=list(required)
        if name not in quick_widget.CUSTOM_TOOLS and name not in ('import_video','import_local_video','get_frame_comments','get_frame_comment','list_projects','get_project','get_timeline'):
            properties.update(project_id=P,expected_version=V);required+=['project_id','expected_version']
        result.append({'name':name,'description':description,'inputSchema':{'type':'object','properties':properties,'required':required,'additionalProperties':False},
                       'annotations':{'readOnlyHint':name in ('list_projects','get_project','get_timeline','get_frame_comments','get_frame_comment'),'destructiveHint':False,'openWorldHint':name=='import_video'}})
        if name=='import_video':result[-1]['_meta']={'openai/fileParams':['file']}
        quick_widget.decorate(result[-1])
    return result

def call(name,args):
    if name not in SPECS:raise ValueError('Unknown tool.')
    if name in quick_widget.CUSTOM_TOOLS:
        return quick_widget.call(name,args,BASE,call)
    if name in ('import_video','import_local_video'):
        import quick_import
        return quick_import.import_attachment(BASE,args.get('file')) if name=='import_video' else quick_import.import_local(BASE,args.get('source_path'))
    if name=='list_projects':path='/api/projects';body=None
    else:
        pid=args.get('project_id','')
        if not isinstance(pid,str) or not re.fullmatch('[a-f0-9]{32}',pid):raise ValueError('Invalid project id.')
        path='/api/quick/projects/'+pid
        body=None
        if name=='get_frame_comments':path+='/frame-comments'
        elif name=='get_frame_comment':
            cid=args.get('comment_id','')
            if not isinstance(cid,str) or not re.fullmatch('[a-f0-9]{32}',cid):raise ValueError('Invalid frame comment id.')
            path+='/frame-comments/'+cid
        elif name not in ('get_project','get_timeline'):
            path+='/commands';body=json.dumps({**{k:v for k,v in args.items() if k!='project_id'},'operation':name}).encode()
    req=urllib.request.Request(BASE+path,data=body,headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=180) as r:return json.load(r)
    except urllib.error.HTTPError as exc:raise ValueError(exc.read().decode()) from exc

def dispatch(req):
    method=req.get('method');rid=req.get('id')
    if rid is None:return None
    try:
        if method=='initialize':result={'protocolVersion':req.get('params',{}).get('protocolVersion','2024-11-05') if req.get('params',{}).get('protocolVersion') in ('2024-11-05','2025-03-26','2025-06-18','2025-11-25') else '2025-03-26','instructions':'Use open_editor to display Frame beside the conversation. Import tools also return the Frame UI. When the user attaches video footage for FRAME, import it from the current conversation with import_video (host file handoff) or import_local_video (host local path), display the returned Frame app. Use editor_url only if the host cannot render MCP Apps. Do not ask for a duplicate upload. When the user asks about a marked area, read get_frame_comments then get_frame_comment for the annotated source image. Comments alone do not change pixels. When the user leaves revisions on the FRAME canvas, call get_project to read its notes and pending proposals in this conversation. Do not imply that reading them approved or rendered them. These tools run on the user laptop; loopback editor links must be opened on that laptop.', 'capabilities':{'tools':{'listChanged':False},'resources':{'subscribe':False,'listChanged':False}},'serverInfo':{'name':'frame-quick-edit','version':'1.1.0'}}
        elif method=='ping':result={}
        elif method=='resources/list':result={'resources':[quick_widget.resource()]}
        elif method=='resources/templates/list':result={'resourceTemplates':[]}
        elif method=='resources/read':
            if req.get('params',{}).get('uri')!=quick_widget.URI:raise ValueError('Unknown UI resource.')
            result={'contents':[quick_widget.contents()]}
        elif method=='tools/list':result={'tools':tools()}
        elif method=='tools/call':
            try:
                value=call(req['params']['name'],req['params'].get('arguments',{}))
                video_data=value.pop('_video_base64',None) if isinstance(value,dict) else None
                result={'content':[{'type':'text','text':json.dumps(value)}],'structuredContent':value if isinstance(value,dict) else {'projects':value},'isError':False}
                if video_data is not None:result['_meta']={'videoChunk':video_data}
                if req['params']['name']=='get_frame_comment':
                    url=BASE+'/api/quick/projects/'+value['project_id']+'/frame-comments/'+value['id']+'/image'
                    with urllib.request.urlopen(url,timeout=30) as image:
                        data=image.read(4*1024*1024+1)
                    if len(data)>4*1024*1024:raise ValueError('Frame image is too large.')
                    result['content'].append({'type':'image','mimeType':'image/png','data':base64.b64encode(data).decode()})
            except Exception as exc:result={'content':[{'type':'text','text':str(exc)}],'isError':True}
        else:return {'jsonrpc':'2.0','id':rid,'error':{'code':-32601,'message':'Method not found'}}
        return {'jsonrpc':'2.0','id':rid,'result':result}
    except Exception as exc:return {'jsonrpc':'2.0','id':rid,'error':{'code':-32602,'message':str(exc)}}

def serve_http(port):
    # Stateless Streamable HTTP: JSON responses, no server-initiated SSE stream.
    import hmac
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    token=os.environ.get('FRAME_MCP_TOKEN','')
    if len(token)<32:raise SystemExit('Set FRAME_MCP_TOKEN to a random secret of at least 32 characters.')
    class Handler(BaseHTTPRequestHandler):
        def reply(self,status,value=None):
            data=json.dumps(value).encode() if value is not None else b''
            self.send_response(status);self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
        def do_GET(self):
            self.reply(405,{'error':'MCP endpoint accepts POST requests.'})
        def do_POST(self):
            if self.path!='/mcp':return self.reply(404,{'error':'Not found'})
            if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+token):
                self.close_connection=True;return self.reply(401,{'error':'Bearer token required'})
            origin=self.headers.get('Origin')
            if origin and origin not in ('http://127.0.0.1:'+str(port),'http://localhost:'+str(port)):
                self.close_connection=True;return self.reply(403,{'error':'Untrusted Origin'})
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=16000:raise ValueError('Invalid request length')
                self.connection.settimeout(20)
                req=json.loads(self.rfile.read(length))
                if not isinstance(req,dict):raise ValueError('Expected JSON-RPC object')
                if req.get('method')=='tools/call' and req.get('params',{}).get('name') in SPECS:
                    quick_runtime.ensure_server(BASE)
                response=dispatch(req)
                return self.reply(200,response) if response is not None else self.reply(202)
            except (ValueError,TypeError) as exc:self.reply(400,{'error':str(exc)})
        def log_message(self,*args):pass
    print('FRAME authenticated MCP: http://127.0.0.1:%d/mcp'%port,file=sys.stderr,flush=True)
    ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()

if __name__=='__main__':
    if '--http' in sys.argv:
        serve_http(int(os.environ.get('FRAME_MCP_PORT','8877')))
        sys.exit(0)
    for line in sys.stdin:
        try:
            request=json.loads(line)
            if request.get('method')=='tools/call' and request.get('params',{}).get('name') in SPECS:
                try:quick_runtime.ensure_server(BASE)
                except Exception as exc:
                    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{'isError':True,'content':[{'type':'text','text':str(exc)}]}}),flush=True)
                    continue
            result=dispatch(request)
            if result is not None:print(json.dumps(result),flush=True)
        except Exception as exc:
            print(json.dumps({'jsonrpc':'2.0','id':None,'error':{'code':-32700,'message':str(exc)}}),flush=True)
