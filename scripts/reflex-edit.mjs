#!/usr/bin/env node
// Green Lantern reflex path: a small deterministic command -> a real FRAME timeline mutation.
// No screenshot loop, browser coordinates, image generation, or replacement timeline.
import { performance } from 'node:perf_hooks';
import { call } from '../src/mcp.js';

const help = `FRAME Reflex — immediate structured editing commands

Usage:
  node scripts/reflex-edit.mjs start "Project name"
  node scripts/reflex-edit.mjs title "A REAL EDIT" [start=0] [duration=3]
  node scripts/reflex-edit.mjs storyboard "Hook|Problem|Payoff" [seconds_per_card=3]
  node scripts/reflex-edit.mjs trim CLIP_ID [seconds=0.5] [start|end]
  node scripts/reflex-edit.mjs zoom CLIP_ID [scale=1.25]
  node scripts/reflex-edit.mjs cut [from=2] [to=3]

Optional: --new creates a scratch project before the operation.
Optional: --project=PROJECT_ID targets a saved project.

Examples:
  node scripts/reflex-edit.mjs storyboard "THE HOOK|THE REVEAL|THE PAYOFF" 2 --new
  node scripts/reflex-edit.mjs title "WATCH THIS" 0 2
  node scripts/reflex-edit.mjs zoom c_abc123 1.3

This is a deterministic command interface, NOT a free-form language parser.
It changes the actual FRAME project through frame_edit and reports wall-clock
request/response duration. That number is NOT a measurement of screen paint.
`;

const raw = process.argv.slice(2);
const createNew = raw.includes('--new');
const projectFlag = raw.find((a) => a.startsWith('--project='));
const args = raw.filter((a) => a !== '--new' && !a.startsWith('--project='));
const [verb, ...values] = args;
if (!verb || ['help', '--help', '-h'].includes(verb)) { console.log(help); process.exit(verb ? 0 : 1); }

function number(value, label, fallback, min = 0, max = Infinity) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be a number between ${min} and ${max}.`);
  return n;
}
function need(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}.\n\n${help}`);
  return value.trim();
}
function assertSuccess(result, tool) {
  const messages = (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (!result || result.isError || /^(Error:|Frame error:|Not applied\.)/.test(messages)) {
    throw new Error(`${tool} failed: ${messages || 'no response'}`);
  }
  // frame_edit reports individual op errors in its text even when the MCP call succeeds.
  if (tool === 'frame_edit' && /(?:^|\n)\d+\. ✗ /.test(messages)) {
    throw new Error(`An edit failed:\n${messages}`);
  }
  return messages;
}

try {
  let ops;
  let summary;
  if (verb === 'title') {
    ops = [{ op: 'add_text', text: need(values[0], 'title text'), start: number(values[1], 'start', 0), duration: number(values[2], 'duration', 3, 0.1), why: 'Show a real title on the editable timeline immediately' }];
    summary = 'Reflex: place a title';
  } else if (verb === 'storyboard') {
    const cards = need(values[0], 'storyboard text').split('|').map((s) => s.trim()).filter(Boolean);
    if (!cards.length || cards.length > 30) throw new Error('Provide 1 to 30 storyboard cards separated by |.');
    const seconds = number(values[1], 'seconds_per_card', 3, 0.1, 120);
    ops = cards.map((text, index) => ({ op: 'add_text', text, start: index * seconds, duration: seconds, why: `Storyboard card ${index + 1} of ${cards.length}` }));
    summary = 'Reflex: build a real, editable storyboard';
  } else if (verb === 'trim') {
    const id = need(values[0], 'clip ID');
    const by = number(values[1], 'trim duration', 0.5, 0.01);
    const edge = values[2] || 'end';
    if (!['start', 'end'].includes(edge)) throw new Error('edge must be start or end.');
    ops = [{ op: 'trim_clip', id, by, edge, why: 'Immediate non-destructive trim' }];
    summary = 'Reflex: trim footage';
  } else if (verb === 'zoom') {
    const id = need(values[0], 'clip ID');
    const scale = number(values[1], 'scale', 1.25, 0.1, 20);
    ops = [{ op: 'update_clip', id, scale, why: 'Immediate visible punch-in on source footage' }];
    summary = 'Reflex: zoom footage';
  } else if (verb === 'cut') {
    const from = number(values[0], 'from', 2);
    const to = number(values[1], 'to', 3);
    if (to <= from) throw new Error('cut requires to > from.');
    ops = [{ op: 'cut_range', from, to, why: 'Immediate timeline cut with ripple' }];
    summary = 'Reflex: remove a timeline range';
  } else if (verb !== 'start') {
    throw new Error(`Unknown command "${verb}".\n\n${help}`);
  }

  const projectId = projectFlag ? need(projectFlag.slice('--project='.length), 'project ID') : undefined;
  if (createNew && projectId) throw new Error('Choose --new or --project=ID, not both.');
  const started = performance.now();
  if (verb === 'start' || createNew) {
    const name = verb === 'start' ? (values[0] || 'Green Lantern') : 'Green Lantern reflex test';
    assertSuccess(await call('frame_start', { name }), 'frame_start');
  }
  if (ops) {
    const response = assertSuccess(await call('frame_edit', { project_id: projectId, ops, agent: 'Reflex' }), 'frame_edit');
    const lines = response.split('\n');
    console.log(lines.filter((line) => /^\d+\. /.test(line)).join('\n') || lines[0]);
  }
  console.log(`Elapsed command-to-service-response: ${Math.round(performance.now() - started)} ms (includes daemon startup if needed; excludes screen paint and export)`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
