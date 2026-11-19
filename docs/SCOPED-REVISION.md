# Scoped title revision

FRAME can route a quoted wording change on the local canvas. With one active single-node text layer labelled **Main title**, move the playhead inside the layer and enter **Change the Main title to “TAKE TWO”.** The prompt uses the existing text control and records one property change in Review. If two matching titles are active, use the unique clip ID in the existing exact-control syntax. Other requests can use Google Decisions when configured.

## Run

Use Node 22.4+ (native WebSocket for the recorder), FFmpeg, ffprobe and Chromium or Chrome. Set `FRAME_CHROME` to an absolute executable path if automatic discovery misses your browser. From the checkout:

```bash
export FRAME_HOME="$(mktemp -d)" FRAME_PORT=4837 FRAME_NO_OPEN=1 FRAME_DECISIONS=off
output="$(mktemp -d)"
node bin/frame.js call frame_start '{"name":"Scratch","aspect":"16:9"}'
node scripts/record.mjs "$output/window.mp4" --size 1440x900 --script scripts/scoped-revision.mjs
```

The runner connects to that local service and opens a new project. Keep other tabs for that service closed so the recorder's tab claims the canvas prompt. It generates a labelled 10-second synthetic clip, imports it, adds a title and punch-in, plays the initial timeline, submits the prompt through the FRAME composer, and resumes playback. It saves a silent screen recording, separate H.264/AAC before and after exports, a repeat export, canvas PNGs and a timing report in `window.mp4.evidence`. The recorder exits nonzero if a scripted check fails.

The timing report uses epoch milliseconds. `executionStartedAt` is the browser's server-side claim of the canvas job. `firstPlayableAt` is the first sampled playing frame with revised title pixels after clicking Play. Export submission, encoder start and verified completion are separate. An unchanged repeat should report zero newly drawn effect frames because the live-layer overlay is cached. The encoder still writes a fresh MP4.

## Preview, export and test

After the runner, open `http://127.0.0.1:4837/` to inspect the same project. The final verification reverts the change, so the timeline starts with **FIRST LOOK**. Seek to 3.5 seconds, submit the example prompt, press Play and use **Review** to inspect the one text change. Use the timeline's **Back to timeline** control if you are viewing an export.

```bash
node bin/frame.js call frame_prompt_jobs '{}'
node bin/frame.js call frame_revisions '{"action":"list","limit":3}'
node bin/frame.js call frame_render '{"quality":"final","output_dir":"/tmp/frame-scoped-revision-export"}'
npm test
node test/live-update.js
node bin/frame.js stop
```

The browser runner checks full timeline clip equality after substituting the one expected property, compares preview and export glyph pixels at 3.5 seconds, compares whole exported frames outside the revision at 1 and 8 seconds, checks identical decoded audio, decodes both exports in full, and verifies the scoped revert.
