# YC / Sazabi conversation — November 12, 2026

Archived by Codex at Dante's request. Source: the ChatGPT conversation **Sazabi Issue Detection Demo**. This is Dante's conversation with ChatGPT about Sazabi's YC company/launch text, not a transcript of a meeting with Sazabi or YC staff. The original exchange is preserved below.

## Status and interpretation

- The user supplied the YC listing and launch text; its company claims and dated metrics have not been independently verified for this archive.
- The assistant's alert, export counts, 620 ms mismatch, root cause, suggested fix, and future incident are illustrative. They are not measured findings from this repository or a real Sazabi investigation.
- This document does not establish that Sazabi is connected to FRAME, has received logs, or has diagnosed or fixed an issue. The original assistant's reference to a “known” timing issue is historical conversation text, not a verified diagnosis here.
- A possible follow-up is to test whether instrumentation can expose a reproducible preview/export mismatch, then evaluate detection, evidence, and a proposed fix. No implementation is included in this archive.

## Original user message

About
Companies
Library
Y Combinator
Partners
Resources
Startup Jobs
D
Apply
Hi, Dante! Find 2000+ YC startups hiring on the YC company directory.

Browse startups
Home
›
Companies
›
Sazabi

Sazabi
AI-native observability and security platform
Spring 2026
Active
San Francisco
Company
Jobs
0
News
 https://www.sazabi.com/
The AI-native observability and security platform for fast-moving engineering teams. Backed by tastemakers from the world's top AI companies: Vercel, Graphite, Daytona, Browserbase, LangChain, Mastra, Replit, and more.
Active Founders
Sherwood Callaway
Sherwood Callaway
Founder/CEO
Sherwood Callaway is a 2x YC founder and software engineer with over ten years of experience in infrastructure, DevOps, and observability engineering roles top VC-backed startups, including Crunchbase and Brex. Currently, he is founder and CEO at Sazabi, the AI-native observability and security platform for fast-moving engineering teams. Sazabi is directly inspired by Sherwood's experience at Brex, where helped start the company's infrastructure and observability engineering teams.
Videos

The End of Manual Debugging
Mar 27, 2026
Latest News
The End of Manual Debugging
Mar 27, 2026
Company Launches
Sazabi - Datadog for the AI Era
See original launch post
Sazabi - Datadog for the AI Era
uploaded image

Sazabi is a next-generation observability platform designed for fast-moving, AI-native engineering teams. If you're using Datadog, Sentry, Grafana, or Axiom today, you could be moving ten times faster with Sazabi. Book a demo here.

Rethinking Observability
Right now, every engineering team in the world is coming to the same conclusion: it doesn't matter how fast you can ship if your app is constantly going down. The antidote to production instability is observability, but not the flavor we have today.

Legacy observability platforms can’t keep up with the pace of modern AI-driven software development. They take hours or days to set up. They are complex and clunky to use. The alerts they give you are noisy and confusing. They aren't built to be used with agents.

Sazabi is what Datadog would look like if it were built in 2026 instead of 2010:

A simple chat-based user experience instead of endless dashboards.
Effortless agent-driven instrumentation that requires zero code or config changes.
Autonomous alerts that can contain all the relevant context and never misfire.
A powerful CLI that gives your coding agent complete visibility into your observability data.
Slack has the primary application entry point.
An AI agent that memorizes your codebase, architecture, traffic patterns, and past incidents.
Native integrations with every major cloud provider and hosting service.
A storage layer that uses AI for compression and is optimized specifically for agentic query patterns.
uploaded image

How It Works
You can get started with Sazabi in less than 15 minutes. There are just three steps:

Connect your GitHub repository
Install the Slack app
Start sending logs
For legacy platforms, instrumentation is a headache. With Sazabi, it's effortless. We've got integrations with over 35 of the leading cloud hosting services, including Vercel, AWS, GCP, Temporal, Cloudflare, Neon, Supabase, and more. If we don't have a native integration, Sazabi can open a pull request with the necessary instrumentation changes. Our log intake is OpenTelemetry compatible.

uploaded image

After setup, a few things happen automatically:

Sazabi scans your logs and codebase to learn more about the system, registering all key services, components, and product features to a live status page that gives you an overall view of system health.
Sazabi's background agents begin monitoring your logs, codebase, and infrastructure for anomalies - everything from unfamiliar errors to traffic spikes to crash pods and failed deployments.
When an issue is detected, Sazabi sends you a rich Slack alert with all the relevant context, including the root cause.
uploaded image

uploaded image

You and anyone from your team can send Sazabi a follow-up message via Slack, CLI, Web, or MCP. Sazabi is great for ad hoc questions and queries too. Sazabi automations allow you to generate detailed reports at any cadence.

uploaded image

After receiving an alert, you can fix it directly with just a click of a button. Sazabi will open the pull request against your repo. If you prefer to use a different coding agent, it’s easy to hand off context - Sazabi has integrations with Cursor, Codex, and Claude Code.

uploaded image

uploaded image

Teams that use Sazabi are detecting issues they didn’t know they had and resolving incidents in minutes instead of hours.

Logs Are All You Need
Sazabi is based on a few big ideas. The most important one: “logs are all you need”.

uploaded image

What this means is that Sazabi doesn't require users to send metrics or traces. You only need to send us logs (stdout and stderr). Sazabi is able to answer complex queries, perform aggregations, profile endpoints, and trace requests through your entire system using just log data. The result is a much simpler instrumentation experience for you and your team, with all the power of a traditional observability platform.

What Makes Us Different
A lot of companies are building in observability right now. How is Sazabi different? Here’s how we think about the landscape:

