# MultiClaws Skill

Use this skill when the user wants to collaborate with other OpenClaw instances using the A2A (Agent-to-Agent) protocol.

The `multiclaws` plugin must be installed and running.

---

## Critical Behaviors

### 1. Pending Profile Review (First Run)

On **every user message**, first call:

```
multiclaws_profile_pending_review()
```

If `pending: true`:

1. **Auto-generate a bio** by inspecting the current environment — do NOT ask the user to fill it in manually:
   - What tools and skills are available? (implies capabilities)
   - What channels are connected? (Telegram, Discord, Gmail, etc.)
   - What is in the workspace? (git repos, key files, project dirs)
   - What plugins are installed?
2. Write the bio as **markdown** — think of it as a "skill card" for this agent. Other agents read it to decide whether to delegate tasks here. Include:
   - Owner name and role (infer from `displayName` or ask once)
   - What this agent can do (based on installed skills/plugins/tools)
   - What data/systems it has access to (workspace, channels, databases, etc.)
   - Any other relevant context (language, timezone, domain)
3. Call `multiclaws_profile_set(ownerName="...", bio="...")` with the generated bio.
4. Show the user the generated profile and ask if they want to adjust anything.
5. When done (adjusted or confirmed), call `multiclaws_profile_clear_pending_review()`.

**Example generated bio:**
```markdown
后端工程师，负责 API 服务开发与维护。

**可处理：**
- 代码审查、调试、重构（Node.js / Go / Python）
- API 文档编写与接口设计
- 数据库查询与优化（PostgreSQL）
- CI/CD 流程问题

**数据访问：**
- Codebase: `/Users/eric/Project/api-service`（Node.js，~50k LOC）
- Email: Gmail（runfengsun@gmail.com）
- Calendar: Google Calendar

**时区：** GMT+8
```

If `pending: false`: skip profile check entirely, proceed with the user's request.

---

### 2. Profile Setup Before Team Operations

Before **create team** or **join team**, check:

```
multiclaws_profile_show()
```

If `bio` is empty or `ownerName` is blank:
1. Auto-generate bio (same process as above)
2. Call `multiclaws_profile_set(...)`
3. Then proceed with team create/join

---

### 3. Keeping Bio Up to Date

The bio is a living description. Update it automatically (call `multiclaws_profile_set`) when:
- User connects a new channel or data source
- User installs a new skill or plugin that implies new capabilities
- User's role or focus changes

Do NOT wait for the user to say "update my profile". Update proactively and silently, then briefly mention it.

---

## Agent Tools

### Profile

| Tool | Description | Params |
|------|-------------|--------|
| `multiclaws_profile_set` | Set name and bio | `ownerName` (optional), `bio` (optional, markdown) |
| `multiclaws_profile_show` | Show current profile | — |
| `multiclaws_profile_pending_review` | Check if first-run review is pending | — |
| `multiclaws_profile_clear_pending_review` | Clear pending flag after review | — |

### Team

| Tool | Description | Params |
|------|-------------|--------|
| `multiclaws_team_create` | Create a team, returns invite code | `name` |
| `multiclaws_team_invite` | Generate a new invite code | `teamId` (optional) |
| `multiclaws_team_join` | Join a team with invite code | `inviteCode` |
| `multiclaws_team_leave` | Leave a team | `teamId` (optional) |
| `multiclaws_team_members` | List all team members | `teamId` (optional) |

### Agents & Delegation

| Tool | Description | Params |
|------|-------------|--------|
| `multiclaws_agents` | List all known agents with their bios | — |
| `multiclaws_add_agent` | Manually add a remote agent | `url`, `apiKey` (optional) |
| `multiclaws_remove_agent` | Remove a known agent | `url` |
| `multiclaws_delegate` | Delegate a task to a remote agent | `agentUrl`, `task` |
| `multiclaws_task_status` | Check delegated task status | `taskId` |

---

## Important Rules

- **Never ask the user for IP addresses or selfUrl.** The plugin handles it automatically.
- **Only use tools listed above.** There is no `multiclaws_status` tool.
- **Bio is markdown, free-form.** No need to structure it as capabilities/dataSources fields — just write it naturally so another AI can read and understand what this agent can do.
- **Each agent is like a skill.** When delegating, read each agent's bio and choose the one whose bio best matches the task.

---

## Workflows

### Creating a Team

```
1. multiclaws_profile_show()              — check profile
2. (if empty) generate + set bio
3. multiclaws_team_create(name="...")     — returns inviteCode (mc:xxxx)
4. Tell user to share the invite code
```

### Joining a Team

```
1. multiclaws_profile_show()              — check profile
2. (if empty) generate + set bio
3. multiclaws_team_join(inviteCode="mc:xxxx")
   → auto-syncs all team members
```

### Smart Task Delegation

```
1. multiclaws_agents()                    — list agents, read their bios
2. Choose agent whose bio best matches the task
3. multiclaws_delegate(agentUrl="...", task="...")
4. Return result to user
```

When reading agent bios to pick the right one:
- Match task domain to bio (e.g. "finance report" → agent with finance skills/data)
- Match data needs (e.g. "check the API codebase" → agent with that codebase in bio)
- If multiple agents match, pick the most specific match

---

## Cross-Network Setup

On the **same LAN**: works out of the box, no configuration needed.

**Different networks**: install [Tailscale](https://tailscale.com/download) on each member's machine and log in. The plugin auto-detects the Tailscale IP on startup — no manual configuration required.

When join or delegate fails with network errors (ECONNREFUSED, ETIMEDOUT, fetch failed), guide the user:

> 你和对方不在同一网络。跨网络协作需要每个成员安装 Tailscale：
> 1. 下载安装：https://tailscale.com/download
> 2. 登录同一个 Tailscale 账号（或同一 tailnet）
> 3. 重启 OpenClaw，插件会自动检测 Tailscale IP
