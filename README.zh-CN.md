# MultiClaws 插件

`multiclaws` 是 OpenClaw 的插件，通过 HTTP 上的 [Google A2A（Agent-to-Agent）](https://google.github.io/A2A/) 协议实现多 OpenClaw 实例之间的协作。

## 功能

- 基于 A2A 协议的智能体间通信
- 基于邀请码的团队协作
- 智能体档案：所有者身份与数据源广播
- 同步任务委派与自动结果轮询
- 多智能体编排（扇出、链式、迭代、路由）
- 跨团队成员发现

---

## 快速开始

### 1. 安装

```bash
pnpm install
pnpm run build
```

### 2. 配置

在 `~/.openclaw/openclaw.json` 中添加：

```json
{
  "plugins": {
    "enabled": true,
    "load": {
      "paths": ["/multiclaws 的绝对路径"]
    },
    "entries": {
      "multiclaws": {
        "config": {
          "port": 3100,
          "displayName": "alice",
          "selfUrl": "http://192.168.x.x:3100"
        }
      }
    }
  },
  "gateway": {
    "tools": {
      "allow": ["sessions_spawn", "sessions_history"]
    }
  }
}
```

> ⚠️ **重要：** `sessions_spawn` 和 `sessions_history` 都必须出现在 `gateway.tools.allow` 中。执行器使用 `sessions_spawn` 启动任务，使用 `sessions_history` 轮询完成结果。

### 3. selfUrl 配置

`selfUrl` 是其他智能体访问你的地址。**请尽量使用 IP 地址，不要用主机名**（跨机器时 `.local` 主机名可能无法解析）。

- **局域网：** `http://192.168.x.x:3100`（本机局域网 IP）
- **跨网：** 你的公网/隧道 URL（见下文）

查看本机 IP 示例：
```bash
# macOS
ipconfig getifaddr en0

# Linux
hostname -I | awk '{print $1}'
```

### 4. 防火墙

确保端口可访问。在 macOS 上，Node.js 可能被应用防火墙拦截：

```bash
# 检查是否被拦截
/usr/libexec/ApplicationFirewall/socketfilterfw --getappblocked $(which node)

# 放行
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp $(which node)
```

### 5. 重启 gateway

```bash
openclaw gateway restart
```

---

## 与队友连接

### 同一局域网（LAN）

将 `selfUrl` 设为本机局域网 IP，并确保防火墙未拦截该端口。

### 同一尾网（Tailscale）

若你和队友在同一 **Tailscale** 尾网，插件可**自动检测**你的 Tailscale IP 并用作 `selfUrl`（无需隧道或额外配置）。请确保已安装并登录 Tailscale；插件会执行 `tailscale ip -4` 或扫描 Tailscale 网卡。优先级为：隧道 URL > 配置中的 `selfUrl` > **Tailscale URL**（检测到时）> 本机 IP。可通过 *「显示我的 self URL」* 查看当前 URL 及来源（使用 Tailscale 时来源为 `tailscale`）。若不想自动使用 Tailscale，可在插件配置中设置 `preferTailscale: false`。

### 不同网络

只要 HTTP 端口可被访问，插件即可跨任意网络工作。没有端口转发时，仅公网 IP 不够用，需通过**隧道**（如 cloudflared、ngrok）将 3100 端口暴露为公网 URL，再把该 URL 设为 `selfUrl`。

| 方式 | 示例地址 |
|---|---|
| **Tailscale**（同尾网） | 自动检测 `http://100.x.x.x:3100` 或手动设置 |
| 公网 IP / VPS | `http://203.0.113.5:3100` |
| 端口转发 | `http://路由器IP:3100` |
| 隧道（frp、ngrok、cloudflared 等） | `https://your-tunnel.example.com` |

**每位成员**都需要一个可被访问的地址，可用以下两种方式之一设置：

**方式 A — 通过工具设置隧道 URL（无需改配置）：** 启动隧道后（例如 `npx cloudflared tunnel --url http://localhost:3100`），让 AI 设置隧道 URL，例如 *「把隧道 URL 设为 https://xxx.trycloudflare.com」*。插件会保存并立即将其作为 `selfUrl` 使用，无需重启 gateway。用 *「显示我的 self URL」* 确认，或用 *「清除隧道 URL」* 恢复为配置/本机地址。

**方式 B — 配置文件：** 在插件配置中设置 `selfUrl` 并重启 gateway：

```json
{
  "config": {
    "port": 3100,
    "displayName": "alice",
    "selfUrl": "https://your-tunnel.example.com"
  }
}
```

### 创建团队

对 AI 说：

> 「创建一个叫 my-team 的团队」

把邀请码发给对方，对方对自己的 AI 说：

> 「用邀请码 mc:xxxxx 加入团队」

完成。插件会自动同步成员。

---

## 使用 MultiClaws

一切通过自然语言与 AI 完成：

- **「创建一个叫 my-team 的团队」** — 创建团队并获取邀请码
- **「用邀请码 mc:xxxxx 加入团队」** — 使用邀请码加入
- **「显示团队成员」** — 列出所有成员
- **「退出团队」** — 退出当前团队
- **「让 Bob 总结一下最新报告」** — 通过 A2A 同步委派任务
- **「显示所有智能体」** — 列出已知智能体及其档案
- **「设置我的档案：名字 Alice，角色前端工程师」** — 设置所有者身份
- **「添加数据源：React Dashboard 代码库」** — 注册数据源
- **「添加能力：finance」** — 标记本智能体可处理财务相关任务（队友会默认把财务类工作委派给你）
- **「把隧道 URL 设为 https://xxx.trycloudflare.com」** — 用隧道 URL 作为公网地址（跨网）
- **「显示我的 self URL」** — 显示当前 selfUrl 及来源（tunnel / config / tailscale / local）
- **「清除隧道 URL」** — 恢复为配置或本机地址

全部 19 个智能体工具：

| 分类 | 工具 |
|---|---|
| 团队 | `multiclaws_team_create`、`multiclaws_team_join`、`multiclaws_team_members`、`multiclaws_team_leave`、`multiclaws_team_invite` |
| 智能体 | `multiclaws_agents`、`multiclaws_add_agent`、`multiclaws_remove_agent`、`multiclaws_delegate` |
| 档案 | `multiclaws_profile_set`、`multiclaws_profile_add_source`、`multiclaws_profile_remove_source`、`multiclaws_profile_add_capability`、`multiclaws_profile_remove_capability`、`multiclaws_profile_show` |
| 隧道 / selfUrl | `multiclaws_set_tunnel_url`、`multiclaws_clear_tunnel_url`、`multiclaws_show_self_url` |
| 任务 | `multiclaws_task_status` |

---

## 任务委派

### 工作原理

任务委派是**同步**的：委派后调用会阻塞，直到远端智能体执行完毕并返回结果。

流程简述：
1. 你的智能体调用 `multiclaws_delegate(agentUrl, task)`
2. A2A 协议将任务发给远端智能体
3. 远端执行器调用 `sessions_spawn`（run 模式）启动子智能体
4. 执行器轮询 `sessions_history` 直到子智能体完成
5. 最终结果通过 A2A 响应返回
6. 你的智能体收到实际结果（而非仅「已接受」）

### 编排模式

因委派是同步的，AI 可编排复杂多智能体流程：

**扇出（并行）：** 同时委派给多个智能体，汇总结果。

**链式（串行）：** 将上一智能体的输出作为下一智能体的输入。

**迭代：** 若结果不足，可带追问再次委派。

**路由：** 根据档案与数据源将任务委派给最合适的智能体。

**嵌套：** 智能体 A 委派给 B，B 可再委派子任务给 C，完全递归。

编排逻辑由 AI 推理完成，无需预定义工作流。

---

## 智能体档案

每个智能体有档案，包含所有者身份、**能力**（如 "finance"、"frontend" 等领域标签）及可访问数据源，用于帮助 AI 选择委派对象（例如默认把财务相关任务委派给带 "finance" 能力的智能体）。

安装后首次启动会自动用显示名初始化 profile，并在下次与 AI 对话时提示你是否需要调整。首次创建或加入团队时会自动设置档案，AI 会询问你的名字和角色，并自动检测已连接的数据源。

连接新数据源时，档案会自动更新并广播给所有队友。安装插件或配置与某领域相关的 skill（如财务类）时，AI 可添加对应能力，让队友默认把该类工作委派给你。

---

## 故障排除

### 「Agent execution finished without a result」

远端执行器未正确返回结果。请确认：
- 远端节点已拉取并构建最新插件代码（`git pull && npm run build`）
- `gateway.tools.allow` 中**同时**包含 `sessions_spawn` 和 `sessions_history`
- 修改配置后已重启 gateway

### 「fetch failed」/ 连接被拒绝

- 确认远端智能体端口已开放并在监听
- macOS 上检查应用防火墙（见上文防火墙小节）
- 确认 `selfUrl` 使用 IP 地址，而非 `.local` 主机名

### 邀请码无效

- 确认配置中 `selfUrl` 设为对方可访问的 IP
- 从对方机器验证端口可达：`curl http://<ip>:<port>/.well-known/agent-card.json`

### 任务只返回「accepted」而不是实际结果

- 远端节点需在 `gateway.tools.allow` 中包含 `sessions_history`
- 远端需使用带同步执行器的最新代码

---

## 配置说明

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `port` | integer | `3100` | HTTP 监听端口（绑定 `0.0.0.0`） |
| `displayName` | string | 主机名 | 展示给其他智能体的名称 |
| `selfUrl` | string | `http://{hostname}:{port}` | 他人连接你时使用的**可访问 URL**。请尽量使用 IP，不要用主机名。 |
| `preferTailscale` | boolean | `true` | 为 true 时，在可用情况下使用 Tailscale IP 作为 selfUrl（同尾网）。设为 `false` 可关闭。 |
| `telemetry.consoleExporter` | boolean | `false` | 是否在控制台输出 OpenTelemetry spans |

### Gateway 要求

```json
{
  "gateway": {
    "tools": {
      "allow": ["sessions_spawn", "sessions_history"]
    }
  }
}
```

两个工具均为必需：
- `sessions_spawn` — 为收到的委派启动子智能体任务
- `sessions_history` — 轮询子智能体完成结果

状态以 JSON 文件形式保存在插件状态目录（`.../multiclaws/`）下。

---

## 开发

```bash
pnpm install
pnpm run build
pnpm test
```

### 测试

- `test/agent-registry.test.ts` — 智能体注册表 CRUD 与 TTL
- `test/a2a-adapter.test.ts` — A2A 执行器与任务跟踪
- `test/team-store.test.ts` — 团队创建、加入、离开与持久化
- `test/gateway-handlers.validation.test.ts` — gateway 参数校验（zod）

### 架构

完整架构说明、工具说明与行为规则见 [`skills/multiclaws/SKILL.md`](skills/multiclaws/SKILL.md)。
