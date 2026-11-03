# Frame for Codex

Edit existing videos from your Codex conversation. Import footage, trim and split clips, reorder or position the video layer, save timestamped pins and frame annotations, undo/redo, and export H.264/AAC MP4.

## Install

Paste this into Codex and ask it to run it:

```sh
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/dantegarcia654/frame-mcp/v0.2.0/install.sh | bash'
```

Requires a current Codex CLI with plugin support, Python 3.9+, FFmpeg/ffprobe, and Git. On macOS, install missing FFmpeg with `brew install ffmpeg`. On Ubuntu, use `sudo apt install ffmpeg python3-venv`. Setup downloads Python dependencies. Manual edits and exports need no model API key, separate account, tunnel, or paid rendering service.

The release is verified on macOS. Linux uses the same installer/runtime but is experimental until its full desktop workflow is tested. Windows is unsupported by this release.

After installation, ask Codex:

> Edit `/absolute/path/to/video.mp4`. Keep seconds 2–8 and export it.

The bundled video-edit skill allows automatic selection for ordinary video-edit requests, including requests that do not name Frame. New chats load the installed skill and MCP tools. The installer also prints the skill path and a command interface so the current installation chat can start immediately. If another connected app is also named Frame, use this plugin’s `frame_editor` local server or its bundled command interface.

Frame opens beside the chat when the host supports MCP Apps. Otherwise it returns a local browser link to the same editor. Codex CLI provides the link; it cannot display an inline canvas. Open local links on the computer running the installed runtime. Conversation video handoffs and absolute local file paths are supported; the model must not invent attachment URLs.

## Persistent data and recovery

Projects live at `~/.local/share/frame-mcp/desktop/projects`, outside the plugin cache. Original uploads, timelines, notes, undo history, and completed exports survive reinstalling the same release and restarting its service. Back up that directory. `FRAME_DESKTOP_HOME` can select an isolated installation. Frame binds only to a dynamically selected loopback port and verifies its own runtime identity before tool calls.

The bridge starts its editor when needed. A changed or occupied port fails closed. Only one server may own a project store. To update a running installation, finish exports and close old Frame chats first, then run the old installation’s printed `bootstrap.py --stop` command. It refuses active work, verifies the server identity, and retains project files. Install the new version and open a new chat. A source-version change cannot silently attach to an older server.

Earlier desktop-preview data at `desktop/runtime/frame/jobs` is copied and hash-verified during installation if the old server is stopped; the original remains as a backup. Other standalone Frame folders remain separate installations and can still run. To bring footage into the new plugin, import the original video; do not overwrite another installation’s project directory.

## Exact tool command fallback

Use the plugin path printed by the installer:

```sh
python3 /path/printed/by/installer/plugins/frame/bootstrap.py --doctor
python3 /path/printed/by/installer/plugins/frame/bootstrap.py --call tools
python3 /path/printed/by/installer/plugins/frame/bootstrap.py --call open_editor
```

`--call` uses the same tools and version checks as MCP. Mutations require the current `expected_version`; re-read after a conflict. Export requests are asynchronous: poll the same project until the specific export is done, then download it from the editor. Do not start another export merely because a polling request timed out.

Pins, annotations, and commentary are saved editing requests. They do not automatically repaint or animate objects inside recorded footage. Whole-clip positioning changes the video layer. This release supports editing existing footage; generation and the legacy Claude proposal controls are outside its supported workflow.

## Privacy

Media remains in the installation unless you explicitly share an output or a tool returns selected content. Project metadata and selected annotated frames can be sent to your conversation. The editor’s playback transport uses app-only tool results. No user projects, credentials, browser profiles, virtual environments, or account-specific configuration are included in the source release.

## Regression checks

From this source checkout, with the Python dependencies installed:

```sh
PYTHONPATH=plugins/frame/runtime/frame python3 -m unittest discover -s tests
python3 build_release.py
```

The release builder verifies the runtime manifest and scans the source archive for private local paths and API keys. It excludes installed environments, project data and browser state.
