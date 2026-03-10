# MultiClaws

Multi-agent collaboration plugin for [OpenClaw](https://openclaw.ai). Connect multiple OpenClaw instances into a team so their AIs can delegate tasks to each other using the [A2A protocol](https://google.github.io/A2A/).

[中文文档](README.zh-CN.md)

## The Core Idea

Every OpenClaw instance is a gateway to data and systems that only *that machine* can reach — local files, logged-in accounts, connected devices, internal networks. MultiClaws connects these isolated islands so AI agents can collaborate across them.

**The division of labor isn't about who is smarter. It's about who has the key.**

- Your laptop has your codebase and personal email
- Your colleague's machine has their Google Workspace and internal database access
- The office server has the production logs

None of these can reach the others directly. MultiClaws lets each agent do what only it can do, and routes the results back to whoever asked.

## Two Core Features

### 1. Profiles Make Every OpenClaw Discoverable

Each OpenClaw instance has a profile — a bio written in plain text that describes what data and systems it can access. When your agent needs to get something done, it reads the team profiles and figures out who to ask. No manual routing, no hardcoded assignments.

The profile is what turns each OpenClaw into a callable unit for others. Your colleague writes "I have access to Google Workspace and the sales spreadsheets" in their bio — and your agent can now delegate Google Sheets tasks to them, without you configuring anything. Add a new teammate to the team, their profile appears, your agent starts routing tasks to them automatically.

Getting started takes one sentence to your AI. No config files, no YAML, no A2A protocol knowledge required. The profile is the only interface.

### 2. Collaborate by Who Has the Key, Not Who Is Better

Traditional task routing assumes you split work by skill: "this agent is good at data, that one is good at writing." That's the wrong model for distributed systems.

Each OpenClaw can only reach what its own machine can reach. The right question isn't *who is more capable* — it's *who has access*. MultiClaws routes tasks based on data ownership: your colleague's agent handles their Google Sheets because they're the only one logged in. The office server's agent handles production logs because it's the only one on that network.

**The profile bio is a declaration of access, not a resume.**

## Example

*Eric needs a monthly business review report.*

```
A (Eric's MacBook)
  → has: local git history, personal Telegram, own email

B (zxj's Windows PC)
  → has: Google Sheets with sales data (logged in as zxj)

C (ljl's machine)
  → has: internal OA system (browser already logged in), local MySQL
```

Eric tells his AI: *"Generate this month's business review."*

```
A reads team profiles
  → B's bio: "access to Google Workspace, sales spreadsheets"
  → C's bio: "access to internal OA system and local database"

A delegates:
  → B: "pull this month's sales figures from Google Sheets"
  → C: "get project status and attendance from the OA system"
  → A: reads local git log for code activity

B uses its own Google credentials → returns sales data
C uses its own logged-in browser → returns OA data
A merges all three → generates the report
```

B can also delegate further. If B needs a chart generated and sees from the team profiles that D has that capability, B delegates to D autonomously — without A needing to orchestrate it.

**The profile bio describes what data and systems each instance can access.** That's how agents decide who to ask.

## Installation

Just tell your AI:

> Run `openclaw plugins install multiclaws` and tell me what it can do.

Your AI handles the rest — installation, configuration, and profile setup — no manual steps required.

## Usage

Everything works through natural language:

- **"Create a team called my-team"** — creates a team and generates an invite code
- **"Join team with invite code mc:xxxxx"** — join a teammate's team
- **"Ask Bob to pull the sales data"** — delegate a task to a teammate's AI
- **"Show all agents"** — list team members and their data access

## Roadmap

### Async Delegation
Currently, task delegation is synchronous — the delegating agent waits for the result before continuing. The next major version will support fire-and-forget delegation: dispatch multiple tasks to different agents simultaneously, receive results as push notifications, and aggregate them when all are ready. This enables true parallel execution across agents.

### Multi-turn Collaboration
Today each delegation is a single round-trip. Planned support for multi-turn sessions where agents can exchange follow-up messages within the same context — useful for tasks that require clarification, intermediate feedback, or iterative refinement between agents.

### Permissions
Currently any agent with a valid invite code can send tasks to your OpenClaw. A permission layer is planned: define which agents are allowed to delegate to you, what kinds of tasks they can request, and whether approval is required before execution.

## Documentation

See [SKILL.md](skills/multiclaws/SKILL.md) for full details.

## Development

```bash
npm install
npm run build
```
