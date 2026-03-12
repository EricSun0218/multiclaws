# MultiClaws — 技能行为

以下规则在插件安装后生效，指导 AI 如何使用 MultiClaws 工具。

MultiClaws 让多个 OpenClaw 实例通过 [A2A（Agent-to-Agent）](https://google.github.io/A2A/) 协议组成团队、互相委派任务。

---

## 1. 首次安装：档案初始化（由插件 hook 触发）

首次安装后，插件会通过 `before_prompt_build` hook 自动在系统提示中注入初始化任务。
**无需每次对话手动检查 `multiclaws_profile_pending_review()`**，hook 已处理触发时机。

当 hook 注入了初始化任务时，按以下步骤执行：

1. **确认用户名**（需用户明确回答）：
   询问用户希望使用什么名字。名字会以「{名字} 的 OpenClaw」格式展示给团队成员。

2. **自动生成 bio**（无需用户确认，直接保存），扫描并检查：
   - **可用工具（tools）**：列出所有工具名称，说明能执行的操作类型
   - **已安装 skills**：列出 skill 名称和功能
   - **已连接渠道**：Telegram、Discord、Gmail、Slack、微信等，列出具体渠道
   - **已安装插件**：列出所有插件及主要功能
   - **工作区**：当前目录下的项目（git 仓库名、语言、框架、项目用途）
   - **数据访问**：日历、邮件、Notion、数据库等
   - **系统信息**：时区、OS、语言

   Bio 是给其他 AI 智能体看的，用来判断这个智能体能做什么、能访问什么数据。必须准确反映实际能力。

3. 用户确认名字后，调用 `multiclaws_profile_set(ownerName="...", bio="...")` 保存。

4. 调用 `multiclaws_profile_clear_pending_review()` 完成初始化。

5. 告知网络情况（无需用户回答）。

**示例 bio：**
```markdown
后端工程师，负责 API 服务开发与维护。

**可用工具：** exec, read, write, edit, glob, grep, process, git, message

**已连接渠道：** Telegram, Gmail

**工作区：**
- `/Users/eric/Project/api-service` — Node.js API 服务（Express, TypeScript, ~50k LOC）

**数据访问：**
- Email: Gmail（收发邮件）
- Calendar: Google Calendar（查看日程）
- Database: PostgreSQL（只读查询）

**已安装插件：** multiclaws, calendar-sync

**时区：** GMT+8
```

---

## 2. 团队操作前检查档案

在 **创建团队** 或 **加入团队** 之前：

```
multiclaws_profile_show()
```

如果 `ownerName` 为空：
1. 询问用户确认名字
2. 自动生成 bio（无需用户确认）
3. 调用 `multiclaws_profile_set(...)` 设置
4. 然后继续团队操作

如果 `ownerName` 已设置但 `bio` 为空：
1. 自动生成 bio 并保存（无需用户确认）
2. 继续团队操作

---

## 3. 保持档案更新

档案是动态的。在以下情况自动更新（调用 `multiclaws_profile_set`）：
- 用户连接了新渠道或数据源
- 用户安装了新 skill 或插件
- 用户的角色或关注点发生变化

不要等用户说「更新档案」，主动更新并简要提及即可。

---

## 工具列表

### 档案

| 工具 | 说明 | 参数 |
|------|------|------|
| `multiclaws_profile_set` | 设置名字和 bio | `ownerName`（可选）, `bio`（可选，markdown） |
| `multiclaws_profile_show` | 查看当前档案 | — |
| `multiclaws_profile_pending_review` | 检查是否有待确认的首次档案 | — |
| `multiclaws_profile_clear_pending_review` | 清除待确认标记 | — |

### 团队

| 工具 | 说明 | 参数 |
|------|------|------|
| `multiclaws_team_create` | 创建团队，返回邀请码 | `name` |
| `multiclaws_team_join` | 用邀请码加入团队 | `inviteCode` |
| `multiclaws_team_leave` | 离开团队 | `teamId`（可选） |
| `multiclaws_team_members` | 列出团队成员 | `teamId`（可选） |

### 智能体与委派

| 工具 | 说明 | 参数 |
|------|------|------|
| `multiclaws_agents` | 列出所有已知智能体及 bio | — |
| `multiclaws_add_agent` | 手动添加远端智能体 | `url`, `apiKey`（可选） |
| `multiclaws_remove_agent` | 移除已知智能体 | `url` |
| `multiclaws_delegate` | 委派任务给远端智能体（自动 spawn 子 agent，立即返回） | `agentUrl`, `task` |
| `multiclaws_delegate_send` | 同步发送任务并等待结果（子 agent 内部使用，勿直接调用） | `agentUrl`, `task` |
| `multiclaws_task_status` | 查看委派任务状态 | `taskId` |

---

## 重要规则

- **不要问用户 IP 地址或 selfUrl。** 插件自动处理。
- **只使用上面列出的工具。** 没有 `multiclaws_status` 工具。
- **Bio 是自由格式的 markdown。** 写得让另一个 AI 能读懂这个智能体能做什么。
- **每个智能体就像一个 skill。** 委派时读每个智能体的 bio，选最匹配的。
- **只有名字需要用户明确确认**；bio 自动生成无需确认；网络情况仅告知无需回答。

---

## 工作流

### 创建团队

```
1. multiclaws_profile_show()              — 检查档案
2.（如果 ownerName 为空）确认名字，自动生成 bio
3. multiclaws_team_create(name="...")     — 返回 inviteCode (mc:xxxx)
4. 告诉用户把邀请码分享给队友
```

### 加入团队

```
1. multiclaws_profile_show()              — 检查档案
2.（如果 ownerName 为空）确认名字，自动生成 bio
3. multiclaws_team_join(inviteCode="mc:xxxx")
   → 自动同步所有团队成员
```

### 委派任务

所有委派（无论单轮还是多轮）都通过 `multiclaws_delegate` 进行。代码会自动 spawn 子 agent 执行，主 agent 立即返回，无需手动 `sessions_spawn`。

```
1. multiclaws_agents()                    — 列出智能体，读 bio
2. 选择 bio 最匹配任务的智能体
3. multiclaws_delegate(agentUrl="...", task="...")
   → 代码自动 spawn 子 agent，子 agent 通过 message 实时汇报结果
```

选择智能体时：
- 匹配任务领域和 bio（如「财务报告」→ 有财务技能的智能体）
- 匹配数据需求（如「检查 API 代码」→ bio 中有该代码库的智能体）
- 多个匹配时选最具体的

需要联系多个智能体时，对每个智能体分别调用 `multiclaws_delegate`。

#### 示例

**单人任务：**
```
用户: "问一下小明他那个 API 接口的参数格式"

1. multiclaws_delegate(小明, "你那个 API 接口的参数格式是什么？")
   → 子 agent 自动发送、等待回复、通过 message 汇报结果
```

**多人任务：**
```
用户: "帮我和小明、小红约明天下午的会议"

1. multiclaws_agents() → 找到小明、小红
2. multiclaws_delegate(小明, "明天下午 2-5 点开会，你什么时候有空？")
3. multiclaws_delegate(小红, "明天下午 2-5 点开会，你什么时候有空？")
   → 每个委派各自 spawn 子 agent，通过 message 实时汇报进展
```

---

## 网络配置

所有实例通过 FRP 隧道通信。需要一台运行 frps 的公网服务器。
frpc 会在首次启动时自动下载安装，无需手动安装。

在插件配置中添加 tunnel 字段即可：
```json
{
  "tunnel": {
    "type": "frp",
    "serverAddr": "你的frps地址",
    "serverPort": 7000,
    "token": "你的认证令牌",
    "portRangeStart": 7011,
    "portRangeEnd": 7020
  }
}
```

当加入或委派因网络错误失败时（ECONNREFUSED、ETIMEDOUT、fetch failed），引导用户：

> 网络连接失败，请检查：
> 1. 确认 frpc 已正常启动（查看日志中的 `[frp] FRP tunnel ready` 信息）
> 2. 检查插件配置中的 `tunnel.serverAddr` / `tunnel.token` 是否正确
> 3. 确认 frps 服务器可达（`telnet frps地址 端口`）
> 4. 重启 OpenClaw
