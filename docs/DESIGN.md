# Why Frame is built this way

This is the reasoning behind version 1.0, written by the model that built it (Claude), so the next person or model can disagree with specifics instead of guessing at intent.

## The brief

From the founder, in substance: when Claude edits a video the user sits in front of a black box and waits. Build the thing that removes that. The moment an edit starts, a window should open. The user should see Claude's decisions as they are made and the video being assembled, and be able to interrupt, redirect, or change a cut by hand. Claude should keep thinking however it normally thinks; the tool reflects what is really happening. It must be installable by anyone as an MCP server, it must actually work, and it is black and white. Earlier prototypes existed and did not fully work.

A reference clip showed a dense multi-track editor filling in while an agent worked. The look was a guide; the requirement was the footprint.

## Decisions

### 1. The timeline is the product, not a picture of it
Earlier prototypes replayed recorded data or showed an editor beside a separate pipeline. Here there is one project file, and both the AI and the human change it through one function (`applyOp`). The window cannot show something that did not happen, because it only renders that file. This is the decision everything else follows from.

*Rejected:* having the AI write ffmpeg or Python and "visualising" it afterwards. That keeps the black box and adds a cartoon of it.

### 2. A local service with a thin MCP bridge
MCP clients start a new stdio process per session. If that process owned the state, the window would die with the session, two sessions could not share a project, and a shell could not drive it. So the stdio process is a forwarder and a detached local service owns everything.

*Cost:* a background process on port 4747. It is small and idle when unused. The bridge replaces it automatically when versions differ.

### 3. Zero dependencies
The MCP protocol is hand-written JSON-RPC (about 40 lines), the server is `node:http`, the UI is plain JavaScript with no build. The aim is "clone and it runs" for a stranger, and a codebase another model can read end to end in one pass. ffmpeg is the one real requirement.

*Cost:* no component framework, so the UI re-renders whole panels on each state update. At tens to low hundreds of clips this is fine. It will need work for long timelines.

### 4. ffmpeg is the truth; the browser is a preview
The export, and the frames the AI inspects with `frame_view`, come from one filter graph. The browser preview is a second implementation that must agree with it. Where exact agreement was cheap it was made exact (the grade uses CSS-defined maths on both sides). Where it was not (chroma key edges, volume above 100%), the README says the preview approximates.

### 5. The window draws the text
The ffmpeg build on the development machine had no `drawtext` filter, and font rendering differs between ffmpeg and a browser anyway. So the window rasterises each text clip with the same function it uses for preview and uploads a PNG; ffmpeg overlays it. Preview and render match to the pixel.

When no window is open, the service runs that same drawing file (`ui/text-draw.js`) in headless Chrome with a throwaway profile, so text no longer needs a window. Every drawn caption records the text and style it came from, and the renderer refuses to overlay one that is out of date. Before this, a restyle made with the window closed reported success while the old look was still composited and exported.

*Cost:* without a window, drawing text needs a Chromium-based browser on the machine (found automatically, or `FRAME_CHROME`). A headless draw takes about a second. Window and headless drawings agree in size and position; antialiased edges can differ by a few values in a fraction of a percent of pixels (GPU vs software rasterisation).

### 6. The human talks to the AI through tool results
An MCP server cannot push a message into a model that is mid-thought. The dependable channel is the result of the model's next tool call. So everything the human does (messages, manual edits, pause) lands in an inbox, and every tool result ends with it under a heading that tells the model to act on it first. `frame_wait` exists for when the model should stop and listen.

*Consequence:* steering lands at the next step, not instantly. This is stated in the UI ("Claude reads this at its next step") rather than hidden.

### 7. Narration is a tool, not a side effect
`frame_note` exists so the model's reasoning is on screen: thinking, decision, plan, question. The server instructions ask for it before each batch of edits, and each op takes a `why`. This is the part of the brief about decision-making being visible. It depends on the model using it; the instructions are the lever.

### 8. Work outside the timeline is declared, not executed
Models do things Frame has no operation for: a custom script, an AI generation, a download. `frame_step` logs the title, tool and exact code before it runs and the outputs after, and imports the outputs. Frame does not execute the code itself. Giving an MCP server a general "run this shell command" tool would hand arbitrary execution to hosts that do not otherwise have it.

*Limit:* the log is the model's own account. Frame cannot verify the code shown is the code that ran.

### 9. Operations are paced on purpose
Ops in a batch are applied one at a time with about 140 ms between them and an animated cursor. Applied instantly, thirty changes are a jump cut and the person learns nothing. The pacing is real sequencing of real changes, not a replay. It is configurable (`FRAME_PACE`), and tests set it to zero.

### 10. Measured numbers only
A founder rule from earlier builds: no invented statistics, no "AI" label on rules. Loudness is EBU R128 from ffmpeg. Silences come from a measured RMS envelope with the threshold stated. Render results are probed from the written file. The histogram is computed from the canvas.

### 11. What was left out of 1.0, deliberately
Keyframes, transitions beyond fades, tracking, generative effects, multi-project view, collaborative sessions, a hosted version. The first version had to be something that works completely for cut, caption, grade, key, mix and render, rather than a wide surface that half works. See the roadmap.

## What real footage taught us

Three defects were found only by editing real videos, then fixed in the product:

1. **Dropped first words.** Whisper timed a word 0.9 s early, inside silence, so a cut on measured speech lost it. Fix: `alignWordsToSpeech`.
2. **Captions spanning a comma.** Phrases ran across clause boundaries. Fix: break on `, ; :` as well as sentence ends.
3. **Orphan caption words at cuts.** Splitting one continuous take into shots broke phrases at every boundary. Fix: only break where the source actually jumps.

One ffmpeg process hung once at start and never again in testing. The renderer now has a 45-second stall watchdog with one retry.

The lesson for whoever continues: synthetic tests pass easily. Edit a real talking-head clip end to end after every meaningful change.
