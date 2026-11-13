---
name: sketch-to-demo
description: Run the saved FRAME drawing-to-product video editing workflow. Invoke with /sketch-to-demo to select Flappy Turd, Simpsons/doughnut, or MoneyStack, validate the local recipe and footage, and run only the selected edit with evidence.
disable-model-invocation: true
---
# Sketch to demo

This is the user-facing entry point for the FRAME sketch-to-demo recipe. Read `docs/EDITING-ASSIGNMENT-SKETCH-TO-DEMO.md` first. That document is a specification and historical evidence summary, NOT an executable recipe. The local recipe runner, indexed clips, and project manifests were not included in this repository as of 2026-11-13. Never claim an edit ran merely because the recipe is documented.

## Invocation
- If no version is supplied, show **Flappy Turd**, **Simpsons/doughnut**, **MoneyStack** and ask the user to choose exactly one. Make no timeline changes before selection.
- If a valid version is specified in the command arguments, continue with that single version. Do not run all versions.
- If an unsupported name is supplied, show the valid options and stop.

## Preflight before editing
1. Confirm this Claude Code session is running in the FRAME repository and the FRAME MCP tools are connected; run `node bin/frame.js doctor` and report any missing Node/ffmpeg dependencies.
2. Locate the actual saved recipe runner, reference study, version manifest, indexed source paths, footage, and audio on the local machine. Do not invent their filenames or assume the docs/ acceptance-test JSON contains media.
3. Confirm the selected version's shots have reviewed source windows and correct product/brand labels. Flappy Turd/Simpsons/MoneyStack are separate candidates, not interchangeable with Freebuff or unrelated PS2 footage.
4. If any executable recipe, authorized media or required local service is missing, report exactly what is missing, mark **BLOCKED**, and stop. Do not silently substitute footage or simulate edits.

## Execute only after selection and passing preflight
1. Start a scratch FRAME project; leave existing user projects untouched. Use normal `frame_start`, `frame_import`, and `frame_edit` operations or the verified saved runner that calls those operations. Show source clips and editable titles appearing on the actual timeline.
2. Follow the measured racecar reference's editorial pattern (proof → drawing/photo → setup → attachment/prompt if present → build → working result → CTA). For MoneyStack and Simpsons, omit genuinely missing upload/prompt steps and ripple timing instead of inventing material.
3. Record timestamps for command, preflight, runner launch, first timeline clip, first visible frame, assembly, render, and decode. Distinguish prep time from assembly and export. The under-60-second target applies to measured editable assembly; do not call it total turnaround.
4. Inspect the actual preview, render an MP4, probe and decode it, then verify a post-export title change, source trim, undo, and project reload in scratch state. Report what passed, failed, or remains untested.
5. Return artifact paths and evidence. Only mark **VERIFIED** when the edit exists and the acceptance checks pass; otherwise mark **BLOCKED** or **NOT YET TESTED**. Do not assert independent agents executed deterministic recipe stages.

Arguments supplied: $ARGUMENTS
