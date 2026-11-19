# Case study: two sketch-to-demo reels in one day (13 November 2026)

Two vertical reels were made for The AGI Guide with Frame and Claude: **MoneyStack** (money sketch → stacking game, approved) and **Simpsons / doughnut** (donut sketch → "donut forecast" website, rendered and called "really good" by the user, not yet approved).

Every number below was measured during the session: runner receipts, Frame Inbox records, file timestamps. Where a time includes Claude's own thinking, it says so.

## Headline

The second reel, shot on purpose for this workflow, went from "go" to an editable 20.3 s cut in about **3½ minutes**. The user then did a light hand pass in Frame and judged it **better than the first**, describing the edit as "certainly more punchy". Two things made the difference:

1. **The footage was shot for the edit.** The user recorded stable shots and left out flubs ("flubber"). Every slot had a clean take, including the two setup steps the earlier doughnut footage never had: uploading the drawing and typing the prompt.
2. **The captions carried the video.** Claude wrote all of them from a saved style profile, with no input from the user. The user called them "hilarious" and said they "definitely help carry the video".

## Results

| | MoneyStack | Simpsons / doughnut (new footage) |
|---|---|---|
| Source footage | Existing index + 2 new laptop angles shot mid-session | 14 new clips (≈4 min), shot for this edit |
| Footage in → processed | n/a | uploaded 12:26:21, all 14 ready 12:30:58 (≈4½ min, automatic) |
| Matching clips to slots | Done earlier, by an older pipeline | 1 min 45 s (Claude reviewing contact sheets of all 14 clips) |
| Captions | 4 revision rounds with the user | Written once from the style profile, alongside the matching |
| Bind → preflight → prepare | — | 36 s |
| Assembly (runner receipt) | 15.19 s (first clip on the timeline at 0.35 s) | **11.2 s** (first clip at 4.0 s) |
| Frame check by Claude | Several rounds | ≈1 min, 14 composited frames |
| Final length | 18.1 s | 20.33 s |
| Status | Approved: `~/Movies/Frame/Approved/MoneyStack-sketch-to-demo_v1.mp4` | Rendered: `~/Movies/Frame/Simpsons-doughnut-new-footage_v1.mp4`, awaiting the user's approval |

Assembly beat the under-60 s requirement and the 30 s stretch target both times. The 4.0 s first clip on the doughnut cut (vs 0.35 s) came with all-4K source footage; that the 4K caused it is unconfirmed.

## What worked

- **A style profile saved inside Frame** (`~/.frame/profiles/agi-guide-reels.md`). It holds every correction the user made on MoneyStack, plus the operational mistakes and their fixes. The doughnut cut applied all of it on the first draft:
  - story captions
  - white text with intentional caps
  - no back-to-back beat cuts on the same angle
  - laptop-focused opening
  - the product working in the last shot
  - no end card

  Frame hands the profile to any AI that starts an edit (`frame_start`, `frame_profile`), so Codex sees the same rules.
- **Story captions.** Hook (why it matters) → one punchy line per cut showing how it works → "Here's how to set it up ↓" → the steps, unchanged → payoff and shock ("Wait… it WORKS?!") → one more reason to care. They were written from what was on screen (the "100% chance of donuts" forecast, donuts raining through clouds, the "Your turn" panel), never from invented features.
- **Five laptop angles, alternated.** The user shot the same screen from several positions, so every beat cut could change angle.
- **Frame Inbox as the drop folder.** Upload, then automatic measurement (metadata, audio, silences, scenes, preview copy, transcript), with the originals untouched.
- **Deterministic assembly.** Once the recipe exists, the runner builds the editable timeline in about 11–15 s. Every clip, trim and caption stays separately editable.
- **The human finish in Frame.** The user fine-tuned timing with **slip**, built mid-session. That turned "90% there" into a cut they liked.
- **The approve gate.** Render → watch → **Approve & save**, which copies to `~/Movies/Frame/Approved/`. Only the user approves.

## What broke, and what was done

