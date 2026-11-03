export const applyDocumentTheme=()=>{}, applyHostStyleVariables=()=>{};
export class App {
 async connect(){const id=new URL(location.href).searchParams.get('project');this.ontoolresult?.({structuredContent:id?{project_id:id}:{}})}
 getHostContext(){return {theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}}
 getHostCapabilities(){return {}}
 async updateModelContext(){}
 async requestDisplayMode(){if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen()}
 async sendMessage(){throw Error('Ask your Codex chat to read the saved Frame notes.')}
 async openLink({url}){if(new URL(url).origin!==location.origin)throw Error('Unexpected download origin');const a=document.createElement('a');a.href=url;a.download='Frame-export.mp4';a.click()}
 async callServerTool(request){const response=await fetch('/api/frame/tools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});if(!response.ok)throw Error('Frame request failed: '+response.status);return await response.json()}
}
