// Run with scripts/record.mjs. A protocol client exercises the published MCP tool, without a model.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemo } from './live-title-demo.mjs';
import { HOME } from '../src/util.js';

const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 4e6 });

export default async function ({ out, evaluate, sleep, mark }) {
  const dir = out + '.evidence';
  fs.mkdirSync(dir);
  const report = { caller: 'Local MCP stdio protocol test', model: null, stages: {} };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/frame.js', import.meta.url)), 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const reader = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  async function rpc(method, params) {
    const expected = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: expected, method, params }) + '\n');
    const result = await reader.next();
    assert(!result.done, 'MCP server closed early');
    const reply = JSON.parse(result.value);
    assert.equal(reply.id, expected);
    assert(!reply.error, JSON.stringify(reply.error));
    return reply.result;
  }
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  const project = () => evaluate('window.__frame?.P');
  async function until(label, check, timeout = 10000) {
    const deadline = Date.now() + timeout;
    do {
      const result = await check();
      if (result) return result;
      await sleep(20);
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
  }
  const savePng = (name, png) => fs.writeFileSync(path.join(dir, name), Buffer.from(png.split(',')[1], 'base64'));
  async function render(project_id) {
    const submittedAt = Date.now();
    const reply = await call('frame_render', { project_id, quality: 'final', loudnorm: false, output_dir: dir });
    assert(!reply.isError, reply.content[0].text);
    const render = await until('completed render', () => evaluate('__frame.P.renders.at(-1)?.status === "done" && __frame.P.renders.at(-1)'));
    ffmpeg(['-xerror', '-i', render.file, '-f', 'null', '-']);
    assert.equal(render.duration, 10);
    await evaluate("document.querySelector('#backToTimeline').click()");
    return { file: path.basename(render.file), submittedAt, encoderStartedAt: render.startedAt, completedAt: render.endedAt, duration: render.duration };
  }
  const pink = `(d,i) => d[i] > 210 && d[i+1] < 155 && d[i+2] >= 75 && d[i+2] < 165`;
  const browserFrame = `(() => {
    const viewer = document.querySelector('#viewer');
    const d = viewer.getContext('2d').getImageData(0, 225, 680, 248).data;
    const pink = ${pink};
    let count = 0;
    for(let i = 0; i < d.length; i += 4) count += pink(d,i);
    return count > 1800 ? { at: Date.now(), t: __frame.T, count, png: viewer.toDataURL() } : null;
  })()`;
  try {
    assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'FRAME test', version: '1' } })).serverInfo.name, 'frame');
    assert((await rpc('tools/list')).tools.some(t => t.name === 'frame_revise_title'));
    await evaluate("document.querySelector('#present').click()");
    const seed = await seedDemo(dir);
    const { project_id } = seed;
    report.setup = { ...seed, source: path.basename(seed.source) };
    const before = await until('active demo project', async () => { const p = await project(); return p?.id === project_id && p.clips.length === 5 && p; });
    const target = before.clips.find(c => c.label === 'Main title');
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#rows .lane')).map(e => e.dataset.track).sort()"), ['A1', 'V1', 'V2', 'V3', 'V4']);
    report.exports = { before: await render(project_id) };

    // Start one pass and instrument the actual HTML media element once it is playing.
    await evaluate("document.querySelector('#loop').checked = true; __frame.seek(0); document.querySelector('#play').click()");
    await until('playing source', () => evaluate('__frame.T > 1.2 && [...__frame.slots.values()].filter(s => s.used && !s.el.paused && s.el.readyState >= 3).length === 2'));
    await evaluate(`(() => {
      const active = [...__frame.slots.values()].filter(s => s.used).map(s => s.el);
      const events = [];
      for (const media of active) {
        for (const type of ['pause','seeking','waiting','stalled','emptied','loadstart','volumechange','ratechange']) {
          media.addEventListener(type, () => events.push({ type, media: media.tagName, t: __frame.T }));
        }
      }
      window.liveWatch = { active, events, before: { t: __frame.T, media: active.map(m => m.currentTime), at: Date.now() } };
    })()`);
    const request = { project_id, label: 'Main title' };
    const failed = await call('frame_revise_title', { ...request, patch: { text: 'INVALID', size: 0.8 } });
    assert(failed.isError && /outside/.test(failed.content[0].text), failed.content[0].text);
    const rejected = await until('failed activity', () => evaluate('__frame.P.feed.findLast(e => e.op === "frame_revise_title" && e.phase === "failed")'));
    report.stages.invalid = { at: rejected.ts, message: rejected.text };
    assert.match(await evaluate("document.querySelector('#timelineActivity').textContent"), /Title edit failed/);
    assert.deepEqual((await project()).clips, before.clips);
    assert.equal(await evaluate(browserFrame), null);
    savePng('before-playing.png', await evaluate("document.querySelector('#viewer').toDataURL()"));
    const patch = { text: 'STILL\nROLLING.', color: '#ff536b', size: .19, x: .12, y: .44 };
    const submittedAt = Date.now();
    mark('mcp_request');
    const edited = await call('frame_revise_title', { ...request, patch });
    assert(!edited.isError, edited.content[0].text);
    const applied = JSON.parse(edited.content[0].text);
    assert.equal(applied.status, 'applied');
    const first = await until('revised canvas pixels during playback', () => evaluate(browserFrame), 2500);
    const cell = `document.querySelector('[data-id="${target.id}"]')`;
    assert.match(await evaluate(`${cell}.querySelector('.lb').textContent`), /STILL \/ ROLLING/);
    assert.equal(await evaluate(`${cell}.querySelector('.clipTask').textContent`), 'FRAME · Title edit');
    assert.match(await evaluate("document.querySelector('#timelineActivity').textContent"), /FRAME · Main title saved/);
    report.timeline = { title: await evaluate(`${cell}.querySelector('.lb').textContent`),
      task: await evaluate("document.querySelector('#timelineActivity').textContent") };
    savePng('after-playing.png', first.png);
    mark('updated_playing_frame');
    report.stages.revision = { submittedAt, ...applied, firstVisibleAt: first.at, previewTime: first.t };
    const after = await project();
    const expected = structuredClone(before.clips);
    Object.assign(expected.find(c => c.id === target.id).effect.params.nodes[0], patch);
    assert.deepEqual(after.clips, expected);
    assert.deepEqual(after.assets, before.assets);
    assert.equal(after.id, before.id);
    assert.equal(after.duration, before.duration);
    assert(after.revisions.some(r => r.id === applied.revision_id && r.components.length === 1));
    const saved = JSON.parse(fs.readFileSync(path.join(HOME, 'projects', project_id, 'project.json'), 'utf8'));
    assert.deepEqual(saved.clips, expected);
    assert(saved.revisions.some(r => r.id === applied.revision_id));
    report.diskVerified = true;

    await until('continuing playback', () => evaluate(`__frame.T > ${first.t} + .5`));
    const continuity = await evaluate(`(() => {
      const w = liveWatch, active = [...__frame.slots.values()].filter(s => s.used).map(s => s.el);
      return { sameMedia: active.length === w.active.length && active.every((m,i) => m === w.active[i]),
        tracks: active.map(m => ({ kind: m.tagName, paused: m.paused, muted: m.muted, volume: m.volume })),
        before: w.before, after: { t: __frame.T, media: active.map(m => m.currentTime), at: Date.now() }, events: w.events };
    })()`);
    assert(continuity.sameMedia && continuity.tracks.every(m => !m.paused));
    assert(continuity.tracks.some(m => m.kind === 'AUDIO' && !m.muted && m.volume > 0));
    assert.deepEqual(continuity.events, []);
    assert(continuity.after.t > first.t && first.t > continuity.before.t);
    assert(continuity.after.media.every((t, i) => Math.abs(t - continuity.before.media[i] - (continuity.after.t - continuity.before.t)) < .15));
    report.continuity = continuity;
    const unchanged = await call('frame_revise_title', { ...request, patch });
    assert.equal(JSON.parse(unchanged.content[0].text).status, 'unchanged');

    // Verify repeating is independent of the revision, then export the revised timeline.
    await until('one completed loop', () => evaluate('__frame.T < 1 && document.querySelector("#play").textContent !== "▶"'), 12000);
    report.repeatVerified = true;
    await evaluate("document.querySelector('#play').click()");
    report.exports.after = await render(project_id);
    const files = ['before','after'].map(k => path.join(dir, report.exports[k].file));
    const audioHash = file => ffmpeg(['-i', file, '-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 'md5', '-']).toString().trim();
    assert.equal(audioHash(files[0]), audioHash(files[1]));
    report.audioHash = audioHash(files[1]);
    const raw = file => ffmpeg(['-ss', first.t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'crop=680:248:0:224',
      '-c:v', 'rawvideo', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    const countPink = data => { let count = 0; for (let i = 0; i < data.length; i += 3) count += data[i] > 210 && data[i+1] < 155 && data[i+2] >= 75 && data[i+2] < 165; return count; };
    const [beforePink, afterPink] = files.map(f => countPink(raw(f)));
    assert(beforePink < 600 && afterPink > 1800 && Math.abs(first.count - afterPink) / first.count < .2,
      `Preview/export color changed unexpectedly: ${beforePink}, ${first.count}, ${afterPink}`);
    report.pixels = { beforeExport: beforePink, playingCanvas: first.count, afterExport: afterPink };
    await evaluate('location.reload(); undefined');
    const reopened = await until('reopened browser project', async () => { const p = await project(); return p?.id === project_id && p.clips.find(c => c.id === target.id)?.effect.params.nodes[0].text === patch.text && p; });
    assert.deepEqual(reopened.clips, expected);
    assert(reopened.revisions.some(r => r.id === applied.revision_id));
    report.reopenVerified = true;
    report.passed = true;
  } catch (error) {
    report.failure = error.message;
    throw error;
  } finally {
    child.kill();
    fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(report, null, 2));
  }
}
