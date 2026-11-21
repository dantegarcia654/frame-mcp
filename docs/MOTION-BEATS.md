# Authoring a motion beat in FRAME

Write down what moves, when it settles, when the title arrives, and which decisions the revision preserves. Give the video crop and the text separate editable layers. Use seconds relative to each clip.

| Beat | First cut | Revision |
| --- | --- | --- |
| Establish | Hold the full source through 0.30s | Keep the opening and center |
| Punch in | Ease out to 116% from 0.30s to 0.64s | Ease out to 106% from 0.30s to 0.98s |
| Title | At 0.40s, rise 14px and fade up over 0.28s | At 1.20s, rise 8px and fade up over 0.36s |
| Hold | Keep the title through 4.00s | Keep the copy, source, audio and end time |

Use the existing `reframe.keyframes` on the picture and `anim` on a text node in a `live_graphic` clip. The example uses the cubic `out` ease for the zoom and quartic `out4` for the title. Graphic offsets are fractions of the output frame, so divide the rise in pixels by the canvas height. Set the text node's `at` and its first animation keyframe to the same cue. Set the land position and full opacity on its second keyframe.

Use **Send to agent** in the Activity composer for a request that changes both the picture and title. It queues the text and current playhead for the connected MCP client. To apply the request, read the live project's clip and node IDs, then use one `frame_edit` call with `fast: true`. Pass `update_clip {id, reframe, ripple:false}` and `patch_graphic {id,node_id,patch:{at,anim}}`. Start from the current values and retain unrelated settings. Leave `preview_at` unset during playback. After observing the change on the running timeline, inspect the early cue, settle, and title hold in the export. A title cue that has already passed remains visible on the next playback or in the exported frame sequence.

## Film rehearsal and review order

Put the request ahead of both cues. In the 54-second rehearsal, submit around 1s during playback. The centered picture move starts at 20.30s. The initial title cue is 20.40s. The gentler move settles at 20.98s and the revised title starts at 21.20s. Watch both cues in the same pass. Record time from submission to the first draw of the saved values and separately to the first visibly different crop and title pixels. The visible timings include the authored hold before the cues.

If the canvas route asks for input, no change was saved. For a compound request, paste the request into the composer and choose **Send to agent** with an MCP client connected. For a canvas edit, select a single layer and request one change.

PR #21 uses the animated reframe model and renderer from #20. The open stack merges from the bottom up. Merge #17, then #19, then #20, then #21. After each lower PR lands, retarget the next PR to `main` and verify its diff. If a squash or rebase merge removed the original parent history, replay only the next PR's commits onto the landed base before retargeting so the diff stays scoped.

The launch title is a `live_graphic` effect, drawn in the window and via the loopback effect renderer for export. The two failures on #20 and #21 concern ordinary text clips drawn with no window. On the rehearsal machine, Chromium 154's standalone `--dump-dom` invocation timed out on a minimal page as well as on FRAME's caption page. That failure leaves the smoke-test frames without the expected white or red caption pixels. The launch fixture has no ordinary text clips and uses the independently exercised effect renderer. A demo that adds ordinary captions and exports with the window closed still needs its own check.


## November 20 export regression fix (Codex)

Quartic-out (`out4`) now has an FFmpeg expression shared by crop and position animation. `node test/motion-export.js` compares all five easing curves against FFmpeg at six points, then renders and fully decodes ten exports (five curves, two motion paths). `npm test` includes that regression. The runtime version is bumped to 1.5.12 so existing services reload the fix.

These checks resolve the demonstrated export failure. The previously referenced `frame-pr21-review-evidence.zip` remains unavailable here; the connected-agent turnaround, continuous playback, audio and filming-readiness claims have not been independently verified in this follow-up. This code fix does not grant filming or final visual acceptance.
