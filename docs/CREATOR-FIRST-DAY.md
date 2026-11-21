# First creator activation: actual footage, actual export

This is a **local acceptance gate**, not a polished installer or an assertion that the product is ready for an unsupervised creator.

## Safe first trial

1. Clone FRAME and install Node.js 18+, ffmpeg/ffprobe, Claude Code and a Chromium-based browser (for text effects). Check `node bin/frame.js doctor`.
2. Run `node test/smoke.js` on the machine before using personal footage.
3. Use a creator-approved, local sample MP4 with speech or B-roll (at least 2 seconds). Run:

```bash
node scripts/creator-activation.mjs "/absolute/path/to/creator-sample.mp4" "./frame-activation-exports"
```

This creates an **isolated Frame home** in a temporary folder, disables optional cloud labeling, does not alter the source, and runs the real `frame call` path: start, import, initial cut, inspect a frame, shorten the cut, then draft-export an MP4. It writes `creator-activation-evidence.json` alongside the MP4 with timings and failures. It does not install anything or read the real `~/.frame`. A pass confirms only this local path, not Claude's behavior.

4. After the gate passes, run `node bin/frame.js install`, restart Claude Code, and have the creator request an edit of their own video. Observe whether they can inspect the timeline, make a specific revision, find the exported file, and return to the project. Record each failure and the unassisted completion time.
5. Do **not** promise a 30-second first cut, revision, or full export until actual real-creator measurements support those claims. Nor should unsupported Adobe preset/MOGRT import be advertised as working.

## First-day retention acceptance

- **Installation:** doctor confirms dependencies, MCP registration is visible in a fresh Claude Code session.
- **Real edit:** import a user-approved clip and produce a cut without touching source media.
- **Agency:** creator requests a precise adjustment and sees the result in the same timeline.
- **Delivery:** a playable MP4 exists and the creator knows where to find it.
- **Return:** creator can reopen the project and repeat the workflow without the founder present.

Capture: OS, machine, source resolution/codec/duration, time to first preview, time per revision, render time, failures and workarounds, and whether the creator actually returns the next day. **Unobserved means unverified.**

This gate deliberately excludes background cutouts, optional Gemini Decisions uploads and captions so a failing optional subsystem does not obscure fundamental import/edit/export reliability. Test captions, presets and longer media separately, with explicit creator consent before optional third-party uploads.


## November 20 verification follow-up (Codex)

The original GitHub Actions job did not start: its annotation reports an account billing lock. This is an infrastructure block, not a test failure from the script. Hosted verification remains pending until account access is restored.

Local smoke checks passed, including caption/effect raster checks through an adapter attached only to the allocated agent-owned Chrome session. This does not certify the standalone headless launcher. The activation gate passed on synthetic footage, including repeated runs preserving earlier exports, and rejects audio-only input. It now verifies that the exported duration includes the requested trim and fully decodes the MP4. Each run uses a separate render folder.

The public flower-footage export already attached to PR #20 was also used as a non-synthetic media fixture; this is derived footage, not an unassisted creator installation or original-camera-media acceptance. No recording or paid model call was made. The existing real creator/MCP installation acceptance requirement remains open.
