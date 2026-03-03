# MultiClaws Plugin

`multiclaws` is an OpenClaw plugin that enables collaboration between multiple OpenClaw instances.

## Scope (v0.1)

- Peer discovery and connection over LAN or self-managed network (WebSocket).
- Direct human-readable messaging between peers.
- Runtime permission approval via existing channel replies.
- Permission prompts are proactively sent to the latest active channel conversation.
- Cross-peer memory search request/response.
- Task delegation request/response.
- Delegated task completion notification back to the requester peer.
- Team creation and invite-based join.

## Design choices

- Plugin-only implementation: no OpenClaw core modification.
- Default transport is LAN/self-managed WebSocket.
- No extra UI required for permission approval.
- Permission model is intentionally simple for MVP: per-peer `prompt | allow-all | blocked`.

## Installation

```bash
npm install
npm run build
```

Add plugin path in OpenClaw config (example):

```json
{
  "plugins": {
    "enabled": true,
    "load": {
      "paths": ["/absolute/path/to/multiclaws/dist/index.js"]
    },
    "allow": ["multiclaws"]
  }
}
```

## Plugin config (`openclaw.plugin.json`)

- `port`: WebSocket listen port (default `39393`).
- `displayName`: Local peer display name.
- `localAddress`: Optional local address used for team flow.
- `knownPeers`: Optional static peer list.

Example runtime config:

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

## Registered gateway methods

- `multiclaws.peer.handshake`
- `multiclaws.peer.list`
- `multiclaws.peer.add`
- `multiclaws.peer.remove`
- `multiclaws.memory.search`
- `multiclaws.task.delegate`
- `multiclaws.task.status`
- `multiclaws.message.send`
- `multiclaws.team.create`
- `multiclaws.team.join`
- `multiclaws.team.members`
- `multiclaws.team.leave`
- `multiclaws.permission.set`

## Registered tools

- `multiclaws_peers`
- `multiclaws_message`
- `multiclaws_search`
- `multiclaws_delegate`

## Permission reply format

When a permission prompt is shown, reply using one of:

- `/mc allow <requestId> once`
- `/mc allow <requestId> permanent`
- `/mc deny <requestId>`

If the plugin has observed an inbound message route (`message_received` hook),
approval prompts are delivered directly to that same channel conversation.

## HTTP routes

- `GET /multiclaws/health`
- `GET /multiclaws/ws` (returns 426, because WebSocket runs on the plugin port)

## Development

```bash
npm test
npm run build
```

## Tests

- `test/peer-connection.test.ts`: handshake and connection lifecycle.
- `test/permission.test.ts`: approval parsing and persistence.
- `test/multiclaws.e2e.test.ts`: two in-process services messaging/search/task flow.
