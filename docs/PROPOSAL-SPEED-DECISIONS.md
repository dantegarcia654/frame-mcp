# Proposal: make Frame faster with a decision model

Status: **design only**, written 17 November 2026. Nothing is built and no API call has been made, because no Gemini or TypeSafe key exists on this machine. Every Google or TypeSafe number below is the vendor's claim until the spike at the end measures it.

## Verdict

Use Google's **Gemini Decisions API** (`gemini-decision-1`). Skip **Jev**.

Frame's slow steps are perception: looking at clips and listening to takes. Jev only reads text. Gemini Decision 1 reads video, audio, images, PDFs and text in one input, and answers up to 1,000 yes/no, choice and rubric questions about it in one pass. The one Frame job Jev could do, routing a typed command to an edit op, Gemini also does, so a second vendor buys nothing. Price doesn't decide it at Frame's volume.

| | Gemini Decision 1 (Google) | Jev (TypeSafe) |
| --- | --- | --- |
| Input | Text, images, audio, video, PDF. 256K tokens | Text or JSON only. 32K tokens of state |
| Question types | yes/no (`noul`), choice (2–255 options), rubric score. Up to 1,000 per call | Same three types, up to 255 options |
| Output | Probabilities and a 0–1 confidence per answer. No text | Same. No text |
| Latency (vendor) | 150–250 ms end to end, on contexts up to 16K tokens | 70–500 ms |
| Price | $0.10 per 1M input tokens, output free | $0.042 per 1M input tokens, output free |
| Access | API key from AI Studio, free tier. `v1beta` only | Direct API waitlisted. Open through Vercel AI Gateway and Cloudflare Workers AI |
| Can it see a clip or hear a take? | Yes | No |

## Where Frame's time goes today (measured)

| Run | Step | Time |
| --- | --- | --- |
| `frame speedrun`, 28 s 4K clip (2026-11-16) | import / Whisper / render | 17 s / 23 s / 38 s, 80 s total |
| sketch-to-demo, 14 new doughnut clips (2026-11-13) | Inbox processing (automatic) | about 4½ min |
| | **clip-to-slot matching** | **1 min 45 s** |
| | prepare / assembly | 36 s / 11.2 s |
| Timed challenges (2026-11-16/17) | before the first visible edit, the agent looking at footage and planning | 50–70 s |

Quality is the other half. The sketch-to-demo labels were the weak link: labeling each clip from 3 sampled frames reused overlapping ranges, kept camera-junk windows and missed the best moments.

A decision model can't speed up ffmpeg or Whisper. It targets the **looking and judging** steps: matching, the agent's first-minute planning, checking captions by ear, and the wait before a typed steer gets applied.

## The workflow

```
import ─┬─ proxy, scenes, loudness                         (today)
        ├─ Whisper words                                   (today)
        └─ decision proxy → one Decisions call per asset   (new, starts at once, blocks nothing)
                     │
                     ▼
   every asset shows role · confidence · scores · flags     (seconds, not minutes)
                     │
                     ▼
   story picked by reading the sheet (agent or speedrun) → frame_edit
                     │
   transcript lands → caption check on audio slices → captions to re-check get flagged
                     │
                     ▼
   render → fast perceptual QC → final-boss only before posting

   at any time: a steer typed in the window → routed to an op in under a second, or handed to Claude
```

### 1. Decision sheet at import (the matching win)

- On import, Frame makes a small **decision proxy**: 360p, 2 fps, mono 16 kHz audio, a few hundred KB. It sends it with one question pack, in parallel with Whisper. Nothing waits on it.
- A separate proxy, because Gemini usually samples video at about 1 fps. The 720p, 30 fps preview proxy would only add upload time. (This is an assumption to check.)
- Media goes inline as base64, up to 100 MB per request, so there's no Files API upload round trip.
- There's one request per asset, and all assets run in parallel. The API has no context caching, so all of an asset's questions go in one request. That way the clip is billed once.

