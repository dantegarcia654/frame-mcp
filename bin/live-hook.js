#!/usr/bin/env node
// Claude Code hook → Frame Live. Wire it to UserPromptSubmit, PreToolUse, PostToolUse and Stop.
// Reads the hook's JSON from stdin and posts one event to the Frame service.
// It must never slow Claude down or break it: short timeouts, no output on stdout (UserPromptSubmit stdout
// would be added to Claude's context), and it always exits 0.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.FRAME_PORT || 4747;
const BASE = `http://127.0.0.1:${PORT}`;
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'frame.js');
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (f) => (f ? path.basename(String(f)) : '');

/** A short human label for a tool call: [group, label, detail]. */
function describe(tool, i = {}) {
  const t = String(tool || '');
  if (t === 'Bash') return ['Shell', clip(i.description || i.command, 70), i.description ? clip(i.command, 110) : ''];
  if (t === 'Read') return ['Read', base(i.file_path), clip(i.file_path, 110)];
  if (t === 'Write') return ['Write', base(i.file_path), clip(i.file_path, 110)];
  if (t === 'Edit' || t === 'MultiEdit') return ['Edit', base(i.file_path), clip(i.file_path, 110)];
  if (t === 'Glob' || t === 'Grep') return ['Search', clip(i.pattern, 70), clip(i.path, 110)];
  if (t === 'Agent' || t === 'Task') return ['Agent', clip(i.description, 70), clip(i.prompt, 110)];
  if (t === 'Skill') return ['Skill', clip(i.skill, 70), ''];
  if (t === 'WebSearch') return ['Web', clip(i.query, 70), ''];
  if (t === 'WebFetch') return ['Web', clip(i.url, 70), ''];
  if (t === 'ToolSearch') return ['Tools', 'Loading tools', clip(i.query, 110)];
  const m = t.match(/^mcp__(.+?)__(.+)$/);
  if (m) {
    const [, server, name] = m;
    if (server === 'ccd_turn' && name === 'update_plan') return ['Plan', i.items ? `Plan: ${i.items.length} steps` : 'Next step', i.items ? clip(i.items.map((x) => x.content).join(' → '), 110) : ''];
    if (server === 'ccd_turn' && name === 'wrap_up') return ['Wrap up', clip(i.recap, 70), ''];
    if (server.startsWith('frame')) return ['Frame', name.replace(/^frame_/, '').replace(/_/g, ' '), clip(i.summary || i.text || i.why || '', 110)];
    if (server === 'Claude_Browser') return ['Browser', clip(i.action || name.replace(/_/g, ' '), 70), clip(i.url || '', 110)];
    return [clip(server, 18), name.replace(/_/g, ' '), ''];
  }
  return ['Tool', t, ''];
}

async function post(ev) {
  const r = await fetch(`${BASE}/api/live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev), signal: AbortSignal.timeout(700) });
  return r.json();
}

async function main() {
  let raw = ''; for await (const c of process.stdin) raw += c;
  let h = {}; try { h = JSON.parse(raw); } catch {}
  const name = h.hook_event_name || process.argv[2];
  const common = { session: h.session_id };
  let ev;
  if (name === 'UserPromptSubmit') ev = { kind: 'prompt', text: clip(h.prompt, 280), ...common };
  else if (name === 'PreToolUse' || name === 'PostToolUse') {
    const [group, label, detail] = describe(h.tool_name, h.tool_input);
    const failed = name === 'PostToolUse' && (h.tool_response?.is_error || h.tool_response?.isError || h.tool_response?.interrupted);
    ev = { kind: name === 'PreToolUse' ? 'tool_start' : 'tool_end', id: h.tool_use_id, tool: h.tool_name, group, label, detail, ok: !failed, ...common };
  } else if (name === 'Stop') ev = { kind: 'stop', ...common };
  if (!ev) return;
  try {
    const r = await post(ev);
    // Nothing is showing the panel: pop a window open, once, on a new prompt.
    if (ev.kind === 'prompt' && r && r.windows === 0 && !process.env.FRAME_LIVE_NO_OPEN) openWindow();
  } catch {
    // Service not running: start it on a new prompt and open the panel. Tool events are simply dropped.
    if (ev.kind === 'prompt') {
      spawn(process.execPath, [BIN, 'serve'], { detached: true, stdio: 'ignore' }).unref();
      for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 150)); try { await post(ev); if (!process.env.FRAME_LIVE_NO_OPEN) openWindow(); break; } catch {} }
    }
  }
}
function openWindow() {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [`${BASE}/live`], { detached: true, stdio: 'ignore' }).unref();
}
main().catch(() => {}).finally(() => { process.exitCode = 0; });
