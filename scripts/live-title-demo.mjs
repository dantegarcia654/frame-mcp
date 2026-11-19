// Seed a ten-second local project using normal FRAME tools. No external services.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { call } from '../src/mcp.js';
import { BASE } from '../src/util.js';

async function tool(name, args) {
  const result = await call(name, args);
  const output = result.content.map(c => c.text || '').join('\n');
  if (result.isError || /^\s*(?:\d+\. )?✗/m.test(output)) throw new Error(output);
  return output;
}

export async function seedDemo(dir, input) {
  const source = input ? path.resolve(input) : path.join(dir, 'synthetic-sample.mp4');
  const preparationStarted = Date.now();
  if (input) {
    const sourceInfo = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source]));
    if (!sourceInfo.streams.some(s => s.codec_type === 'video') || !sourceInfo.streams.some(s => s.codec_type === 'audio')
      || Number(sourceInfo.format.duration) < 10) throw new Error('Use a clip at least ten seconds long with video and audio.');
  } else {
    execFileSync('ffmpeg', ['-v', 'error', '-n', '-f', 'lavfi', '-i',
      'gradients=s=960x540:r=24:d=10:c0=0x0e121b:c1=0x38141e:c2=0x112936:n=3:seed=17:speed=0.09',
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=10',
      '-vf', 'drawgrid=w=80:h=80:t=1:c=white@0.12', '-af', 'volume=0.12',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source]);
  }
  const audio = path.join(dir, 'source-audio.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-n', '-i', source, '-map', '0:a:0', '-t', '10', '-c:a', 'pcm_s16le', audio]);
  const preparationMs = Date.now() - preparationStarted;
  const setupStarted = Date.now();
  const session = await tool('frame_start', { name: input ? 'Live title rehearsal' : 'Live title · synthetic sample', aspect: '960x540', fps: 24 });
  const project_id = session.match(/\((p_\w+)\)/)?.[1];
  if (!project_id) throw new Error('FRAME did not return a project ID.');
  await tool('frame_import', { project_id, paths: [source, audio], prepare: false, decide: false, actor: 'frame' });
  const graphic = (label, track, start, duration, nodes) => ({
    op: 'add_effect', effect: 'live_graphic', label, track, start, duration, params: { nodes },
  });
  const copy = (id, text, x, y, size, color) => ({ kind: 'text', id, x, y, text, size, color, weight: 700, font: 'sans' });
  await tool('frame_edit', { project_id, agent: 'Demo setup script', ops: [
    ...[['V1', 'Footage'], ['V2', 'Treatment'], ['V3', 'Title'], ['V4', 'Counter'], ['A1', 'Audio']]
      .map(([track, name]) => ({ op: 'name_track', track, name })),
    { op: 'add_clip', asset: 'a1', in: 0, out: 10, muted: true, label: 'Source footage' },
    { op: 'add_clip', asset: 'a2', in: 0, out: 10, track: 'A1', label: 'Source audio' },
    graphic('Treatment', 'V2', 0, 10, [
      { id: 'shade', kind: 'rect', x: 0, y: 0, w: .70, h: 1, fill: '#13131d', anim: [{t: 0, a: .55}, {t: 10, a: .4}] },
      { id: 'rule', kind: 'line', x: .08, y: .37, w: .48, lineWidth: .005, color: '#ff536b',
        anim: [{ t: 0, p: 0 }, { t: .75, p: 1, e: 'out' }] },
      copy('label', input ? 'LIVE TITLE REHEARSAL' : 'LIVE TITLE / SYNTHETIC SAMPLE', .08, .28, .033, '#ff7185'),
      copy('foot', 'THE TIMELINE IS STILL PLAYING', .08, .88, .028, '#e6d9df'),
    ]),
    graphic('Main title', 'V3', 0, 10, [{
      ...copy('main-title', 'THIS VIDEO\nCAN CHANGE.', .08, .44, .16, '#fff4eb'), weight: 800,
      anim: [{ t: 0, x: -.018, a: .15 }, { t: .68, x: 0, a: 1, e: 'out' }],
    }]),
    graphic('Time cue', 'V4', 0, 10, [{
      ...copy('count', '{v}', .82, .077, .085, '#e8bcc8'),
      font: 'mono', from: 0, to: 10, pad: 2, align: 'center',
      anim: [{ t: 0, p: 0 }, { t: 10, p: 1 }],
    }]),
  ] });
  return { project_id, source, sample: !input, preview: BASE, preparationMs, setupMs: Date.now() - setupStarted };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-live-title-'));
  console.log(JSON.stringify(await seedDemo(dir, process.argv[2]), null, 2));
}
