# Proposal: let Claude see the video the way a person does

Status: **PR 1 and PR 2 built** and committed on branch `truthful-pixels-honest-edits` (not pushed); PRs 3–6 are still proposals. Written 13 November 2026 after editing the MoneyStack reel end to end in the sketch-to-demo copy of Frame.

## The problem in one paragraph

A person editing a reel watches it. They notice that two cuts in a row show the same laptop angle, that a caption kept its old colour, that the last shot is a screen full of small text, and that a caption sits under Instagram's header. Claude can't watch. It gets up to six still frames per `frame_view` call, text summaries of the timeline, and a "✓" from every edit. It trusts the "✓". In one session that let three real defects through, each caught only by luck:

| What happened | Why Claude missed it at first | How it was caught |
| --- | --- | --- |
| Captions were restyled white, mixed case. The tool said "✓ style uppercase, color". The preview and render still showed yellow and red capitals. | Text is drawn into images by the browser window. With the window closed, the old images were reused, and nothing says so. | A contact sheet happened to include those frames. |
| "Swap this clip to the other camera" was reported as done. Only the in and out points changed; the clip kept the same source, now from the wrong moment. | `update_clip` silently ignores `asset`. The result line listed the in/out change, which looked like success. | Reading the timeline text line by line afterwards. |
| The final shot (15.2–18.1 s) was a screen full of small text under the closing message. | No frame was sampled in that range until the export was checked. | A contact sheet of the rendered MP4. |

Two more were never caught by a tool at all. The user saw them in the window: the opening cuts all came from the same camera angle, and one shot (`IMG_4842`) looks almost identical to its neighbour.

The fix isn't "more screenshots". It's to give Claude what a person gets from watching: the whole video at a glance, a memory of what each shot looks like, and a reason to look closer at specific moments. Every one of those should be **measured**, following this repo's no-fake-anything rule.

## What "seeing like a person" means here, concretely

A person watching gets five things. Each one maps to something Frame can compute.

1. **The whole thing at once.** You know the shape of a reel after one viewing. → A timecoded **contact sheet** of the full timeline or the rendered file in one image, plus a strip of first, middle and last frames for every shot.
2. **Shot memory.** You know "that's the same camera as two cuts ago". → A **visual signature** per second of every asset, and automatic grouping of shots into **angles**.
3. **Gut reactions to problems.** Your eye catches a jump, an unreadable caption, a dead frame. → **Measured checks**, each pointing at a timestamp, the measured value, the threshold, and a cropped image to look at.
4. **Rhythm.** You feel whether a cut lands on the beat. → A **beat map** of the music, with each cut's distance to the nearest beat.
5. **Trust in what you see.** What you watched is what ships. → **One source of truth for pixels**: text drawn by the service, not by whichever browser tab is open, and checks run on the exported file.

Claude still does the judging, such as whether a shot is good or a caption is funny. The tools decide **where to look** and **what is objectively off**.

## The pieces

Each piece is one reviewable pull request, in dependency order.

### PR 1 — Truthful pixels (text no longer needs the window)

**Problem.** `render.js` composites text from PNGs uploaded by `ui/app.js` (`rasterizeTexts`). There are three failure modes:
- No window: the text is missing from the render (already listed in ROADMAP, weakness 3).
- Window closed after a restyle: the stale image is used.
- A styling edit "succeeds" without the window, but nothing draws it.

