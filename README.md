# MultiClaws Plugin

`multiclaws` is an OpenClaw plugin that enables collaboration between multiple OpenClaw instances using the [Google A2A (Agent-to-Agent)](https://google.github.io/A2A/) protocol over HTTP.

## Features

- A2A protocol for agent-to-agent communication
- Team-based collaboration with invite codes
- Agent profile with owner identity and data source broadcasting
- Task delegation to remote agents
- Cross-team member discovery

---

## Quick start

### 1. Install

```bash
pnpm install
pnpm run build
```

### 2. Configure

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "load": {
      "paths": ["/absolute/path/to/multiclaws"]
    },
    "entries": {
      "multiclaws": {
        "config": {
          "port": 3100,
          "displayName": "alice"
        }
      }
    }
  }
}
```

### 3. Restart gateway

```bash
openclaw gateway restart
```

---

## Connecting to teammates

### Same network (LAN)

Use local IPs directly: `http://192.168.1.11:3100`

### Different networks

The plugin works across any network as long as the HTTP port is reachable. Common approaches:

| Method | Example address |
|---|---|
| Public IP / VPS | `http://203.0.113.5:3100` |
| Port forwarding | `http://your-router-ip:3100` |
| Tunnel (frp, ngrok, cloudflared, etc.) | `https://your-tunnel.example.com` |

Set `selfUrl` in your config so team invites include the correct reachable address:

```json
{
  "config": {
    "port": 3100,
    "displayName": "alice",
    "selfUrl": "http://your-public-or-tunnel-address:3100"
  }
}
```

### Creating a team

Ask your AI agent:

> "Create a team called my-team"

Share the invite code with the other person. They tell their agent:

> "Join team with invite code mc:xxxxx"

Done. The plugin handles member sync automatically.

---

## Using MultiClaws

Everything is done through natural language with your AI agent:

- **"Create a team called my-team"** — create team, get invite code
- **"Join team with code mc:xxxxx"** — join with invite code
- **"Show team members"** — list all members
- **"Leave the team"** — leave a team
- **"Ask Bob to summarize the latest report"** — task delegation via A2A
- **"Show all agents"** — list all known agents with their profiles
- **"Set my profile: name Alice, role frontend engineer"** — set owner identity
- **"Add data source: React Dashboard codebase"** — register a data source

All 14 agent tools:

| Category | Tools |
|---|---|
| Team | `multiclaws_team_create`, `multiclaws_team_join`, `multiclaws_team_members`, `multiclaws_team_leave`, `multiclaws_team_invite` |
| Agents | `multiclaws_agents`, `multiclaws_add_agent`, `multiclaws_remove_agent`, `multiclaws_delegate` |
| Profile | `multiclaws_profile_set`, `multiclaws_profile_add_source`, `multiclaws_profile_remove_source`, `multiclaws_profile_show` |
| Tasks | `multiclaws_task_status` |

---

## Agent Profile

Each agent has a profile describing the owner's identity and accessible data sources. This helps AI decide which agent to delegate tasks to.

Profile is set automatically when you first create or join a team. The AI will ask for your name and role, and auto-detect connected data sources.

When you connect a new data source, the profile updates automatically and broadcasts to all team members.

---

## Config reference

| Field | Type | Default | Description |
|---|---|---|---|
| `port` | integer | `3100` | HTTP listen port |
| `displayName` | string | hostname | Name shown to other agents |
| `selfUrl` | string | `http://{hostname}:{port}` | Reachable URL others use to connect to you. **Required for cross-network setups.** |
| `telemetry.consoleExporter` | boolean | `false` | Print OpenTelemetry spans to console |

State is persisted as JSON files under your plugin state directory (`.../multiclaws/`).

### Task delegation prerequisite

Task delegation uses `sessions_spawn` internally. Add it to the gateway allow list:

```json
{
  "gateway": {
    "tools": {
      "allow": ["sessions_spawn"]
    }
  }
}
```

---

## Development

```bash
pnpm install
pnpm run build
pnpm test
```

### Tests

- `test/agent-registry.test.ts` — agent registry CRUD and TTL
- `test/a2a-adapter.test.ts` — A2A executor and task tracking
- `test/team-store.test.ts` — team creation, join, leave, persistence
- `test/gateway-handlers.validation.test.ts` — gateway parameter validation (zod)

### Architecture

See [`skills/multiclaws/SKILL.md`](skills/multiclaws/SKILL.md) for full architecture details, tool reference, and behavioral rules.
