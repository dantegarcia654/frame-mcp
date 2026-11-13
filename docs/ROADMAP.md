# Where Frame stands and what would improve it

Version 1.2.0, 13 November 2026. Built and tested on one Mac (macOS, Node 24, ffmpeg 9, Chrome). The sections below the priority list are from 1.0.0 (12 November) except where marked.

## Priority: this repo is the installable product (decided 13 November 2026)

frame-mcp is the product people install. The private `frame-creative-agent` repo holds the earlier consumer-app work; its branch map is in that repo's `docs/REPO-MAP.md`. Pieces proven there get ported here with their tests, not the other way round.

Next, in order:

1. **Bring the editing-room features from the sketch-to-demo copy into this repo.** The two reels on 13 November were edited in a copy of Frame (1.1.0) that now has features this repo doesn't. Port each one with a smoke check:
   - **+ Text** and **T**
   - drag captions in the preview
   - double-click to edit text in place, and a side panel that doesn't wipe typing
   - caption size handle and A− / A+
   - Lines (Auto, 1–4)
   - slip (Option-drag and frame-step buttons)
   - save a clip to the Frame Inbox library
   - Approve & save to `~/Movies/Frame/Approved`
   - style profiles (`~/.frame/profiles`, `frame_profile`)

   This repo already has ripple. Then the sketch-to-demo runner can use this repo instead of its own copy. See `docs/CASE-STUDY-2026-11-13-SKETCH-TO-DEMO.md`.
2. **A one-line install:** publish to npm so it's `npx -y frame-mcp install`, and add an install check that finds ffmpeg, Chrome (for headless text) and Whisper.
3. **The fast footage path:** hardware-accelerated preview copies, scene detection on the preview copy, transcripts only when a clip has speech, and slot tags at upload. Measured on one 22.7 s 4K clip, this cut processing from ≈18 s to ≈5.6 s.
4. **Let Claude see the video:** `frame_watch`, shot memory, `frame_check` and an approve gate. See `docs/PROPOSAL-SEEING.md`, PRs 3–6.
5. **An HTTP MCP endpoint**, so ChatGPT in the browser can connect (it can't reach a local stdio server).

## What has actually been verified

- `node test/smoke.js`: 9 checks pass, including from a fresh clone.
- Two real edits end to end through the tool path: a 100-second vertical talking-head take cut to 10 seconds with captions, grade, punch-in, a synthesized sound and a render; and an 18-shot 16:9 cut with 41 captions and an end card.
- The MCP handshake and tool listing over stdio; registration in Claude Code reports connected.
- In the window: live updates, real-time preview with audio sync, dragging a clip, trimming an edge, undo, typing a message, pause and resume, opening a process step, playing a render. Checked by hand and by scripted mouse.

## What has not been verified

- **A full edit driven by a model through real MCP tool calls in a fresh session.** Both real edits were driven with `frame call`, which uses the same service path, by the model that wrote the tool. Whether a model that has only the tool descriptions uses Frame well (opens it first, narrates, reads the user block) is the most important untested thing.
- Linux and Windows. Browser auto-open on Windows is a guess.
- Safari and Firefox.
- Timelines longer than about a minute or more than about 70 clips.
- Chroma key on real green-screen footage. It was checked on a synthetic solid-green clip only (keyed out fully, layer below visible).
- Whisper models other than `base.en`; languages other than English.
- Two AI sessions editing at once.

## Known weaknesses

1. **Steering is not instant.** A message reaches the model at its next tool call. A model in a long think or a long external task will not see it until it comes back.
2. **Pause cannot stop a render in progress** and cannot stop work the model does outside Frame.
3. ~~**Text needs the window.**~~ Fixed: headless Chrome draws captions with the same code when no window is open, and stale captions are never rendered. Needs a Chromium-based browser installed.
4. **`frame_step` is self-reported.** Frame shows the code the model says it ran.
5. **Preview is approximate for chroma key and for volume above 100%.**
6. **No keyframes.** Scale, position, opacity and volume are constant per clip. A push-in or audio duck needs splitting clips.
7. **The only transition is a fade.** A crossfade needs two clips on different tracks.
8. **The UI rebuilds panels on every update** and sends the whole project each time. Fine now; will not scale to long edits.
9. **Undo history is in memory** and is lost when the service restarts.
10. **Captions cannot be merged or split in the UI**, and there is no per-word highlight style.
11. **One project on screen.** A second session switching projects switches everyone's window.
12. **The service never exits by itself** and has no log file.
13. **Not on npm**, so no `npx` install.
14. **No licence check on what users import**; not Frame's job, but worth a line in the UI before a hosted version.

## Highest-value next steps, in order

1. **Run it cold with a model.** Fresh session, only the MCP connected, a real clip, one sentence of instruction. Record where the model misuses the tools and fix the tool descriptions in `src/tools.js`. This is cheap and decides whether the product works for strangers.
2. **An HTTP MCP endpoint** (`/mcp`, streamable HTTP) beside stdio, so clients that only speak network MCP, including ChatGPT, can connect through a tunnel. The service already has the HTTP server and the tool table; this is a protocol adapter plus an auth token.
3. **Keyframes** for scale, position, opacity and volume, in the model, renderer and preview. This unlocks push-ins, ducking and animated text.
4. **A faster human channel.** MCP elicitation or sampling where the client supports it; otherwise a notification the client can surface.
5. **Publish to npm** so install is `npx -y frame-mcp install`.
6. **Incremental UI updates** (send patches, reuse DOM nodes) and persisted undo.
7. **Cross-platform pass**: Linux and Windows open/paths, Safari and Firefox preview.
8. **A real test suite** from the list in `docs/TESTING.md`, run in CI.
9. ~~**Server-side text**~~ Done (headless Chrome running `ui/text-draw.js`; this ffmpeg has no `drawtext`). See `docs/PROPOSAL-SEEING.md` for what comes next: `frame_watch`, shot memory, `frame_check`.
10. **Audio ducking and a music-bed helper**, since nearly every edit needs them.

## Ideas that fit the product

- Show a diff when the human changes something the model set, and let the human pin a clip so the model may not touch it.
- A "why" on hover for every clip: the reasons are already stored in the feed.
- Export the timeline as an EDL or FCPXML so an edit can continue in a traditional editor.
- Sub-agent lanes: the `agent` label already exists on ops; give each agent its own cursor colour (in greys) and a filter in the feed.
- A replay mode that scrubs through the project's version history.
