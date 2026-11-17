# Start here (for any AI agent or engineer picking this up)

Frame is a local MCP server plus a browser window. When an AI edits a video, the window shows the edit happening on a real timeline, and the person watching can stop it, steer it, or edit by hand. This file tells you how to run it, test it, read it and change it. Everything you need is in this repository.

| You want to… | Read |
| --- | --- |
| Know what the product is and what it promises | [README.md](README.md) |
| Run it and test it in five minutes | this file, below |
| Understand how it works, file by file | [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) |
| Understand why it was built this way | [docs/DESIGN.md](docs/DESIGN.md) |
| Write your own test cases | [docs/TESTING.md](docs/TESTING.md) |
| Know what is weak, missing or untested | [docs/ROADMAP.md](docs/ROADMAP.md) |

## Run it

Requirements: Node 18+, `ffmpeg` and `ffprobe` on PATH. Optional: `pip install -U openai-whisper` for transcripts and captions. There is nothing to `npm install`; the project has zero dependencies.

```bash
git clone https://github.com/dantegarcia654/frame-mcp.git
cd frame-mcp
node bin/frame.js doctor     # checks node, ffmpeg, whisper
node test/smoke.js           # 37 end-to-end checks on a scratch instance, about 30 s
```

The smoke test generates its own test video, starts a private copy of the service on port 4791 with a temporary data folder, and cleans up. It does not open a browser and does not touch `~/.frame`.

## Drive it without an MCP client

Every MCP tool can be called from a shell. This goes through exactly the same code path as a real client.

```bash
node bin/frame.js call frame_start '{"name":"Test","aspect":"9:16"}'
node bin/frame.js call frame_import '{"paths":["/absolute/path/to/clip.mp4"]}'
node bin/frame.js call frame_edit '{"ops":[{"op":"add_clip","asset":"a1"},{"op":"remove_silences"}]}'
node bin/frame.js call frame_view '{"t":1}'
node bin/frame.js call frame_render '{"quality":"draft"}'
```

`frame_start` opens http://127.0.0.1:4747 in the default browser. Set `FRAME_NO_OPEN=1` to stop that, `FRAME_PORT` and `FRAME_HOME` to run an isolated instance.

## Connect it to an AI client

- **Claude Code:** `node bin/frame.js install`
- **Codex CLI:** `codex mcp add frame -- node /absolute/path/to/frame-mcp/bin/frame.js mcp`
- **Any stdio MCP client:** command `node`, args `["/absolute/path/to/frame-mcp/bin/frame.js", "mcp"]`
- **ChatGPT in the browser:** not directly. ChatGPT web only reaches MCP servers over the network, and Frame speaks stdio and binds to localhost. It would need an HTTP MCP endpoint in front of it. That is not built; see the roadmap. Until then, use Codex, or drive it with `frame call`.

## Change it

1. The whole product is about 2,000 lines in `src/` (service) and `ui/` (window). No build step: edit a file, restart the service (`node bin/frame.js stop`; it restarts on the next call), reload the window.
2. A new timeline operation is one `case` in `applyOp` in `src/project.js` plus one line in the `frame_edit` description in `src/tools.js`. The UI needs no change unless the op adds a new clip property.
3. A new clip property that affects pixels or sound must be implemented twice: in `src/render.js` (ffmpeg, the truth) and in `ui/app.js` (live preview). If they disagree, the render is right and the preview must be fixed or labelled.
4. Run `node test/smoke.js` before committing. Add a check there for anything you add.
5. Bump `VERSION` in `src/util.js` and `version` in `package.json` together. The MCP bridge replaces a running service whose version differs.

## Rules this project holds itself to

- **No fake anything.** Every number in the UI or in a tool result is measured (ffprobe, ffmpeg, or computed from the audio). Rule-based logic is not labelled AI. If something does not work, the tool result says so.
- **One timeline.** The AI and the human go through the same `applyOp`. Never add a second path that mutates clips.
- **Source files are read-only.** Frame never writes to a user's media.
- **Local only.** The service binds to 127.0.0.1 and rejects requests whose Host or Origin is not its own.
- **Black and white.** The UI uses no colour of its own. The video is the only colour on screen.