**Question pack: sketch-to-demo.** It reuses the 14-role taxonomy already defined in the indexer's `INDEXING-WORKFLOW.md`.

| Key | Type | Question |
| --- | --- | --- |
| `role` | choice | reaction_hook, drawing, photograph, open_tool, select_model, connect_tool, upload_drawing, enter_prompt, build_in_progress, result_reveal, interactive_demo, outro, shared_setup, unclassified |
| `drawing_visible` | yes/no | Is a hand-drawn sketch clearly visible? |
| `upload_matches_drawing` | yes/no | Does the uploaded attachment show the drawing itself, not a screenshot or another file? (The `IMG_4782.PNG` problem that needed a reshoot. This would catch it at import instead of in the export.) |
| `camera_junk` | yes/no | Is this mostly pocket, floor, blur or the camera being set down? |
| `screen_legible_vertical` | yes/no | Would the screen text still be readable cropped to 9:16? |
| `stability` | score | shaky / mostly steady / locked off |
| `hook_strength` | score | wouldn't stop a scroll / might / would |

**Question pack: talking head.** It asks for delivery, using the rubric from Google's own launch example (hesitant / mostly steady / polished). It also asks yes/no questions for a flub or self-correction and for eyes on the lens, plus an energy score.

**Storage and display.**
- Results go on the asset record as `decisions: {model, at, answers, confidence}` with `source: "gemini-decision-1"`. They're never mixed with measured data.
- The window shows a role badge with its confidence.
- Anything below the threshold gets a **review** pill instead of a guess. This follows the flag-don't-guess rule.

**Where in a clip.** The API answers about the whole input. The spike decides between two ways to get in and out windows:
- a. One request per scene window, in parallel. Frame already detects scene cuts at import.
- b. A `choice` whose options are time windows ("0–2 s", "2–4 s"…, up to 255). It returns a probability over time in one call. Nobody has shown the model localizes in time this well.

Either way, windows still go through the existing motion and entry/exit review before they count as cuts.

### 2. The agent reads instead of looking (timed runs)

- `frame_state` gains one line per asset: role, confidence, hook score, flags. The first-minute loop of "six `frame_view` stills, think, repeat" becomes reading about 15 lines.
- `frame speedrun` uses `hook_strength` to choose the opening beat and drops clips flagged as camera junk.
- A new tool, **`frame_decide {project_id, assets | range, questions}`**, lets Claude batch ad-hoc questions into one call of about a second instead of viewing each clip. An example is "which of takes a3–a8 is the most fluent?"

### 3. Caption check by ear becomes a flagged list

- After Whisper, Frame cuts each caption phrase's audio slice and asks one yes/no question: does the speaker say exactly this?
- Where Whisper was unsure, or on brand names (Zenzap, Higgsfield, Frame), it asks a `choice` among the likely spellings instead.
- All phrases go in one parallel batch. A low score puts a **check wording** pill on that caption.
- This automates the forced-scoring that the Zenzap brief already requires. It replaces the "then fix misheard captions" listening pass in speedrun.

### 4. Instant steering in the window

- Today a message typed in the Frame window waits for the agent's next tool result, the "FROM THE USER" block.
- New: Frame first routes the message as a `choice` over a short list of safe ops. The list is caption bigger, caption smaller, caption colour, undo, delete selected, nudge selected, mute music, and **other**.
- A confident answer is applied immediately and shown as the user's own edit, so undo works.
- An answer of **other**, or one with low confidence, goes to Claude as today.
- This is text-only, the one place Jev could do the job. Gemini does it as well, so there's still one vendor.

### 5. Fast perceptual QC before final-boss

- On the render, Frame asks the few questions that measured checks can't answer:
  - Is the subject cropped out of the 9:16 frame?
  - Does a caption cover a face?
  - Is the payoff visible in the first 2 seconds?
  - Does it end on a dead screen?
- It takes about a second. It doesn't replace final-boss; it saves waiting on final-boss for an export that's obviously broken.
- It complements the measured `frame_check` in `PROPOSAL-SEEING.md` PR 5.

