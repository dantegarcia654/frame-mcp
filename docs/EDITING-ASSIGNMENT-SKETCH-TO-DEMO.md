# Editing assignment after the Sazabi event: review test

Prepared by Codex on November 13, 2026, from the task history and saved local artifacts. This is an agent-authored reconstruction and manual acceptance test, not a new editing run or a human-approved result.

**Task:** turn supplied drawing-to-product footage into the racecar reference's repeatable edit through `/sketch-to-demo`, visibly in Frame, fast enough to review in seconds, while preserving editable clips, titles and audio. Prepare footage automatically before an editor asks for it. Let the user choose among three projects before execution.

**Current verdict: partial.** A saved real-footage receipt records 24.889 seconds to assemble a 26.5-second racecar timeline. That excludes preparation, model dispatch and export. The three newer versions are prepared, not assembled; post-export editability acceptance on the fresh racecar run remains pending.

## 1. Assignment

The assignment is to save a reusable command, `/sketch-to-demo`, that assembles a drawing-to-product video using a studied racecar reference. It must show real changes on Frame's timeline, allow footage and copy to vary while retaining the editorial pattern, and preserve post-export editing.

The original speed target was roughly 30 seconds. The later acceptance requirement was a fresh real-footage assembly in strictly under a minute. The measured implementation excludes earlier preparation; it does not prove an entire request-to-finished-edit turnaround under a minute.

Supporting requirements:

- Process incoming footage before the edit request, including audio dips and searchable source windows.
- Offer Flappy Turd, Simpsons/doughnut and MoneyStack as explicit choices.
- Wait for selection and user-triggered execution; do not automatically assemble the three prepared versions.
- Skip missing upload/prompt steps for MoneyStack and Simpsons and close the gaps, without substituting unrelated footage.
- Keep source clips, titles and audio editable; disclose baked-in objects that require a new source render.

This public brief is paraphrased. Exact task wording and private source locations are in the separate owner-facing report. Private chat excerpts, identifiers, local paths, source hashes and raw media are not published here.

## 2. Problem this was supposed to solve

The Sazabi discussion made persistent, evidence-backed context the product question: how can Frame know enough about footage and prior editing decisions that each request does not restart discovery?

The concrete failures were waiting through analysis and asset creation before seeing a timeline, repeatedly scanning whole videos, guessing audio boundaries, rebuilding the same editorial choices, and receiving a flattened video whose internal animation objects cannot be hand-edited. Speed had to mean a useful visible result, with enough retained state to revise and reuse it.

The earlier editing experiment used a Claude/AdGuard explainer. The user's central feedback was that visible assembly happened only after lengthy preparation. The requested improvement was to keep recording ready, place available local footage immediately, and append useful recording segments during capture.

That experiment also exposed an editability limitation: animation scenes were rendered video clips. Frame could trim and reorder them, while objects inside those clips required re-rendering.

See the existing [Sazabi conversation archive](YC-SAZABI-CONVERSATION-2026-11-12.md). Its imagined alerts and timing diagnosis are illustrative; they are not evidence for this editing test.

## 3. How the work approached it

1. **Put useful footage on screen early.** The precursor implemented cached local placeholders, a warm isolated recorder, incremental recording segments, background analysis, pause/undo and capture recovery. Historical owner reports recorded 72 ms to local footage and 2.45 seconds to real capture. These are different tests from the racecar assembly.
2. **Study once, save the editing decisions.** The racecar study measured 720×1280, 30 fps, 26.5 seconds. It saved 16 shot slots: proof first → drawing/photo → setup → attachment/prompt → build → working result → CTA. Cut-frame anchors: `0, 26, 89, 133, 177, 220, 263, 305, 339, 370, 406, 437, 524, 546, 589, 675, 795`. These reconstruct the editorial pattern; they do not recover hidden layers from a finished MP4.
3. **Separate variables from the recipe.** Source ranges, product names, copy, supplied audio and reviewed caption timing bind to the measured slots. The runner validates duration, source bounds and hashes before applying ordinary Frame imports/edits. It retains the editable project after export.
4. **Preprocess on intake.** A separate local FrameInbox prepares metadata, transcripts, audio levels/dips, scene candidates and playback copies. It indexes by project, visible action and candidate source windows. The editor retrieves selected ranges. The installed service was moved out of iCloud-backed Documents after file-read failures.
5. **Use evidence for labels.** Google/Gemini analysis was attempted but returned no usable shot information. Labels came from local measurements and bounded visual review. Nearly silent footage produced unreliable transcript candidates, which were flagged. Four setup clips showing a PS2 screenshot were excluded from automatic drawing selection.
6. **Prepare three selectable versions.** Twenty-three new clips were indexed for Flappy Turd, Simpsons/doughnut and MoneyStack. Actual footage showed Freebuff, so older Claude/Higgsfield captions were unsuitable for those versions. Missing MoneyStack/Simpsons upload-and-prompt steps were removed and timing rippled, following the user's correction.
7. **Respect the execution hold.** The command was prepared to ask which version to edit. Automatic indexing does not execute the three edits. Recipe role labels describe deterministic stages; they are not proof that independent AI agents were running.

This is a local prototype beside an isolated Frame runtime. The runner, inbox and three prepared versions are not delivered by this documentation change, nor established as capabilities of a fresh clone of this repository. No hosted ChatGPT web connection was deployed.

