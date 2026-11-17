# FRAME inside ChatGPT (MCP Apps preview)

The FRAME project owns the interactive UI in `mobile/index.html`. `src/chatgpt-app.js` serves that UI as an MCP Apps resource, available through the `frame_open_visual` tool.

## User experience target

User: "Generate a 3D rocket flying past the Statue of Liberty."

1. The **ChatGPT host** chooses FRAME's `frame_open_visual` tool when it recognizes a visual creation/editing request.
2. The tool opens FRAME's interactive in-conversation widget rather than a hosted Wix page.
3. The user can manipulate scene elements and the timeline without waiting for a model call for every direct edit.
4. ChatGPT can call FRAME again with an updated instruction. The same scene should persist through authoritative project state (not yet implemented).

**Important boundary:** The host controls tool discovery and auto-invocation. Tool descriptions can improve routing, but an MCP server cannot force automatic activation for every prompt. Do not market this guarantee until an actual installed integration is tested with representative users.

## Run development bridge

```bash
npm run start:chatgpt
# http://127.0.0.1:4777/mcp
npm run test:chatgpt
```

Requires Node 18+. The default listener is intentionally loopback-only. ChatGPT cannot reach your local computer at `127.0.0.1` from its cloud. To connect as a ChatGPT developer app, deploy to a trusted HTTPS origin with the appropriate app registration, authentication, tool permissions, and the platform's review requirements. Do not expose an unprotected development endpoint to the public Internet. Use `FRAME_APP_HOST`, `FRAME_APP_PORT`, `FRAME_APP_TOKEN` and `FRAME_APP_ALLOWED_ORIGINS` to configure an isolated development deployment; validate them against the production hosting and auth model before launch.

## Implemented now

- Tool declaration with `_meta.ui.resourceUri` and `openai/outputTemplate`
- `ui://frame/live-scenes/v1.html` interactive editor resource, served from FRAME-owned source
- JSON-RPC `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`
- Local procedural scene editor with timeline, instant direct controls, browser persistence and experimental WebM recording
- Browser widget accepts tool prompt through `window.openai.toolInput` where available

## Not implemented or verified

- ChatGPT connector installation, approval, production HTTPS hosting, OAuth and review
- Universal automatic invocation
- Authenticated server-side projects and cross-widget persistent state
- Actual 3D mesh generation, arbitrary natural-language editing, production MP4 exports
- Wiring this separate procedural preview to FRAME's existing FFmpeg timeline/media engine
- iOS runtime QA and video recording compatibility
- Full standards-compliant remote MCP transport and MCP Apps message lifecycle testing

The bridge is **an integration scaffold**, not a finished ChatGPT-connected product. Do not confuse local JSON-RPC smoke tests with production ChatGPT integration.

See [official MCP Apps UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui).
