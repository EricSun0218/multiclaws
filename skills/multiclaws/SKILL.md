# MultiClaws Skill

Use this skill when the user wants to collaborate with other OpenClaw instances over a local network.

## Prerequisites

The `multiclaws` plugin must be installed and the gateway must be running.
If `multiclaws_peers` returns an empty list and no peers are configured, ask the user to either:
- Add peers manually via `multiclaws.peer.add` (gateway WebSocket call)
- Or create/join a team first

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

## Permission behavior

When a remote peer requests memory search or task delegation on this node, a permission prompt appears in the active channel. The user must reply:

```
/mc allow <requestId> once
/mc allow <requestId> permanent
/mc deny <requestId>
```

## Team setup (first time)

Team setup requires calling gateway WebSocket methods directly (not agent tools).
Guide the user through the steps:

1. **Create a team** (one node does this):
   - Call `multiclaws.team.create` with `teamName` and `localAddress`
   - Share the returned `inviteCode` with the other node

2. **Join a team** (other nodes do this):
   - Call `multiclaws.team.join` with `inviteCode` and `localAddress`
   - After joining, the connection to the owner is established automatically

These calls require a WebSocket connection to the gateway with `operator.admin` scope.
See README for the full handshake protocol and Node.js example.

## Available tools

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

## Tips

- Use `multiclaws_peers` to confirm a peer is `connected: true` before delegating.
- For memory search, keep queries short and specific for better results.
- For task delegation, be explicit about the expected output format.
- If a permission prompt is pending, remind the user to approve it on the remote node.
