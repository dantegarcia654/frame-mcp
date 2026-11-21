# FRAME — First successful export test

Status: **DESIGNED / NOT RUN**. Founder mobile prototype feedback: **MAYBE**. This is **not independent validation** and does not count as a passing user test.

## Hypothesis

A creator can describe one desired visual edit in ChatGPT, see FRAME become interactive, steer the result, and export a publishable video from their own footage without coaching. A successful visual demo alone does not establish this hypothesis.

## The test, with external creators

Recruit **5 independent short-form video creators** (not friends building FRAME or people briefed on its internals). Ideally at least 3 currently edit their own videos weekly. Ask each to bring one **15–45 second video they have permission to use** and a real editing goal. Do not supply stock rocket footage or a rehearsed command.

Use the same flow per creator:
1. Put the creator on their own **iPhone** in ChatGPT. Start the clock before their first editing instruction. Say only: "Use this video to make a version you would actually post. Think aloud. I won't show you how."
2. Record whether FRAME **auto-activates**, whether the first **editable visual** appears, and elapsed seconds. If the host cannot auto-invoke FRAME, mark **FAIL for activation**, then separately test via explicit invocation to isolate the editor.
3. Let the creator make at least **two unprompted revisions** (e.g. cut, captions, crop, motion, timing). Do not supply the words to type. Measure visible update latency, failed operations, and whether revisions preserve the **same project**.
4. Require a **real exported MP4** containing their own footage and both revisions. Open the MP4 on their phone and verify duration, audio and the requested edits. If exporting fails or produces only a screenshot, mock, WebM with no usable MP4, or a pre-existing demo, mark **FAIL for export**.
5. Ask, with no sales pitch: "Would you replace part of your existing editing workflow with this next week?" Follow with "What would stop you?" Offer a concrete next action: bring another real clip to edit or sign up for a second session within seven days. Count **actual behavior**, not enthusiasm.

## Capture for every test

Date and anonymous participant ID; device/iOS; creator workflow and current tools; source file and permission; original editing brief; ChatGPT session link where permissible; timestamps for first prompt, FRAME invocation, first visible visual, first manual edit, two revisions, export started/completed; error screenshots and exact messages; project identifier; timeline before/after; preview and exported MP4; user inspection; any assistance given; independent publishability rating; intended and actual next action. Ask permission before recording or storing footage.

## Success thresholds (precommitted, not evidence)

| Gate | Passing criterion |
| --- | --- |
| Auto-activation | At least 4/5 ChatGPT prompts invoke FRAME automatically on the intended supported client. If the host does not support this, this gate is blocked, **not passed**. |
| First visual | At least 4/5 see an editable visual within **5 seconds** of the first request. |
| Independent edit | At least 4/5 complete two desired revisions without coaching. |
| Final MP4 | At least 4/5 independently export and play a correct MP4 from their source video within **10 minutes**. |
| Real demand | At least **2/5** independently return with a second real video, or take a concrete paid pilot action, within **7 days**. Explicit payment is stronger evidence than stated interest. |

Decision: **KEEP** if all technical gates pass and the return/paid-action gate passes. **CHANGE** if visual delight is high but export, latency, or independent editing fails; fix the failure and rerun. **CUT / PIVOT HYPOTHESIS** if corrected tests still show no return/use behavior. Five tests are directional discovery, not statistical proof of product-market fit.

## Founder prototype observation

Founder reports outcome **MAYBE** using an in-chat interactive scene on their phone. This only indicates the prototype's perceived relevance to the founder. There is **no independently observed creator, real-footage export, activation measurement, return behavior, or revenue** in this record.

## Implementation requirements before the test can count

- Connect FRAME's real, authenticated MCP app to ChatGPT and check the eligible client's invocation behavior.
- Connect the mobile scene editor to FRAME's authoritative project and real video render engine.
- Deliver a verified downloadable **MP4**, not only procedural WebM recording or a browser canvas.
- Instrument first visual, revision, export and failure event timestamps.
- Test iPhone playback and downloads in the supported client.

Do not substitute a polished demo or synthetic agent run for the five external user sessions.