**Change (as built).** The first plan was ffmpeg `drawtext`, but the ffmpeg on this machine (like Homebrew's default) has no `drawtext`, and Node has no canvas. So:
- Caption drawing moved into one file, `ui/text-draw.js`. The window imports it.
- With no window open, the service runs that same file in headless Chrome (`src/text.js`). It uses a throwaway profile, and one browser launch draws every caption in about a second.
- Every drawn caption stores the key of the text and style it came from. `render.js` refuses to overlay a caption whose key no longer matches. `frame_view` and `frame_render` redraw stale captions first.
- `frame_render` refuses to export with a caption missing, unless `allow_missing_text: true` is passed.

**Measured parity.** The same two captions drawn by the window and by headless Chrome had identical position and size. 142 of 777,400 bytes differed, by at most 1 value. A caption with a background box had 652 of 1,525,920 bytes differ, on antialiased edges.

**Cost.** Without a window, drawing text needs a Chromium-based browser (found automatically, or `FRAME_CHROME`).

**Files.** New `ui/text-draw.js` and `src/text.js`; `ui/app.js`, `src/daemon.js`, `src/render.js`, `src/tools.js`.

### PR 2 — Honest edits

**Problem.** Edits can report success for something they didn't do.

**Change.**
- `update_clip` **throws** on any key it doesn't apply, listing the keys it accepts.
- New op **`replace_source {id, asset, in, out}`**. It keeps the clip's start, duration and track and checks the range fits the new asset. This is what "cut to the other angle" needed. The workaround of deleting and re-adding the clip with `ripple:false` was fragile.
- Every op result ends with a one-line **diff of what actually changed**, read back from the project after the op. It's built from the stored project, not from the request.
- V1 overlaps and gaps above one frame are reported after every batch. A 10 ms overlap appeared today from rounding.

**Files.** `src/project.js`, `src/tools.js` (op list), `test/smoke.js`.

### PR 3 — Eyes: `frame_watch`

A new tool that answers "show me the video". It's built from the same ffmpeg graph as the render, so it shows truth.
- **Contact sheet.** One image covering the whole timeline: a frame at every cut and every *n* seconds (default 1), each tile labelled with timecode, clip label and source.
- **Shot strip.** For every V1 clip, its first, middle and last frame side by side. This is where "same angle twice in a row" and "this shot ends on a menu screen" become obvious.
- **Zoom.** `frame_watch {from, to, fps}` gives a dense look at a short range. The `frame_view` cap of 6 stills stays for single moments.
- **Target.** `target: "timeline"` (default) or `"render"`. The second reads the exported MP4 itself, so the final check is on the file that ships.

Output is a few images plus a compact text table, sized to stay cheap. It's one call instead of the 6–8 `frame_view` calls plus scratch ffmpeg scripts used today.

**Files.** `src/daemon.js` (tool), `src/render.js` (tiled still graph), `src/tools.js`.

### PR 4 — Shot memory and rhythm (computed at import)

On import, alongside the existing duration, loudness, silences and scenes:
- **Per-second visual signature.** A 16×16 greyscale thumbnail and a perceptual hash per second, stored in the asset record.
- **Angles.** Shots are clustered by signature across all assets. Each clip gets an `angle` letter (A, B, C…) shown in the timeline and in `frame_state`. The two laptop files that looked alike today would share or neighbour a cluster, and a measured distance makes that visible.
- **Beat map.** For audio and music assets: onset times and an estimated tempo, from an energy-flux pass over decoded PCM. This is rule-based and labelled as such.
- **Snapping.** `split_clip`, `keep_ranges` and `add_clip` accept `snap: "beat"`. The reported cut time includes its offset from the beat.
- **Labels Claude writes.** `frame_note {asset, t, label}` stores a reviewed label ("laptop close-up, stack at $300"). It's marked `source: "model-reviewed"` so it's never confused with measured data. Frame Inbox already separates these. This brings that into the project.

**Files.** `src/media.js`, `src/daemon.js` (import pipeline), `src/project.js` (snap), `ui/app.js` (angle badge).

### PR 5 — The final-video gate: `frame_check` + approve

`frame_check` runs measured checks and returns findings. Each finding has a timestamp, clip id, measured value, threshold and a cropped image. Every rule below caught, or would have caught, something real in this session.

| Check | Measurement | Default |
| --- | --- | --- |
| Same angle back to back | Signature distance between the last frame of clip *i* and the first frame of clip *i+1*, plus the angle cluster | Flag if same angle |
| Stale or missing text | Raster hash ≠ current style hash | Error |
| Caption in platform UI zone | Caption bounding box vs a 9:16 safe-zone mask | Configurable top/bottom/right bands. **Today's captions at y = 0.075–0.105 sit in the top band**; real limits to be confirmed against the current Instagram UI before use |
| Caption legibility | Luminance contrast between text and the pixels under its box | Flag low contrast |
| Reading time | Characters per second shown | Flag above ~20 cps |
| Weak frame | Black and freeze detection (ffmpeg `blackdetect`, `freezedetect`); "dense small text" via edge density in the shot's last second | Heuristic, labelled as such |
| Cut rhythm | Each cut's distance to the nearest beat | Report; flag above 2 frames when `snap` was requested |
| Ending | The last caption must finish on or before the final frame, and no caption may start after the last cut | Error |
| Loudness | Integrated LUFS and true peak of the render | Target set per project |
| Timeline | V1 gaps or overlaps above one frame | Error |

**Approve becomes a gate.**
- **Approve & save** first runs `frame_check` on the rendered file. It saves only if nothing is at error level, or if the user types an override reason.
- `~/Movies/Frame/Approved/manifest.json` records the file, sha256, project version, check results and a one-line note of what changed.
- The destination folder becomes a setting, for example a Google Drive folder.

**Files.** New `src/check.js`, `src/daemon.js` (tool and approve), `ui/app.js` (findings list with click-to-seek).

### PR 6 — Bring today's window features into the product, and stop fragile recipes

These exist only in the sketch-to-demo copy of the runtime, which has drifted from this repo (version 1.1.0 vs 1.0.0, and every file in `src/` differs):
- **+ Text** button and the **T** shortcut.
- Click-and-drag captions in the preview.
- **Save to Frame library**: send a clip's range to Frame Inbox.
- **Approve & save** to `~/Movies/Frame/Approved`.

Then:
- Add resize handles and a colour picker on the selected caption. These were requested and aren't built.
- In the sketch-to-demo runner, hash only the files that change pixels or sound (`src/render.js`, `src/project.js`, `src/text.js`) for the prepared-recipe check. Any UI edit currently invalidates every prepared recipe and forces a re-prepare. This happened twice today.

## How to know it works

The tests turn today's real failures into permanent regression cases, in `test/smoke.js` style, on generated media:
1. Restyle a caption with no window connected, render, and sample the pixel colour inside the caption. It must be the new colour.
2. `update_clip {asset}` must throw. `replace_source` must change the source and keep start and duration.
3. Build a timeline with the same synthetic clip twice in a row. `frame_check` must flag "same angle". With two different clips, it must not.
4. A shot whose last second is a dense text card must be flagged as a weak frame. A plain colour field and a moving gradient must not be flagged.
5. A caption placed at y = 0.05 must be flagged for the UI zone. At y = 0.5 it must not.
6. A click track at 120 BPM must produce beats 0.5 s apart, within 1 frame, and a snapped cut must land on one.
7. Approve with an error-level finding must refuse without an override, and with an override it must write the manifest.

Plus one **real replay**: rebuild the MoneyStack timeline as it stood mid-session, with the duplicate angles, stale captions and text-screen ending, and check that `frame_check` reports all three before anyone looks.

## What this does *not* do

- It doesn't give Claude taste. Checks find objective problems and point at moments. Whether "Wait… it WORKS?!" lands is still a human-and-Claude judgement.
- Nothing here is labelled AI unless a model actually produced it. Signatures, clusters, beats and edge density are measured or rule-based, and the docs and UI say so.
- No new dependencies. Everything uses Node and ffmpeg, which Frame already requires.

## Rough size and order

| PR | Size | Depends on |
| --- | --- | --- |
| 1 Truthful pixels | Medium. Text layout parity is the risky part | — |
| 2 Honest edits | Small | — |
| 3 `frame_watch` | Small–medium | 1 (so frames show true text) |
| 4 Shot memory + beats | Medium | — |
| 5 `frame_check` + approve gate | Medium | 1, 3, 4 |
| 6 Upstream window features + recipe hash | Small–medium | 1 (drag uses server text) |

PRs 1 and 2 are independent and remove the two ways the tools lie today. I'd start there.

## How this proposal was put together

- **Evidence first.** Every weakness above happened in one real edit: the MoneyStack reel, from the prepared run to the approved 18.1 s export in `~/Movies/Frame/Approved/MoneyStack-sketch-to-demo_v1.mp4`. I list only problems I hit or the user pointed out. I confirmed each one in the source of the sketch-to-demo runtime:
  - `render.js` takes text from UI-uploaded rasters.
  - `project.js` `CLIP_PROPS` has no `asset`, and `update_clip` drops unknown keys.
  - `frame_view` slices to 6 times.
  - Scene cuts exist (`sceneCuts`), but there's no per-second signature or beat analysis.
- **What I did by hand, then automated on paper.**
  - Contact sheets with ad-hoc ffmpeg and Python tiling → `frame_watch`.
  - Eyeballing which file was which camera → angles.
  - Reading the timeline text to spot the ignored source swap → honest diffs and `replace_source`.
  - Checking the export frame by frame before approving → the approve gate.
- **Checked against this repo's own rules** (AGENTS.md): one timeline through `applyOp`, render as truth, measured numbers only, zero dependencies, local only. Server-side text is already roadmap item 9; this proposal promotes it to first, because it's the one that let a wrong video look right.
- **Not yet done:** no code written in this repo, and no tests run. Size estimates are judgement, not measurement. The safe-zone numbers must be checked against the live Instagram UI before they are trusted.

---

## Draft pull request description (for PR 1 + PR 2, if approved)

**Title:** Truthful pixels and honest edits: server-side text, `replace_source`, strict `update_clip`

**Summary**
- Caption drawing lives in one file, `ui/text-draw.js`. The window uses it, and with no window the service runs it in headless Chrome (`src/text.js`), so text no longer needs a window.
- Each drawn caption records the text and style it came from. The renderer never overlays an out-of-date one, and `frame_render` refuses to export with a caption missing unless `allow_missing_text` is passed.
- `update_clip` rejects keys it doesn't apply, instead of silently ignoring them.
- New `replace_source {id, asset, in, out}` op swaps a clip's footage while keeping its start, duration and track.
- Every `frame_edit` result ends with a read-back diff of what actually changed, plus any V1 gap or overlap above one frame.

**Why.** In a real edit, a caption restyle and a camera swap were both reported as done when they weren't. See `docs/PROPOSAL-SEEING.md`.

**Tests.** `node test/smoke.js`: 22 checks, all passing (15 existing, 7 new):
- caption drawn with no window
- restyle shows its new colour with no window
- a stale caption is never composited
- `update_clip {asset}` is rejected and changes nothing
- `replace_source` keeps the slot
- `replace_source` refuses a range past the end of the footage
- gaps on V1 are reported

The headless checks skip themselves when no Chromium browser is installed. Also checked by hand: the window loads the shared drawing file with no console errors and uploads its captions.

**Version.** 1.2.0, so an MCP bridge replaces a running older service.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
