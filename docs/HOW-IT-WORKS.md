# How Frame works

## The pieces

```
AI client ──MCP over stdio──▶ bin/frame.js mcp      (src/mcp.js: thin bridge, no state)
                                   │ HTTP POST /api/call
                                   ▼
                         Frame service  (src/daemon.js, one process, 127.0.0.1:4747)
                           ├─ projects on disk   ~/.frame/projects/<id>/project.json
                           ├─ operation engine   src/project.js
                           ├─ media analysis     src/media.js   (ffprobe, ffmpeg, whisper)
                           ├─ renderer           src/render.js  (one ffmpeg filter graph)
                           └─ Server-Sent Events ──▶ the window (ui/index.html, app.js, style.css)
                                                          │ POST /api/ui  (the human's edits and messages)
                                                          └ POST /api/raster (text drawn by the window)
```

The MCP process is disposable. The client starts one per session; it checks whether the service is running, starts it detached if not, and forwards each `tools/call` as an HTTP request. All state lives in the service, so several sessions, the shell (`frame call`) and the window all see the same project.

## Files

| File | Lines | What it holds |
| --- | --- | --- |
| `bin/frame.js` | ~50 | CLI: `mcp`, `serve`, `call`, `install`, `open`, `doctor`, `stop` |
| `src/mcp.js` | ~60 | JSON-RPC over stdio, hand-written. `ensureDaemon()` starts or replaces the service |
| `src/tools.js` | ~130 | The 11 tool definitions and the server `instructions`. This text is the contract the AI reads |
| `src/daemon.js` | ~475 | HTTP server, project storage, tool handlers, UI actions, the user inbox, undo history |
| `src/project.js` | ~290 | The data model and `applyOp`: every operation that can change a timeline |
| `src/media.js` | ~150 | Probe, thumbnails, audio envelope, silences, loudness, scene cuts, Whisper, word re-alignment |
| `src/render.js` | ~140 | Builds the ffmpeg filter graph for a full render or a single still |
| `ui/app.js` | ~490 | State stream, bin, feed, timeline, inspector, drag editing, real-time preview, text rasteriser |
| `scripts/record.mjs` | ~70 | Records the window through headless Chrome, optionally driving it with a scripted mouse |
| `test/smoke.js` | ~50 | End-to-end checks |

## The data model (`project.json`)

```
project {
  id, name, width, height, fps, version
  assets  { a1: { id, path, name, kind: video|audio|image, duration, width, height, fps,
                  hasAudio, thumbs, hasEnv, loudness, scenes?, transcript?: { engine, words[] } } }
  tracks  ["V2","V1","T1","A1","A2"]        // display order, top to bottom. Created on demand.
  clips   [ clip ]
  markers [ { id, t, label } ]
  feed    [ { id, ts, actor: claude|user|frame, agent?, kind, text, why?, clipIds?, t?, img? } ]
  steps   [ { id, title, tool, code, status, note, outputs[] } ]      // work done outside Frame
  renders [ { id, status, progress, file, duration, width, height, loudness } ]
  inbox   [ { kind, text } ]                // what the human did since the AI last looked
  rasters { clipId: { file, x, y, hash } }  // text clips drawn by the window
  paused, status, plan
}

clip {
  id, kind: video|image|audio|text, track, asset?
  start            // seconds on the timeline
  in, out          // seconds in the source (for text and images: 0 and the duration)
  speed, volume, muted
  fit: cover|contain, scale, x, y, opacity, fadeIn, fadeOut      // x, y are offsets as a fraction of the frame
  grade? { brightness, contrast, saturation }
  key?   { color, similarity, blend }
  text?  { content, size, color, stroke, strokeWidth, bg, weight, x, y, maxWidth, uppercase, font }
  caption?, label?
}
```

Timeline duration of a clip is `(out - in) / speed`. Video clips carry their own audio; A tracks hold audio-only clips. V1 is the bottom picture layer, higher V numbers stack above it, T tracks draw on top of all video.

## What happens on a tool call

1. `callTool` in `daemon.js` queues the call (calls run one at a time; `frame_wait` is the exception so it does not block the queue).
2. The handler runs. For `frame_edit`, it snapshots the timeline for undo, then applies ops one by one through `applyOp`, appending a feed entry and emitting state after each, with a short pause between (`FRAME_PACE`, default 140 ms) so a person can see them land.
3. `emit()` bumps the version, writes `project.json`, and sends the whole project to every open window over SSE.
4. Before returning, `userInput()` drains the inbox and appends it to the tool result as a "FROM THE USER" block. If the project is paused, it also appends a stop notice. This is the only channel from the human to the AI.

## How the human reaches the AI

The window posts to `/api/ui`: `message`, `pause`, `resume`, `ops` (manual edits), `undo`, `redo`, `render`, `import`. Manual edits call the same `applyOp`. Each action writes a line into `inbox`. The AI cannot be interrupted mid-thought; it receives the inbox with the result of its next tool call. `frame_wait` long-polls the inbox for when the AI has asked a question or been paused.

## How a render is built

`buildGraph` in `render.js` turns the timeline into one `-filter_complex`:

- A black `color` source of the project size and length is the base.
- Each visual clip is its own ffmpeg input, seeked with `-ss in -t length`. Its chain is: retime, scale to the computed cover/contain size, optional grade, optional `chromakey`, optional opacity and alpha fades, then a `setpts` shift to its timeline start and an `overlay` enabled only during its span.
- Text clips are PNGs the window drew and uploaded. They are overlaid at the recorded position. This is why preview and render match, and why text needs a window open.
- Each audio source is resampled, retimed, levelled, faded, delayed to its start and mixed with `amix`. The mix is padded to length and, unless disabled, normalised to −14 LUFS.

`frame_view` uses the same builder with a one-frame window, so the still an AI inspects is produced by the export path, not by the browser.

The grade is defined as CSS-equivalent maths (`brightness(k) contrast(c) saturate(s)`) and implemented with `lutrgb` and `colorchannelmixer`, so the browser preview and ffmpeg produce the same picture.

## How the preview works

`tick()` in `ui/app.js` runs on animation frames (with a timer fallback when the window is hidden). For the current time it finds the active clip on each track, keeps two reusable `<video>`/`<audio>` elements per track (alternating, so the next clip is pre-seeked), corrects drift, and draws to a canvas in track order. Chroma key is a per-pixel pass in JavaScript using the same distance formula as ffmpeg's filter. Text is drawn by `drawText`, the same function that produces the uploaded PNGs.

## Captions

`timelineWords` maps each transcript word through the clips on a track, so captions follow cuts and speed changes. `groupWords` builds phrases, breaking on word count, character count, pauses, punctuation and real jumps in the source (not on cuts inside continuous speech). After Whisper runs, `alignWordsToSpeech` moves any word Whisper placed inside a measured silence onto the nearest measured speech edge.

## Security posture

The service listens on 127.0.0.1 only. Every request must carry a Host header of `127.0.0.1:<port>` or `localhost:<port>`, and any Origin header must match, which blocks other websites and DNS rebinding. Media is served only for registered assets. There is no shell-execution tool: `frame_step` records what the AI says it ran; it does not run anything.
