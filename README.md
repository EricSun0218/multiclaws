# MultiClaws Plugin

`multiclaws` is an OpenClaw plugin that enables collaboration between multiple OpenClaw instances over LAN or self-managed networks.

## Scope (v0.1)

- Peer discovery and connection over LAN (WebSocket).
- Direct messaging between peers.
- Runtime permission approval via existing channel replies.
- Cross-peer memory search.
- Task delegation and completion notification.
- Team creation and invite-based join.

## Design choices

- Plugin-only: no OpenClaw core modification required.
- Default transport: LAN/self-managed WebSocket.
- Permission model: per-peer `prompt | allow-all | blocked`.

---

## Installation

```bash
npm install
npm run build
```

Add to OpenClaw config (`~/.openclaw/openclaw.json`):

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

> **Note:** Do not set `plugins.allow` unless you intend to restrict which plugins are active.
> `allow` acts as a whitelist — any plugin not listed (including built-ins like `telegram`) will be blocked.

Then restart the gateway:

```bash
openclaw gateway restart
```

---

## Plugin config fields

| Field | Type | Default | Description |
|---|---|---|---|
| `port` | integer | `39393` | WebSocket listen port for peer connections |
| `displayName` | string | — | Human-readable name shown to other peers |
| `localAddress` | string | — | This node's address (used when creating/joining teams), e.g. `ws://192.168.1.10:39393` |
| `knownPeers` | array | — | Static peer list to connect on startup (see below) |

### `knownPeers` example

```json
{
  "plugins": {
    "entries": {
      "multiclaws": {
        "config": {
          "port": 39393,
          "displayName": "alice-node",
          "localAddress": "ws://192.168.1.10:39393",
          "knownPeers": [
            {
              "peerId": "oc_xxx",
              "displayName": "bob-node",
              "address": "ws://192.168.1.11:39393"
            }
          ]
        }
      }
    }
  }
}
```

---

## Task delegation (sessions_spawn)

The task executor calls `sessions_spawn` via the local gateway's `/tools/invoke` endpoint.
This tool is blocked by default — you must add it to the allow list:

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

## Calling gateway methods

All `multiclaws.*` methods are registered on the OpenClaw gateway WebSocket.
They are **not** available via plain HTTP — you must use the WebSocket protocol.

### 1. Connect to the gateway WebSocket

```
ws://localhost:<gateway.port>
```

Default port is `18789`. Auth token is in `gateway.auth.token`.

### 2. Handshake sequence

**Step 1** — Gateway sends a challenge immediately on connect:

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "<uuid>", "ts": 1234567890 }
}
```

**Step 2** — Client sends a `connect` request (**ignore the nonce** — do not include it in `auth`):

```json
{
  "type": "req",
  "id": "conn-1",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.0.0",
      "platform": "macos",
      "mode": "cli"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write", "operator.admin"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "<gateway.auth.token>" },
    "locale": "en-US",
    "userAgent": "my-client/1.0.0"
  }
}
```

Key requirements:
- `client.mode` must be one of: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`
- `scopes` must include `operator.admin` to call plugin gateway methods
- Do **not** include `nonce` inside `auth`

**Step 3** — Gateway responds with `hello-ok`:

```json
{
  "type": "res",
  "id": "conn-1",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, ... }
}
```

### 3. Call a gateway method

```json
{
  "type": "req",
  "id": "req-1",
  "method": "multiclaws.team.create",
  "params": {
    "teamName": "my-team",
    "localAddress": "ws://192.168.1.10:39393"
  }
}
```

Response:

```json
{
  "type": "res",
  "id": "req-1",
  "ok": true,
  "payload": {
    "teamId": "team_xxx",
    "teamName": "my-team",
    "inviteCode": "TEAM-..."
  }
}
```

### Minimal Node.js example

