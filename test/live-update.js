import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';

const home = await mkdtemp(tmpdir() + '/frame-live-test-');
const port = process.env.FRAME_LIVE_TEST_PORT || '4825';
const base = 'http://127.0.0.1:' + port;
const proc = spawn(process.execPath, [new URL('../bin/frame.js', import.meta.url).pathname, 'serve'],
  { env: { ...process.env, FRAME_PORT: port, FRAME_HOME: home, FRAME_NO_OPEN: '1', FRAME_PACE: '0' }, stdio: 'ignore' });
const exited = once(proc, 'exit');
const events = [];
const stop = new AbortController();
const post = async (path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  assert(response.ok && !result.error && !result.isError, JSON.stringify(result));
  return result;
};
const call = (name, args) => post('/api/call', { name, arguments: args });
const ui = (action, data) => post('/api/ui', { action, ...data });
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    const result = await fn();
    if (result) return result;
    await wait(35);
  }
  throw Error('Frame did not reach the expected state');
}

try {
  await until(async () => { try { return (await (await fetch(base + '/api/ping')).json()).pid === proc.pid; } catch { return false; } });
  await call('frame_start', { name: 'Cursor smoke' });
  for (const [i, id] of ['paper','ink'].entries()) {
    await call('frame_edit', { ops: [{ op: 'add_effect', start: 0, duration: 1, track: 'V'+(i+2), effect: 'live_graphic', label: id,
      params: { nodes: [{ kind: 'rect', id, x: .1, y: .1, w: .2, h: .2, fill: '#654321' }] } }] });
  }
  const stream = await fetch(base + '/api/events', { signal: stop.signal });
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  const read = (async () => {
    let pending = '';
    while (true) {
      const {done,value} = await reader.read();
      if (done) return;
      pending += value;
      const parts = pending.split('\n\n');
      pending = parts.pop();
      for (const part of parts) if (part.startsWith('data: ')) events.push(JSON.parse(part.slice(6)));
    }
  })().catch(error => { if (!stop.signal.aborted) throw error; });
  const initial = await until(() => events.find(e => e.type === 'state'));
  const node = id => initial.project.clips.find(c => c.label === id);
  await call('frame_edit', { fast:true, ops:[{op:'patch_graphic',id:node('ink').id,node_id:'ink',patch:{x:.25}}] });
  await until(() => events.find(e => e.type === 'project_delta' && e.clips?.some(c => c.id === node('ink').id)));
  const requests = await Promise.all(['paper','ink'].map(id => call('frame_prompt', { prompt: id+': fill=#998877', clip_id: node(id).id })));
  const ids = requests.map(r => JSON.parse(r.content[0].text).job_id);
  const ready = await until(() => events.find(e => e.promptJobs?.filter(j=>ids.includes(j.id)&&j.status==='ready').length === 2));
  assert.equal(ready.type, 'project_delta');
  assert.equal(ready.clips, undefined);
  for (const j of ready.promptJobs.filter(j=>ids.includes(j.id))) {
    assert((await ui('claim_prompt',{id:j.id,client:'smoke'})).ok);
    assert.equal((await ui('claim_prompt',{id:j.id,client:'another'})).ok,false);
    await ui('ops',{surface:'canvas',prompt_job:{id:j.id,client:'smoke'},ops:[{op:'patch_graphic',id:j.clip_id,node_id:j.node_id,patch:{fill:'#998877'}}]});
    const committed = await until(() => events.find(e=>e.clips?.some(c=>c.id===j.clip_id&&c.effect.params.nodes[0].fill==='#998877')));
    assert.equal(committed.clips.length,1);
    assert(committed.revisions.some(r=>r.method==='Live canvas control'));
  }
  assert.equal(events.filter(e=>e.type==='state').length, 1, 'prompt updates must not resend the project');
  const saved = JSON.parse(await readFile(home+'/projects/'+initial.project.id+'/project.json','utf8'));
  assert(saved.promptJobs.filter(j=>ids.includes(j.id)).every(j=>j.status==='done'&&j.revision_id));
  stop.abort();
  await read;
  console.log('Live update smoke passed: compact deltas, concurrent prompts, one claim owner, and durable canvas revisions.');
} finally {
  stop.abort();
  proc.kill();
  await exited;
  await rm(home,{recursive:true,force:true});
}
