// Drive the real MCP server and FRAME viewer with the CC0 flower clip. Run via record.mjs.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from '../src/util.js';

const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const writeData = (file, url) => fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));

export default async function ({ out, evaluate, sleep, mark }) {
  const dir = out + '.evidence';
  fs.mkdirSync(dir);
  const original = process.env.FRAME_REFRAME_SOURCE;
  assert(original, 'Set FRAME_REFRAME_SOURCE to the downloaded CC0 flower clip.');
  const source = path.join(dir, 'source-with-test-score.mp4');
  // The stock clip is silent. Use an original, sustained three-note bed to expose any playback gaps.
  ffmpeg('-i', path.resolve(original), '-f', 'lavfi', '-i',
    'aevalsrc=0.065*(sin(2*PI*220*t)+0.6*sin(2*PI*329.63*t)+0.38*sin(2*PI*440*t))*(0.8+0.2*cos(2*PI*0.8*t)):s=48000',
    '-map', '0:v', '-map', '1:a', '-t', '5', '-c:v', 'copy', '-c:a', 'aac', source);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/frame.js', import.meta.url)), 'mcp'],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const transcript = path.join(dir, 'mcp.jsonl');
  const log = (direction, packet) => fs.appendFileSync(transcript, JSON.stringify({ at: Date.now(), direction, packet }) + '\n');
  let id = 0;
  async function rpc(method, params) {
    const packet = { jsonrpc: '2.0', id: ++id, method, params };
    log('request', packet);
    child.stdin.write(JSON.stringify(packet) + '\n');
    const next = await lines.next();
    assert(!next.done, 'MCP server stopped');
    const reply = JSON.parse(next.value);
    log('response', reply);
    assert.equal(reply.id, packet.id);
    assert(!reply.error, JSON.stringify(reply.error));
    return reply.result;
  }
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  async function tool(name, args) {
    const result = await call(name, args);
    const text = result.content[0].text;
    assert(!result.isError && !/^\d+\. ✗/m.test(text), text);
    return text;
  }
  async function until(expression, timeout = 12000) {
    const deadline = Date.now() + timeout;
    do {
      const value = await evaluate(expression);
      if (value) return value;
      await sleep(12);
    } while (Date.now() < deadline);
    throw new Error('Timed out: ' + expression);
  }
  const report = { caller: 'Local MCP stdio protocol client', model: null, trials: [] };

  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'FRAME reframe benchmark', version: '1' }, capabilities: {} });
    const tools = await rpc('tools/list', {});
    assert(tools.tools.some(tool => tool.name === 'frame_reframe'));
    const start = await tool('frame_start', { name: 'Bloom · live reframe', aspect: '960x540', fps: 30 });
    const project_id = start.match(/\((p_\w+)\)/)[1];
    await tool('frame_import', { project_id, paths: [source], prepare: false, decide: false });
    await tool('frame_edit', { project_id, fast: true, ops: [
      { op: 'name_track', track: 'V1', name: 'Picture + source audio' },
      { op: 'add_clip', asset: 'a1', label: 'Moss rose · time-lapse', out: 5 },
    ] });
    const before = await until(`__frame.P?.id === '${project_id}' && __frame.P.clips[0]`);
    const args = { project_id, clip_id: before.id };
    const reframe = async (zoom, focus) => JSON.parse(await tool('frame_reframe', { ...args, zoom, focus }));
    await evaluate("document.querySelector('#present').click()");
    await until("[...__frame.slots.values()].find(s => s.el.readyState >= 2)?.el.readyState");
    await evaluate(`(async () => {
      const viewer = document.querySelector('#viewer');
      const video = __frame.slots.get('V1:0').el;
      const probe = window.probe = { video, frames: [], events: [], audio: [] };
      for (const type of ['pause', 'seeking', 'waiting', 'stalled', 'emptied', 'loadstart']) {
        video.addEventListener(type, () => probe.events.push({type, wall: Date.now(), at: video.currentTime}));
      }
      const browserAudio = new AudioContext();
      await browserAudio.resume();
      const input = browserAudio.createMediaElementSource(video);
      const mix = browserAudio.createMediaStreamDestination();
      const analyser = browserAudio.createAnalyser();
      const wave = new Float32Array(analyser.fftSize);
      input.connect(browserAudio.destination);
      input.connect(mix);
      input.connect(analyser);
      const chunks = [];
      const recorder = new MediaRecorder(mix.stream, {mimeType: 'audio/webm;codecs=opus'});
      recorder.ondataavailable = e => chunks.push(e.data);
      probe.startAudio = () => { recorder.start(); return Date.now(); };
      probe.endAudio = () => new Promise(resolve => {
        recorder.onstop = () => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(new Blob(chunks, {type: recorder.mimeType}));
        };
        recorder.stop();
      });
      function decoded(now, frame) {
        if (probe.active) probe.frames.push({wall: Date.now(), at: frame.mediaTime, n: frame.presentedFrames});
        video.requestVideoFrameCallback(decoded);
      }
      video.requestVideoFrameCallback(decoded);
      const small = document.createElement('canvas'); small.width = 24; small.height = 14;
      const ctx = small.getContext('2d', {willReadFrequently:true});
      probe.paint = [];
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        const result = drawImage.apply(this, args);
        if (this.canvas === viewer && args[0] === video && probe.active) {
          ctx.drawImage(viewer, 0, 0, 24, 14);
          const pixels = ctx.getImageData(0, 0, 24, 14).data;
          let hash = 0, max = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            hash = (Math.imul(hash, 31) + pixels[i] + 3 * pixels[i+1] + 7 * pixels[i+2]) | 0;
            max = Math.max(max, pixels[i], pixels[i+1], pixels[i+2]);
          }
          if (probe.paint.at(-1)?.hash !== hash) {
            probe.paint.push({wall:Date.now(), at:__frame.T, hash, max, width:args[3],
              same: __frame.slots.get('V1:0').el === video, size: viewer.width});
          }
        }
        return result;
      };
      setInterval(() => {
        if (!probe.active) return;
        analyser.getFloatTimeDomainData(wave);
        const rms = Math.sqrt(wave.reduce((sum, v) => sum + v*v, 0) / wave.length);
        probe.audio.push({wall: Date.now(), rms});
      }, 15);
    })()`);
    const audioStarted = await evaluate('probe.startAudio()');
    mark('browserAudioStarted');
    const trialInputs = [
      { zoom: 1.85, focus: { x: .47, y: .47 } },
      { zoom: 1.55, focus: { x: .43, y: .41 } },
      { zoom: 1.85, focus: { x: .47, y: .47 } },
    ];
    for (const [i, input] of trialInputs.entries()) {
      if (i) await reframe(1, { x: .5, y: .5 });
      await evaluate("__frame.seek(0); document.querySelector('#play').click()");
      await until("__frame.T > .65 && !probe.video.paused && !probe.video.muted && probe.video.readyState >= 2");
      await evaluate('probe.events = []; probe.frames = []; probe.paint = []; probe.audio = []; probe.active = true');
      if (i === 0) {
        const bad = await call('frame_reframe', { ...args, zoom: 0, focus: input.focus });
        assert(bad.isError);
        await until("document.querySelector('#timelineActivity').dataset.phase === 'failed'");
        assert.equal(await evaluate('__frame.P.clips[0].scale'), 1);
        report.rejected = bad.content[0].text;
      }
      await until('__frame.T > 1.15');
      const submitted = Date.now();
      mark('submit' + (i + 1));
      const edit = await reframe(input.zoom, input.focus);
      assert.equal(edit.status, 'applied');
      const first = await until(`probe.paint.find(f => Math.abs(f.width/f.size - ${input.zoom}) < .001)`);
      assert(first.wall >= submitted && first.wall - submitted < 400, 'Late visual update');
      assert(await until("document.querySelector('#timelineActivity').textContent.includes('reframed')"));
      mark('visible' + (i + 1));
      await until('__frame.T > 2.55');
      const measurements = await evaluate(`(() => {
        probe.active = false;
        return {project:__frame.P.id, playing:!probe.video.paused, source:probe.video.currentSrc,
          ...Object.fromEntries(['events','frames','paint','audio'].map(k=>[k,probe[k]]))};
      })()`);
      assert(measurements.playing && measurements.project === project_id);
      assert.deepEqual(measurements.events, []);
      assert(measurements.paint.length >= 25 && measurements.paint.every(f => f.max > 20 && f.same));
      assert(measurements.frames.length >= 25 && measurements.frames.every((f, j, a) => !j || f.at > a[j-1].at));
      const maxGap = samples => Math.max(...samples.slice(1).map((sample, j) => sample.wall - samples[j].wall));
      const longestPaintGapMs = maxGap(measurements.paint);
      const longestDecodedGapMs = maxGap(measurements.frames);
      assert(longestPaintGapMs < 225 && longestDecodedGapMs < 225, 'Large picture gap');
      assert(measurements.audio.length > 30 && measurements.audio.every(a => a.rms > .009), 'Audio dipped into silence');
      report.trials.push({ edit, submitted, first, latencyMs: first.wall - submitted, events: measurements.events,
        pictureSamples: measurements.paint.length, longestPaintGapMs, longestDecodedGapMs,
        missedVideoCallbacks: measurements.frames.at(-1).n - measurements.frames[0].n + 1 - measurements.frames.length,
        lowestAudioRms: Math.min(...measurements.audio.map(a => a.rms)), audioSamples: measurements.audio.length });
      if (i === trialInputs.length - 1) await until('__frame.T > 4.3');
      await evaluate("document.querySelector('#play').click()");
    }
    const audioStopped = Date.now();
    writeData(path.join(dir, 'browser-audio.webm'), await evaluate('probe.endAudio()'));
    report.browserAudio = { startedAt: audioStarted, stoppedAt: audioStopped, capture: 'FRAME video element via Web Audio' };
    const final = report.trials.at(-1).edit;
    const saved = JSON.parse(fs.readFileSync(path.join(HOME, 'projects', project_id, 'project.json')));
    assert.equal(saved.revisions.at(-1).id, final.revision_id);
    const revised = { ...before, scale: final.scale, x: final.x, y: final.y };
    assert.deepEqual(saved.clips, [revised]);

    await tool('frame_start', { name: 'Reopen checkpoint' });
    await until(`__frame.P?.id !== '${project_id}'`);
    await tool('frame_start', { project_id });
    assert.deepEqual(await until(`__frame.P?.id === '${project_id}' && __frame.P.clips`), [revised]);
    report.reopened = true;
    const compareAt = 3;
    await evaluate(`__frame.seek(${compareAt})`);
    await until(`(() => {
      const video = __frame.slots.get('V1:0')?.el;
      return video?.readyState >= 2 && !video.seeking && Math.abs(video.currentTime-${compareAt}) < .02;
    })()`);
    await sleep(100);
    writeData(path.join(dir, 'preview-3s.png'), await evaluate("document.querySelector('#viewer').toDataURL()"));

    const submittedAt = Date.now();
    await tool('frame_render', { project_id, quality: 'final', output_dir: dir, loudnorm: false });
    const render = await until("__frame.P.renders.at(-1)?.status === 'done' && __frame.P.renders.at(-1)");
    assert.equal(render.duration, 5);
    ffmpeg('-xerror', '-i', render.file, '-f', 'null', '-');
    const audioHash = file => ffmpeg('-i', file, '-map', '0:a:0', '-af', 'aformat=sample_rates=48000:channel_layouts=stereo',
      '-f', 'md5', '-').toString().trim();
    // Encode an unchanged crop through the same export path for a decoded-audio equality check.
    await reframe(1, { x: .5, y: .5 });
    await tool('frame_render', { project_id, quality: 'final', output_dir: dir, loudnorm: false });
    const control = await until(`__frame.P.renders.at(-1)?.id !== '${render.id}' && __frame.P.renders.at(-1)?.status === 'done' && __frame.P.renders.at(-1)`);
    assert.notEqual(control.file, render.file);
    assert.equal(audioHash(render.file), audioHash(control.file));
    report.export = { final: path.basename(render.file), control: path.basename(control.file), submittedAt,
      encoderStartedAt: render.startedAt, completedAt: render.endedAt, audioHash: audioHash(render.file) };
    ffmpeg('-ss', '3', '-i', render.file, '-frames:v', '1', path.join(dir, 'export-3s.png'));
    ffmpeg('-ss', '3', '-i', source, '-frames:v', '1', path.join(dir, 'source-3s.png'));
    const preview = path.join(dir, 'preview-3s.png');
    const ssim = other => {
      const result = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', preview, '-i', path.join(dir, other),
        '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return Number(result.stderr.match(/All:([\d.]+)/)?.[1]);
    };
    report.export.previewToExportSsim = ssim('export-3s.png');
    report.export.previewToSourceSsim = ssim('source-3s.png');
    assert(report.export.previewToExportSsim >= .85 &&
      report.export.previewToExportSsim - report.export.previewToSourceSsim > .15, 'Export did not match the preview crop');
    await reframe(final.scale, trialInputs.at(-1).focus);
    fs.writeFileSync(path.join(dir, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  } finally {
    child.stdin.end();
    child.kill();
  }
}