```js
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:18789', {
  headers: { Authorization: 'Bearer <token>' }
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);

  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    ws.send(JSON.stringify({
      type: 'req', id: 'conn-1', method: 'connect',
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: 'cli', version: '1.0.0', platform: 'macos', mode: 'cli' },
        role: 'operator',
        scopes: ['operator.read', 'operator.write', 'operator.admin'],
        caps: [], commands: [], permissions: {},
        auth: { token: '<token>' },
        locale: 'en-US', userAgent: 'my-client/1.0.0'
      }
    }));
  }

  if (msg.id === 'conn-1' && msg.ok) {
    ws.send(JSON.stringify({
      type: 'req', id: 'req-1', method: 'multiclaws.team.create',
      params: { teamName: 'my-team', localAddress: 'ws://192.168.1.10:39393' }
    }));
  }

  if (msg.id === 'req-1') {
    console.log(msg.payload);
    ws.close();
  }
});
```

---

## Gateway methods reference

### Peer management

#### `multiclaws.peer.handshake`
Returns local peer identity.
```json
// params: {}
// response: { localIdentity: { peerId, displayName, publicKey } }
```

#### `multiclaws.peer.list`
List all known peers and their connection status.
```json
// params: {}
// response: { peers: [{ peerId, displayName, address, connected, trustLevel, ... }] }
```

#### `multiclaws.peer.add`
Add a peer manually.
```json
// params: { address: "ws://...", peerId?: "...", displayName?: "...", publicKey?: "..." }
// response: { peerId, displayName, address, ... }
```

#### `multiclaws.peer.remove`
Remove a peer.
```json
// params: { peerId: "oc_xxx" }
// response: { removed: true }
```

---

### Messaging

#### `multiclaws.message.send`
Send a direct text message to a peer.
```json
// params: { peerId: "oc_xxx", message: "Hello" }
// response: { delivered: true }
```

---

### Memory search

#### `multiclaws.memory.search`
Search a remote peer's memory.
```json
// params: { peerId: "oc_xxx", query: "...", maxResults?: 5 }
// response: { results: [{ path, snippet, score }] }
```

> Requires the remote peer to grant `memory.search` permission.

---

### Task delegation

#### `multiclaws.task.delegate`
Delegate a task to a remote peer's agent.
```json
// params: { peerId: "oc_xxx", task: "...", context?: "..." }
// response: { ok: true, output: "...", taskId: "..." }
```

> Requires the remote peer to grant `task.delegate` permission.
> Timeout: 120 seconds.

#### `multiclaws.task.status`
Check status of a delegated task.
```json
// params: { taskId: "..." }
// response: { task: { taskId, status, result, error, ... } }
```

---

### Team management

#### `multiclaws.team.create`
Create a new team and get an invite code.
```json
// params: { teamName: "...", localAddress: "ws://..." }
// response: { teamId, teamName, inviteCode }
```

Invite code expires in **7 days**.

#### `multiclaws.team.join`
Join a team using an invite code.
```json
// params: { inviteCode: "TEAM-...", localAddress: "ws://..." }
// response: { teamId, teamName, ownerPeerId }
```

After joining, the plugin automatically connects to the team owner.

#### `multiclaws.team.members`
List members of a team.
```json
// params: { teamId: "team_xxx" }
// response: { members: [{ peerId, displayName, address }] }
```

#### `multiclaws.team.leave`
Leave a team.
```json
// params: { teamId: "team_xxx" }
// response: { left: true }
```

---

### Permissions

#### `multiclaws.permission.set`
Set permission mode for a peer.
```json
// params: { peerId: "oc_xxx", mode: "prompt" | "allow-all" | "blocked" }
// response: { updated: true, mode: "..." }
```

---

## Permission reply format

When a remote peer requests memory search or task delegation, the local node sends a permission prompt to the active channel. Reply with:

```
/mc allow <requestId> once
/mc allow <requestId> permanent
/mc deny <requestId>
```

---

## Agent tools (AI-side)

These tools are available to the AI agent directly:

| Tool | Description |
|---|---|
| `multiclaws_peers` | List all known peers and status |
| `multiclaws_message` | Send a direct message to a peer |
| `multiclaws_search` | Search memory across one or more peers |
| `multiclaws_delegate` | Delegate a task to a peer's agent |

---

## HTTP routes

| Route | Description |
|---|---|
| `GET /multiclaws/health` | Check if the plugin service is running |
| `GET /multiclaws/ws` | Returns 426 — WebSocket runs on the plugin port, not the gateway port |

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
- `test/multiclaws.e2e.test.ts` — two in-process services: messaging, memory search, task delegation
