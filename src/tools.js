// What Claude sees. These descriptions are the whole contract between Claude and Frame.
export const INSTRUCTIONS = `Frame is a live editing room. The user watches a real timeline fill in while you edit, and can stop, steer or hand-edit at any moment.

USE FRAME FOR EVERY VIDEO EDITING TASK. The moment the user asks to edit, cut, assemble, caption, grade or render a video, call frame_start FIRST — before analysing anything — so the window is open while you think. Do not edit video with hidden shell scripts when Frame can do it.

How to work:
1. frame_start → opens the window. Pass your plan.
2. frame_import the footage. Frame measures it (duration, loudness, silences) and returns the numbers.
3. frame_transcribe for speech. Use frame_view to actually look at frames.
4. Think out loud with frame_note (kind "thinking" / "decision") — short, specific, one idea each. This is what removes the black box; do it before each batch of edits.
5. Change the timeline ONLY through frame_edit. Give each op a "why". Prefer several small batches over one giant one, so the user can interrupt.
6. If you do anything outside Frame (a custom ffmpeg/python script, an AI generation, a download), wrap it in frame_step: call it with status "running" and the exact command/code before you run it, and status "done" with output file paths after. Outputs are imported automatically.
7. frame_view the composited result at a few timestamps before you render. frame_render when it is right.

The user's hands are on the same timeline. EVERY tool result may end with a "FROM THE USER" block — messages typed in Frame, manual trims/moves, pause. Treat that as the user speaking to you: obey it before continuing. If you are paused, stop and call frame_wait.

Units: all times are seconds. Clips have "start" (timeline), "in"/"out" (source). Tracks: V1 is the base video layer, V2/V3 stack on top, T1 is text, A1–A3 are audio-only. Video clips carry their own audio.
Be honest: Frame's numbers are measured. Never tell the user something was checked unless a tool result shows it.`;

const pid = { project_id: { type: 'string', description: 'Optional. Defaults to the open project.' } };
const why = { why: { type: 'string', description: 'One short sentence shown to the user explaining this choice.' } };

