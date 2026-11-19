# Continuous title revision from Claude Code

FRAME serves the timeline and preview in a separate local Chromium window. Claude Code uses a stdio MCP connection to the FRAME service on the same machine. Keep the FRAME window visible beside the Claude terminal. The title tool updates the active project directly, so the viewer keeps its current playhead and playback state. The activity feed shows the actual FRAME tool start, applied revision or error.

The supported live edit is one named, single-node live text graphic in the active project. Claude can submit wording, hex color, size, x/y position, numeric weight or font in one revision. Only submitted fields change. FRAME handles this without a Google Decisions key or a media-generation call.

## Set up a clean local session

Use a local Claude Code installation, a Claude login or configured provider that grants model use, Git, Node 22.4 or newer, FFmpeg/ffprobe, and Chromium or Chrome. The commands below use a Bash-style shell. The viewer and source must be on the machine running Claude Code. FRAME itself has no account, npm dependency, or per-edit service fee. Claude model usage follows the applicable [Claude Code setup and billing terms](https://code.claude.com/docs/en/setup).

```bash
git clone --branch spike/continuous-creative-revision https://github.com/dantegarcia654/frame-mcp.git
cd frame-mcp
export FRAME_HOME="$(mktemp -d)" FRAME_PORT=4840 FRAME_NO_OPEN=1 FRAME_DECISIONS=off
node bin/frame.js doctor
claude auth status
claude mcp add --transport stdio --scope local frame -- "$(command -v node)" "$PWD/bin/frame.js" mcp
claude mcp list
node scripts/live-title-demo.mjs
```

Install Claude Code through [Anthropic's local setup](https://code.claude.com/docs/en/setup) and complete `claude auth login` if needed. On an existing install, run `claude mcp get frame` and check where it points before changing any registration. Open `http://127.0.0.1:4840/`, then copy the project ID printed by the seed command. The script generates a labeled 10-second sample with a tone and motion graphics. To rehearse with your own authorized clip, pass an absolute path to `node scripts/live-title-demo.mjs "/path/to/clip.mp4"`. Supply at least ten seconds of video and audio, preferably landscape H.264/AAC. Keep the source available on disk.

A clean Linux Claude Code 2.1.328 profile registered and reported FRAME connected. Model sign-in was unavailable for this verification. The browser-to-export check below used a separate MCP protocol client. An authenticated clean-user Claude rehearsal is pending.

## Make the live change

In FRAME, expand the graphics tracks if desired and enable **Repeat** so the 10-second timeline stays playing while you work in Claude. Click **Play**. Repeat is a browser playback setting. Its ordinary wrap is at the end of the timeline. For a single-pass recording, make sure the change lands away from a wrap. Start `claude` in the same shell and directory as the registration.

Replace `<project-id>` and submit in Claude Code:

> Use FRAME to revise the existing Main title in project <project-id> while it plays. Make the first line STILL and the second line ROLLING. with its period. Set the title to #FF536B, make it 19% of the frame height and move its left edge to 12% of frame width. Keep its vertical position, typeface, timing, the footage and audio as they are. Use frame_revise_title once. Leave playback alone and tell me the returned revision ID.

The player should change while the timecode continues. Open **Review change** after capture to inspect the revision's properties. A simpler second exercise is to ask Claude to change the same layer to “YOUR EDIT HERE” and leave the styling alone.

Record the real Claude prompt/tool transcript and the visible browser timecode. Keep the request and updated playback in the same continuous capture. Save the execution and revision IDs. Confirm the request actually ran through Claude; a tool call from the shell exercises the server only.

## Export and reopen

In the same shell:

```bash
node bin/frame.js call frame_render '{"quality":"final","output_dir":"/tmp/frame-live-title-exports"}'
node bin/frame.js stop
node bin/frame.js call frame_start '{"project_id":"<project-id>"}'
```

Reopen the same browser URL after restart. Use the same `FRAME_HOME` and source path. Chrome/Chromium is required for live-layer export. If discovery fails, set `FRAME_CHROME` to the absolute path of an installed Chromium browser before starting FRAME.

## Engineering reproduction

```bash
node test/live-update.js
npm test
output="$(mktemp -d)"
node bin/frame.js call frame_start '{"name":"Scratch"}'
node scripts/record.mjs "$output/window.mp4" --size 1440x900 --script scripts/check-live-title.mjs
```

The runner uses MCP stdio with a local protocol client. It checks a rejected edit, the same project's actual playing media element and timecode, an atomic revision over one title, saved disk state, reopening, preview/export title pixels and equal decoded audio. The screen recording is silent and the evidence JSON contains the timing from the browser and tool events. Run with a clean FRAME home. The previous scoped-composer example is documented separately.
