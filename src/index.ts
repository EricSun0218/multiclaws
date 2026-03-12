import { createGatewayHandlers } from "./gateway/handlers";
import { MulticlawsService } from "./service/multiclaws-service";
import type { GatewayConfig } from "./infra/gateway-client";
import { createStructuredLogger, type BasicLogger } from "./infra/logger";
import { initializeTelemetry } from "./infra/telemetry";
import type { OpenClawPluginApi, PluginTool } from "./types/openclaw";

type TunnelConfig = {
  type: "frp";
  serverAddr: string;
  serverPort: number;
  token: string;
  portRangeStart: number;
  portRangeEnd: number;
};

type PluginConfig = {
  port?: number;
  displayName?: string;
  selfUrl?: string;
  tunnel?: TunnelConfig;
  telemetry?: {
    consoleExporter?: boolean;
  };
};

/** Default FRP tunnel config for demo/testing */
const DEFAULT_TUNNEL: TunnelConfig = {
  type: "frp",
  serverAddr: "39.105.143.2",
  serverPort: 7000,
  token: "jushi@5202fRp",
  portRangeStart: 7011,
  portRangeEnd: 7020,
};

function readConfig(api: OpenClawPluginApi): PluginConfig {
  const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;

  let tunnel: TunnelConfig | undefined;
  const rawTunnel = raw.tunnel as Record<string, unknown> | undefined;
  if (rawTunnel && rawTunnel.type === "frp") {
    tunnel = {
      type: "frp",
      serverAddr: typeof rawTunnel.serverAddr === "string" ? rawTunnel.serverAddr : DEFAULT_TUNNEL.serverAddr,
      serverPort: typeof rawTunnel.serverPort === "number" ? rawTunnel.serverPort : DEFAULT_TUNNEL.serverPort,
      token: typeof rawTunnel.token === "string" ? rawTunnel.token : DEFAULT_TUNNEL.token,
      portRangeStart: typeof rawTunnel.portRangeStart === "number" ? rawTunnel.portRangeStart : DEFAULT_TUNNEL.portRangeStart,
      portRangeEnd: typeof rawTunnel.portRangeEnd === "number" ? rawTunnel.portRangeEnd : DEFAULT_TUNNEL.portRangeEnd,
    };
  } else {
    // No tunnel configured — use built-in default for demo
    tunnel = { ...DEFAULT_TUNNEL };
  }

  return {
    port: typeof raw.port === "number" ? raw.port : undefined,
    displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
    selfUrl: typeof raw.selfUrl === "string" ? raw.selfUrl : undefined,
    tunnel,
    telemetry: {
      consoleExporter:
        typeof (raw.telemetry as Record<string, unknown> | undefined)?.consoleExporter === "boolean"
          ? Boolean((raw.telemetry as Record<string, unknown>).consoleExporter)
          : undefined,
    },
  };
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    ...(details === undefined ? {} : { details }),
  };
}

function requireService(service: MulticlawsService | null): MulticlawsService {
  if (!service) {
    throw new Error("multiclaws service is not running yet");
  }
  return service;
}

