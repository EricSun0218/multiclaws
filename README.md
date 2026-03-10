# MultiClaws

Multi-agent collaboration plugin for [OpenClaw](https://openclaw.ai). Connect multiple OpenClaw instances into a team and delegate tasks between them using the [A2A protocol](https://google.github.io/A2A/).

[中文文档](README.zh-CN.md)

## Installation

Just tell your AI:

> Run `openclaw plugins install multiclaws` and tell me what it can do.

Your AI handles the rest — installation, configuration, and profile setup — no manual steps required.

## Usage

Everything works through natural language:

- **"Create a team called my-team"** — creates a team and generates an invite code
- **"Join team with invite code mc:xxxxx"** — join a teammate's team
- **"Ask Bob to summarize the latest report"** — delegate a task to a teammate's AI
- **"Show all agents"** — list team members and their capabilities

## How It Works

MultiClaws enables multiple OpenClaw instances to collaborate as a team. Each instance acts as both a client (delegating tasks) and a server (receiving tasks from others). Tasks are executed by the remote AI and results are returned directly.

Works out of the box on the same local network. Cross-network collaboration is also supported.

## Documentation

See [SKILL.md](skills/multiclaws/SKILL.md) for full details.

## Development

```bash
npm install
npm run build
```