## 4. How it went: evidence and limits

| Check | Saved evidence | Review status |
| --- | --- | --- |
| Fresh real footage | Receipt: `fixture=false`, `headless=false` | A real run is recorded; not independently rerun here |
| First timeline clip | 3,570.324 ms after runner invocation | Timeline placement timing; not a measurement of first visible pixels |
| Editable assembly | 24,889.123 ms; 31 clips = 16 video + 15 title clips | Under 30 s and 60 s for the defined assembly scope |
| Result duration | 26.5 s | Preserves reference length for racecar |
| Export + decode | Separate recorded phase: 5,056.942 ms; H.264, 540×960, video/audio, decode passed | Draft export, not full-resolution acceptance |
| Creative match | Racecar opening used drawing instead of absent face-reaction footage; no separate supplied soundtrack in that run | Not a claim of exact reference fidelity or creator approval |
| Editability after export | Native timeline retained; receipt says `requires_visual_and_editability_review` | Fresh-run title edit, source trim and undo acceptance still pending |
| New footage preparation | 23 clips processed and labeled according to saved workflow/chat | Candidate source windows still require motion-boundary review |
| Three versions | Flappy Turd 26.5 s; Simpsons/doughnut 22.1 s; MoneyStack 22.1 s; all preflight passed; all `executed=false` | Prepared only, held for user selection |
| Total wait | User repeatedly reported excessive setup delay and redirected work toward indexing | No measured request-to-finished-edit total; the 24.889 s result cannot stand in for it |

The evidence summary in [the companion JSON](../test/cases/sketch-to-demo-review.json) was extracted from saved receipts and readiness files. This review reads those artifacts; it does not recertify their measurements or silently complete missing checks.

## 5. Manual acceptance test everyone can review

**Case ID:** `sketch-to-demo-review`. This is a manual product test specification, not an executable smoke test.

### Inputs and setup

Use a scratch Frame project/store, reviewed raw sources and audio, the racecar reference, the saved recipe/runner, and a version-specific manifest. The required media and local prototype are not bundled here: external reviewers need an authorized fixture handoff before execution. Their absence is **blocked**, not passed.

Never use a human-owned browser. Allocate an agent-owned session with the host's `agent-session allocate "$CODEX_THREAD_ID"`, verify ownership, and use only that profile/PID/window. Do not replace another Frame runtime or touch approved projects. Do not start the three held versions without the user's command and selection.

### Procedure and acceptance

| Step | Action | Required evidence / pass condition |
| --- | --- | --- |
| A | Invoke the command without selecting a version | Offers exactly the three named versions and waits; zero timeline edits before selection |
| B | Select one version and resolve its indexed sources | Correct bucket, source identities, reviewed windows and brand labels; unrelated/ambiguous PS2 footage excluded |
| C | Check preparation and missing shots | Explicit report of missing/uncertain inputs; MoneyStack/Simpsons skip absent steps and close gaps; no substitute proof |
| D | Start a fresh visible assembly | Record user-command time, runner invocation, first clip, first visible frame and assembly completion separately |
| E | Watch the actual editing room | Real clips/titles land progressively; labels truthfully distinguish recipe stages from independent agents |
| F | Complete the timed build | Verified native editable assembly strictly under 60,000 ms; report 30,000 ms stretch result; account separately for preprocessing, dispatch, generation and export |
| G | Inspect editorial output | Match the approved shot order, crop, readable text, action/result holds and supplied audio; human creative review pending until actually given |
| H | Export and decode | Probe dimensions/duration/audio; clean full decode; compare representative preview/export frames and relevant audio |
| I | Edit after export | Change a title and trim a source clip, see the changes in a new export, undo them, reload and verify restored state; preserve the original checkpoint |
| J | Change multiple variables | Swap source/product/copy in a second scratch version; intended recipe stays stable; approved skipped steps ripple correctly |
| K | Test steering safely | Pause during assembly, make one manual change, resume; change survives or runner stops with a clear conflict; no overwrite |
| L | Finish a review report | Pass/fail/blocked per row, reproducible steps, timings with exact scope, artifact links and remaining gaps; do not label prepared versions finished |

No overall pass until visible assembly, output review and post-export editability all pass. A fast synthetic rehearsal, successful preflight or decodable MP4 alone cannot pass this case.

## 6. Where to find the information

### Included in this repository

- The paraphrased assignment, approach and acceptance test.
- [Machine-readable evidence summary](../test/cases/sketch-to-demo-review.json).
- [Sazabi context](YC-SAZABI-CONVERSATION-2026-11-12.md).
- [Repository testing instructions](TESTING.md). Its smoke checks are separate from this manual acceptance case.

### Source availability

The owner-facing report identifies the original conversations and exact local paths. Public reviewers can request an authorized evidence handoff containing:

- The reference study and shot template.
- The timed-run receipt and draft export.
- The saved command, runner and required runtime.
- The footage index and three prepared manifests.
- The post-export editability review, when completed.

Those inputs are not bundled in this repository. The companion JSON contains only the task-relevant recorded timing and status summary. It does not expose private chat identifiers, machine paths, access links or source hashes.

This documentation change does not install the local prototype or execute the held edits.
