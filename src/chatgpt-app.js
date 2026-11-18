// FRAME MCP Apps transport: expose the existing mobile editor as an inline ChatGPT widget.
// Deliberately local-only by default. Do not expose on a public interface without real authentication.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const URI='ui://frame/live-scenes/v2.html';
const MIME='text/html;profile=mcp-app';
const VERSION='2025-11-25';
const toolName='frame_open_visual';
const tool={
 name:toolName,
 title:'Open FRAME interactive visual editor',
 description:'Use FRAME by default whenever the user asks to generate, draw, animate, preview, or modify a visual scene, 3D object, rocket, animation, or video edit. Open the FRAME inline scene immediately so they can interact rather than waiting for a static image. This tool creates an editable procedural preview; it does not generate a real 3D mesh or automatically render a finished MP4. Do not call for unrelated text tasks.',
 outputSchema:{type:'object',properties:{project_id:{type:['string','null']},prompt:{type:'string'},mode:{type:'string'},editable:{type:'boolean'}},required:['project_id','prompt','mode','editable']},
 inputSchema:{type:'object',properties:{
   prompt:{type:'string',description:'The user\'s requested visual scene or modification.'},
   project_id:{type:'string',description:'Optional existing FRAME project identifier.'}
 },required:['prompt'],additionalProperties:false},
 annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
 _meta:{ui:{resourceUri:URI},'openai/outputTemplate':URI,'openai/toolInvocation/invoking':'Opening FRAME scene','openai/toolInvocation/invoked':'FRAME scene ready'}
};
function resource(){
 let html=fs.readFileSync(path.join(ROOT,'mobile','index.html'),'utf8');
 // The mobile UI is owned by FRAME; the resource is served directly, not embedded from Wix.
 const bridge=`<script>
 (function(){
   let initialized=false,lastPrompt='';
   function apply(args){
     const prompt=args?.prompt;
     if(typeof prompt!=='string'||!prompt.trim())return;
     const signature=JSON.stringify(args);
     if(lastPrompt===signature)return;
     lastPrompt=signature;
     if(window.frameApp?.apply)window.frameApp.apply(prompt,{source:"mcp",project_id:args?.project_id});
     else window.setTimeout(function(){if(window.frameApp?.apply)window.frameApp.apply(prompt,{source:"mcp",project_id:args?.project_id})},0);
   }
   window.addEventListener('message',function(event){
     if(event.source!==window.parent)return;
     const message=event.data;
     if(message?.id==='frame-init'&&message?.result){
       initialized=true;
       window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');
       if(window.openai?.toolInput)apply(window.openai.toolInput);
     }
     if(!initialized)return;
     if(message?.method==='ui/notifications/tool-input')apply(message.params?.arguments);
     if(message?.method==='ui/notifications/tool-result'){
       const result=message.params?.structuredContent;
       if(result)apply({prompt:result.prompt,project_id:result.project_id||undefined});
     }
   });
   if(window.parent!==window){
     window.parent.postMessage({
       jsonrpc:'2.0',id:'frame-init',method:'ui/initialize',
       params:{protocolVersion:'2026-01-26',appInfo:{name:'frame-live-scenes',version:'0.1.1'},appCapabilities:{availableDisplayModes:['inline','fullscreen']}}
     },'*');
   }
   if(window.openai?.toolInput)apply(window.openai.toolInput);
 })();
 <\/script>`;
 html=html.replace('</body>',bridge+'</body>');
 return {contents:[{uri:URI,mimeType:MIME,text:html,_meta:{ui:{prefersBorder:false},'openai/ui':{availableDisplayModes:['inline','fullscreen']}}}]};
}
function handle(message){
 const {method,params={},id}=message;
 if(method==='initialize')return {protocolVersion:VERSION,capabilities:{tools:{},resources:{}},serverInfo:{name:'frame-chatgpt',title:'FRAME Live Scenes',version:'0.1.1'},instructions:'For supported visual scene and editing requests, call frame_open_visual immediately to render an inline, editable FRAME interface. Do not promise automatic routing for all conversations; the host controls invocation.'};
 if(method==='ping')return {};
 if(method==='tools/list')return {tools:[tool]};
 if(method==='resources/list')return {resources:[{uri:URI,name:'FRAME Live Scenes',mimeType:MIME,description:'Interactive FRAME-owned editor for ChatGPT'}]};
 if(method==='resources/read'){
   if(params.uri!==URI)throw Object.assign(new Error('Resource not found'),{rpcCode:-32002});
   return resource();
 }
 if(method==='tools/call'){
   if(params.name!==toolName)throw Object.assign(new Error('Unknown tool'),{rpcCode:-32602});
   const prompt=params.arguments?.prompt;
   if(typeof prompt!=='string'||!prompt.trim()||prompt.length>4000)throw Object.assign(new Error('prompt is required (max 4000 characters)'),{rpcCode:-32602});
   const args=params.arguments;
   if(Object.keys(args).some(key=>!['prompt','project_id'].includes(key)) ||
      (args.project_id!==undefined && (typeof args.project_id!=='string'||!args.project_id.trim()||args.project_id.length>128)))
     throw Object.assign(new Error('Invalid arguments: project_id must be a non-empty string (max 128 characters)'),{rpcCode:-32602});
   const out={project_id:params.arguments?.project_id||null,prompt,mode:'interactive-procedural-preview',editable:true};
   return {content:[{type:'text',text:'FRAME interactive preview opened for: '+prompt}],structuredContent:out,_meta:{ui:{resourceUri:URI},'openai/outputTemplate':URI}};
 }
 if(method==='notifications/initialized')return null;
 throw Object.assign(new Error('Method not found'),{rpcCode:-32601});
}
export function startChatGptApp({host=process.env.FRAME_APP_HOST||'127.0.0.1',port=Number(process.env.FRAME_APP_PORT||4777)}={}){
 // A static bearer secret is not ChatGPT OAuth. Keep this scaffold private even when a token is set.
 if(!['127.0.0.1','::1','localhost'].includes(host))throw Error('Loopback binding required; use Secure MCP Tunnel or an authenticated HTTPS gateway');
 const server=http.createServer(async(req,res)=>{
   const address=server.address();
   const actualPort=typeof address==='object'?address.port:port;
   const hosts=new Set(['localhost:'+actualPort,'127.0.0.1:'+actualPort,'[::1]:'+actualPort]);
   if(!hosts.has(req.headers.host)){res.writeHead(403);res.end('Host not allowed');return}
   const origin=req.headers.origin;
   const configured=(process.env.FRAME_APP_ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
   const allowed=new Set(['http://localhost:'+actualPort,'http://127.0.0.1:'+actualPort,...configured]);
   if(origin&&!allowed.has(origin)){res.writeHead(403);res.end('Origin not allowed');return}
   if(req.url!=='/mcp'){res.writeHead(404);res.end('Not found');return}
   if(process.env.FRAME_APP_TOKEN && req.headers.authorization!=='Bearer '+process.env.FRAME_APP_TOKEN){res.writeHead(401);res.end('Unauthorized');return}
   if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});res.end();return}
   let size=0,chunks=[];
   try{for await(const part of req){size+=part.length;if(size>128*1024){res.writeHead(413);res.end('Too large');return}chunks.push(part)}}catch{res.destroy();return}
   let msg;
   try{msg=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{res.writeHead(400);res.end('Invalid JSON');return}
   if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'){res.writeHead(400);res.end('Invalid JSON-RPC');return}
   if(msg.id===undefined){res.writeHead(202);res.end();return}
   let response;
   try{response={jsonrpc:'2.0',id:msg.id,result:handle(msg)}}
   catch(e){response={jsonrpc:'2.0',id:msg.id,error:{code:e.rpcCode||-32603,message:e.message}}}
   res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
   res.end(JSON.stringify(response));
 });
 return server.listen(port,host,()=>console.log('FRAME MCP App listening at http://'+host+':'+port+'/mcp'));
}
// Private tunnel alternative using the exact same handlers, without any HTTP listener.
export function startChatGptStdio(){
 const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
 input.on('line',line=>{
   let msg;
   try{msg=JSON.parse(line)}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');return}
   if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'){
     process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}})+'\n');return;
   }
   if(msg.id===undefined)return;
   let response;
   try{response={jsonrpc:'2.0',id:msg.id,result:handle(msg)}}
   catch(e){response={jsonrpc:'2.0',id:msg.id,error:{code:e.rpcCode||-32603,message:e.message}}}
   process.stdout.write(JSON.stringify(response)+'\n');
 });
 return input;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--stdio'))startChatGptStdio();else startChatGptApp();
}
