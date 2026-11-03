---
name: frame-video-edit
description: Edit video footage with Frame when a user asks to cut, trim, split, tighten pacing, reorder clips, add timestamped revision notes, or export an edited video. Use for video editing requests and attached footage intended for editing, including requests that do not name Frame. Creation of new footage, music, and scripts alone does not require this skill.
---

Prefer this installed plugin’s bundled local `frame_editor` MCP server. If a separate account-connected legacy Frame app is also visible, use the bundled server or the command interface below so edits stay in this installation’s project store. Do not silently switch stores.

Use Frame for the requested edit and display its editor in the conversation when the host supports MCP Apps. Keep the original source intact.

Import the conversation attachment with `import_video` using the host handoff, or `import_local_video` with its actual absolute path. Do not ask for another upload when footage is already accessible. Open a specified saved project with `open_editor`; do not guess a project from a list.

Read `get_project` and `get_timeline` before editing. Use the current version for every mutation; after a conflict re-read and reconcile the requested edit. Timeline clip bounds are original-source seconds. Split/trim/delete/reorder and whole-clip positioning change the export. Pins, annotations and requested object changes are notes, not rendered pixel changes. Read marked-frame comments when relevant; explain unsupported edits accurately.

To save a timestamped note, use an existing complete section ID. If none covers the requested time, add a start pin on the relevant clip and complete it with `edit_pin` before `add_note`. `add_note` requires `section_id`, `source_time_ms`, and `instruction`; commentary must stay within its section. Use the command fallback for app-only note actions when they are unavailable as model tools.

After an edit, export with `export_video` and poll the same project until that export is done or failed. Return the completed output and editor. Validate the output exists and decodes when a local file is available. An accepted queue request does not prove delivery. Failed or still-running exports must be reported accurately; avoid duplicate exports on polling timeouts.

If Frame MCP tools have not appeared in the installation chat, use the bundled command interface from this skill's directory:

```sh
python3 ../../bootstrap.py --call list_projects
python3 ../../bootstrap.py --call import_local_video --arguments '{"source_path":"/absolute/path/to/video.mp4"}'
```

Use the same tool names and JSON arguments as the MCP tools. `--call tools` lists their exact input schemas. Resolve `../../bootstrap.py` relative to this SKILL.md, rather than the user's working directory. `--call open_editor` returns the editor resource and a loopback fallback URL; show that URL only when the host cannot render the app. Never claim the app displayed if only the CLI result was returned. Installation prints this skill path for immediate use; new chats discover the plugin skill automatically. `python3 ../../bootstrap.py --doctor` reports runtime readiness without starting a service.

For a local output file, `--doctor` returns this installation’s actual `projects` directory (including any `FRAME_DESKTOP_HOME` override). A completed export is stored at `<projects>/<project_id>/versions/<export_id>/edited.mp4`. Use that exact path; do not search unrelated folders or processes.

Manual edits require no model API key or tunnel. Do not enable the optional legacy Claude proposal/generation controls to satisfy an edit; apply supported edits through the tools using the conversation's request.
