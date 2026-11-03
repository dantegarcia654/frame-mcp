import {build} from 'esbuild';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const out=await build({entryPoints:[root+'editor.js'],bundle:true,format:'esm',minify:true,write:false,target:'es2022'});
const js=out.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
writeFileSync(root+'../frame_widget.html',readFileSync(root+'editor.html','utf8').replace('/* FRAME_WIDGET_SCRIPT */',()=>js));
