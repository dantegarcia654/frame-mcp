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
                           └─ headless Chrome    src/text.js    (draws text when no window has: same ui/text-draw.js)

Outside FRAME_HOME, shared or kept by the user:
  ~/.frame/profiles/<name>.md      style profiles every AI reads at frame_start   (FRAME_PROFILES overrides)
  ~/Movies/Frame/Approved/          copies made by "Approve & save"               (FRAME_APPROVED_DIR overrides)
  Frame Inbox, 127.0.0.1:4875       optional library app "Save to Frame library" sends clips to
                                    (token in ~/Library/Application Support/FrameInbox/data/access-token;
                                     FRAME_INBOX_DIR and FRAME_INBOX_URL override)
```

The MCP process is disposable. The client starts one per session; it checks whether the service is running, starts it detached if not, and forwards each `tools/call` as an HTTP request. All state lives in the service, so several sessions, the shell (`frame call`) and the window all see the same project.

## Files

| File | Lines | What it holds |
| --- | --- | --- |
| `bin/frame.js` | ~50 | CLI: `mcp`, `serve`, `call`, `install`, `open`, `doctor`, `stop` |
| `src/mcp.js` | ~60 | JSON-RPC over stdio, hand-written. `ensureDaemon()` starts or replaces the service |
| `src/tools.js` | ~180 | The tool definitions (including `frame_profile`) and the server `instructions`. This text is the contract the AI reads |
| `src/daemon.js` | ~650 | HTTP server, project storage, tool handlers, UI actions, the user inbox, undo history, style profiles, Approve & save, Save to Frame library |
| `src/project.js` | ~400 | The data model and `applyOp`: every operation that can change a timeline |
| `src/media.js` | ~150 | Probe, thumbnails, audio envelope, silences, loudness, scene cuts, Whisper, word re-alignment |
| `src/render.js` | ~150 | Builds the ffmpeg filter graph for a full render or a single still. Skips any caption drawn from older text |
| `src/text.js` | ~90 | Finds a Chromium browser and runs `ui/text-draw.js` in it headless to draw captions with no window open |
| `ui/text-draw.js` | ~80 | The only code that draws caption pixels. Used by the window and by `src/text.js`. Also `balanceLines` / `reflowLines`, the layout maths behind the Lines buttons (they measure, they do not draw) |
| `ui/app.js` | ~590 | State stream, bin, feed, timeline, inspector, drag editing, slip, caption handles and in-place editing, real-time preview, uploads captions it draws |
| `scripts/record.mjs` | ~70 | Records the window through headless Chrome, optionally driving it with a scripted mouse |
| `test/smoke.js` | ~220 | End-to-end checks (37 at 1.3.0) |

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
  rasters { clipId: { file, x, y, hash, by } }  // drawn captions; hash = the text+style they were drawn from, by = window | service
  paused, status, plan, profile?         // profile = name of the style profile frame_start applied
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

The window posts to `/api/ui`: `message`, `pause`, `resume`, `ops` (manual edits), `undo`, `redo`, `render`, `reveal`, `approve`, `save_clip`, `pack_use`, `import`. Manual edits call the same `applyOp`. Each action writes a line into `inbox`. The AI cannot be interrupted mid-thought; it receives the inbox with the result of its next tool call. `frame_wait` long-polls the inbox for when the AI has asked a question or been paused.

## Editing by hand in the window (1.3)

Everything below goes through `ops` and therefore through `applyOp`, the same path the AI uses. Nothing here adds a second way to change a clip or to draw text.

| Gesture | What it sends |
| --- | --- |
| **+ Text** button or **T** | `add_text` "Your text" at the playhead on T2, 2 s, default style with `y: 0.3` |
| Drag a caption in the preview | `update_clip {style: {x, y}}` on release. The preview shows the live position while dragging |
| Round corner handle / **A−** **A+** | `update_clip {style: {size}}` (A± step by ×1.1, clamped 0.012–0.25) |
| Square side handle | `update_clip {style: {maxWidth}}` (how wide a line may run before it wraps) |
| **Lines** Auto, 1–4 | `update_clip {text, style: {size, maxWidth}}`. `reflowLines` splits the words into N lines whose widest line is as short as possible, measured with the caption's own font, sizes it as large as fits 94% of the frame (up to 0.055), and sets `maxWidth` just wide enough that `drawText` keeps exactly those breaks. Auto joins the lines back into one paragraph with `maxWidth` 0.84 |
| Double-click a caption (preview or timeline) | An overlay text box over the caption. Enter saves (`update_clip {text}`), Shift+Enter adds a line, Esc cancels |
| Text box in the side panel | Same keys. The side panel is not rebuilt while one of its fields has focus or the overlay is open; it catches up when focus leaves |
| Option-drag a video/audio clip, or **−1s −5f −1f +1f +5f +1s** | `slip_clip`: start and length stay, in and out move together, stopped at the ends of the footage |

The selection box and handles are drawn on the preview canvas only (UI chrome, black and white). They never reach a raster or a render.

## Outputs the user keeps

- **Approve & save** (Last render, in the side panel with no clip selected) copies the newest finished render to `~/Movies/Frame/Approved/<project>_vN.mp4`. It picks the first free `N` and copies with `COPYFILE_EXCL`, so an existing file is never overwritten, even by two clicks at once.
- **Save to Frame library** (side panel, video or audio clip) cuts the clip's source range (`in`–`out` of the original file, not the proxy) with ffmpeg and uploads it to Frame Inbox at `POST /api/upload` with the `x-frame-token` header. If the token file is missing ("not installed") or nothing answers on the port ("not running"), the window shows that and nothing changes. Frame Inbox is a separate app; Frame works without it.

## Style profiles

A profile is a plain Markdown file of the user's editing rules and the mistakes already made and fixed, in `~/.frame/profiles/<name>.md`. The folder is outside `FRAME_HOME` on purpose: every copy of Frame and every AI client reads the same rules. `frame_start` loads `profile` (default `default`, only if that file exists), stores the name on the project, writes a feed line and returns the full text in its result; a named profile that does not exist is an error. `frame_profile` shows the open project's profile or lists them. `frame_state` says which profile applies. Frame does not check that an AI follows the profile; it only makes sure the AI has read it.

## How a render is built

`buildGraph` in `render.js` turns the timeline into one `-filter_complex`:

- A black `color` source of the project size and length is the base.
- Each visual clip is its own ffmpeg input, seeked with `-ss in -t length`. Its chain is: retime, scale to the computed cover/contain size, optional grade, optional `chromakey`, optional opacity and alpha fades, then a `setpts` shift to its timeline start and an `overlay` enabled only during its span.
- Text clips are PNGs drawn by `ui/text-draw.js`: by the window when it is open, otherwise by headless Chrome running the same file (`src/text.js`). Each PNG records the text and style it was drawn from; a caption whose text or style has changed since is never overlaid. `frame_view` and `frame_render` redraw stale captions first, and `frame_render` refuses to export with any caption missing unless `allow_missing_text` is passed.
- Each audio source is resampled, retimed, levelled, faded, delayed to its start and mixed with `amix`. The mix is padded to length and, unless disabled, normalised to −14 LUFS.

`frame_view` uses the same builder with a one-frame window, so the still an AI inspects is produced by the export path, not by the browser.

The grade is defined as CSS-equivalent maths (`brightness(k) contrast(c) saturate(s)`) and implemented with `lutrgb` and `colorchannelmixer`, so the browser preview and ffmpeg produce the same picture.

## How the preview works

`tick()` in `ui/app.js` runs on animation frames (with a timer fallback when the window is hidden). For the current time it finds the active clip on each track, keeps two reusable `<video>`/`<audio>` elements per track (alternating, so the next clip is pre-seeked), corrects drift, and draws to a canvas in track order. Chroma key is a per-pixel pass in JavaScript using the same distance formula as ffmpeg's filter. Text is drawn by `drawText`, the same function that produces the uploaded PNGs.

## Captions

`timelineWords` maps each transcript word through the clips on a track, so captions follow cuts and speed changes. `groupWords` builds phrases, breaking on word count, character count, pauses, punctuation and real jumps in the source (not on cuts inside continuous speech). After Whisper runs, `alignWordsToSpeech` moves any word Whisper placed inside a measured silence onto the nearest measured speech edge.

## Security posture

The service listens on 127.0.0.1 only. Every request must carry a Host header of `127.0.0.1:<port>` or `localhost:<port>`, and any Origin header must match, which blocks other websites and DNS rebinding. Media is served only for registered assets. There is no shell-execution tool: `frame_step` records what the AI says it ran; it does not run anything.
