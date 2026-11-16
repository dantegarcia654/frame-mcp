# Where Frame stands and what would improve it

Version 1.0.0, 12 November 2026. Built and tested on one Mac (macOS, Node 24, ffmpeg 9, Chrome).

## 1.4, continued (14 November 2026)

Added: `blow_away` (the person breaks into particles and leaves the empty set; needs `plate`, a real shot of the empty set from the same locked camera — Frame never invents what is behind the person), `agent_swarm` and the `add_agent_swarm` op, `add_effects_at_words` (effects placed on the word where the speaker names them), cue words per effect, `frame_import prepare` (cutout + transcript start in the background at import and are waited for automatically), `scripts/dryrun-effects-reel.mjs` (times the whole recipe on a take, footage in, MP4 out), and a preview fix: a video still seeking holds its last complete frame instead of flashing black.

**Verified on one Mac:**
- `node test/smoke.js`: 48 checks pass. The four effect checks that went stale when import started preparing cutouts now import with `prepare: false` so the "needs a cutout" refusal is still tested, and a new check covers the cutout starting at import.
- The preview hold-frame fix in the 1.4 window: playing a timeline with two cuts and an effect, 680 frames sampled, 0 black frames, every frame within 0.2 s of a cut kept its picture.
- A real 110 s one-take talking-head recording (1080×1920 HEVC) cut to a 21.3 s reel: 10 effects placed by `add_effects_at_words` from the spoken names, each op with its own agent label, plus `add_agent_swarm` and the call-to-action text, rendered in 25.6 s (-14.9 LUFS).

**Not verified yet:**
- `blow_away` on real footage with a real plate (the take had no empty-set shot, so it was cut from the reel).
- `add_effects_at_words` and `add_agent_swarm` driven by a model that only has the tool descriptions.

## 1.4: effect clips and the person cutout (13 November 2026)

**Verified on one Mac (macOS, Node 24, ffmpeg 9, Chrome):**
- `node test/smoke.js`: 47 checks pass, 10 of them new — an undrawn effect is never composited; `add_effect` rejects unknown effects, out-of-range settings and its own source track; an effect is drawn in headless Chrome and composited; a changed setting is redrawn, never shipped from old frames; an effect needing a cutout says so in `frame_view` and stops `frame_render` before anything is drawn; `frame_cutout` reports measured results on footage with no person (0/30 frames); `frame_effects` names a cutout that does not cover an effect.
- A real talking-head take (1080×1920, 30 fps): `frame_cutout` on 9 s took 18.9 s with Apple Vision (accurate), person in 270/270 frames, face in 239/270. All nine effects placed through `frame_edit`, checked with `frame_view`, and rendered: 8 s, 375 effect frames, 32 s in all.
- The window: all nine effects preview live; editing a setting in the inspector goes through `update_clip` and reaches Claude as a manual edit; the Effects panel's + adds an effect at the playhead; playback stays around 36 fps with effects on; no console errors.
- The rembg fallback helper produced mattes from real footage (6 frames, about 0.5 s a frame after a ~15 s model load).

**Not verified yet:**
- `frame_cutout` and effects driven by a model that only has the tool descriptions.
- The rembg fallback end to end through `frame_cutout`, and on Windows or Linux at all.
- The window's "Cut out person" button (it calls `frame_cutout` exactly like Claude does, but nobody clicked it).
- Effects on 16:9 or 1:1 projects, on clips with scale/position changes, on sped-up clips, and on an effect spanning a cut on V1.
- Long cutouts (minutes of footage) and long effect-heavy renders.

**Known weaknesses of 1.4:**
1. **Effects read one track, not the composite.** An effect sees its source track only (V1 by default); an opaque effect on top hides any effect below it.
2. **Cutout quality is whatever the engine gives.** Vision is good on people and hair; it can include things the person holds or leans on. The rembg fallback is coarser and slower, and its face detector misses angled faces.
3. **Preview of cutout effects is approximate while playing** (the matte video can drift a frame or two); paused frames, `frame_view` and the render are exact.
4. **Effects need Chrome** (or Chromium, Edge, Brave) to render, like captions.
5. **The catalogue is fixed in code.** A new effect means editing `ui/effects.js`; there is no way yet for Claude to add one at runtime as a reusable pack.
6. **Text behind and clone row depend on framing.** In a tight close-up the person covers most of the words and the copies leave the frame.
7. **Effect frames take disk space**: one full-frame image per frame in the project cache, plus the extracted picture and cutout under it. Measured at 1080×1920: 60–430 KB per JPEG frame (opaque effects), 63–73 KB per PNG frame (overlays); the 8 s test with nine effects held about 68 MB of effect frames. Frames of deleted or changed effects are removed.

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
