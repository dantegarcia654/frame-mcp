#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION, BASE, HOME } from '../src/util.js';

const [cmd = 'mcp', ...rest] = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);

if (cmd === 'serve') {
  (await import('../src/daemon.js')).startDaemon();
} else if (cmd === 'mcp') {
  (await import('../src/mcp.js')).startMcp();
} else if (cmd === 'call') {
  // frame call <tool> '<json args>' — drive Frame from a shell exactly as an MCP client would.
  const { call } = await import('../src/mcp.js');
  const r = await call(rest[0], rest[1] ? JSON.parse(rest[1]) : {});
  for (const c of r.content || []) console.log(c.type === 'text' ? c.text : `[${c.type} ${c.mimeType}, ${Math.round(c.data.length * 0.75 / 1024)} KB]`);
  // exitCode, not process.exit(): on Windows, exiting while fetch's socket is still closing aborts Node
  // ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)") and the shell sees a failure.
  process.exitCode = r.isError ? 1 : 0;
} else if (cmd === 'speedrun') {
  // frame speedrun <file> [--name "..."] [--model base.en] [--no-render]
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const file = rest.find((a, i) => !a.startsWith('--') && !['--name', '--model'].includes(rest[i - 1]));
  if (!file) { console.log('Usage: frame speedrun <video file> [--name "Project name"] [--model <whisper model>, forces Whisper] [--no-render]'); process.exit(1); }
  const { speedrun } = await import('../src/speedrun.js');
  try { await speedrun(file, { name: opt('--name'), model: opt('--model'), render: !rest.includes('--no-render') }); }
  catch (e) { console.error(`Speed run stopped: ${e.message}`); process.exitCode = 1; }
} else if (cmd === 'open') {
  const { ensureDaemon } = await import('../src/mcp.js');
  await ensureDaemon();
  spawnSync(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [BASE]);
  console.log(BASE);
} else if (cmd === 'stop') {
  try { await fetch(`${BASE}/api/shutdown`, { method: 'POST' }); console.log('Frame stopped.'); } catch { console.log('Frame was not running.'); }
} else if (cmd === 'install') {
  // Registers Frame with Claude Code for this user.
  // On Windows `claude` is a .cmd shim, which Node can only start through a shell, so quote each argument ourselves.
  const claude = (args, opts) => process.platform === 'win32'
    ? spawnSync(['claude', ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' '), { shell: true, ...opts })
    : spawnSync('claude', args, opts);
  const has = claude(['--version'], { encoding: 'utf8' });
  if (has.status !== 0) { console.log(`Claude Code CLI not found. Add this to your MCP client config instead:\n\n{ "mcpServers": { "frame": { "command": "node", "args": [${JSON.stringify(self)}, "mcp"] } } }`); process.exit(1); }
  claude(['mcp', 'remove', 'frame', '-s', 'user'], { stdio: 'ignore' });
  const r = claude(['mcp', 'add', 'frame', '-s', 'user', '--', process.execPath, self, 'mcp'], { stdio: 'inherit' });
  if (r.status === 0) console.log('\nFrame is installed. Start a new Claude Code session and say: "edit this video with Frame".');
  process.exit(r.status ?? 1);
} else if (cmd === 'doctor') {
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  // Windows has no python3 (that name opens the Microsoft Store); it is python or py there.
  const wh = ['python3', 'python', 'py'].some((py) => spawnSync(py, ['-c', 'import whisper'], { encoding: 'utf8' }).status === 0);
  let ping = null; try { ping = await (await fetch(`${BASE}/api/ping`)).json(); } catch {}
  const { findChrome } = await import('../src/text.js'), { cutoutEngine } = await import('../src/cutout.js');
  const chrome = findChrome(), cut = await cutoutEngine(), dz = (await import('../src/decide.js')).decisionsConfig();
  const speech = await (await import('../src/media.js')).transcriber();
  console.log(`Frame ${VERSION}\nnode     ${process.version}\nffmpeg   ${ff.status === 0 ? ff.stdout.split('\n')[0] : 'MISSING — install ffmpeg (macOS: brew install ffmpeg · Windows: winget install Gyan.FFmpeg)'}\nspeech   ${speech ? `${speech.label} (transcripts + captions available)` : 'no engine — macOS 26+: xcode-select --install · anywhere: pip install -U openai-whisper'}\nwhisper  ${wh ? 'installed (fallback engine)' : 'not installed (optional fallback: pip install -U openai-whisper)'}\nchrome   ${chrome ? `${chrome} (draws captions and effects)` : 'not found — captions and effect clips need Chrome, Chromium, Edge or Brave'}\ncutout   ${cut.id ? cut.label : `not available: ${cut.reason}`}\nlabels   ${dz.on ? `on: gemini-decision-1, key from ${dz.source} (uploads a 360 px copy of each imported clip to Google)` : `off: ${dz.reason}`}\nservice  ${ping ? `running at ${BASE}, ${ping.clients} window(s) open` : 'not running (starts on demand)'}\ndata     ${HOME}`);
} else {
  console.log(`Frame ${VERSION} — the live editing room for Claude

  frame mcp       run as an MCP server over stdio (what your MCP client launches)
  frame install   register Frame with Claude Code
  frame open      open the Frame window
  frame doctor    check ffmpeg / whisper / chrome / cutout / service
  frame call <tool> '<json>'   call a tool from the shell
  frame speedrun <file>        raw clip → cut, vertical crop, punch-ins, captions, render (live in the window)
  frame serve     run the local service in the foreground
  frame stop      stop the local service`);
}
