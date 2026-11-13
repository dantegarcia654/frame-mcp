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
  console.log(`Frame ${VERSION}\nnode     ${process.version}\nffmpeg   ${ff.status === 0 ? ff.stdout.split('\n')[0] : 'MISSING — install ffmpeg (macOS: brew install ffmpeg · Windows: winget install Gyan.FFmpeg)'}\nwhisper  ${wh ?'installed (transcripts + captions available)' : 'not installed (optional: pip install -U openai-whisper)'}\nservice  ${ping ? `running at ${BASE}, ${ping.clients} window(s) open` : 'not running (starts on demand)'}\ndata     ${HOME}`);
} else {
  console.log(`Frame ${VERSION} — the live editing room for Claude

  frame mcp       run as an MCP server over stdio (what your MCP client launches)
  frame install   register Frame with Claude Code
  frame open      open the Frame window
  frame doctor    check ffmpeg / whisper / service
  frame call <tool> '<json>'   call a tool from the shell
  frame serve     run the local service in the foreground
  frame stop      stop the local service`);
}