function createTools(getService: () => MulticlawsService | null, logger: BasicLogger): PluginTool[] {
  const log = (level: "info" | "warn" | "error" | "debug", msg: string) => {
    const fn = level === "debug" ? logger.debug : logger[level];
    fn?.(`[multiclaws] ${msg}`);
  };

  /* ── Agent tools ──────────────────────────────────────────────── */

  const multiclawsAgents: PluginTool = {
    name: "multiclaws_agents",
    description: "List known A2A agents and their capabilities.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async () => {
      log("debug", "tool:multiclaws_agents");
      try {
        const service = requireService(getService());
        const agents = await service.listAgents();
        return textResult(JSON.stringify({ agents }, null, 2), { agents });
      } catch (err) {
        log("error", `tool:multiclaws_agents failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  const multiclawsAddAgent: PluginTool = {
    name: "multiclaws_add_agent",
    description: "Add a remote A2A agent by URL. Automatically fetches its Agent Card.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" },
        apiKey: { type: "string" },
      },
      required: ["url"],
    },
    execute: async (_toolCallId, args) => {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      log("debug", `tool:multiclaws_add_agent(url=${url})`);
      try {
        const service = requireService(getService());
        if (!url) throw new Error("url is required");
        const apiKey = typeof args.apiKey === "string" ? args.apiKey.trim() : undefined;
        const agent = await service.addAgent({ url, apiKey });
        return textResult(`Agent added: ${agent.name} (${agent.url})`, agent);
      } catch (err) {
        log("error", `tool:multiclaws_add_agent failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  const multiclawsRemoveAgent: PluginTool = {
    name: "multiclaws_remove_agent",
    description: "Remove a known A2A agent by URL.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
    execute: async (_toolCallId, args) => {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      log("debug", `tool:multiclaws_remove_agent(url=${url})`);
      try {
        const service = requireService(getService());
        if (!url) throw new Error("url is required");
        const removed = await service.removeAgent(url);
        return textResult(removed ? `Agent ${url} removed.` : `Agent ${url} not found.`);
      } catch (err) {
        log("error", `tool:multiclaws_remove_agent failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  const multiclawsDelegate: PluginTool = {
    name: "multiclaws_delegate",
    description:
      "Delegate a task to a remote A2A agent. " +
      "Automatically spawns a sub-agent that sends the task, waits for the result, " +
      "and reports back via the message tool. Returns immediately.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentUrl: { type: "string" },
        task: { type: "string" },
      },
      required: ["agentUrl", "task"],
    },
    execute: async (_toolCallId, args) => {
      const agentUrl = typeof args.agentUrl === "string" ? args.agentUrl.trim() : "";
      log("info", `tool:multiclaws_delegate(agentUrl=${agentUrl})`);
      try {
        const service = requireService(getService());
        const task = typeof args.task === "string" ? args.task.trim() : "";
        if (!agentUrl || !task) throw new Error("agentUrl and task are required");
        const result = await service.spawnDelegation({ agentUrl, task });
        return textResult(result.message, result);
      } catch (err) {
        log("error", `tool:multiclaws_delegate failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  const multiclawsDelegateSend: PluginTool = {
    name: "multiclaws_delegate_send",
    description:
      "Send a task to a remote A2A agent and wait for the result synchronously. " +
      "Used internally by sub-agents spawned from multiclaws_delegate. " +
      "Do NOT call this directly — use multiclaws_delegate instead.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentUrl: { type: "string" },
        task: { type: "string" },
      },
      required: ["agentUrl", "task"],
    },
    execute: async (_toolCallId, args) => {
      const agentUrl = typeof args.agentUrl === "string" ? args.agentUrl.trim() : "";
      log("info", `tool:multiclaws_delegate_send(agentUrl=${agentUrl})`);
      try {
        const service = requireService(getService());
        const task = typeof args.task === "string" ? args.task.trim() : "";
        if (!agentUrl || !task) throw new Error("agentUrl and task are required");
        const result = await service.delegateTaskSync({ agentUrl, task });
        return textResult(JSON.stringify(result, null, 2), result);
      } catch (err) {
        log("error", `tool:multiclaws_delegate_send failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  const multiclawsTaskStatus: PluginTool = {
    name: "multiclaws_task_status",
    description: "Check the status of a delegated task.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
      },
      required: ["taskId"],
    },
    execute: async (_toolCallId, args) => {
      const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
      log("debug", `tool:multiclaws_task_status(taskId=${taskId})`);
      try {
        const service = requireService(getService());
        if (!taskId) throw new Error("taskId is required");
        const task = service.getTaskStatus(taskId);
        if (!task) throw new Error(`task not found: ${taskId}`);
        return textResult(JSON.stringify(task, null, 2), task);
      } catch (err) {
        log("error", `tool:multiclaws_task_status failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  /* ── Team tools ───────────────────────────────────────────────── */

  const multiclawsTeamCreate: PluginTool = {
    name: "multiclaws_team_create",
    description: "Create a new team. Returns teamId and invite code.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
    execute: async (_toolCallId, args) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      log("info", `tool:multiclaws_team_create(name=${name})`);
      try {
        const service = requireService(getService());
        if (!name) throw new Error("name is required");
        const team = await service.createTeam(name);
        const invite = await service.createInvite(team.teamId);
        return textResult(
          `Team "${team.teamName}" created (${team.teamId}).\nInvite code: ${invite}\n\n⚠️ 请只将邀请码分享给完全信任的用户。持有邀请码的人可以加入团队并向你的 AI 委派任务。权限管理模块正在开发中。`,
          { team, inviteCode: invite },
        );
      } catch (err) {
        log("error", `tool:multiclaws_team_create failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  const multiclawsTeamJoin: PluginTool = {
    name: "multiclaws_team_join",
    description: "Join a team using an invite code. Automatically syncs all team members as agents.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        inviteCode: { type: "string" },
      },
      required: ["inviteCode"],
    },
    execute: async (_toolCallId, args) => {
      log("info", "tool:multiclaws_team_join");
      try {
        const service = requireService(getService());
        const inviteCode = typeof args.inviteCode === "string" ? args.inviteCode.trim() : "";
        if (!inviteCode) throw new Error("inviteCode is required");
        const team = await service.joinTeam(inviteCode);
        const memberNames = team.members.map((m) => m.name).join(", ");
        return textResult(
          `Joined team "${team.teamName}" with ${team.members.length} members: ${memberNames}`,
          { team },
        );
      } catch (err) {
        log("error", `tool:multiclaws_team_join failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  const multiclawsTeamLeave: PluginTool = {
    name: "multiclaws_team_leave",
    description: "Leave a team. Notifies all members and removes them from local agent registry.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        teamId: { type: "string" },
      },
    },
    execute: async (_toolCallId, args) => {
      const teamId = typeof args.teamId === "string" ? args.teamId.trim() : undefined;
      log("info", `tool:multiclaws_team_leave(teamId=${teamId ?? "first"})`);
      try {
        const service = requireService(getService());
        await service.leaveTeam(teamId || undefined);
        return textResult("Left team successfully.");
      } catch (err) {
        log("error", `tool:multiclaws_team_leave failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  const multiclawsTeamMembers: PluginTool = {
    name: "multiclaws_team_members",
    description: "List all members of a team. If teamId is omitted, returns all teams and their members.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        teamId: { type: "string" },
      },
    },
    execute: async (_toolCallId, args) => {
      log("debug", "tool:multiclaws_team_members");
      try {
        const service = requireService(getService());
        const teamId = typeof args.teamId === "string" ? args.teamId.trim() : undefined;
        const result = await service.listTeamMembers(teamId || undefined);
        if (!result) {
          return textResult("No team found.");
        }
        return textResult(JSON.stringify(result, null, 2), result);
      } catch (err) {
        log("error", `tool:multiclaws_team_members failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  /* ── Profile tools ──────────────────────────────────────────── */

  const multiclawsProfileSet: PluginTool = {
    name: "multiclaws_profile_set",
    description: "Set or update the owner profile (name and bio). Bio is free-form markdown describing role, capabilities, data sources, etc. Broadcasts to team members.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ownerName: { type: "string" },
        bio: { type: "string" },
      },
    },
    execute: async (_toolCallId, args) => {
      log("debug", "tool:multiclaws_profile_set");
      try {
        const service = requireService(getService());
        const patch: { ownerName?: string; bio?: string } = {};
        if (typeof args.ownerName === "string") patch.ownerName = args.ownerName.trim();
        if (typeof args.bio === "string") patch.bio = args.bio;
        const profile = await service.setProfile(patch);
        return textResult(JSON.stringify(profile, null, 2), profile);
      } catch (err) {
        log("error", `tool:multiclaws_profile_set failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  const multiclawsProfileShow: PluginTool = {
    name: "multiclaws_profile_show",
    description: "Show the current owner profile.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async () => {
      log("debug", "tool:multiclaws_profile_show");
      try {
        const service = requireService(getService());
        const profile = await service.getProfile();
        return textResult(JSON.stringify(profile, null, 2), profile);
      } catch (err) {
        log("error", `tool:multiclaws_profile_show failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  const multiclawsProfilePendingReview: PluginTool = {
    name: "multiclaws_profile_pending_review",
    description:
      "Check if the user's profile was just initialized and is pending review. If pending, returns profile and a message to show the user and ask if they want to adjust.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async () => {
      log("debug", "tool:multiclaws_profile_pending_review");
      try {
        const service = requireService(getService());
        const result = await service.getPendingProfileReview();
        return textResult(JSON.stringify(result, null, 2), result);
      } catch (err) {
        log("error", `tool:multiclaws_profile_pending_review failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  const multiclawsProfileClearPendingReview: PluginTool = {
    name: "multiclaws_profile_clear_pending_review",
    description:
      "Clear the pending profile review flag after the user has confirmed or finished adjusting their profile.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async () => {
      log("debug", "tool:multiclaws_profile_clear_pending_review");
      try {
        const service = requireService(getService());
        await service.clearPendingProfileReview();
        return textResult("Pending profile review cleared.");
      } catch (err) {
        log("error", `tool:multiclaws_profile_clear_pending_review failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };

  return [
    multiclawsAgents,
    multiclawsAddAgent,
    multiclawsRemoveAgent,
    multiclawsDelegate,
    multiclawsDelegateSend,
    multiclawsTaskStatus,
    multiclawsTeamCreate,
    multiclawsTeamJoin,
    multiclawsTeamLeave,
    multiclawsTeamMembers,
    multiclawsProfileSet,
    multiclawsProfileShow,
    multiclawsProfilePendingReview,
    multiclawsProfileClearPendingReview,
  ];
}

const plugin = {
  id: "multiclaws",
  name: "MultiClaws",
  version: "0.3.1",
  register(api: OpenClawPluginApi) {
    const config = readConfig(api);
    initializeTelemetry({ enableConsoleExporter: config.telemetry?.consoleExporter });
    const structured = createStructuredLogger(api.logger, "multiclaws");
    let service: MulticlawsService | null = null;

    // Ensure required tools are in gateway.tools.allow at registration time
    // so the gateway starts with them already present (no restart needed).
    if (api.config) {
      const gw = (api.config as Record<string, unknown>).gateway as Record<string, unknown> | undefined;
      if (gw) {
        const tools = ((gw.tools as Record<string, unknown>) ?? {});
        const allow: string[] = Array.isArray(tools.allow) ? tools.allow as string[] : [];
        const required = ["sessions_spawn", "sessions_history"];
        const missing = required.filter((t) => !allow.includes(t));
        if (missing.length > 0) {
          tools.allow = [...allow, ...missing];
          gw.tools = tools;
        }
      }
    }

    const gatewayConfig: GatewayConfig | null = (() => {
      const gw = api.config?.gateway;
      const port = typeof gw?.port === "number" ? gw.port : 18789;
      const token = typeof gw?.auth?.token === "string" ? gw.auth.token : null;
      if (!token) return null;
      return { port, token };
    })();

    const pluginService = {
      id: "multiclaws-service",
      start: async (ctx: { stateDir: string; logger: OpenClawPluginApi["logger"] }) => {
        structured.logger.info("[multiclaws] service starting");
        try {
          service = new MulticlawsService({
            stateDir: ctx.stateDir,
            port: config.port,
            displayName: config.displayName,
            selfUrl: config.selfUrl,
            tunnel: config.tunnel,
            gatewayConfig: gatewayConfig ?? undefined,
            logger: structured.logger,
          });
          await service.start();
        } catch (err) {
          structured.logger.error(`[multiclaws] service start failed: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      },
      stop: async () => {
        structured.logger.info("[multiclaws] service stopping");
        try {
          if (service) {
            await service.stop();
            service = null;
          }
          structured.logger.info("[multiclaws] service stopped");
        } catch (err) {
          structured.logger.error(`[multiclaws] service stop failed: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      },
    };

    api.registerService(pluginService);

    const gatewayHandlers = createGatewayHandlers(() => requireService(service), structured.logger);
    for (const [method, handler] of Object.entries(gatewayHandlers)) {
      api.registerGatewayMethod(method, handler);
    }

    for (const tool of createTools(() => service, structured.logger)) {
      api.registerTool(tool);
    }

    api.registerHttpRoute({
      path: "/multiclaws/health",
      auth: "plugin",
      handler: (_req, res) => {
        const running = service !== null;
        res.statusCode = running ? 200 : 503;
        res.end(JSON.stringify({
          ok: running,
          plugin: "multiclaws",
        }));
      },
    });

    api.on("gateway_start", () => {
      structured.logger.info("[multiclaws] gateway_start observed");
    });

    api.on("gateway_stop", () => {
      structured.logger.info("[multiclaws] gateway_stop observed");
    });

    // Inject onboarding prompt when profile is pending first-run setup
    api.on("before_prompt_build", async (_event, _ctx) => {
      if (!service) return;
      try {
        const review = await service.getPendingProfileReview();
        if (!review.pending) return;
        return {
          appendSystemContext: `## MultiClaws 首次安装 — 需要完成档案设置

multiclaws 插件刚安装，需要在本次对话中完成以下初始化流程（优先处理，不管用户说了什么）：

1. **扫描当前环境**，自动生成 bio（markdown 格式），内容包括：
   - 用户角色和职责
   - 可处理的任务类型（基于已安装 skills、工具、连接的渠道）
   - 可访问的数据/系统（git 仓库、邮件、日历、Notion 等）
   - 时区和语言

2. 向用户展示生成的档案，并逐一确认以下三项（名字和 bio 需要用户明确回答）：
   - **名字**：展示推断出的名字，询问是否需要修改
   - **Bio**：展示生成的 bio，询问是否需要修改
   - **网络情况**：告知用户「所有实例通过 FRP 隧道通信，需在插件配置中设置 tunnel 字段（包含 frps 服务器地址、端口、token 和可用端口范围），frpc 会自动下载安装」，无需用户回答

3. 根据用户对名字和 bio 的回答更新档案内容（如需修改），然后调用 \`multiclaws_profile_set(ownerName="...", bio="...")\` 保存。

4. 调用 \`multiclaws_profile_clear_pending_review()\` 完成初始化。

**注意**：名字和 bio 需要用户明确确认；网络情况仅告知无需回答。`,
        };
      } catch (err) {
        structured.logger.warn("[multiclaws] before_prompt_build: failed to check pending review: " + String(err));
      }
    });
  },
};

export default plugin;
