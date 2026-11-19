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
