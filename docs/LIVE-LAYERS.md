# Live layers

A design element in Frame can be a **live layer** instead of pixels baked into an MP4: a `live_graphic` effect clip
whose `params.nodes` describe what to draw. The window draws it every frame with `ui/live-graphics.js`. Export draws it
with the same file in headless Chrome. An edit therefore shows on the canvas at once, with no compositor run and no
re-encode, and it is saved as a revision you can review, revert and redo by hand.

## One element per clip

A clip with exactly one node is one clickable object.
- **Canvas:** clicking selects it, dragging moves it, and the corner handle resizes it.
- **Toolbar:** the toolbar under the canvas shows its controls: text, colour (fill, color, or the highlight colour once that is showing), size, position and corners.
- **Prompts:** only single-node clips can be prompt targets.

Multi-node clips are for decoration sets: dot grids, particle bursts, stair steps.

Give each clip a plain-English label that names its section, for example `L50 · Call-to-action button`. Prompts are routed by those words.

## Node schema

All geometry is a fraction of the frame. Times are clip-local seconds.

| Kind | What it draws | Key properties |
|---|---|---|
| `rect` | box, card, button | `w h radius fill fill2 (vertical gradient) stroke lineWidth dash shadow` |
| `line` | rule, underline | `w h lineWidth color dash`; drawn up to progress `p` |
| `text` | type | `text size font (sans/serif/mono) weight align reveal (type/words) cues`; `{v}` counts from `from` to `to`, padded to `pad` |
| `pixtext` | 5×7 pixel font | `text size` (one pixel as a fraction of height), `align reveal {v}` |
| `sprite` | pixel art | `asset` (squid, block, saucer, spark, clawd, clawd-blink, clawd-walk) or `rows`+`pal`, plus `size speed flip eye` |
| `brand` | Claude symbol, wordmark, Clawd | `asset w h color motion` |
| `slider` | control | `w value` or progress `p` |
| `invader` | legacy sprite | `w h speed` |

These properties apply to every kind:

| Property | Effect |
|---|---|
| `at`, `until` | When the node is visible |
| `fade`, `fadeOut` | Fade in after `at`, fade out before `until` |
| `highlightAt` + `accent` | Switch to the accent colour at a time |
| `edge` | Leading-tile colour for the `tiles` reveal |
| `spin` | Rotation speed in rad/s |
| `hz` | Stepped, retro motion |
| `reveal` | `wipe`, `wipeup`, `wipedown` or `tiles` (the 40 px generate sweep), driven by `p` |
| `anim` | Keyframes `[{t, x, y, s, a, r, p, e}]` (see below) |

**`anim` keyframes:**
- `x` and `y` are offsets from the node's position.
- `s` is scale and `r` is rotation, both about the node's centre.
- `a` is alpha.
- `p` is progress, which drives typing, wipes, counters and slider values.
- `e` is the ease into the keyframe: `lin`, `out`, `in`, `io`, `back` or `step`.

**Limits:** 400 nodes and 400 KB per clip. Validation is `validateNodes()`, used by both the window and export.

## Footage motion

Video and image clips accept `move: [{t, x, y, e}]` (`ui/clip-move.js`). The keyframes offset the clip's own x/y.
- The window interpolates them every frame.
- Export turns them into ffmpeg `overlay` expressions.
- Splitting a moving clip keeps the motion continuous.

A typical use is a face sliding into the bottom half of a split screen: `{"op":"update_clip","id":"…","y":0.2448,"move":[{"t":0,"y":0.5},{"t":0.28,"y":0,"e":"out"}]}`.

## Export

When every live layer sits above all footage, export draws them as one overlay (`live_stack` in `src/effects.js`):
- **One PNG per output frame,** not one per layer per frame. For an 85 s reel with about 700 layers that is roughly 230 MB, instead of more than 1 GB.
- **Each layer keeps its own clip-local time, opacity and fades.**
- **Any edit changes the overlay's key,** so the next export redraws it.

## Prompt routing

`frame_prompt` sends natural language to Google Decisions (`gemini-decision-1`). The routing works like this:
1. Candidates are single-node live clips. When the prompt names something on screen at the playhead, only on-screen clips are considered.
2. Decisions picks the target and the control. Below 0.7 confidence the job asks for input.
3. A colour request goes to the colour you can see: `fill` or `color`, whichever the shape has, or `accent` once its highlight is showing.
4. The window claims the job, moves a named cursor to the same toolbar control a person would use, sets the value and saves a revision with before and after.

Several prompts route concurrently, and the exact form `element-id: property=value` skips the model.
