# Frame in OpenAI Cloud

Run the installer only in a Codex task with Work in > Cloud selected. No local laptop worker, tunnel, Claude account or model API key is needed for the supported manual editing tools. Cloud usage is subject to your OpenAI plan.

The CLI and FFmpeg run in that task's Linux workspace. Use the cloud terminal; a Bash command cannot move a local Codex chat into the cloud or grant account access.

1. Create a cloud environment using the public dantegarcia654/frame-mcp repository. Allow package registries plus the launch site's domain during setup.
2. Ask Codex to run the launch page's cloud installation command, then run the included cloud smoke check before publishing the environment.
3. Attach a short H.264/AAC MP4 to the task. Use the host-provided cloud file path with import_local_video. Never invent an attachment path.
4. Read get_project, use the current version for trim/split/reorder/undo and export, poll get_project, then return the actual saved MP4 as an artifact.

The cloud CLI does not register a local MCP server. Embedded MCP App playback in cloud Codex requires a separately configured supported MCP connection and remains unverified. Do not tell users a loopback editor URL opens on their laptop. Cloud VM saved state is not a permanent media backup; download important exports and project bundles.

Example: .frame-cloud/frame-command tools
Example: .frame-cloud/frame-command list_projects

This preview is the allowlisted manual editor snapshot from the local Frame distribution, plus a cloud CLI and installer. No accounts or private projects are included. Launch is a setup preview until actual OpenAI Cloud installation/export is verified.
