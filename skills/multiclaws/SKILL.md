# MultiClaws Skill

Use this skill when the user wants to collaborate with other OpenClaw instances over a local network.

## Prerequisites

The `multiclaws` plugin must be installed and the gateway must be running.
If `multiclaws_peers` returns an empty list and no peers are configured, ask the user to either:
- Add peers manually via `multiclaws.peer.add` (gateway WebSocket call)
- Or create/join a team first

---

## Agent tools

### `multiclaws_peers`
List known peers and connection status.
- No parameters required.
- Returns: list of peers with `peerId`, `displayName`, `connected`, `trustLevel`.

### `multiclaws_message`
Send a direct text message to a peer.
- `peer` (required): peer display name or peerId
- `message` (required): message text

### `multiclaws_search`
Search memory on one or more peers.
- `query` (required): search query
- `peer` (optional): specific peer name/id — omit to search all connected peers
- `maxResults` (optional): default 5, max 20

### `multiclaws_delegate`
Delegate a task to another peer's agent.
- `peer` (required): target peer name/id
- `task` (required): task description
- `context` (optional): additional background for the task

---

## Workflow

### Check peer availability first

Always call `multiclaws_peers` before any operation. If the target peer is not connected, report it and stop — do not retry blindly.

### Sending a message

```
multiclaws_message(peer="bob-node", message="Hello from Alice")
```

### Searching peer memory

```
multiclaws_search(query="project deadlines", peer="bob-node", maxResults=5)
```

Omit `peer` to search all connected peers at once.

### Delegating a task

```
multiclaws_delegate(peer="bob-node", task="Summarize the latest emails", context="Focus on urgent items")
```

- The remote peer's agent will execute the task and return results.
- Timeout is 120 seconds.
- The remote peer may show a permission prompt — ask the user to approve it on their side if needed.

---

## Permission behavior

When a remote peer requests memory search or task delegation on this node, a permission prompt appears in the active channel. The user must reply:

```
/mc allow <requestId> once
/mc allow <requestId> permanent
/mc deny <requestId>
```

---

## Calling gateway methods (WebSocket)

Team setup and peer management require calling gateway WebSocket methods directly.
When the user asks to create a team, join a team, add a peer, or set permissions,
provide the following code and guide them through running it.

### Gateway config

- **Port**: from `gateway.port` in `openclaw.json` (default `18789`)
- **Token**: from `gateway.auth.token` in `openclaw.json`

### Handshake sequence

**Step 1** — Gateway sends a challenge on connect:

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "<uuid>", "ts": 1234567890 }
}
```

**Step 2** — Client sends a `connect` request.

Critical requirements:
- `client.mode` must be `"cli"` (not `"operator"`)
- `scopes` must include `"operator.admin"` to call plugin methods
- Do **not** put the nonce inside `auth` — ignore it

```json
{
  "type": "req",
  "id": "conn-1",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": { "id": "cli", "version": "1.0.0", "platform": "macos", "mode": "cli" },
    "role": "operator",
    "scopes": ["operator.read", "operator.write", "operator.admin"],
    "caps": [], "commands": [], "permissions": {},
    "auth": { "token": "<gateway.auth.token>" },
    "locale": "en-US",
    "userAgent": "my-client/1.0.0"
  }
}
```

**Step 3** — Call the method after `hello-ok`:

```json
{
  "type": "req",
  "id": "req-1",
  "method": "multiclaws.team.create",
  "params": { "teamName": "my-team", "localAddress": "ws://192.168.1.10:39393" }
}
```

### Common pitfalls

| Mistake | Error | Fix |
|---|---|---|
| `client.mode: "operator"` | `must be equal to constant` | Use `"cli"` |
| Missing `operator.admin` in scopes | `missing scope: operator.admin` | Add it to `scopes` array |
| Putting `nonce` in `auth` | `unexpected property 'nonce'` | Remove it — just send `token` |
| Calling via HTTP POST `/rpc` | 404 | Use WebSocket, not HTTP |

### Minimal Node.js script

Provide this script when the user needs to call a gateway method:

```js
const WebSocket = require('ws');

const PORT = 18789;          // gateway.port
const TOKEN = 'YOUR_TOKEN'; // gateway.auth.token

const ws = new WebSocket(`ws://localhost:${PORT}`, {
  headers: { Authorization: `Bearer ${TOKEN}` }
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
        auth: { token: TOKEN },
        locale: 'en-US', userAgent: 'my-client/1.0.0'
      }
    }));
  }

  if (msg.id === 'conn-1' && msg.ok) {
    // Replace method and params as needed:
    ws.send(JSON.stringify({
      type: 'req', id: 'req-1',
      method: 'multiclaws.team.create',
      params: { teamName: 'my-team', localAddress: 'ws://192.168.x.x:39393' }
    }));
  }

  if (msg.id === 'req-1') {
    console.log(JSON.stringify(msg.payload, null, 2));
    ws.close();
  }
});
```

---

## Gateway methods reference

### Peer management

| Method | Params | Response |
|---|---|---|
| `multiclaws.peer.handshake` | `{}` | `{ localIdentity: { peerId, displayName, publicKey } }` |
| `multiclaws.peer.list` | `{}` | `{ peers: [...] }` |
| `multiclaws.peer.add` | `{ address, peerId?, displayName?, publicKey? }` | peer record |
| `multiclaws.peer.remove` | `{ peerId }` | `{ removed: true }` |

### Messaging

| Method | Params | Response |
|---|---|---|
| `multiclaws.message.send` | `{ peerId, message }` | `{ delivered: true }` |

### Memory & tasks

| Method | Params | Response |
|---|---|---|
| `multiclaws.memory.search` | `{ peerId, query, maxResults? }` | `{ results: [{ path, snippet, score }] }` |
| `multiclaws.task.delegate` | `{ peerId, task, context? }` | `{ ok, output, taskId }` |
| `multiclaws.task.status` | `{ taskId }` | `{ task: { taskId, status, result, error } }` |

### Team management

| Method | Params | Response |
|---|---|---|
| `multiclaws.team.create` | `{ teamName, localAddress }` | `{ teamId, teamName, inviteCode }` |
| `multiclaws.team.join` | `{ inviteCode, localAddress }` | `{ teamId, teamName, ownerPeerId }` |
| `multiclaws.team.members` | `{ teamId }` | `{ members: [{ peerId, displayName, address }] }` |
| `multiclaws.team.leave` | `{ teamId }` | `{ left: true }` |

### Permissions

| Method | Params | Response |
|---|---|---|
| `multiclaws.permission.set` | `{ peerId, mode: "prompt"\|"allow-all"\|"blocked" }` | `{ updated: true, mode }` |
| `multiclaws.permission.pending` | `{}` | `{ requests: [{ requestId, peerId, peerDisplayName, action, context, createdAtMs, expiresAtMs }] }` |
| `multiclaws.permission.resolve` | `{ requestId, decision: "allow-once"\|"allow-permanently"\|"deny" }` | `{ resolved: true, requestId, decision }` |

---

## Tips

- Use `multiclaws_peers` to confirm a peer is `connected: true` before delegating.
- For memory search, keep queries short and specific for better results.
- For task delegation, be explicit about the expected output format.
- If a permission prompt is pending, remind the user to approve it on the remote node.
- Invite codes from `team.create` expire in **7 days**.
