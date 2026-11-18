# FRAME real ChatGPT invocation: developer runbook

Prepared November 18, 2026 against PR #10 head `915d3ac6b318faff9704ed1d357cd4e3e7d77897`.
This is a procedural canvas widget, separate from FRAME's FFmpeg editor. Nothing here proves a working ChatGPT connection until the host steps pass. No production deployment, public listener, tunnel, or registration was created by this change.

## First boundary and smallest fix

The first blocking boundary is reachability/authentication: `127.0.0.1:4777` belongs to the developer machine, not ChatGPT. A URL rewrite or static bearer token does not solve ChatGPT authentication. The bridge has no OAuth discovery or user-token validation. Do not use a public ngrok/Cloudflare forwarding URL directly to this scaffold.

The smallest private developer test uses OpenAI Secure MCP Tunnel with this branch's stdio entry point. It creates an outbound HTTPS path to an OpenAI-managed endpoint, not a public FRAME deployment. Tunnel access is governed by organization/workspace association and Tunnels Read/Use permissions. Restrict the association and plugin access to the test workspace/testers. No customer data or shared project service is present. For a public HTTPS developer URL use the separate gated configuration below; that route remains blocked until an OAuth gateway is supplied and verified.

## Local preparation (no exposure)

Requirements: Node 18+; ffmpeg/ffprobe for the existing engine smoke suite. No npm dependencies.

```bash
git clone https://github.com/dantegarcia654/frame-mcp.git
cd frame-mcp
git fetch origin fix/chatgpt-host-test
git switch --track origin/fix/chatgpt-host-test
node --version
npm run test:chatgpt
node test/smoke.js
```

For an existing checkout, preserve local changes before switching. Pin the resulting `git rev-parse HEAD` in the evidence record. `npm run test:chatgpt` tests HTTP/stdio handlers and a synthetic DOM/host bridge; neither test launches a real browser or ChatGPT.

Optional local HTTP inspection in a separate terminal:

```bash
FRAME_APP_HOST=127.0.0.1 FRAME_APP_PORT=4777 npm run start:chatgpt
```

Use MCP Inspector's Streamable HTTP mode at `http://127.0.0.1:4777/mcp` to initialize, list/call `frame_open_visual`, and read `ui://frame/live-scenes/v2.html`. GET returns 405 intentionally; this stateless server does not offer an SSE stream. An HTTP token can protect local requests but is not an OAuth implementation. Host headers must name localhost, 127.0.0.1 or [::1] with the actual listening port. Reverse proxies must rewrite Host to that upstream authority. Origins are denied unless local or explicitly listed in `FRAME_APP_ALLOWED_ORIGINS`; an absent Origin is allowed for non-browser clients and is not authentication.

## Preferred private developer connection: outbound HTTPS tunnel

1. In https://platform.openai.com/settings/organization/tunnels inspect/reuse an appropriate tunnel or create a dedicated development tunnel. Verify the correct Platform organization and Dante's intended ChatGPT Business workspace association. Creation requires Tunnels Read + Manage; runtime and plugin operator require Read + Use. Do not reuse unrelated credentials.
2. Install the supported binary from the download link in those settings or https://github.com/openai/tunnel-client/releases/latest. The binary is not bundled with FRAME. Run `tunnel-client help quickstart` and `tunnel-client init --help` to check the installed version's options.
3. In Bash, from the repository root, enter the restricted runtime key locally. These commands do not contain a literal secret:

```bash
read -r -s -p 'Tunnel runtime API key: ' CONTROL_PLANE_API_KEY
printf '\n'
export CONTROL_PLANE_API_KEY
read -r -p 'Tunnel ID: ' FRAME_TUNNEL_ID
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile frame-dev \
  --tunnel-id "$FRAME_TUNNEL_ID" \
  --mcp-command "node $PWD/src/chatgpt-app.js --stdio"
tunnel-client doctor --profile frame-dev --explain
tunnel-client run --profile frame-dev
```

Use a checkout path without spaces for the command string, or configure the executable and argument array through the client's supported configuration. Inspect the generated profile to confirm the runtime key is an environment reference, not a literal secret. Keep the runtime key out of chat, logs and commits. Stop if doctor fails; record its exact non-secret error. This stdio route needs no HTTP listener and does not use `FRAME_APP_TOKEN`.

