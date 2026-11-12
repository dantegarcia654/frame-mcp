// MCP stdio server. A thin bridge: it makes sure the Frame daemon is running, then forwards tool calls to it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';
import { VERSION, BASE, sleep } from './util.js';
import { TOOLS, INSTRUCTIONS } from './tools.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'frame.js');

async function ping() { try { const r = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; } }

export async function ensureDaemon() {
  let p = await ping();
  if (p && p.name === 'frame' && p.version !== VERSION) { // an older Frame is running: replace it
    try { await fetch(`${BASE}/api/shutdown`, { method: 'POST' }); } catch {}
    await sleep(400); p = null;
  }
  if (p) return p;
  spawn(process.execPath, [BIN, 'serve'], { detached: true, stdio: 'ignore', env: process.env }).unref();
  for (let i = 0; i < 50; i++) { await sleep(120); p = await ping(); if (p) return p; }
  throw new Error(`Frame could not start its local service on ${BASE}. Is another program using that port? Set FRAME_PORT to change it.`);
}

export async function call(name, args) {
  await ensureDaemon();
  const r = await fetch(`${BASE}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
  return r.json();
}

export function startMcp() {
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  ensureDaemon().catch(() => {});
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const reply = (result) => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code, message) => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    try {
      switch (m.method) {
        case 'initialize':
          return reply({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'frame', title: 'Frame', version: VERSION }, instructions: INSTRUCTIONS });
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools: TOOLS });
        case 'tools/call': {
          try { return reply(await call(m.params.name, m.params.arguments || {})); }
          catch (e) { return reply({ content: [{ type: 'text', text: `Frame error: ${e.message}` }], isError: true }); }
        }
        case 'resources/list': return reply({ resources: [] });
        case 'prompts/list': return reply({ prompts: [] });
        default:
          if (m.method?.startsWith('notifications/')) return;
          return fail(-32601, `Method not found: ${m.method}`);
      }
    } catch (e) { fail(-32603, e.message); }
  });
  rl.on('close', () => process.exit(0));
}
