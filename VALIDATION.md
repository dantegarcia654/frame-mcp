# Frame 0.2.0 maintenance validation

Supported release scope: editing existing footage in Codex on macOS, through the local MCP tools and the matching browser fallback. Linux installation remains experimental. Host support determines whether the MCP App appears inline.

Verified before publication:

- 76 packaged regression checks pass, covering import boundaries, timeline versions, trimming/splitting/reordering, undo/redo, notes/markup, and MCP widget transport/download contracts.
- A fresh Codex request selected the installed video-edit skill without naming Frame. The installed local MCP tools imported footage, trimmed source seconds 1–9, split at 4, undid/redid the split, and exported an eight-second H.264/AAC MP4. A timestamped note at source second 3 persisted. The source remained unchanged.
- A second fresh session used the packaged `frame_editor` connector while the older `frame` connector was also configured. It read the correct project and completed output.
- The actual editor played the output and downloaded a byte-identical MP4. Its 420-pixel layout showed the video, real filmstrip, controls, and download without horizontal overflow.
- Project files remained byte-identical across an idle stop, restart, read, and repeat preparation. Interrupted exports are marked failed once; completed timelines are not rewritten on startup.
- Actual isolated tests reject an unrelated service, concurrent ownership of the same store, cross-origin browser writes, invalid tool requests, stale edits, and stopping active work. Queued commentary does not count as a running job.
- Legacy project migration copies and verifies files while preserving the original backup; active legacy servers, unexpected symlinks, and interrupted migration directories fail closed.
- Interrupted setup can resume without overwriting project data. Runtime code, environments, and projects are kept outside the plugin cache.

The public install command and its repeat installation are checked against the published tag before the GitHub release is made public. Local test results alone do not establish that distribution check.
