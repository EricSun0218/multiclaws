# MultiClaws Plugin

`multiclaws` is an OpenClaw plugin that enables collaboration between multiple OpenClaw instances. Works on LAN, across networks, or anywhere WebSocket connections can reach.

## Features

- Peer-to-peer messaging between OpenClaw instances
- Cross-peer memory search
- Task delegation to remote agents
- Team creation with invite codes
- Per-peer permission control (`prompt` / `allow-all` / `blocked`)

---

## Quick start

### 1. Install

```bash
npm install
npm run build
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
          "port": 39393,
          "displayName": "alice-node"
        }
      }
    }
  }
}
```

That's it — just `port` and `displayName`. Everything else is optional.

### 3. Restart gateway

```bash
openclaw gateway restart
```

---

## Connecting to peers

### Same network (LAN)

No extra setup needed — just use local IPs like `ws://192.168.1.11:39393`.

### Different networks

The plugin works across any network as long as the WebSocket port is reachable. Common approaches:

| Method | Example address |
|---|---|
| Public IP / VPS | `ws://203.0.113.5:39393` |
| Port forwarding | `ws://your-router-ip:39393` (forward to local machine) |
| Tunnel (frp, ngrok, cloudflared, etc.) | `ws://your-tunnel.example.com:39393` |

Set `localAddress` in your config so team invites include the correct reachable address:

```json
{
  "config": {
    "port": 39393,
    "displayName": "alice-node",
    "localAddress": "ws://your-public-or-tunnel-address:39393"
  }
}
```

### Option A: Team invite (recommended)

Ask your AI agent:

> "Create a team called my-team"

Share the invite code with the other person. They tell their agent:

> "Join team with invite code TEAM-xxxxx"

Done. The plugin handles connection automatically.

### Option B: Static peer list

If you know peer addresses in advance, add `knownPeers` to config:

```json
{
  "config": {
    "port": 39393,
    "displayName": "alice-node",
    "knownPeers": [
      { "address": "ws://192.168.1.11:39393" }
    ]
  }
}
```

---

## Using MultiClaws

Once connected, just talk to your AI agent naturally:

- **"Show my peers"** — lists connected peers
- **"Send Bob a message: meeting at 3pm"** — direct messaging
- **"Search Bob's memory for project deadlines"** — cross-peer memory search
- **"Ask Bob's agent to summarize the latest report"** — task delegation

The AI agent has these tools available:

| Tool | Description |
|---|---|
| `multiclaws_peers` | List peers and connection status |
| `multiclaws_message` | Send a message to a peer |
| `multiclaws_search` | Search memory on remote peers |
| `multiclaws_delegate` | Delegate a task to a peer's agent |

---

## Permissions

When a remote peer requests memory search or task delegation, you'll see a prompt in your chat. Reply with:

```
/mc allow <requestId> once        — allow this one request
/mc allow <requestId> permanent   — always allow this peer
/mc deny <requestId>              — reject
```

---

## Config reference

| Field | Type | Default | Description |
|---|---|---|---|
| `port` | integer | `39393` | WebSocket listen port |
| `displayName` | string | — | Name shown to other peers |
| `localAddress` | string | auto | Reachable address others use to connect to you. **Required for cross-network setups.** e.g. `ws://203.0.113.5:39393` |
| `knownPeers` | array | — | Static peers to connect on startup |

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
npm install
npm run build
npm test
```

### Tests

- `test/peer-connection.test.ts` — handshake and connection lifecycle
- `test/permission.test.ts` — approval parsing and persistence
- `test/channel-prompt.test.ts` — channel message routing
- `test/multiclaws.e2e.test.ts` — two in-process services: messaging, memory search, task delegation

### Gateway API reference

For gateway WebSocket protocol details and method reference, see [`skills/multiclaws/SKILL.md`](skills/multiclaws/SKILL.md).
