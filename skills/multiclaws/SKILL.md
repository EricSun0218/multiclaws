# MultiClaws Skill

Use this skill when the user wants to collaborate with other OpenClaw instances over a local network using the A2A (Agent-to-Agent) protocol.

## Prerequisites

The `multiclaws` plugin must be installed and the service must be running.

---

## Critical Behaviors

### 1. Auto Profile Setup

When the user asks to **create a team** or **join a team**, you MUST first check if a profile has been set:

```
multiclaws_profile_show()
```

If the profile is empty (ownerName is blank), you MUST:
1. Ask the user for their **name** and **role** (e.g., "What's your name and role?")
2. Call `multiclaws_profile_set` with the provided info
3. Auto-detect connected data sources (see below) and add them
4. Then proceed with the team create/join

**Example flow:**
```
User: "I want to create a team"
AI: Profile not set yet. What's your name and role?
User: "I'm Alice, frontend engineer"
AI: → multiclaws_profile_set(ownerName="Alice", role="frontend engineer")
    → (auto-detect data sources and add them)
    → multiclaws_team_create(name="...")
```

### 2. Auto Data Source Detection

You MUST NOT ask the user what data sources they have. Instead, auto-detect from the OpenClaw environment:

- If the user has a **codebase** loaded (working directory, git repo), add it as a data source
- If the user has **email** connected (e.g., Gmail plugin), add it
- If the user has **calendar** connected (e.g., Google Calendar plugin), add it
- If the user has **documents** connected (e.g., Notion, Google Docs), add it
- If the user has **database** access, add it
- If the user has **project management** tools (e.g., Jira, Linear), add it

Use `multiclaws_profile_add_source` for each detected source. Include a brief description if possible.

```
multiclaws_profile_add_source(type="codebase", name="React Dashboard", description="Next.js 14 frontend project")
multiclaws_profile_add_source(type="email", name="Gmail")
```

### 3. Auto Profile Update on Data Source Change

When the user **connects a new data source** (e.g., "connect my Gmail", "load this codebase", "connect to Jira"), you MUST automatically:

1. Call `multiclaws_profile_add_source` with the new source info
2. The plugin will auto-broadcast the updated profile to all team members

Do NOT wait for the user to say "update my profile". This must happen automatically whenever a new data source is connected.

Similarly, when a data source is **disconnected**, call `multiclaws_profile_remove_source` automatically.

---

## Agent Tools

### Profile

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `multiclaws_profile_set` | Set owner name, role, description | At least one of: `ownerName`, `role`, `description` |
| `multiclaws_profile_add_source` | Add a data source to the profile | `type`, `name`; optional: `description` |
| `multiclaws_profile_remove_source` | Remove a data source by name | `name` |
| `multiclaws_profile_show` | Show current profile and data sources | -- |

### Team

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `multiclaws_team_create` | Create a team and get an invite code | `name` |
| `multiclaws_team_invite` | Generate a new invite code for the team | optional: `teamId` |
| `multiclaws_team_join` | Join a team with an invite code | `inviteCode` |
| `multiclaws_team_leave` | Leave a team | optional: `teamId` |
| `multiclaws_team_members` | List all team members | optional: `teamId` |

### Agent Discovery & Task Delegation

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `multiclaws_agents` | List all known remote agents with their profiles | -- |
| `multiclaws_add_agent` | Manually add a remote agent by URL | `url`; optional: `apiKey` |
| `multiclaws_remove_agent` | Remove a known agent | `url` |
| `multiclaws_delegate` | Delegate a task to a remote agent | `agentUrl`, `task` |
| `multiclaws_task_status` | Check the status of a delegated task | `taskId` |

---

## Important Rules

- **Do NOT ask the user for addresses or URLs.** The plugin automatically determines `selfUrl` from plugin config or the machine's hostname. Just call the tool directly.
- **Do NOT call tools that don't exist.** Only use the tools listed in the "Agent Tools" section above. There is NO `multiclaws_status` tool.
- **Do NOT ask the user to "check status" before creating/joining a team.** Just proceed directly with the workflow below.

---

## Workflows

### Creating a Team

```
1. multiclaws_profile_show()          -- check if profile exists
2. (if empty) Ask user for name/role → multiclaws_profile_set(...)
3. (auto-detect) multiclaws_profile_add_source(...)  -- for each detected source
4. multiclaws_team_create(name="Engineering Team")   -- just call it, no address needed
   → returns teamId and inviteCode (format: mc:xxxx)
5. Tell the user to share the invite code with teammates
```

### Joining a Team

