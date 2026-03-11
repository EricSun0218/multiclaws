# MultiClaws — 技能行为

以下规则在插件安装后生效，指导 AI 如何使用 MultiClaws 工具。

MultiClaws 让多个 OpenClaw 实例通过 [A2A（Agent-to-Agent）](https://google.github.io/A2A/) 协议组成团队、互相委派任务。

---

## 1. 首次安装：档案初始化（由插件 hook 触发）

首次安装后，插件会通过 `before_prompt_build` hook 自动在系统提示中注入初始化任务。
**无需每次对话手动检查 `multiclaws_profile_pending_review()`**，hook 已处理触发时机。

当 hook 注入了初始化任务时，按以下步骤执行：

1. **扫描当前环境**，自动生成 bio（markdown 格式），包含：
   - 可用的工具和 skills（推断能力）
   - 已连接的渠道（Telegram、Discord、Gmail 等）
   - 工作区内容（git 仓库、关键文件、项目目录）
   - 已安装的插件
   - 时区、语言等上下文

2. 向用户展示生成的档案，并逐一确认以下三项：
   - **名字**：展示推断出的名字，询问是否需要修改（需用户明确回答）
   - **Bio**：展示生成的 bio，询问是否需要修改（需用户明确回答）
   - **网络情况**：告知用户「所有实例通过 FRP 隧道通信，需在插件配置中设置 tunnel 字段（frps 地址、端口、token、可用端口范围），frpc 会自动下载安装」，无需用户回答

3. 根据用户对名字和 bio 的回答更新内容后，调用 `multiclaws_profile_set(ownerName="...", bio="...")` 保存档案。

4. 调用 `multiclaws_profile_clear_pending_review()` 完成初始化。

**示例 bio：**
```markdown
后端工程师，负责 API 服务开发与维护。

**可处理：**
- 代码审查、调试、重构（Node.js / Go / Python）
- API 文档编写与接口设计
- 数据库查询与优化（PostgreSQL）

**数据访问：**
- Codebase: `/Users/eric/Project/api-service`（Node.js，~50k LOC）
- Email: Gmail
- Calendar: Google Calendar

**时区：** GMT+8
```

---

## 2. 团队操作前检查档案

在 **创建团队** 或 **加入团队** 之前：

```
multiclaws_profile_show()
```

如果 `bio` 为空或 `ownerName` 为空：
1. 自动生成 bio（同上）
2. 询问用户确认名字和 bio
3. 调用 `multiclaws_profile_set(...)` 设置
4. 然后继续团队操作

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
| `multiclaws_delegate` | 委派任务给远端智能体 | `agentUrl`, `task` |
| `multiclaws_task_status` | 查看委派任务状态 | `taskId` |

---

## 重要规则

- **不要问用户 IP 地址或 selfUrl。** 插件自动处理。
- **只使用上面列出的工具。** 没有 `multiclaws_status` 工具。
- **Bio 是自由格式的 markdown。** 写得让另一个 AI 能读懂这个智能体能做什么。
- **每个智能体就像一个 skill。** 委派时读每个智能体的 bio，选最匹配的。
- **名字和 bio 必须用户明确确认**；网络情况仅告知，无需用户回答。

---

## 工作流

### 创建团队

```
1. multiclaws_profile_show()              — 检查档案
2.（如果为空）自动生成并设置 bio，确认名字和 bio
3. multiclaws_team_create(name="...")     — 返回 inviteCode (mc:xxxx)
4. 告诉用户把邀请码分享给队友
```

### 加入团队

```
1. multiclaws_profile_show()              — 检查档案
2.（如果为空）自动生成并设置 bio，确认名字和 bio
3. multiclaws_team_join(inviteCode="mc:xxxx")
   → 自动同步所有团队成员
```

### 智能委派（单轮）

适用于一次性任务，不需要来回沟通。

```
1. multiclaws_agents()                    — 列出智能体，读 bio
2. 选择 bio 最匹配任务的智能体
3. multiclaws_delegate(agentUrl="...", task="...")
4. 把结果返回给用户
```

选择智能体时：
- 匹配任务领域和 bio（如「财务报告」→ 有财务技能的智能体）
- 匹配数据需求（如「检查 API 代码」→ bio 中有该代码库的智能体）
- 多个匹配时选最具体的

### 多轮协作（需要来回沟通）

适用于需要协商、确认、多次沟通才能完成的任务（如约会议、对需求、联合调试）。

**根据用户是否需要看到中间过程，选择以下两种模式：**

#### 模式 A：交互式多轮（推荐 — 用户能看到每一步进展）

主 AI 直接处理多轮沟通，每轮之间向用户汇报进展。

```
用户: "帮我和小明约明天下午的会议"

1. multiclaws_agents()                    — 找到小明
2. multiclaws_delegate(agentUrl="小明", task="我想约明天下午开会，你什么时候有空？")
3. → 向用户汇报: "小明说明天下午 3 点和 4 点都可以"
4.（用户说"约 3 点"或 AI 自行判断）
5. multiclaws_delegate(agentUrl="小明", task="确认明天下午 3 点开会")
6. → 向用户汇报: "已和小明确认明天下午 3 点"
```

**关键规则：**
- 每次 `multiclaws_delegate` 返回后，**立即向用户汇报结果**，不要等全部完成
- 如果能自行判断下一步（如对方给了选项，用户已表达偏好），直接继续
- 如果需要用户决策（如对方提出多个方案），暂停并询问用户
- 协商未达成一致时，继续发 `multiclaws_delegate`，最多 5 轮

#### 模式 B：自主式多轮（AI 全自动完成，只报告最终结果）

适用于用户明确授权自主处理、不需要看中间过程的场景。使用 `sessions_spawn` 启动子 agent，子 agent 自主完成全部沟通。

```
用户: "帮我和小明约个会，我明天下午都行，你自己搞定"

1. sessions_spawn(task="联系小明协商明天下午的会议时间。我这边下午都可以。
   使用 multiclaws_delegate 与小明沟通，协商确定具体时间。
   完成后汇报最终结果。", mode="run")
2.（子 agent 自主多轮沟通）
3. 子 agent 完成 → announce 回父 agent → 向用户报告最终结果
```

**何时用模式 B：**
- 用户明确说「你自己搞定」「自动处理」「不用问我」
- 任务参数已完全明确，不需要用户中间决策

**默认用模式 A。** 除非用户明确要求自主处理，否则始终用交互式模式，确保用户看到每一步。

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