4. Verify readiness and active polling in the client's local admin UI. A healthy local process alone does not prove host discovery.
5. At https://chatgpt.com/plugins select plus → Add custom MCP server → Connection: Tunnel. Select the SAME tunnel, name it **FRAME Dev**, configure the private connection's required authentication, review the warning, and Create as a plugin. If unavailable, record the workspace policy/permission error. Do not bypass it with an unauthenticated public URL. The current prototype has no OAuth user accounts; do not claim otherwise or attach customer data.
6. Confirm discovery actually lists `frame_open_visual` and its v2 resource metadata. Install/enable it, start a fresh conversation, type `@` and select FRAME Dev explicitly. This proves deliberate invocation only; automatic selection is a separate test.
7. After server/resource changes, restart the client/server as appropriate, Refresh the custom connection and start a new conversation.

The tunnel client was not installed or run in this workspace. Key, tunnel identity, workspace permissions, discovery and real UI remain external prerequisites.

## Public HTTPS developer URL: minimum gated configuration

This is an alternative, not a prerequisite for the private test above. Do not start a public listener until its authentication checks pass and exposure is approved. Keep FRAME itself on loopback. Configure a development DNS name with trusted TLS, then place an established OAuth 2.1 resource-server gateway in front of it. The gateway must:

- Serve protected resource metadata, advertise the exact canonical HTTPS resource and authorization server; challenge unauthenticated MCP requests with 401 and `WWW-Authenticate: Bearer resource_metadata="https://YOUR_DEV_HOST/.well-known/oauth-protected-resource"`.
- Support authorization-code + PKCE S256 and discovery; use CIMD, DCR or a predefined ChatGPT OAuth client supported by the provider. Copy the exact redirect URI displayed in ChatGPT management into the provider allowlist; do not guess a callback URL.
- Validate token signature, issuer, resource/audience, expiry/not-before and required scope on EVERY MCP request; restrict authenticated subjects to designated testers. Reject missing, expired, wrong-audience, wrong-issuer, wrong-scope and non-tester tokens before forwarding.
- Strip externally supplied identity headers. Never regard Host, Origin, a tunnel URL or an OAuth client secret as user authorization. Do not forward an OAuth token to some unrelated upstream service.

The repository has no configured provider, issuer, domain, TLS certificate, OAuth client or gateway. Those values cannot be fabricated. This nginx template specifies the gateway contract, but is not a deployable authentication implementation by itself:

```nginx
# Inside an HTTPS server with a trusted certificate for YOUR_DEV_HOST.
# Loopback port 4780 is an independently configured and tested OAuth gateway.
location = /.well-known/oauth-protected-resource {
    proxy_pass http://127.0.0.1:4780/.well-known/oauth-protected-resource;
}
location = /_frame_authorize {
    internal;
    proxy_pass http://127.0.0.1:4780/verify;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Authorization $http_authorization;
}
location = /mcp {
    auth_request /_frame_authorize;
    proxy_pass http://127.0.0.1:4777/mcp;
    proxy_set_header Host 127.0.0.1:4777;
    proxy_set_header Authorization "";
    client_max_body_size 128k;
    proxy_buffering off;
}
location / { return 404; }
```

`/verify` must return 2xx ONLY for a fully validated, scoped tester token; otherwise 401 (including the Bearer challenge) or 403. A missing gateway must fail closed, never fall back to FRAME. Keep `FRAME_APP_TOKEN` unset for this gateway contract; gateway authentication is the boundary. Configure only exact observed trusted browser origins if required; never wildcard origins. Prevent direct network access to port 4777.

Before approving exposure, test gateway configuration privately. After authorized exposure, unauthenticated HTTPS requests must return 401 plus discovery challenge; verify discovery, PKCE login, all invalid-token cases, and one authorized MCP Inspector call. Use OAuth in ChatGPT's public-URL connection with `https://YOUR_DEV_HOST/mcp`; do not select no-auth or paste a FRAME bearer secret into a URL. Discovery/tool/UI testing then follows the same host procedure as the tunnel path. mTLS can authenticate the ChatGPT client but does not replace user OAuth.

## One mobile demo, with a persistence trap

Use the iPhone 16 Pro. Record exact iOS, ChatGPT app/browser version, workspace, commit, connection method and time. Establish desktop discovery first; then test the same connection in iPhone Safari ChatGPT and separately the native ChatGPT app if available. A responsive desktop viewport is not iPhone evidence. A standalone `mobile/index.html` tab is not the ChatGPT widget.

