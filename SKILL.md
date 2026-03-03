# MultiClaws Skill

Use this skill when collaboration across OpenClaw peers is needed.

## When to use

- You need to send a message to another teammate's OpenClaw instance.
- You need to search memory from another peer.
- You need to delegate work to another peer.
- You need to inspect peer availability.

## Available tools

### `multiclaws_peers`
List known peers and connectivity status.

### `multiclaws_message`
Send a direct message to a peer.

Parameters:
- `peer`: peer name or peer id
- `message`: message body

### `multiclaws_search`
Search memory on one or more peers.

Parameters:
- `query`: search query
- `peer` (optional): specific peer name/id
- `maxResults` (optional)

### `multiclaws_delegate`
Delegate a task to another peer.

Parameters:
- `peer`: target peer name/id
- `task`: task description
- `context` (optional): additional context

When the delegated peer finishes execution, a completion notification is sent back to the requester side.

## Permission behavior

Remote operations may require user approval on the target peer.
Approval prompts are pushed to the latest active channel conversation.

Approval replies are interpreted via channel messages:
- `/mc allow <requestId> once`
- `/mc allow <requestId> permanent`
- `/mc deny <requestId>`

## Usage guidance

1. Always call `multiclaws_peers` before delegation/search.
2. If the target peer is offline, report that status instead of retrying indefinitely.
3. For memory search, keep query focused and limit results.
4. For delegation, provide concise task and explicit expected output.
