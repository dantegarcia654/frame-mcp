// Run with scripts/record.mjs. FRAME_PUNCH_SOURCE is the pinned MDN flower clip.
// FRAME_PUNCH_PORTRAIT=1 runs the 1080×1920 project with live text layers.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from '../src/util.js';

const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const saveData = (file, url) => fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
const audioHash = file => ffmpeg('-i', file, '-map', '0:a:0', '-f', 'md5', '-').toString().trim();

export default async function ({ out, evaluate, sleep, mark }) {
  const startedAt = Date.now();
  const dir = out + '.evidence';
  fs.mkdirSync(dir);
  const original = process.env.FRAME_PUNCH_SOURCE;
  assert(original, 'Set FRAME_PUNCH_SOURCE to the downloaded CC0 flower clip.');
  const portrait = process.env.FRAME_PUNCH_PORTRAIT === '1';
  const source = path.join(dir, 'source.mp4');
  // The fixture is silent. Mix an original sustained bed and an accent at the bloom.
  ffmpeg('-i', path.resolve(original), '-f', 'lavfi', '-i',
    'aevalsrc=0.065*(sin(2*PI*220*t)+0.6*sin(2*PI*329.63*t)+0.38*sin(2*PI*440*t))*(0.8+0.2*cos(2*PI*0.8*t))+0.10*sin(2*PI*660*t)*exp(-18*abs(t-2.1)):s=48000',
    '-map', '0:v', '-map', '1:a', '-vf', 'fps=30', '-t', '5', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', source);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/frame.js', import.meta.url)), 'mcp'],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const transcript = path.join(dir, 'mcp.jsonl');
  let id = 0;
  const write = (direction, packet) =>
    fs.appendFileSync(transcript, JSON.stringify({ at: Date.now(), direction, packet }) + '\n');
  async function rpc(method, params) {
    const packet = { jsonrpc: '2.0', id: ++id, method, params };
    if (method === 'tools/call') write('request', packet);
    child.stdin.write(JSON.stringify(packet) + '\n');
    const line = await lines.next();
    assert(!line.done, 'MCP server stopped');
    const reply = JSON.parse(line.value);
    if (method === 'tools/call') write('response', reply);
    assert.equal(reply.id, packet.id);
    assert(!reply.error, JSON.stringify(reply.error));
    return reply.result;
  }
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  async function tool(name, args) {
    const r = await call(name, args);
    const message = r.content[0].text;
    assert(!r.isError && !/^\d+\. ✗/m.test(message), message);
    return message;
  }
  async function until(expression, timeout = 20000) {
    const deadline = Date.now() + timeout;
    do {
      const value = await evaluate(expression);
      if (value) return value;
      await sleep(12);
    } while (Date.now() < deadline);
    throw new Error('Timed out: ' + expression);
  }
  const trySilence = file => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af',
      'silencedetect=n=-43dB:d=0.045', '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stderr.split('\n').filter(line => /silence_(start|end)/.test(line));
  };
  const ssim = (preview, frame) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', preview, '-i', frame,
      '-lavfi', portrait ? '[1:v]scale=540:960[smaller];[0:v][smaller]ssim' : 'ssim', '-f', 'null', '-'],
    { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return Number(r.stderr.match(/All:([\d.]+)/)?.[1]);
  };
  const report = { mode: portrait ? '1080x1920 creator-style' : '960x540 source comparison',
    caller: 'Local MCP stdio client', model: null, renders: {}, parity: [] };
  const keyframes = [
    { t: 1.55, zoom: 1, x: portrait ? .49 : .5, y: .5 },
    { t: 2.25, zoom: portrait ? 1.28 : 1.6, x: .458, y: .405, e: 'io' },
  ];

  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'FRAME punch-in benchmark', version: '1' }, capabilities: {} });
    const start = await tool('frame_start', { name: portrait ? 'Bloom study · portrait' : 'Bloom study · punch-in',
      aspect: portrait ? '9:16' : '960x540', fps: 30 });
    const project_id = start.match(/\((p_\w+)\)/)[1];
    await tool('frame_import', { project_id, paths: [source], prepare: false, decide: false });
    const graphics = portrait ? [{
      op: 'add_effect', effect: 'live_graphic', track: 'V2', label: 'Bloom study · typography', start: 0, duration: 5,
      params: { nodes: [
        { kind: 'rect', id: 'top', x: 0, y: 0, w: 1, h: .156, fill: '#162517', anim: [{ t: 0, a: .9 }] },
        { kind: 'text', id: 'series', x: .07, y: .047, text: 'FIELD NOTES    /    01', size: .018, font: 'mono', color: '#d5e196', weight: 700 },
        { kind: 'text', id: 'title', x: .07, y: .083, text: 'Moss rose', size: .04, font: 'serif', color: '#f8eddd', weight: 700 },
        { kind: 'rect', id: 'card', x: 0, y: .835, w: 1, h: .165, fill: '#162517', anim: [{ t: 0, a: .94 }] },
        { kind: 'text', id: 'copy', x: .07, y: .878, text: 'Wait for the bloom.', size: .033, color: '#f8eddd', weight: 800 },
        { kind: 'line', id: 'rule', x: .07, y: .95, w: .86, lineWidth: .002, color: '#d5e196',
          anim: [{ t: 0, p: 0 }, { t: 5, p: 1 }] },
      ] },
    }] : [];
    await tool('frame_edit', { project_id, fast: true, ops: [
      { op: 'name_track', track: 'V1', name: 'Picture + source audio' },
      { op: 'add_clip', asset: 'a1', label: 'Moss rose · time lapse', out: 5 },
      ...graphics,
    ] });
    const before = await until(`window.__frame?.P?.id === '${project_id}' && __frame.P.clips.length === ${1 + graphics.length} && __frame.P.clips[0]`);
    const args = { project_id, clip_id: before.id };
    const reframe = async patch => JSON.parse(await tool('frame_reframe', { ...args, ...patch }));
    await evaluate("document.querySelector('#present').click()");
    await until("__frame.slots.get('V1:0')?.el.readyState >= 2");
    await evaluate(`(async () => {
      const viewer = document.querySelector('#viewer');
      const video = __frame.slots.get('V1:0').el;
      const probe = window.punch = { video, frames: [], paint: [], events: [], audio: [] };
      for (const type of ['pause', 'seeking', 'waiting', 'stalled', 'emptied', 'loadstart']) {
        video.addEventListener(type, () => {
          if (probe.active) probe.events.push({ type, wall: Date.now(), t: __frame.T });
        });
      }
      const browserAudio = new AudioContext();
      await browserAudio.resume();
      const source = browserAudio.createMediaElementSource(video);
      const mix = browserAudio.createMediaStreamDestination();
      const analyser = browserAudio.createAnalyser();
      source.connect(browserAudio.destination);
      source.connect(mix);
      source.connect(analyser);
      const wave = new Float32Array(analyser.fftSize), chunks = [];
      const recorder = new MediaRecorder(mix.stream, { mimeType: 'audio/webm;codecs=opus' });
      recorder.ondataavailable = e => chunks.push(e.data);
      probe.begin = () => { recorder.start(); return Date.now(); };
      probe.stop = () => new Promise(resolve => {
        recorder.onstop = () => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType }));
        };
        recorder.stop();
      });
      function decoded(now, f) {
        if (probe.active) probe.frames.push({ wall: Date.now(), t: f.mediaTime, n: f.presentedFrames });
        video.requestVideoFrameCallback(decoded);
      }
      video.requestVideoFrameCallback(decoded);
      const small = document.createElement('canvas'); small.width = 24; small.height = 24;
      const ctx = small.getContext('2d', { willReadFrequently: true });
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        const result = drawImage.apply(this, args);
        if (this.canvas === viewer && args[0] === video && probe.active) {
          ctx.drawImage(viewer, 0, 0, 24, 24);
          const pixels = ctx.getImageData(0, 0, 24, 24).data;
          let hash = 0, max = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            hash = (Math.imul(hash, 31) + pixels[i] + 3*pixels[i+1] + 7*pixels[i+2]) | 0;
            max = Math.max(max, pixels[i], pixels[i+1], pixels[i+2]);
          }
          if (probe.paint.at(-1)?.hash !== hash) {
            probe.paint.push({ wall: Date.now(), t: __frame.T, hash, max, width: args[3],
              same: __frame.slots.get('V1:0').el === video });
          }
        }
        return result;
      };
      setInterval(() => {
        if (!probe.active) return;
        analyser.getFloatTimeDomainData(wave);
        probe.audio.push({wall: Date.now(), rms: Math.sqrt(wave.reduce((sum, v) => sum + v*v, 0) / wave.length)});
      }, 15);
    })()`);
    const audioStartAt = await evaluate('punch.begin()');
    mark('browserAudioStarted');
    await evaluate("document.querySelector('#play').click()");
    await until('__frame.T > .65 && !punch.video.paused && !punch.video.muted');
    await evaluate('punch.active = true');
    const invalid = await call('frame_reframe', { ...args, keyframes: [...keyframes].reverse() });
    assert(invalid.isError);
    assert.deepEqual(await evaluate('__frame.P.clips[0]'), before);
    report.rejected = invalid.content[0].text;
    await until('__frame.T > 1.78');
    const submitted = Date.now();
    mark('request');
    const animation = await reframe({ keyframes });
    assert.equal(animation.status, 'applied');
    const first = await until('punch.paint.find(f => f.width > punch.paint[0]?.width * 1.02)');
    assert(first.wall >= submitted && first.wall - submitted < 250);
    await until("document.querySelector('#timelineActivity').textContent.includes('crop animation saved')");
    mark('visible');
    await until('__frame.T > 4.15');
    const captured = await evaluate(`(() => {
      punch.active = false;
      return { project: __frame.P.id, playing: !punch.video.paused, frames: punch.frames,
        paint: punch.paint, events: punch.events, audio: punch.audio };
    })()`);
    assert(captured.playing && captured.project === project_id);
    assert.deepEqual(captured.events, []);
    const { frames, paint, audio } = captured;
    const gap = list => Math.max(...list.slice(1).map((sample, j) => sample.wall - list[j].wall));
    const frameSkip = frames.at(-1).n - frames[0].n + 1 - frames.length;
    assert(paint.length >= 70 && paint.every(f => f.max > 20 && f.same) && gap(paint) < 180,
      `Picture probe: ${paint.length} changed draws, ${gap(paint)}ms longest gap, ${paint.filter(f => f.max <= 20 || !f.same).length} bad draws`);
    assert(frames.length >= 70 && gap(frames) < 180 && frames.every((f, i) => !i || f.t > frames[i-1].t),
      `Decoder probe: ${frames.length} callbacks, ${gap(frames)}ms longest gap, ${frameSkip} skipped callbacks`);
    assert(Math.abs(paint.at(-1).width / paint[0].width - keyframes.at(-1).zoom) < .001);
    assert(audio.length > 100 && audio.every(a => a.rms > .008));
    const capture = path.join(dir, 'browser-audio.webm');
    saveData(capture, await evaluate('punch.stop()'));
    await evaluate("document.querySelector('#play').click()");
    const silence = trySilence(capture);
    // Encoder start may contain lead-in silence before Play. Forbid silence during the monitored window.
    assert(!silence.some(line => {
      const t = Number(line.match(/silence_start: ([\d.]+)/)?.[1]);
      return t > (paint[0].wall - audioStartAt) / 1000 && t < (paint.at(-1).wall - audioStartAt) / 1000;
    }));
    report.live = { animation, submitted, first, latencyMs: first.wall - submitted, events: captured.events,
      firstSampleTime: paint[0].t, lastSampleTime: paint.at(-1).t, largestPaintGapMs: gap(paint),
      largestDecodedGapMs: gap(frames), heldZoom: paint.at(-1).width / paint[0].width,
      missedDecodedCallbacks: frameSkip, decodedSamples: frames.length,
      lowestAudioRms: Math.min(...audio.map(a => a.rms)), audioSamples: audio.length, silence, audioStartAt };
    const saved = JSON.parse(fs.readFileSync(path.join(HOME, 'projects', project_id, 'project.json')));
    assert.equal(saved.revisions.at(-1).id, animation.revision_id);
    assert.deepEqual(saved.clips[0], { ...before, reframe: { offset: 0, keyframes: animation.keyframes } });

    await tool('frame_start', { name: 'Reopen checkpoint' });
    await until(`__frame.P?.id !== '${project_id}'`);
    await tool('frame_start', { project_id });
    assert.deepEqual(await until(`__frame.P?.id === '${project_id}' && __frame.P.clips`), saved.clips);
    report.reopened = true;
    async function render(name) {
      mark('render-' + name);
      const submittedAt = Date.now();
      const old = await evaluate('__frame.P.renders.at(-1)?.id');
      await tool('frame_render', { project_id, quality: 'final', output_dir: dir, loudnorm: false });
      const r = await until(`__frame.P.renders.at(-1)?.id !== ${JSON.stringify(old ?? null)} &&
        __frame.P.renders.at(-1)?.status === 'done' && __frame.P.renders.at(-1)`, 40000);
      assert.equal(r.duration, 5);
      ffmpeg('-xerror', '-i', r.file, '-f', 'null', '-');
      mark('export-' + name);
      report.renders[name] = { file: path.basename(r.file), elapsedMs: r.endedAt - submittedAt,
        audioHash: audioHash(r.file) };
      return r.file;
    }
    const output = await render('animated');
    await until("document.querySelector('#renderPlayer').currentTime > 2.8");
    mark('export-playing');
    await evaluate("document.querySelector('#backToTimeline').click()");
    const times = [24, 51, 56, 57, 60, 64, 68, 78, 120].map(f => f / 30);
    const framesDir = path.join(dir, 'frames');
    fs.mkdirSync(framesDir);
    for (const [i, t] of times.entries()) {
      // Seek just inside the requested frame to avoid browser rounding at a frame boundary.
      await evaluate(`__frame.seek(${t + .001})`);
      await until(`(() => {
        const v = __frame.slots.get('V1:0')?.el;
        return v?.readyState >= 2 && !v.seeking && Math.abs(v.currentTime - ${t + .001}) < .004;
      })()`);
      await sleep(110);
      saveData(path.join(framesDir, `preview-${i}.png`), await evaluate("document.querySelector('#viewer').toDataURL()"));
    }

    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,nb_frames',
      '-select_streams', 'v:0', '-of', 'json', output])).streams[0];
    assert.deepEqual(probe, { width: portrait ? 1080 : 960, height: portrait ? 1920 : 540, nb_frames: '150' });
    report.format = probe;
    for (const [i, t] of times.entries()) {
      const preview = path.join(framesDir, `preview-${i}.png`);
      const frame = path.join(framesDir, `export-${i}.png`);
      ffmpeg('-i', output, '-vf', `select=eq(n\\,${Math.round(t * 30)})`, '-frames:v', '1', frame);
      const score = ssim(preview, frame);
      assert(score >= (portrait ? .86 : .9), `Preview/export SSIM at ${t.toFixed(3)}s: ${score}`);
      report.parity.push({ time: t, ssim: score });
    }
    if (!portrait) {
      await reframe({ zoom: 1.85, replace_motion: true, focus: { x: .47, y: .47 } });
      await render('pr19-static');
      await reframe({ zoom: 1, focus: { x: .5, y: .5 } });
      await render('wide');
      assert(new Set(Object.values(report.renders).map(r => r.audioHash)).size === 1, 'Audio changed across crops');
    } else {
      // Compare to the same portrait project with identical timeline text and the punch-in cleared.
      await reframe({ zoom: 1, replace_motion: true, focus: { x: keyframes[0].x, y: keyframes[0].y } });
      await render('wide');
      assert.equal(report.renders.animated.audioHash, report.renders.wide.audioHash);
    }
    report.elapsedMs = Date.now() - startedAt;
    fs.writeFileSync(path.join(dir, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  } finally {
    child.stdin.end();
    child.kill();
  }
}
