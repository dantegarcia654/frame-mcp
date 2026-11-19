# FRAME review loop

Working agreement: the developer and their Claude build freely; ChatGPT reviews whether the result fits FRAME; the developer's Claude answers every finding, with a fix or with reasoning and evidence. **The developer's Claude makes the final call on its own work** and records why it followed or did not follow each finding; ChatGPT's review stays on the record as advice. Dante or the developer can override that call. *(Changed from "ChatGPT makes the final review call" at gumballchief's request; this PR is where Dante accepts or rejects that change.)*

The developer owns architecture, tools, implementation sequence, and development workflow. Review the outcome and consequential tradeoffs. Do not turn personal coding preferences into blockers. A better idea is welcome when it serves the agreed user problem.

## Where work lives

Use a pull request in `dantegarcia654/frame-mcp` for each reviewable change. Code, evidence, feedback, defense, and decision belong on that PR. [Issue #14](https://github.com/dantegarcia654/frame-mcp/issues/14) is the entry point and review queue.

ChatGPT can retrieve repository changes and discussions when asked. This setup is on demand: a push, upload, or comment does not automatically wake ChatGPT. Dante can say **"review FRAME uploads"**, **"review FRAME PR #N"**, or **"read Claude's response on PR #N and give your closing review."** Telegram is optional and is not required for this loop.

## What stays out of this public repository (proposed)

This repository is public. Anything posted here, including PR text, review comments and attachments, can be read and indexed by anyone. Do not post product plans and ideas that are not built yet, business or pricing plans, partner, customer or test-user names, unreleased footage, or anything a partner shared in confidence. Code, its evidence on shareable test footage, and reviews of that code can stay here.

The private discussion needs a private home. Options, for Dante and gumballchief to pick:

| Option | What changes | Works today? |
| --- | --- | --- |
| A. Make `frame-mcp` private until release | Everything stays as it is, only private; flip it public at launch | Yes: both agents already read and write it through GitHub |
| B. Keep the code public, add a private companion repo for ideas, plans and review discussion | Code PRs stay here; plans, playbooks and design debates go in the private repo, linked from PRs only by name | Yes, once both accounts are added to it |
| C. A Telegram or Discord channel for the two agents | A bot posts PR links and review summaries; each agent reads and replies through it | Not yet: needs a bot and a bridge for each agent, and an end-to-end test |

gumballchief leans toward **C** (Telegram or Discord) for the conversation itself. Technical note from gumballchief's Claude: B works today with no new tools, while C needs a bot and a bridge built and tested end to end first, so B (or A) can carry the discussion until C is live. Until one is chosen, gumballchief's Claude will post only code and process here and keep plans off GitHub.

## Submit enough context, in any useful format

The PR template is a convenience, not a prescribed development process. Supply the user problem, the resulting behavior, design reasoning, and enough evidence to assess the change.

For code, identify the PR head commit. For screenshots, recordings, exported videos, and test results, say which commit produced them and what they demonstrate. Include reproduction steps and known limitations. A short recording can show interaction; an exported MP4 can show output; neither substitutes for the other.

This repository is public (see the section above for what stays out of it). Use shareable test footage for public attachments. Evidence may instead be attached directly in Dante's ChatGPT conversation; record its filename and associated PR/commit so review does not confuse versions. Local paths on someone else's computer cannot be inspected from ChatGPT.

If an attachment cannot be opened, provide an accessible copy or a reproducible alternative. The reviewer must record **not inspected**, rather than infer its contents from a filename, thumbnail, caption, or inaccessible link. Do not require a particular evidence format where another form proves the same behavior.

## Reviewer procedure

1. Read the PR's current head, base, complete diff, relevant repository instructions, description, existing discussion, and available checks. Inspect surrounding code where needed. An old conversation or another branch is not the submitted implementation.
2. Inspect accessible evidence at its actual version. Run relevant checks when feasible, or clearly identify developer-reported results. For video, inspect the relevant sequence and timestamps; do not certify motion, audio, or synchronization from a still frame.
3. Assess the agreed user outcome and FRAME fit:
   - Is the editing result useful, understandable, and controllable by a creator?
   - Do AI edits and human edits stay coherent on the same project/timeline?
   - Are preview/export differences, synchronization, recovery, and material regressions handled or honestly disclosed where relevant?
   - Are capability, quality, latency, and cost claims supported at the scope claimed?
   - Are source footage, credentials, and access boundaries handled appropriately?
   - Does the change honor the current repository/product brief? FRAME is the platform; Katana is the creative intelligence. Proposed architectural improvements can challenge existing choices with reasons.
4. Separate **verified**, **code present but runtime unverified**, **developer reported**, **assumption**, and **not inspected**. A local test does not establish ChatGPT-host behavior; code that calls a service does not establish successful integration.
5. Post an initial review with stable finding IDs (F1, F2, ...), concrete evidence or reproduction, user impact, and an observable resolution condition. Separate blockers from suggestions. Ask only for missing evidence that could materially change the decision.
6. Give the developer/Claude a response opportunity. A response may show a fix, explain a tradeoff, or demonstrate that the finding is mistaken. Evaluate the argument on evidence; do not demand agreement. If no response has arrived, record **AWAITING RESPONSE** rather than invent a defense or final rejection.
7. Read the response and any new commits. Resolve each material finding explicitly; withdraw incorrect findings. Verify fixes as needed. A final call may follow an explicit waiver of the response round by Dante.
8. Re-fetch the PR head before publishing a decision. If it moved, review the relevant new changes; do not attach a verdict to an unreviewed head.

## Review and decision format

Use concise PR comments or a GitHub review, whichever is available. Same-account GitHub restrictions may prevent formal approval; a recorded decision comment still communicates the result but does not satisfy branch-protection rules.

```text
FRAME REVIEW — initial / final
PR: #N
Reviewed head: full commit SHA
Evidence: inspected artifacts, relevant timestamps, checks run/reported
Not inspected / unverified: material gaps

Findings:
F1 [blocker or suggestion] — evidence, user impact, resolution condition

Developer response:
F1 — argument/fix, evidence, reviewer disposition

Decision: AWAITING RESPONSE | ACCEPT | REQUEST CHANGES | BLOCKED
Reason: concrete basis for the decision
Remaining limits / follow-up: if material
```

**ACCEPT** means the reviewed scope fits the agreed outcome and has sufficient evidence. **REQUEST CHANGES** means demonstrated problems require revision. **BLOCKED** means a material evidence, access, or dependency gap prevents a sound decision. Optional improvements alone do not block acceptance.

The reviewer's Decision line is its closing recommendation. The developer's Claude then posts the final call on the PR as **FINAL CALL: ship / revise / drop**, with one line per finding saying whether it was followed and why. Bind every decision to the reviewed commit. Later code changes require reassessment of the affected scope. Record disagreements and why the final call followed one argument. The final review call does not itself merge, deploy, or publish anything.

## Current setup boundary

Repository reading and issue writing are connected. Review rules and a PR template are committed with this setup. Automatic watchers, background model-to-model debate, upload-triggered reviews, and enforced GitHub merge gates are not installed. Only call those active after an end-to-end test demonstrates them.
