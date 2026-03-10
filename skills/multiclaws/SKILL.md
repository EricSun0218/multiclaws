# MultiClaws — 技能行为

MultiClaws 让多个 OpenClaw 实例通过 [A2A（Agent-to-Agent）](https://google.github.io/A2A/) 协议组成团队、互相委派和协作任务。

---

## 1. 首次安装：档案初始化（由插件 hook 触发）

首次安装后，插件会通过 `before_prompt_build` hook 自动在系统提示中注入初始化任务。

当 hook 注入了初始化任务时，按以下步骤执行：

1. **扫描当前环境**，自动生成 bio（markdown 格式）
2. 向用户展示，逐一确认：
   - **名字**：询问是否需要修改（需用户明确回答）
   - **Bio**：询问是否需要修改（需用户明确回答）
   - **网络情况**：告知「同局域网开箱即用；跨网络需安装 Tailscale」，无需用户回答
3. 调用 `multiclaws_profile_set(ownerName="...", bio="...")` 保存
4. 调用 `multiclaws_profile_clear_pending_review()` 完成初始化

---

## 2. 协作任务（Session）

**所有委派任务均通过 session 进行**，支持单轮和多轮场景。

### 开始协作
```
multiclaws_session_start(agentUrl="...", message="任务描述")
→ 立即返回 sessionId，任务在后台运行
→ 完成后自动推送消息通知
```

### 远端需要补充信息（input-required）
收到 `📨 AgentName 需要补充信息` 通知后：
```
multiclaws_session_reply(sessionId="...", message="补充内容")
→ 继续会话，后台处理，完成后推送通知
```

### 查看会话状态
```
multiclaws_session_status()              → 列出所有会话
multiclaws_session_status(sessionId="...") → 查看单个会话及消息历史
```

### 结束会话
```
multiclaws_session_end(sessionId="...")  → 取消并关闭会话
```

### 并发协作
可同时开启多个 session，各自独立运行：
```
multiclaws_session_start(agentUrl=B, message="任务1") → sessionId_1
multiclaws_session_start(agentUrl=C, message="任务2") → sessionId_2
```

### 链式协作（A→B→C）
B 内部可以自己调用 `multiclaws_session_start` 委派给 C，结果自然冒泡回 A。

---

## 3. 智能委派流程

```
1. multiclaws_team_members()          → 列出所有成员，读 bio
2. 选择 bio 最匹配任务的 agent
3. multiclaws_session_start(agentUrl, message)
4. 等待推送通知（或用 session_status 查进度）
5. 如收到 input-required 通知 → multiclaws_session_reply 回复
```

**选择 agent 原则：**
- 匹配任务领域（「财务报告」→ 有财务技能的 agent）
- 匹配数据访问（「检查代码」→ bio 中有该代码库的 agent）
- 多个匹配时选最具体的

---

## 4. 团队操作前检查档案

在创建或加入团队之前：

```
multiclaws_profile_show()
```

如果 `bio` 为空或 `ownerName` 为空，先完成档案设置再继续。

---

## 工具列表

### 协作 Session

| 工具 | 说明 | 参数 |
|------|------|------|
| `multiclaws_session_start` | 开始协作会话（替代旧 delegate） | `agentUrl`, `message` |
| `multiclaws_session_reply` | 在会话中发送后续消息 | `sessionId`, `message` |
| `multiclaws_session_status` | 查看会话状态和消息历史 | `sessionId`（可选，不传返回全部） |
| `multiclaws_session_end` | 取消/关闭会话 | `sessionId` |

### 档案

| 工具 | 说明 | 参数 |
|------|------|------|
| `multiclaws_profile_set` | 设置名字和 bio | `ownerName`（可选）, `bio`（可选） |
| `multiclaws_profile_show` | 查看当前档案 | — |
| `multiclaws_profile_pending_review` | 检查是否有待确认的首次档案 | — |
| `multiclaws_profile_clear_pending_review` | 清除待确认标记 | — |

### 团队

| 工具 | 说明 | 参数 |
|------|------|------|
| `multiclaws_team_create` | 创建团队，返回邀请码 | `name` |
| `multiclaws_team_join` | 用邀请码加入团队 | `inviteCode` |
| `multiclaws_team_leave` | 离开团队 | `teamId`（可选） |
| `multiclaws_team_members` | 列出所有团队和成员 | `teamId`（可选） |

### 智能体

| 工具 | 说明 | 参数 |
|------|------|------|
| `multiclaws_agents` | 列出已知 agent 及 bio | — |
| `multiclaws_add_agent` | 手动添加 agent | `url`, `apiKey`（可选） |
| `multiclaws_remove_agent` | 移除 agent | `url` |

---

## 重要规则

- **不要问用户 IP 或 selfUrl**，插件自动处理
- **Bio 是 markdown**，写得让另一个 AI 能读懂这个 agent 能做什么
- **名字和 bio 必须用户明确确认**；网络情况仅告知
- **session 超时默认 5 分钟**，超时后 status 变 failed 并推送通知

---

## 跨网络

**同局域网：** 开箱即用。

**不同网络：** 安装 [Tailscale](https://tailscale.com/download) 并登录同一 tailnet，插件自动检测。

网络错误时引导用户：
> 跨网络需要安装 Tailscale：https://tailscale.com/download，登录后重启 OpenClaw。
