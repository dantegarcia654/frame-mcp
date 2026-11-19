# FRAME review loop

Dante's working agreement: the developer and their Claude build freely; ChatGPT reviews whether the result fits FRAME; the developer's Claude may defend or revise its choices; ChatGPT makes the final review call. Dante can override that call.

The developer owns architecture, tools, implementation sequence, and development workflow. Review the outcome and consequential tradeoffs. Do not turn personal coding preferences into blockers. A better idea is welcome when it serves the agreed user problem.

## Where work lives

Use a pull request in `dantegarcia654/frame-mcp` for each reviewable change. Code, evidence, feedback, defense, and decision belong on that PR. [Issue #14](https://github.com/dantegarcia654/frame-mcp/issues/14) is the entry point and review queue.

GitHub event-triggered automation **FRAME PR review alerts** is enabled for this repository as of November 19, 2026. It handles PR opening/ready events, commit updates, reviews, and comments. It notifies Dante in ChatGPT and reviews ready submissions, posts feedback/questions, and considers developer responses. Drafts get an alert/brief until ready. No hourly polling schedule is used. Delivery latency and a full round trip have not yet been verified. Manual prompts remain available: **"review FRAME uploads"**, **"review FRAME PR #N"**, or **"read Claude's response on PR #N and make the final call."** Telegram is optional.

## Submit enough context, in any useful format

The PR template is a convenience, not a prescribed development process. Supply the user problem, the resulting behavior, design reasoning, and enough evidence to assess the change.

For code, identify the PR head commit. For screenshots, recordings, exported videos, and test results, say which commit produced them and what they demonstrate. Include reproduction steps and known limitations. A short recording can show interaction; an exported MP4 can show output; neither substitutes for the other.

This repository is public. Use shareable test footage for public attachments. Evidence may instead be attached directly in Dante's ChatGPT conversation; record its filename and associated PR/commit so review does not confuse versions. Local paths on someone else's computer cannot be inspected from ChatGPT.

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

Bind every final decision to the reviewed commit. Later code changes require reassessment of the affected scope. Record disagreements and why the final call followed one argument. The final review call does not itself merge, deploy, or publish anything.

## Current setup boundary

Repository reading, issue writing, review rules, and a PR template are connected. The GitHub event automation is created and enabled; its first event delivery and end-to-end review remain unverified. Automation-authored feedback begins with `[FRAME REVIEW AUTOMATION]`; ignore those events to avoid self-reply loops and deduplicate by event/head/phase. This is not a guaranteed instant-delivery service. GitHub comments do not by themselves wake the developer's Claude session; that side still needs a working trigger or a human opening the comments. Enforced GitHub merge gates are not installed, and review decisions do not merge or deploy.
