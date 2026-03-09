# MultiClaws Plugin

`multiclaws` is an OpenClaw plugin that enables collaboration between multiple OpenClaw instances using the [Google A2A (Agent-to-Agent)](https://google.github.io/A2A/) protocol over HTTP.

## Features

- A2A protocol for agent-to-agent communication
- Team-based collaboration with invite codes
- Agent profile with owner identity and data source broadcasting
- Synchronous task delegation with automatic result polling
- Multi-agent orchestration (fan-out, chain, iterative, routing)
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
          "displayName": "alice",
          "selfUrl": "http://192.168.x.x:3100"
        }
      }
    }
  },
  "gateway": {
    "tools": {
      "allow": ["sessions_spawn", "sessions_history"]
    }
  }
}
```

> ⚠️ **Important:** Both `sessions_spawn` and `sessions_history` must be in `gateway.tools.allow`. The executor uses `sessions_spawn` to start tasks and `sessions_history` to poll for completion results.

### 3. selfUrl configuration

`selfUrl` is the address other agents use to reach you. **Always use an IP address, not a hostname** (`.local` hostnames cannot be resolved across machines).

- **LAN:** `http://192.168.x.x:3100` (your local IP)
- **Cross-network:** your public/tunnel URL (see below)

To find your local IP:
```bash
# macOS
ipconfig getifaddr en0

# Linux
hostname -I | awk '{print $1}'
```

### 4. Firewall

Ensure the port is accessible. On macOS, Node.js may be blocked by the application firewall:

```bash
# Check if blocked
/usr/libexec/ApplicationFirewall/socketfilterfw --getappblocked $(which node)

# Unblock
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp $(which node)
```

### 5. Restart gateway

```bash
openclaw gateway restart
```

---

## Connecting to teammates

### Same network (LAN)

Set `selfUrl` to your LAN IP address and ensure the port is not blocked by firewall.

### Different networks

The plugin works across any network as long as the HTTP port is reachable. Common approaches:

| Method | Example address |
|---|---|
| Public IP / VPS | `http://203.0.113.5:3100` |
| Port forwarding | `http://your-router-ip:3100` |
| Tunnel (frp, ngrok, cloudflared, etc.) | `https://your-tunnel.example.com` |

**Every team member** needs a reachable address. Set `selfUrl` accordingly:

```json
{
  "config": {
    "port": 3100,
    "displayName": "alice",
    "selfUrl": "https://your-tunnel.example.com"
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
- **"Ask Bob to summarize the latest report"** — synchronous task delegation via A2A
- **"Show all agents"** — list all known agents with their profiles
- **"Set my profile: name Alice, role frontend engineer"** — set owner identity
- **"Add data source: React Dashboard codebase"** — register a data source
- **"Add capability: finance"** — mark that this agent can handle finance-related tasks (so teammates default to delegating finance work here)

All 16 agent tools:

| Category | Tools |
|---|---|
| Team | `multiclaws_team_create`, `multiclaws_team_join`, `multiclaws_team_members`, `multiclaws_team_leave`, `multiclaws_team_invite` |
| Agents | `multiclaws_agents`, `multiclaws_add_agent`, `multiclaws_remove_agent`, `multiclaws_delegate` |
| Profile | `multiclaws_profile_set`, `multiclaws_profile_add_source`, `multiclaws_profile_remove_source`, `multiclaws_profile_add_capability`, `multiclaws_profile_remove_capability`, `multiclaws_profile_show` |
| Tasks | `multiclaws_task_status` |

---

## Task Delegation

### How it works

Task delegation is **synchronous** — when you delegate a task, the call blocks until the remote agent completes execution and returns the result.

Under the hood:
1. Your agent calls `multiclaws_delegate(agentUrl, task)`
2. The A2A protocol sends the task to the remote agent
3. The remote agent's executor calls `sessions_spawn` (run mode) to start a subagent
4. The executor polls `sessions_history` until the subagent completes
5. The final result is returned through the A2A response
6. Your agent receives the actual result (not just "accepted")

### Orchestration patterns

Since delegation is synchronous, your AI agent can orchestrate complex multi-agent workflows:

**Fan-out (parallel):** Delegate to multiple agents simultaneously, gather all results.

**Chain (sequential):** Use one agent's output as input for the next agent.

**Iterative:** If a result is insufficient, delegate again with follow-up questions.

**Router:** Analyze the task and delegate to the most appropriate agent based on their profile and data sources.

**Nested:** Agent A delegates to Agent B, who may delegate sub-tasks to Agent C. Fully recursive.

The orchestration logic lives in the AI agent's reasoning — no workflow definitions needed.

---

## Agent Profile

Each agent has a profile describing the owner's identity, **capabilities** (domain tags like "finance", "frontend"), and accessible data sources. This helps the AI decide which agent to delegate tasks to — e.g. finance-related tasks are delegated by default to agents whose profile includes a "finance" capability.

On first run after install, the profile is auto-initialized from your display name and you will be prompted on your next AI conversation to adjust it if needed. Profile is set automatically when you first create or join a team. The AI will ask for your name and role, and auto-detect connected data sources.

When you connect a new data source, the profile updates automatically and broadcasts to all team members. When you install plugins or configure skills that imply a domain (e.g. finance plugins/skills), the AI can add matching capabilities so teammates default to you for that kind of work.

---

## Troubleshooting

### "Agent execution finished without a result"

The remote agent's executor is not returning results properly. Ensure:
- The remote node has the latest plugin code (`git pull && npm run build`)
- `gateway.tools.allow` includes **both** `sessions_spawn` and `sessions_history`
- Gateway has been restarted after config changes

### "fetch failed" / Connection refused

- Check that the remote agent's port is open and listening
- On macOS, check the application firewall (see Firewall section above)
- Verify `selfUrl` uses an IP address, not a `.local` hostname

### Invite code not working

- Ensure `selfUrl` is set to a reachable IP address in the config
- Verify the port is accessible from the other machine: `curl http://<ip>:<port>/.well-known/agent-card.json`

### Task returns "accepted" instead of actual result

- The remote node needs `sessions_history` in `gateway.tools.allow`
- The remote node needs the latest code with the synchronous executor

---

## Config reference

| Field | Type | Default | Description |
|---|---|---|---|
| `port` | integer | `3100` | HTTP listen port (binds to `0.0.0.0`) |
| `displayName` | string | hostname | Name shown to other agents |
| `selfUrl` | string | `http://{hostname}:{port}` | **Reachable URL** others use to connect to you. Always use IP address, not hostname. Required for proper connectivity. |
| `telemetry.consoleExporter` | boolean | `false` | Print OpenTelemetry spans to console |

### Gateway requirements

```json
{
  "gateway": {
    "tools": {
      "allow": ["sessions_spawn", "sessions_history"]
    }
  }
}
```

Both tools are required:
- `sessions_spawn` — starts subagent tasks for incoming delegations
- `sessions_history` — polls for subagent completion results

State is persisted as JSON files under your plugin state directory (`.../multiclaws/`).

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