## Cost, limits and risks

- **Price.**
  - $0.10 per 1M input tokens. Output is free.
  - Gemini models usually spend roughly 100–300 tokens per second of video, depending on resolution. This rate isn't confirmed for Decision 1.
  - At about 300 tokens per second, a 30 s clip is about 9K tokens, about $0.001. A 14-clip batch is under a cent.
- **Latency.**
  - Google's 150–250 ms was measured on contexts up to 16K tokens, about 50 s of video at the rate above. Longer clips are outside what Google reported.
  - Real wall time adds the upload of the decision proxy.
- **Rate limits.**
  - Free tier: 200 requests/min, 50K tokens/min, 10K requests/day. That's only about 2–3 minutes of video per minute, so one sketch-to-demo batch can hit the cap.
  - Tier 1: 1M tokens/min.
- **Privacy.**
  - Free-tier content is used to improve Google's products. Paid-tier content isn't.
  - The footage includes Dante's face and client work (Zenzap), so use the **paid tier only**.
- **API maturity.**
  - `v1beta` only, and not on Vertex yet.
  - No context caching and no batch API.
  - Questions are text only; media goes only in the input.
- **Answers can be wrong.** They're typed but come with no explanation. Threshold on confidence, and keep human review for anything below it.
- **Frame stays zero-dependency.**
  - Calls are plain `fetch` to `POST https://generativelanguage.googleapis.com/v1beta/decisions` with an `x-goog-api-key` header.
  - With no key, Frame says so in plain words and works as it does today.
  - The exact field names for inline video blocks weren't in the public write-ups read for this proposal. Check the API reference before writing the client.

## Spike before building

**Built:** `zenzap-ad/decisions-spike/` (`spike.mjs`, `mock.mjs`, `README.md`). It's kept out of this public repo because it reads private footage paths. It runs every test below against answers already on file, and prints the go / no-go bars. It's been checked against a mock API only. It has never run against Google.

**Needs:** a paid-tier Gemini API key, created in Google AI Studio and set as `GEMINI_API_KEY`.

1. **Roles.**
   - Run the role pack on the 23 clips in sketch-to-demo's `bucket-labels.json`.
   - Those labels came from agent review of real frames, not from Dante, so treat them as a baseline. The ranges chosen in the approved MoneyStack cut and the liked doughnut cut are the stronger check.
   - Measure agreement, calibration (does 0.9 confidence mean right 9 times in 10?), wall time per clip, wall time for the whole batch in parallel, and tokens.
2. **Windows.** Compare approaches a and b against the windows in `editing-index.json`.
3. **Truth flag.** Does `upload_matches_drawing` fire on IMG_4827 and IMG_4830?
4. **Delivery.** Run the talking-head pack on the Zenzap A-roll takes. Compare it with the takes chosen for the v1 assembly.
5. **Captions.** Use a clip with a known mishear.

**Go if** all three hold (Dante can move these bars):
- role agreement is at least 85% on answers above the threshold
- the 14-clip batch comes back in under 10 s of wall time
- the truth flag fires

Otherwise keep the current pipeline.

## Build order after a go

1. `src/decide.js` (the client), the decision proxy, the import hook, and `decisions` on the asset record, all behind the key.
2. The `frame_state` table, plus the role badge and review pill in the window.
3. The `frame_decide` tool.
4. The caption check.
5. The steering router in the window.
6. Render QC.

## Not covered

Import, Whisper and render times. They're 78 of the 80 seconds in the speedrun above and need their own work, for example a faster Whisper build or renders at preview resolution. A decision model doesn't touch them.

## Sources

- Google AI Studio launch email, 17 Nov 2026, and the launch post: https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api/
- Endpoint, request and response shape, media limits, rate limits: https://apidog.com/blog/gemini-decisions-api/
- Jev facts and limits: https://www.videosdk.live/developer-hub/ai/what-is-jev
- How a video company uses Jev (text-only paths, shadow rollout): https://www.ngram.com/blog/jev-inside-ngram