export const TOOLS = [
  {
    name: 'frame_start',
    description: 'Open the Frame window and start (or reopen) an editing session. ALWAYS call this first on any video editing task, before analysing footage, so the user sees the editor immediately. Returns the project and the local URL.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'Project name, e.g. "Zenzap reel v2".' },
      aspect: { type: 'string', description: '"9:16" (default), "16:9", "1:1", "4:5", "4:3" or "WIDTHxHEIGHT".' },
      fps: { type: 'number', description: 'Default 30.' },
      plan: { type: 'string', description: 'Your editing plan in a few lines. Shown to the user at the top of the feed.' },
      project_id: { type: 'string', description: 'Reopen an existing project instead of creating one.' },
      action: { type: 'string', enum: ['list'], description: '"list" returns saved projects without opening anything.' },
    } },
  },
  {
    name: 'frame_import',
    description: 'Bring video, audio or image files into the project bin. Frame probes each file and measures loudness and silences; the result lists them (source seconds). Paths must be absolute local paths; a folder imports every media file in it.',
    inputSchema: { type: 'object', required: ['paths'], properties: {
      paths: { type: 'array', items: { type: 'string' } },
      scenes: { type: 'boolean', description: 'Also detect scene changes in video (slower). Useful for B-roll or pre-edited footage.' },
      ...why, ...pid,
    } },
  },
  {
    name: 'frame_transcribe',
    description: 'Word-level transcript of an asset using the local Whisper install, returned as timed lines in source seconds. If Whisper is not installed, or you already have timings, pass words to store them instead. Captions and cut decisions use this.',
    inputSchema: { type: 'object', required: ['asset'], properties: {
      asset: { type: 'string' }, model: { type: 'string', description: 'Whisper model, default "base.en". Use "small" or "medium" for accuracy, a non-.en model for other languages.' },
      language: { type: 'string' }, force: { type: 'boolean', description: 'Re-run even if a transcript exists.' },
      words: { type: 'array', description: 'Supply or correct the transcript yourself: [{text,start,end}] in source seconds.', items: { type: 'object', properties: { text: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } } } },
      ...why, ...pid,
    } },
  },
  {
    name: 'frame_note',
    description: 'Show the user what you are thinking or deciding, live, in the Frame feed. Use it often and keep each note short and concrete ("Take 2 of the hook is cleaner — no stumble on \'calendar\'"). kind: thinking (reasoning in progress), decision (a choice made), plan, question (you need the user), note.',
    inputSchema: { type: 'object', required: ['text'], properties: {
      text: { type: 'string' }, kind: { type: 'string', enum: ['thinking', 'decision', 'plan', 'question', 'note'] },
      agent: { type: 'string', description: 'Optional role label if you are acting as a sub-agent, e.g. "Captions".' }, ...pid,
    } },
  },
  {
    name: 'frame_edit',
    description: `Apply timeline operations, in order, live in front of the user. Each op is {op, ...args, why}. Returns what changed plus the full timeline.

Ops:
• add_clip {asset, track?, start?, in?, out?, + clip props} — start omitted = append to the end of the track. Images take duration.
• keep_ranges {asset, ranges:[{in,out,label?}], track?} — assemble selected source ranges back-to-back (the fastest way to build an A-roll cut).
• update_clip {id, + clip props} — trim (in/out), move (start/track), or change any property.
• split_clip {id, at} — at = timeline seconds.
• delete_clip {id | ids, ripple?} — ripple true closes the gap on all tracks, "track" only on its own track.
• cut_range {from, to, tracks?, ripple?} — remove a span of the timeline (default: every track, gap closed).
• remove_silences {track?, min_silence?, pad?, threshold_db?} — cut measured silences from the clips on a track (defaults 0.45 s, 0.08 s pad, −38 dBFS).
• add_text {text, start, duration, track?, style?}
• add_captions {source_track?, max_words?, max_chars?, style?, track?, replace?} — builds captions from the transcript, following every cut. Or pass phrases:[{text,start,end}] in timeline seconds.
• style_text {track?, style, all?} — restyle every caption on a track in one go (all: true includes non-caption text).
• close_gaps {track} · clear_track {track} · add_marker {t,label} · delete_marker {id} · set_project {name?, aspect?, fps?}

Clip props: start, in, out, track, speed (0.25–4), volume (0–4), muted, fit ("cover"|"contain"), scale, x, y (offset as a fraction of the frame; 0 = centred), opacity, fadeIn, fadeOut (seconds; fades picture and sound), label,
grade {brightness, contrast, saturation} (1 = unchanged; saturation 0 = black & white), key {color:"#00ff00", similarity, blend} (chroma key / green screen; set null to remove).
Text style: size (fraction of frame height, default 0.055), color, stroke, strokeWidth, bg (box colour or null), weight, x, y (centre position 0–1), maxWidth, uppercase, font.`,
    inputSchema: { type: 'object', required: ['ops'], properties: {
      ops: { type: 'array', items: { type: 'object', required: ['op'], properties: { op: { type: 'string' }, why: { type: 'string' } }, additionalProperties: true } },
      summary: { type: 'string', description: 'One line describing this batch, shown as a decision before the ops play out.' },
      agent: { type: 'string', description: 'Optional role label shown on the cursor, e.g. "Cutter", "Captions", "Sound".' }, ...pid,
    } },
  },
  {
    name: 'frame_step',
    description: 'Make work you do OUTSIDE Frame visible. Before running a custom script, ffmpeg command, AI generation or download, call with status "running", a title and the exact code/command. When it finishes call again with the same id and status "done" (plus outputs: file paths, which get imported) or "failed". The user can open the step and read exactly what ran.',
    inputSchema: { type: 'object', required: ['title'], properties: {
      id: { type: 'string', description: 'Returned by the first call; pass it to update the step.' },
      title: { type: 'string' }, tool: { type: 'string', description: 'e.g. "ffmpeg", "python", "Higgsfield", "ElevenLabs".' },
      code: { type: 'string', description: 'The exact command, script or prompt.' },
      status: { type: 'string', enum: ['running', 'done', 'failed'] }, outputs: { type: 'array', items: { type: 'string' } },
      note: { type: 'string', description: 'What this step is for / what happened.' }, ...pid,
    } },
  },
  {
    name: 'frame_view',
    description: 'Look with your own eyes. With t/times: returns the composited timeline frame(s), rendered by the same ffmpeg graph as the export — use it to verify framing, keying, grade and captions. With asset + times: returns raw source frames, for choosing takes. Up to 6 frames.',
    inputSchema: { type: 'object', properties: {
      t: { type: 'number' }, times: { type: 'array', items: { type: 'number' } }, asset: { type: 'string', description: 'Look at this source asset instead of the timeline.' }, ...why, ...pid,
    } },
  },
  {
    name: 'frame_state',
    description: 'Re-read the timeline (clips, ids, times, effects) and collect anything the user changed or said in the Frame window. Call it after any pause, before a render, or whenever you are unsure the timeline is what you think it is.',
    inputSchema: { type: 'object', properties: {
      include_transcript: { type: 'boolean' }, include_timeline_words: { type: 'boolean', description: 'List the spoken words as they now fall on the timeline after cuts.' }, track: { type: 'string' }, ...pid,
    } },
  },
  {
    name: 'frame_wait',
    description: 'Wait (up to ~45 s per call) for the user to type a message, make a manual edit, or press resume in the Frame window. Use it when you asked a question in the feed or were paused.',
    inputSchema: { type: 'object', properties: { timeout_s: { type: 'number' }, ...pid } },
  },
  {
    name: 'frame_history',
    description: 'Undo or redo the last batch of timeline changes (yours or the user\'s).',
    inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['undo', 'redo'] }, ...why, ...pid } },
  },
  {
    name: 'frame_render',
    description: 'Render the timeline to an MP4 with ffmpeg (H.264 + AAC). The user sees progress and can play the result in Frame. Returns the file path and measured duration, size and loudness. quality "draft" is half-resolution and fast; "final" is full resolution. Audio is normalised to −14 LUFS unless loudnorm is false.',
    inputSchema: { type: 'object', properties: {
      quality: { type: 'string', enum: ['draft', 'final'] }, loudnorm: { type: 'boolean' },
      output_dir: { type: 'string', description: 'Folder for the MP4. Default ~/Movies/Frame (~/Videos/Frame on Windows).' }, ...why, ...pid,
    } },
  },
];
