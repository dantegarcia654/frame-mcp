// Browser evidence runner for scripts/record.mjs. Uses the real composer and canvas controls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const width = 640, height = 360, fps = 24;
const oldTitle = 'FIRST LOOK', newTitle = 'TAKE TWO';
const prompt = `Change the Main title to “${newTitle}”.`;
const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 4 * 1024 * 1024 });
// Measure the glyphs below the prompt badge and above the selection handles.
const region = { x: 40, y: 184, width: 312, height: 38 };
const media = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
const rgb = (file, t, crop = region) => ffmpeg([...(t == null ? [] : ['-ss', String(t)]),
  '-i', file, '-frames:v', '1', ...(crop ? ['-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`] : []),
  '-c:v', 'rawvideo', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
const pixels = (left, right, size = region) => {
  assert.equal(left.length, size.width * size.height * 3);
  assert.equal(right.length, left.length);
  let diff = 0, intersection = 0, union = 0;
  for (let i = 0; i < left.length; i += 3) {
    diff += Math.abs(left[i] - right[i]) + Math.abs(left[i + 1] - right[i + 1]) + Math.abs(left[i + 2] - right[i + 2]);
    const a = left[i] > 180 && left[i + 1] > 180 && left[i + 2] > 180;
    const b = right[i] > 180 && right[i + 1] > 180 && right[i + 2] > 180;
    intersection += a && b;
    union += a || b;
  }
  return { meanRgbError: diff / left.length, brightMaskIoU: union ? intersection / union : null };
};

export default async function ({ out, evaluate, sleep, mark }) {
  const dir = out + '.evidence';
  fs.mkdirSync(dir);
  const report = { source: 'Synthetic FFmpeg fixture', assetGenerationMs: null, prompt, checks: {}, exports: {} };
  const save = () => fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
  const base = `http://127.0.0.1:${process.env.FRAME_PORT || 4747}`;
  async function until(label, fn, timeout = 12000) {
    const end = Date.now() + timeout;
    do {
      const value = await fn();
      if (value) return value;
      await sleep(30);
    } while (Date.now() < end);
    throw new Error(`Timed out waiting for ${label}`);
  }
  async function post(endpoint, data) {
    const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(120000) });
    const result = await response.json();
    const message = result.content?.map(c => c.text).join('\n') || result.error;
    assert(response.ok && !result.isError && !result.error, message);
    return message;
  }
  const call = (name, args) => post('/api/call', { name, arguments: args });
  const project = () => evaluate('window.__frame?.P');
  const seek = t => evaluate(`__frame.seek(${t})`);
  async function frame(name, t) {
    await seek(t);
    const png = await until('decoded source at the requested playhead', () => evaluate(`(() => {
      const video = Array.from(__frame.slots.values()).find(slot => slot.used)?.el;
      if (!video || video.seeking || video.readyState < 2 || Math.abs(video.currentTime - ${t}) > .03) return null;
      return document.querySelector('#viewer').toDataURL('image/png');
    })()`));
    const file = path.join(dir, name + '.png');
    fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
    return file;
  }
  async function render(name, id) {
    const submittedAt = Date.now();
    const result = await call('frame_render', { project_id: id, quality: 'final', loudnorm: false, output_dir: dir });
    assert(!/⚠/.test(result), result);
    const run = await until('finished export', () => evaluate('__frame.P.renders.at(-1)?.status === "done" && __frame.P.renders.at(-1)'));
    const probe = media(run.file);
    assert.deepEqual(probe.streams.map(s => s.codec_name), ['h264', 'aac']);
    assert.deepEqual([run.width, run.height], [width, height]);
    assert(Math.abs(Number(probe.format.duration) - 10) <= 1 / fps);
    ffmpeg(['-xerror', '-i', run.file, '-f', 'null', '-']);
    report.exports[name] = { file: path.basename(run.file), seconds: Number(probe.format.duration), bytes: run.bytes,
      submittedAt, encoderStartedAt: run.startedAt, completedAt: run.endedAt, effectFramesDrawn: Number(result.match(/Drew (\d+) new effect/)?.[1] || 0) };
    await evaluate("document.querySelector('#backToTimeline').click()");
    save();
    return run.file;
  }
  try {
    const source = path.join(dir, 'synthetic-fixture.mp4');
    let started = Date.now();
    ffmpeg(['-f', 'lavfi', '-i', 'gradients=s=640x360:r=24:d=10:c0=0x142337:c1=0x293f82:c2=0x336470:n=3:seed=3:speed=0.09',
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=10', '-vf', 'drawgrid=w=48:h=48:t=1:c=white@0.12',
      '-af', 'volume=0.18', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source]);
    report.assetGenerationMs = Date.now() - started;
    started = Date.now();
    await call('frame_start', { name: 'Scoped revision — synthetic fixture', aspect: `${width}x${height}`, fps });
    const id = (await until('project to open', project)).id;
    await post('/api/ui', { action: 'import', project_id: id, paths: [source], test_context: 'automated-ui-check' });
    const ops = [
      { op: 'add_clip', asset: 'a1', out: 5.5, label: 'Source framing' },
      { op: 'add_clip', asset: 'a1', in: 5.5, out: 10, scale: 1.18, label: 'Punch-in' },
      { op: 'add_effect', effect: 'live_graphic', label: 'Fixture marker', track: 'V2', start: 0, duration: 10,
        params: { nodes: [{ kind: 'text', id: 'fixture-marker', x: .065, y: .115, size: .028, font: 'mono', color: '#d0d7e3', text: 'SYNTHETIC TEST FIXTURE' }] } },
      { op: 'add_effect', effect: 'live_graphic', label: 'Main title', track: 'V3', start: 2, duration: 5,
        params: { nodes: [{ kind: 'text', id: 'main-title', x: .065, y: .51, size: .12, font: 'sans', weight: 800, color: '#f8f4e9', text: oldTitle }] } }
    ];
    const result = await call('frame_edit', { project_id: id, agent: 'Fixture setup', ops });
    assert(!/✗/.test(result), result);
    const before = await until('four timeline clips', async () => { const p = await project(); return p.clips.length === 4 && p; });
    assert.equal(before.duration, 10);
    report.setupMs = Date.now() - started;
    const original = await render('before', id);
    const t = 3.5;
    await seek(0);
    await evaluate("document.querySelector('#play').click()");
    for (const second of [1, 4, 6, 9.7]) {
      await until(`source playback after ${second}s`, () => evaluate(`__frame.T >= ${second} && Array.from(__frame.slots.values()).some(s => s.used && s.el.readyState >= 2 && !s.el.paused)`));
    }
    await until('end of original playback', () => evaluate('__frame.T === 10'));
    report.checks.originalPlayedSeconds = 10;
    await frame('browser-before', t);

    mark('request_submission');
    const submittedAt = await evaluate(`(() => {
      const form = document.querySelector('#composer');
      form.querySelector('textarea').value = ${JSON.stringify(prompt)};
      const at = Date.now();
      form.requestSubmit();
      return at;
    })()`);
    const job = await until('canvas prompt result', () => evaluate(`(() => {
      const job = __frame.P.promptJobs?.find(j => j.prompt === ${JSON.stringify(prompt)});
      return ['done','failed','needs_input','conflict','cancelled'].includes(job?.status) ? job : null;
    })()`));
    report.revision = { submittedAt, queuedAt: job.createdAt, executionStartedAt: job.claimedAt,
      committedAt: job.finishedAt, status: job.status, provider: job.route?.provider, externalApiMs: job.route?.api_ms, phase: job.phase };
    save();
    assert.equal(job.status, 'done', job.phase);
    assert.equal(job.route.provider, 'local-title');
    assert(job.revision_id);
    const after = await project();
    const expected = structuredClone(before.clips);
    expected.find(c => c.id === job.clip_id).effect.params.nodes[0].text = newTitle;
    assert.deepEqual(after.clips, expected);
    assert.deepEqual(after.assets, before.assets);
    assert.deepEqual(after.markers, before.markers);
    assert.equal(after.duration, before.duration);
    report.checks.onlyTitleTextChanged = true;
    const updated = await frame('browser-after', t);
    report.revision.updatedPausedFrameObservedAt = Date.now();
    const renderedTitle = rgb(updated);
    assert(pixels(rgb(path.join(dir, 'browser-before.png')), renderedTitle).brightMaskIoU < .72, 'Browser title pixels never changed');

    const resumeAt = await evaluate("document.querySelector('#play').click(); Date.now()");
    const firstPlaying = await until('first playing updated title frame', () => evaluate(`(() => {
      const viewer = document.querySelector('#viewer');
      const active = Array.from(__frame.slots.values()).some(s => s.used && !s.el.paused && !s.el.seeking && s.el.readyState >= 2);
      if (!active || __frame.T <= ${t} || __frame.T >= 5.5) return null;
      return { at: Date.now(), t: __frame.T, png: viewer.toDataURL('image/png') };
    })()`));
    const firstPath = path.join(dir, 'browser-playing-after.png');
    fs.writeFileSync(firstPath, Buffer.from(firstPlaying.png.split(',')[1], 'base64'));
    assert(pixels(renderedTitle, rgb(firstPath)).brightMaskIoU > .9);
    mark('first_updated_playback');
    Object.assign(report.revision, { resumeAt, firstPlayableAt: firstPlaying.at, firstPlayableTime: firstPlaying.t });
    await until('updated playback reaching the punch-in', () => evaluate('__frame.T >= 8 && __frame.T < 10'));
    await evaluate("document.querySelector('#play').click()");
    const revised = await render('after', id);
    mark('export_complete');
    await render('unchangedRepeat', id);

    for (const second of [1, 8]) {
      const a = rgb(original, second, null), b = rgb(revised, second, null);
      const comparison = pixels(a, b, { width, height });
      assert(comparison.meanRgbError < 2, `Unrelated pixels changed at ${second}s`);
      report.checks[`outsideTitleAt${second}s`] = comparison;
    }
    const audioHash = file => ffmpeg(['-i', file, '-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 'md5', '-']).toString();
    assert.equal(audioHash(revised), audioHash(original), 'Decoded audio changed');
    report.checks.decodedAudioIdentical = true;
    report.checks.beforePreviewExport = pixels(rgb(path.join(dir, 'browser-before.png')), rgb(original, t));
    report.checks.afterPreviewExport = pixels(renderedTitle, rgb(revised, t));
    assert(report.checks.beforePreviewExport.brightMaskIoU > .88 && report.checks.afterPreviewExport.brightMaskIoU > .88);
    assert(pixels(rgb(original, t), rgb(revised, t)).brightMaskIoU < .72);
    await call('frame_revisions', { project_id: id, action: 'revert', revision_id: job.revision_id, agent: 'Fixture verification' });
    await until('title revision to revert', async () => {
      const p = await project();
      return p.clips.find(c => c.id === job.clip_id).effect.params.nodes[0].text === oldTitle;
    });
    assert.deepEqual((await project()).clips, before.clips);
    await frame('browser-reverted', t);
    assert(pixels(rgb(path.join(dir, 'browser-before.png')), rgb(path.join(dir, 'browser-reverted.png'))).brightMaskIoU > .98);
    report.checks.revisionReverted = true;
    report.passed = true;
  } catch (error) {
    report.failure = error.message;
    throw error;
  } finally {
    save();
    console.log(`Evidence: ${path.join(dir, 'evidence.json')}`);
  }
}
