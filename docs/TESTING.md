# Testing Frame

## The built-in check

```bash
node test/smoke.js
```

It starts a private service (port 4791, temporary data folder, no browser), generates a 6-second test clip with ffmpeg, and checks: start, import with measured silences, a batch of edits including one deliberate failure, a composited still, a user message reaching the AI, pause blocking edits, a draft render that produces a playable file, undo, and rejection of a request from a foreign origin.

It does not cover: the browser UI, text clips (they need a window), Whisper, chroma key, real footage, long timelines.

## Run an isolated instance for your own tests

```bash
export FRAME_PORT=4800 FRAME_HOME=/tmp/frame-test FRAME_NO_OPEN=1 FRAME_PACE=0
node bin/frame.js call frame_start '{"name":"t","aspect":"16:9"}'
# ... your calls ...
node bin/frame.js stop
```

Tool results print to stdout; image results print as a size placeholder. Exit code is 1 when the tool reports an error. The HTTP form, if you prefer it:

```bash
curl -s -X POST http://127.0.0.1:4800/api/call -H 'Content-Type: application/json' \
  -d '{"name":"frame_state","arguments":{}}'
```

To act as the human (same path the window uses):

```bash
curl -s -X POST http://127.0.0.1:4800/api/ui -d '{"action":"message","text":"make it shorter"}'
curl -s -X POST http://127.0.0.1:4800/api/ui -d '{"action":"ops","ops":[{"op":"update_clip","id":"<clip id>","out":4.2}]}'
curl -s -X POST http://127.0.0.1:4800/api/ui -d '{"action":"pause"}'
```

## Make test media without downloading anything

```bash
# picture + tone that is silent 0.8 s out of every 2 s
ffmpeg -y -f lavfi -i testsrc2=s=1280x720:r=30:d=20 \
  -f lavfi -i "aevalsrc='0.4*sin(2*PI*440*t)*lt(mod(t,2),1.2)':d=20" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac clip.mp4
# green screen
ffmpeg -y -f lavfi -i "color=c=0x00ff00:s=1280x720:d=5" -pix_fmt yuv420p green.mp4
# music bed
ffmpeg -y -f lavfi -i "sine=f=220:d=20" bed.wav
```

For speech, record ten seconds on a phone with a few deliberate pauses and a retake. Nothing synthetic exercises the transcript path properly.

## Test the window

Open `http://127.0.0.1:<port>` in a browser while you make calls. To script it and record the result:

```bash
node scripts/record.mjs out.mp4 --size 1600x900 --script demo/shots.mjs
```

The script receives `{ evaluate, mouse, send, sleep, mark }` and drives the page through the Chrome DevTools protocol. `window.__frame` in the page exposes `P` (project), `T` (playhead), `seek`, `togglePlay` and the media `slots` for assertions.

## Cases worth writing (none exist yet)

**Operations**
- `cut_range` across several tracks: clips are split at both edges, later clips shift by exactly the cut length, markers shift too.
- `split_clip` then `update_clip` on each half: source `in`/`out` stay continuous.
- `remove_silences` on a clip with `speed != 1`: timeline ranges are computed in timeline time.
- `delete_clip` with `ripple: "track"` versus `true`.
- A failed op in the middle of a batch leaves earlier ops applied and later ops still attempted; undo reverts the whole batch.
- Kind/track mismatch (audio on V1, text on A1) is rejected with a clear message.

**Render correctness**
- Render a timeline, probe the file: duration equals the timeline within one frame; resolution equals the project.
- Grade: render a solid colour with a known brightness/contrast/saturation and compare the pixel to the CSS formula.
- Chroma key over a known background: sample a pixel that should be background.
- Fades: alpha at the midpoint of a fade is about half.
- Two overlapping audio clips: output level is the sum, not normalised down.
- `speed: 0.25` and `speed: 4` on video with audio: output lengths are correct and audio is present.
- 100+ clips: the render finishes and stays in sync.

**Captions**
- A word whose midpoint falls just outside a cut is excluded; a word straddling the cut is clamped.
- Phrases break at punctuation, at pauses over `max_gap`, at real source jumps, and not at cuts inside continuous speech.
- `alignWordsToSpeech` moves a word placed in silence to the nearer speech edge and does not reorder words.

**Human in the loop**
- Messages, manual edits and pause appear in the next tool result exactly once.
- While paused, `frame_edit`, `frame_render`, `frame_import` do not change anything; `frame_wait` returns on resume.
- A manual edit made during a paced `frame_edit` batch is not lost.

**Service**
- Two MCP bridges at once: both see the same project; calls are serialised.
- Service version mismatch: the bridge replaces the running service.
- Port already taken by something else: a clear error.
- Requests with a foreign Host or Origin are refused.
- Paths with spaces, unicode and `~`.

**Media**
- Portrait phone video with rotation metadata, HEVC, ProRes (proxy path), variable frame rate, audio-only, still images, a file with no audio track.