| What broke | Effect | Fix today | Still open |
|---|---|---|---|
| The `/sketch-to-demo simpsons` fast path ran the **old** doughnut recipe when the user meant the new footage | A wasted run and a revision on the wrong footage | Claude stopped, said so and rebuilt from the new clips | The command should ask "new footage or saved recipe?" when new uploads exist |
| New footage sat in `Downloads/`, not Frame Inbox | Nothing processed; the user thought it had been | Claude uploaded it to the inbox | The upload page or a watched folder should be the one obvious place |
| The background "processing done" notice never reached the user | The user had to ask | — | A reliable notice, ideally shown in Frame |
| Restyled captions kept rendering in the old style (sketch-to-demo Frame) | Yellow and red captions shipped in a check frame after being "changed" to white | Delete and re-add the captions; added to the profile | Fixed in frame-mcp 1.2.0 (PR #4) but **not** in the sketch-to-demo Frame copy |
| `update_clip {asset}` silently ignored ("swap camera" did nothing) | The wrong footage, from the wrong moment | Delete + add at the same start; added to the profile | Fixed in 1.2.0 (`replace_source`, strict `update_clip`); not in the sketch-to-demo copy |
| No ripple: extending a clip didn't push later clips | Hand edits left overlaps and drift | Ported ripple into the sketch-to-demo copy; captions move with their shots | — |
| No slip | Couldn't hold a shot's length and pick a better moment | **Added:** Option-drag, and −1s / −5f / −1f / +1f / +5f / +1s buttons | — |
| The user couldn't type their own text | The side panel rebuilt on every update and wiped typing | Panel holds while typing; double-click a caption to edit in place; Enter saves | — |
| No control over caption size or line count | Hand restyling was clumsy | Corner handle and A− / A+ for size; Lines buttons (Auto, 1–4) that reflow evenly; side handle for line width | Making text bigger can rewrap a fixed line count; press the number again |
| Any change to the runtime invalidates prepared recipes | "Prepared recipe/runtime mismatch" | Re-prepare, never bypass | Hash only the files that affect output (proposal PR 6) |
| A restarted Frame came up after the runner's 6 s wait | The runner reported "did not start" on a healthy service (three times) | Verified it was the runner's own Frame (same program, data folder and port), then recorded it | Lengthen the wait, or poll for the service's own process |
| Template captions (yellow and red, all caps, end card) don't follow the profile | Every prepared recipe needs a caption pass | Captions written into the new recipe | Bake the profile into recipes at prepare time |
| Claude couldn't "see" the video | Manual contact sheets and up to 6 stills per look; problems caught late | Contact sheets by hand | `frame_watch` and `frame_check` (proposal PRs 3–5) |
| Three diverged Frame installs | Fixes land in one and not the others | Shared profile file as a stopgap | Converge the sketch-to-demo copy (1.1.0 fork), Codex's clone (1.1.0, port 4749) and frame-mcp main (1.2.0) |
| ChatGPT in the browser can't reach Frame | Only Claude Code and Codex can edit | — | HTTP MCP endpoint (roadmap) and a Codex prompt for `/sketch-to-demo` |

## Product work shipped the same day

- **frame-mcp (GitHub):** the proposal `docs/PROPOSAL-SEEING.md`, and PR #4, "Truthful pixels and honest edits (1.2.0)":
  - captions drawn by headless Chrome running the same code as the window
  - stale captions never rendered
  - strict `update_clip`, plus `replace_source`
  - read-back diffs and gap warnings

  Review found two blockers: stale caption uploads accepted, and a hole left when a clip moved from V1 to V2. Both were fixed with regression checks that fail on the old code. Merged after #2 (Windows support), then #3 (the assignment brief). `main` passes 27 smoke checks.
- **Sketch-to-demo Frame (port 4873):**
  - **+ Text** and **T**, plus drag captions in the preview
  - **Save to Frame library** and **Approve & save**
  - the style profile and `frame_profile`
  - slip, ripple and in-place text editing
  - caption size and line count

## Lessons

1. **Shoot for the edit.** Stable, single-purpose shots with no flubs, every story step covered and several angles of the same screen did more for quality than any tool change.
2. **Write the rules down where every AI will read them.** MoneyStack took four caption rounds; the doughnut cut took zero, because the corrections were in the profile.
3. **The slow part is matching clips to slots, not assembly.** Assembly is ~11 s; looking at the footage and choosing windows took ~1¾ min. That is where Frame should help next (shot memory, angle groups, `frame_watch`).
4. **A human finishing pass in Frame is the point, not a failure.** Claude got to ~90%; the user's slip edits made it feel right. The tools for that pass (slip, ripple, typing, sizing) mattered as much as the automation.
5. **Tools must not report success they didn't achieve.** The two worst misses were edits that said "✓" and didn't happen.

## Files

- Style profile: `~/.frame/profiles/agi-guide-reels.md`
- Doughnut recipe: `…/outputs/sketch-to-demo/versions/simpsons-doughnut-new-footage/` (template, variables, manifest, prepared)
- Run receipt: `…/outputs/sketch-to-demo/runs/2026-11-13T20-53-53-452Z/receipt.json` (project `p_u28zlt`)
- Renders: `~/Movies/Frame/`; approved: `~/Movies/Frame/Approved/`
