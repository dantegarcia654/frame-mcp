import {build} from 'esbuild';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
for (const local of [false,true]) {
 const out=await build({entryPoints:[root+'editor.js'],bundle:true,format:'esm',minify:true,write:false,target:'es2022',...(local?{alias:{'@modelcontextprotocol/ext-apps':root+'local-adapter.js'}}:{})});
 const js=out.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
 writeFileSync(root+(local?'../frame_local.html':'../frame_widget.html'),readFileSync(root+'editor.html','utf8').replace('/* FRAME_WIDGET_SCRIPT */',()=>js));
}
