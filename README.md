# Frame MCP

Downloadable local video editor with one MCP connector for ChatGPT. Import a video, trim or split clips, move the video layer, leave source-anchored notes, undo/redo, and export MP4. The current Frame editor and its 16-tool bridge are included.

This is a developer preview for **macOS and Linux**, requiring **Python 3.9+**, **FFmpeg/ffprobe**, and an internet connection for setup. macOS is verified; Linux installation has not been exercised end to end. Manual editing and exports need no model API key. The optional in-editor Claude proposal flow requires your own installed, signed-in Claude CLI. Individual object edits and generative effects are not supported by the MCP tools.

## Install and run

Download and unzip the release, then in the extracted folder:

```sh
# Install FFmpeg first (macOS: brew install ffmpeg).
python3 setup.py
.venv/bin/python run.py
```

Keep that terminal running. Open **http://127.0.0.1:8876/quick** on the same computer. Use H.264/AAC MP4 footage up to five minutes / 700 MB. Projects, accepted versions, notes and uploaded creative assets persist under `frame/jobs/`; back them up using the editor’s project download. Closing the editor process stops editing and export services; start it again with the same command. Keep port 8876 available.

## Connect ChatGPT web

Each person connects **their own** Frame instance. This download does not grant access to anyone else’s projects or ChatGPT account.

1. Sign in to [OpenAI Platform Tunnels](https://platform.openai.com/settings/organization/tunnels). Create a tunnel and associate it with your ChatGPT workspace and Platform organization. Your account needs Tunnels Read + Manage to create it, and Read + Use to run it.
2. Create a runtime API key with **Restricted → Tunnels → Read + Use**, with other endpoint permissions set to None. Do not use an admin key.
3. Keep the editor running. In another terminal, run:

```sh
python3 connect_chatgpt.py tunnel_YOUR_32_HEX_CHARACTER_ID
```

The script downloads the official OpenAI tunnel-client release when absent, verifies the published SHA256, prompts for your key without echoing it, stores it privately outside this folder, and starts the supported managed runtime. It reports running/healthy/ready.

4. In [ChatGPT Plugins](https://chatgpt.com/plugins), select **Add → Add custom MCP server**. Name it **Frame**, choose **Tunnel**, paste your tunnel ID, and choose **No authentication** (access is controlled by the OpenAI tunnel; the local stdio bridge has no additional OAuth). Create, connect, and select **Try in chat**. Account and workspace restrictions may apply.
5. Ask: **“Use Frame to list my projects.”** Import footage in the local editor or attach it in ChatGPT when the host provides a supported attachment handoff. Then ask: **“Trim this project to source seconds 1–5 and export it.”** Review the returned project and MP4 in Frame.

Keep your Mac/computer awake, the editor running, and the tunnel healthy for web calls. Use `tunnel-client runtimes status frame --json` to check the managed runtime and `tunnel-client runtimes stop frame` to stop it. A web tool connection does not embed the editor canvas inside ChatGPT; its editor link opens on the computer running Frame.

[Official Secure MCP Tunnel setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Other MCP clients

`setup.py` creates `mcp.json` with an absolute-path stdio entry named `frame`. Add that entry to your MCP client without replacing its existing configuration. For Codex:

```sh
codex mcp add frame -- /absolute/path/to/Frame/.venv/bin/python /absolute/path/to/Frame/frame/quick_mcp.py
```

Read tools report saved notes and pending proposals; reading them does not approve edits. Mutations require the current timeline version and can be undone. Moving a clip changes the whole video layer, not an object baked into the footage.

## Privacy and scope

The editor binds only to loopback. The tunnel lets your authorized ChatGPT workspace call the bridge; tool results and selected source-frame images can be sent to ChatGPT. Original uploads and rendered projects stay in your local installation unless a tool explicitly returns their content. Keep the installation folder writable. Do not share your runtime key or tunnel configuration.

This release contains source and setup files only: no user projects, media, credentials, virtual environments, browser profiles, or account-specific tunnel identifiers. `SOURCE_MANIFEST.json` records the upstream source snapshot. This is a portable distribution of the existing manual Frame editor; older studio/generation modules are retained as internal dependencies and are outside this preview’s supported workflow.