1. In a new conversation explicitly select FRAME Dev. Send: **“Use FRAME's frame_open_visual to create a rocket flying past the Statue of Liberty with blue wings and no explosion. Open the interactive editor.”**
2. Capture the actual host tool call and arguments, the returned resource, visible FRAME-owned editor and invocation receipt. The receipt alone is not proof: a synthetic host can send the same messages. Correlate it with ChatGPT's tool activity. If only text/image/link appears, stop at discovery/invocation/resource-rendering boundary as appropriate.
3. Tap Pause, tap the first timeline clip, type **HOST CHECK 17** into its title, move Camera zoom to 150%, and tap Wing color. Capture the visible title/zoom/wing change and work log. Check horizontal overflow, reachable timeline/controls, touch targets, scrolling, keyboard dismissal and orientation. No export needed for this demo.
4. Send: **“In the same FRAME project, change only the wings to blue. Preserve HOST CHECK 17, my 150% zoom and the existing timeline.”** Record whether ChatGPT calls the tool, its `project_id`, and whether it reuses the iframe or creates another. Compare title, zoom, scene IDs/count/durations and wing color before/after. If accessible via browser developer tools, use `window.frameApp.snapshot()` inside the widget frame; do not require that console step on the phone.
5. Reload/reopen the conversation and repeat the comparison. Then separately reopen on another device. Treat each as its own persistence test. Mark skipped tests “not run.”

**Expected limitation:** the tool returns null for a new project ID, and supplied IDs only change the provenance label. There is no server project lookup/save. Same-widget changes survive a narrow “blue wings” instruction in the synthetic test; a new storage-denied widget loses them even with the same ID. Browser-local storage uses one global key, not per-project isolation. Prompts containing `make`, `create`, `scene` or `storyboard` can rebuild scenes through local keyword rules. Record these as failures, never silently recreate a similar scene and call it persistence.

The smallest next state fix is a shared scene-operation engine with owner-scoped project IDs/revisions, load/save tools, and direct-edit synchronization through the host. Validate the user on every load/save. Persist title/zoom/timing, return the actual project ID/revision in structuredContent, and reject stale revisions. Widget state alone can help same-message restoration but does not establish server persistence or cross-device ownership. That is separate work from proving first invocation.

## Evidence ledger and stop conditions

| Gate | Current evidence | Pass criterion / smallest next step |
| --- | --- | --- |
| Local HTTP/stdio smoke | Automated locally; see checks below | Initialize/list/read/call and rejection assertions pass |
| Synthetic widget lifecycle | Automated locally, mock DOM/parent | Single application of input/result; denied storage does not crash |
| Secure endpoint / tunnel | NOT RUN | Ready authorized tunnel OR verified HTTPS OAuth gateway |
| ChatGPT discovery + tool invocation | NOT RUN | Tool activity with actual arguments/result in a real conversation |
| ChatGPT widget rendering | NOT RUN | Resource renders and accepts a visible edit inside ChatGPT |
| Physical iPhone browser | NOT RUN | Actual iPhone Safari interaction and layout evidence |
| Native ChatGPT iOS | NOT RUN | Test separately; report unavailable capability honestly |
| Same-widget follow-up | Synthetic pass for narrow instruction only | Actual host follow-up preserves measured fields |
| Recreated-widget project state | Known missing server persistence | Owner-scoped load/save + synchronized edits |
| Cross-device persistence | NOT IMPLEMENTED | Same authenticated project/revision loads on device two |
| Real video export | NOT VERIFIED for widget | Play a produced file; measure codec/dimensions/duration; distinguish WebM recording from FFmpeg MP4 |

For each real run record: gate, PASS/FAIL/NOT RUN, timestamp, commit, client/device, prompt, tool/arguments, result/error, screenshot or recording location, project/revision and before/after fields. Do not log tokens. Stop on the FIRST failing gate and fix that boundary before claiming later gates. Existing engine smoke renders do not prove this widget can export or use that engine.

## References (checked November 18, 2026)

- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/build/chatgpt-ui

## Checks observed in this workspace

November 18, 2026, Node v24.22.3, ffmpeg 7.1.5:

- `npm run test:chatgpt`: PASS. Local HTTP initialization, tool/resource discovery/call, schema rejection, hostile Origin/Host, loopback-only binding, local bearer guard and stdio exchange; synthetic parent lifecycle/deduplication, denied storage startup, same-widget state and known lack of server restoration.
- `node --check src/chatgpt-app.js` and `node --check test/chatgpt-widget-contract.js`: PASS.
- `git diff --check`: PASS.
- `node test/smoke.js`: FAIL on two existing headless caption pixel checks (white pixels 0; restyled red pixels 0). The same two failures reproduce on untouched PR head `915d3ac` in a separate worktree. Other reported engine checks pass, including a measured 960×540, 4.008-second H.264/AAC MP4 render. This does not validate widget export. The caption failures remain unresolved and are outside this integration patch.
- Secure tunnel/client, public HTTPS/OAuth, real ChatGPT invocation, physical mobile interaction and widget recording/export: NOT RUN. No external endpoint was exposed.