AI SRE startups like Traversal and Resolve. These sit on top of third-party systems like Datadog. It's an approach that makes sense for enterprises that rely on legacy tools, but not the best solution. Sazabi has its own storage layer.
DIY solutions like Ramp’s “On-Call Assistant”. It’s great to see so many companies building internal AI SREs. It proves demand, but it doesn't make sense for each company to build their own - especially when Sazabi is offering a better agent off-the-shelf.
Legacy players like Datadog, Grafana, Sentry, and Axiom. You can try to use Claude Code with the Datadog MCP, and it will work OK, but not great. importantly, this approach isn't stateful. Each investigation is completely new. Sazabi, on the other hand, accumulates memory and constantly gets better. More fundamentally, all of these companies predate AI agents and are structurally misaligned with AI.
LLM observability companies like Arize, Braintrust, LangChain, and Raindrop. These are a narrow point solution for building and observing agents. Sazabi can do this too, but its scope is much broader than that. It's a general solution for observing any workload. We think that in the long-term there is no meaningful difference between observing agents and other types of software.
Sazabi's most important differentiator is our vertical integration. We're building every piece of the AI observability stack:

The interfaces
The agent
The storage layer
The allows us to do things our competitors fundamentally can't, like analyze and memorize every historical incident, or optimize our DB for the specific query patterns of our agent. It's an Apple-style approach to observability.

Where We Are Today
Sazabi is currently in closed alpha, but we’re growing fast. In the past month we’ve onboarded 35 new teams, run 8,000 background investigations, detected 2,000 issues, ingested 2 TB of logs, and opened 200 PRs.

Sazabi is founded by Sherwood Callaway, a two-time YC founder who previously started the infrastructure and observability teams at Brex. We’re a team of nine engineers in total, including three early members of the Brex team and two former observability founders.

Our investors include angels from top AI dev tools and infrastructure startups. To name a few:

Harrison Chase, CEO of LangChain
Merrill Lutsky, founder and CEO of Graphite
Ivan Burazin, founder and CEO of Daytona
Matt Biilmann, founder and CEO of Netlify
Paul Klein, founder and CEO of Browserbase
Our Ask
Sazabi is currently in closed alpha, but we’re onboarding new customers daily. Teams that sign up through Launch YC post skip to the front of the line.

Book a demo here.

sherwood@sazabi.ai

uploaded image

Sazabi
Sazabi
Founded:
2025
Batch:
Spring 2026
Team Size:
10
Status:
Active
Location:
San Francisco
Primary Partner:
Aaron Epstein

X (Twitter) logo

Footer
Y CombinatorY Combinator
Make something people want.
Programs
YC Program
Startup School
Work at a Startup
Co-Founder Matching
Resources
Startup Directory
Startup Library
Investors
Demo Day
SAFE
Hacker News
Launch YC
YC Deals
Company
YC Blog
Contact
Press
People
Careers
Privacy Policy
Notice at Collection
Security
Terms of Use
Twitter
Facebook
Instagram
LinkedIn
Youtube
© 2026 Y Combinator


if i were to use this product, when would be the first time i personally would be like "wait this is super powerful"

## Original ChatGPT response (AI-authored)

The first time you'd think **“wait, this is actually insanely powerful”** is when Sazabi discovers a problem in FRAME that you didn't know existed, explains exactly why it's happening, and fixes it without you having to debug anything.

Imagine this\:

You're testing FRAME. You upload a 30-second video, tell the editing agent to cut out the boring parts, and hit Export.

The export finishes. The video downloads. Everything looks fine.

But then you get a Slack message.

**Sazabi** 11:42 AM

**Found an issue in FRAME's video exporter**

Your last 6 exports completed successfully, but 2 contained a 620ms timing mismatch between the preview and final render.

**Root cause\:** The preview timeline and FFmpeg compositor calculate clip start times differently after speech-based cuts.

**Impact\:** Users may see a different cut in their downloaded video than in the editor.

**Suggested fix\:** Normalize clip timestamps before passing the timeline to the compositor.

View investigation

Generate fix PR

Illustrative alert, not a real Sazabi investigation.

That's the moment.

Because you didn't ask it to debug anything. You didn't even know something was wrong.

**It was watching your software, understood what normal behavior looked like, noticed something unusual, connected it to your code, and suggested a fix.**

And here's where it gets even more powerful.

Two weeks later, FRAME develops a different export bug. Sazabi remembers the earlier incident, compares the symptoms, and says\:

> This looks related to the timestamp normalization issue from November 12. The new rendering path bypasses the fix introduced in that incident.

Now it isn't just an AI chatbot reading logs.

It's becoming an engineer with institutional memory of your entire application.

## Why that's a bigger deal than it sounds

Most AI coding tools are **reactive**\. You notice a problem, gather context, and ask them to fix it.

Sazabi is pitching something different\:

Traditional AI coding assistant Reactive

You notice bug

Ask AI

Fix

Sazabi's proposed experience Proactive

AI detects bug

Investigates

Offers fix

You review the proposed change instead of starting the investigation.

One important caveat: the example above assumes Sazabi can observe the relevant FRAME events and has enough telemetry to correlate them. The company's launch claims are promising, but they don't establish that it could diagnose this exact bug automatically.

## The real magic moment

I don't think the strongest demo is Sazabi answering “why did my server crash?”

Claude Code can already help investigate that.

The strongest demo is\:

**“I found three problems in your app overnight. Two were invisible to your users. Here's the evidence, here's why they happened, and here are the pull requests to fix them.”**

That's when the product stops feeling like a developer tool and starts feeling like an additional engineer on your team.

And for FRAME, I'd test Sazabi against the known preview/export timing issue first. If it can independently detect the mismatch, trace it to the responsible code, and propose a working fix, you'll have a much better measure of its value than any polished demo.
