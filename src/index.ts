import { createGatewayHandlers } from "./gateway/handlers";
import { MulticlawsService } from "./service/multiclaws-service";
import type { GatewayConfig } from "./infra/gateway-client";
import { createStructuredLogger } from "./infra/logger";
import { initializeTelemetry } from "./infra/telemetry";
import type { OpenClawPluginApi, PluginTool } from "./types/openclaw";

type PluginConfig = {
  port?: number;
  displayName?: string;
  selfUrl?: string;
  telemetry?: {
    consoleExporter?: boolean;
  };
};

function readConfig(api: OpenClawPluginApi): PluginConfig {
  const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
  return {
    port: typeof raw.port === "number" ? raw.port : undefined,
    displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
    selfUrl: typeof raw.selfUrl === "string" ? raw.selfUrl : undefined,
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

function createTools(getService: () => MulticlawsService | null): PluginTool[] {
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
      const service = requireService(getService());
      const agents = await service.listAgents();
      return textResult(JSON.stringify({ agents }, null, 2), { agents });
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
      const service = requireService(getService());
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw new Error("url is required");
      const removed = await service.removeAgent(url);
      return textResult(removed ? `Agent ${url} removed.` : `Agent ${url} not found.`);
    },
  };

  /* ── Session tools (multi-turn collaboration) ─────────────────── */

  const multiclawsSessionStart: PluginTool = {
    name: "multiclaws_session_start",
    description: "Start a multi-turn collaboration session with a remote agent. Sends the first message and returns immediately with a sessionId (async). The agent's response will be pushed as a message when ready. Covers both single-turn and multi-turn use cases.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentUrl: { type: "string" },
        message: { type: "string" },
      },
      required: ["agentUrl", "message"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const agentUrl = typeof args.agentUrl === "string" ? args.agentUrl.trim() : "";
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!agentUrl || !message) throw new Error("agentUrl and message are required");
      const result = await service.startSession({ agentUrl, message });
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };

  const multiclawsSessionReply: PluginTool = {
    name: "multiclaws_session_reply",
    description: "Send a follow-up message in an existing collaboration session. Use when the remote agent returns 'input-required' or to continue a multi-turn conversation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string" },
        message: { type: "string" },
      },
      required: ["sessionId", "message"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!sessionId || !message) throw new Error("sessionId and message are required");
      const result = await service.sendSessionMessage({ sessionId, message });
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };

  const multiclawsSessionStatus: PluginTool = {
    name: "multiclaws_session_status",
    description: "Get the status and message history of a collaboration session. If sessionId is omitted, lists all sessions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string" },
      },
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (sessionId) {
        const session = service.getSession(sessionId);
        if (!session) throw new Error(`session not found: ${sessionId}`);
        return textResult(JSON.stringify(session, null, 2), session);
      }
      const sessions = service.listSessions();
      return textResult(JSON.stringify({ sessions }, null, 2), { sessions });
    },
  };

  const multiclawsSessionWaitAll: PluginTool = {
    name: "multiclaws_session_wait_all",
    description: "Wait for multiple sessions to complete, then return all results at once. Use this when you have started multiple sessions concurrently and need all results before synthesizing an answer. Returns early if any session needs input (input-required). Default timeout: 5 minutes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionIds: { type: "array", items: { type: "string" } },
        timeoutMs: { type: "number" },
      },
      required: ["sessionIds"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const sessionIds = Array.isArray(args.sessionIds)
        ? (args.sessionIds as string[]).map((s) => String(s).trim()).filter(Boolean)
        : [];
      if (!sessionIds.length) throw new Error("sessionIds must be a non-empty array");
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
      const result = await service.waitForSessions({ sessionIds, timeoutMs });
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };

  const multiclawsSessionEnd: PluginTool = {
    name: "multiclaws_session_end",
    description: "Cancel and close a collaboration session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) throw new Error("sessionId is required");
      const ok = service.endSession(sessionId);
      return textResult(ok ? `Session ${sessionId} ended.` : `Session ${sessionId} not found.`);
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
      const service = requireService(getService());
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) throw new Error("name is required");
      const team = await service.createTeam(name);
      const invite = await service.createInvite(team.teamId);
      return textResult(
        `Team "${team.teamName}" created (${team.teamId}).\nInvite code: ${invite}\n\n⚠️ 请只将邀请码分享给完全信任的用户。持有邀请码的人可以加入团队并向你的 AI 委派任务。权限管理模块正在开发中。`,
        { team, inviteCode: invite },
      );
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
      const service = requireService(getService());
      const inviteCode = typeof args.inviteCode === "string" ? args.inviteCode.trim() : "";
      if (!inviteCode) throw new Error("inviteCode is required");
      const team = await service.joinTeam(inviteCode);
      const memberNames = team.members.map((m) => m.name).join(", ");
      return textResult(
        `Joined team "${team.teamName}" with ${team.members.length} members: ${memberNames}`,
        { team },
      );
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
      const service = requireService(getService());
      const teamId = typeof args.teamId === "string" ? args.teamId.trim() : undefined;
      await service.leaveTeam(teamId || undefined);
      return textResult("Left team successfully.");
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
      const service = requireService(getService());
      const teamId = typeof args.teamId === "string" ? args.teamId.trim() : undefined;
      const result = await service.listTeamMembers(teamId || undefined);
      if (!result) {
        return textResult("No team found.");
      }
      return textResult(JSON.stringify(result, null, 2), result);
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
      const service = requireService(getService());
      const patch: { ownerName?: string; bio?: string } = {};
      if (typeof args.ownerName === "string") patch.ownerName = args.ownerName.trim();
      if (typeof args.bio === "string") patch.bio = args.bio;
      const profile = await service.setProfile(patch);
      return textResult(JSON.stringify(profile, null, 2), profile);
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
      const service = requireService(getService());
      const profile = await service.getProfile();
      return textResult(JSON.stringify(profile, null, 2), profile);
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
      const service = requireService(getService());
      const result = await service.getPendingProfileReview();
      return textResult(JSON.stringify(result, null, 2), result);
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
      const service = requireService(getService());
      await service.clearPendingProfileReview();
      return textResult("Pending profile review cleared.");
    },
  };

  return [
    multiclawsAgents,
    multiclawsRemoveAgent,
    multiclawsSessionStart,
    multiclawsSessionReply,
    multiclawsSessionStatus,
    multiclawsSessionWaitAll,
    multiclawsSessionEnd,
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
  version: "0.4.2",
  register(api: OpenClawPluginApi) {
    const config = readConfig(api);
    initializeTelemetry({ enableConsoleExporter: config.telemetry?.consoleExporter });
    const structured = createStructuredLogger(api.logger, "multiclaws");
    let service: MulticlawsService | null = null;

    // Ensure plugin tools and gateway dependencies are whitelisted at registration time.
    // tools.alsoAllow is additive and won't override the user's tools.profile setting.
    if (api.config) {
      const gw = (api.config as Record<string, unknown>).gateway as Record<string, unknown> | undefined;
      if (gw) {
        const tools = ((gw.tools as Record<string, unknown>) ?? {});

        // 1. Gateway tools the plugin depends on → tools.allow
        const allow: string[] = Array.isArray(tools.allow) ? tools.allow as string[] : [];
        const requiredGatewayTools = ["sessions_spawn", "sessions_history", "message"];
        const missingGateway = requiredGatewayTools.filter((t) => !allow.includes(t));
        if (missingGateway.length > 0) {
          tools.allow = [...allow, ...missingGateway];
        }

        // 2. Plugin's own tools → tools.alsoAllow (additive, works with any profile)
        const alsoAllow: string[] = Array.isArray(tools.alsoAllow) ? tools.alsoAllow as string[] : [];
        const pluginToolNames = [
          "multiclaws_agents", "multiclaws_remove_agent",
          "multiclaws_session_start", "multiclaws_session_reply", "multiclaws_session_status",
          "multiclaws_session_wait_all", "multiclaws_session_end",
          "multiclaws_team_create", "multiclaws_team_join", "multiclaws_team_leave", "multiclaws_team_members",
          "multiclaws_profile_set", "multiclaws_profile_show",
          "multiclaws_profile_pending_review", "multiclaws_profile_clear_pending_review",
        ];
        const missingPlugin = pluginToolNames.filter((t) => !alsoAllow.includes(t));
        if (missingPlugin.length > 0) {
          tools.alsoAllow = [...alsoAllow, ...missingPlugin];
        }

        gw.tools = tools;
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
        service = new MulticlawsService({
          stateDir: ctx.stateDir,
          port: config.port,
          displayName: config.displayName,
          selfUrl: config.selfUrl,
          gatewayConfig: gatewayConfig ?? undefined,
          logger: structured.logger,
        });
        await service.start();
      },
      stop: async () => {
        if (service) {
          await service.stop();
          service = null;
        }
      },
    };

    api.registerService(pluginService);

    const gatewayHandlers = createGatewayHandlers(() => requireService(service));
    for (const [method, handler] of Object.entries(gatewayHandlers)) {
      api.registerGatewayMethod(method, handler);
    }

    for (const tool of createTools(() => service)) {
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
      // Re-read gateway config in case token became available after initial registration
      if (service && !gatewayConfig) {
        const gw = api.config?.gateway;
        const port = typeof gw?.port === "number" ? gw.port : 18789;
        const token = typeof gw?.auth?.token === "string" ? gw.auth.token : null;
        if (token) {
          const newConfig = { port, token };
          service.updateGatewayConfig(newConfig);
          structured.logger.info("[multiclaws] gateway config updated from gateway_start event");
        }
      }
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

multiclaws 插件刚安装，需要在本次对话中完成以下初始化流程（优先处理，不管用户说了什么）。
**务必使用插件工具调用，不要通过命令行或 gateway 方法操作。**

1. **扫描当前环境**，自动生成 bio（markdown 格式），内容包括：
   - 用户角色和职责
   - 可处理的任务类型（基于已安装 skills、工具、连接的渠道）
   - 可访问的数据/系统（git 仓库、邮件、日历、Notion 等）
   - 时区和语言

2. 向用户展示生成的档案，并逐一确认以下三项（名字和 bio 需要用户明确回答）：
   - **名字**：展示推断出的名字，询问是否需要修改
   - **Bio**：展示生成的 bio，询问是否需要修改
   - **网络情况**：告知用户「同局域网开箱即用；跨网络需安装 Tailscale（https://tailscale.com/download）并重启 OpenClaw」，无需用户回答

3. 根据用户确认的内容，调用 \`multiclaws_profile_set(ownerName="...", bio="...")\` 保存。保存后初始化自动完成，无需额外操作。

**注意**：名字和 bio 需要用户明确确认；网络情况仅告知无需回答。`,
        };
      } catch (err) {
        structured.logger.warn("[multiclaws] before_prompt_build: failed to check pending review: " + String(err));
      }
    });
  },
};

export default plugin;