```
1. multiclaws_profile_show()          -- check if profile exists
2. (if empty) Ask user for name/role → multiclaws_profile_set(...)
3. (auto-detect) multiclaws_profile_add_source(...)
4. multiclaws_team_join(inviteCode="mc:xxxx")        -- just call it, no address needed
   → auto-syncs all team members bidirectionally
   → all members can now see each other's profiles
```

### Smart Task Delegation

When the user asks you to do something that requires collaboration:

```
1. multiclaws_agents()                -- list all known agents with descriptions
2. Read each agent's description to determine who has the right data sources
3. multiclaws_delegate(agentUrl="http://bob:3100", task="...")
4. multiclaws_task_status(taskId="...")  -- poll for results
5. Return the results to the user
```

**Choosing the right agent:**
- Each agent's description includes their owner's identity and data sources
- Example: `"Bob, backend engineer. data sources: API Codebase (Node.js), PostgreSQL, Jira"`
- Match the task to the agent whose data sources are most relevant
- If multiple agents could help, prefer the one with the most specific data source match

### Example: Cross-team Collaboration

```
User: "Ask the backend team for the user auth API documentation"

AI thinks:
  → multiclaws_agents() returns:
    - Bob (http://bob:3100): "Bob, backend engineer. data sources: API Codebase (Node.js), PostgreSQL"
    - Carol (http://carol:3100): "Carol, designer. data sources: Figma, Design System Docs"
  → Bob has the API codebase, so delegate to Bob

  → multiclaws_delegate(agentUrl="http://bob:3100", task="Find the user authentication API documentation and provide the endpoint details")
  → multiclaws_task_status(taskId="xxx")
  → Return Bob's response to the user
```

---

## Data Source Types

Common `type` values for `multiclaws_profile_add_source`:

| Type | Examples |
|------|----------|
| `codebase` | Git repositories, local projects |
| `email` | Gmail, Outlook |
| `calendar` | Google Calendar, Outlook Calendar |
| `documents` | Notion, Google Docs, Confluence |
| `database` | PostgreSQL, MySQL, MongoDB |
| `api` | REST APIs, GraphQL endpoints |
| `messaging` | Slack, Teams, Discord |
| `project-management` | Jira, Linear, GitHub Issues |
| `design` | Figma, Sketch |
| `storage` | Google Drive, Dropbox |

---

## Cross-Network Setup

MultiClaws uses HTTP for agent-to-agent communication. When team members are on the **same local network (LAN)**, everything works out of the box. But when members are on **different networks** (e.g., different offices, home networks, different cities), each member's multiclaws port must be publicly accessible.

### How to Detect Cross-Network Issues

When `multiclaws_team_join` or `multiclaws_delegate` fails with network errors (e.g., ECONNREFUSED, ENOTFOUND, ETIMEDOUT, fetch failed), it almost always means the target is not reachable across the network.

### What to Tell the User

When a join or delegate fails due to network errors, guide the user with the following:

> 看起来你和对方不在同一个网络，无法直接连接。跨网络协作需要**每个成员**都将自己的 multiclaws 端口暴露到公网。
>
> 每个成员需要执行以下步骤：
>
> **1. 启动隧道（任选一种）：**
> ```bash
> # 方式 A：使用 cloudflared（免费，无需注册）
> npx cloudflared tunnel --url http://localhost:3100
>
> # 方式 B：使用 ngrok
> npx ngrok http 3100
> ```
> 启动后终端会显示一个公网 URL（如 `https://xxx.trycloudflare.com`）。
>
> **2. 配置 selfUrl：**
>
> 在 `~/.openclaw/openclaw.json` 中将 `selfUrl` 设为隧道给你的公网 URL：
> ```json
> {
>   "plugins": {
>     "entries": {
>       "multiclaws": {
>         "config": {
>           "selfUrl": "https://xxx.trycloudflare.com"
>         }
>       }
>     }
>   }
> }
> ```
>
> **3. 重启 gateway：**
> ```bash
> openclaw gateway restart
> ```
>
> **4. 所有成员配置完成后**，由团队创建者重新创建团队并分享新的邀请码。

**Important:** Every member needs to do this, not just the team creator. Otherwise, even if you can join, other members won't be able to reach you for task delegation.

---

## Tips

- Always check profile before team operations. A good profile helps other agents find the right person for each task.
- Data sources should be auto-detected, never manually entered by the user.
- When delegating tasks, be explicit about the expected output format in the task description.
- If `multiclaws_agents` returns an empty list and the user hasn't joined a team, guide them through team setup first.
- Invite codes start with `mc:` prefix. They don't expire.
- All team operations are decentralized -- there is no central server. Members communicate directly via HTTP.
