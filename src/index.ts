import { createGatewayHandlers } from "./gateway/handlers";
import { MulticlawsService } from "./service/multiclaws-service";
import type { GatewayConfig } from "./infra/gateway-client";
import { invokeGatewayTool } from "./infra/gateway-client";
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
      const service = requireService(getService());
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw new Error("url is required");
      const apiKey = typeof args.apiKey === "string" ? args.apiKey.trim() : undefined;
      const agent = await service.addAgent({ url, apiKey });
      return textResult(`Agent added: ${agent.name} (${agent.url})`, agent);
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

  const multiclawsDelegate: PluginTool = {
    name: "multiclaws_delegate",
    description: "Delegate a task to a remote A2A agent.",
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
      const service = requireService(getService());
      const agentUrl = typeof args.agentUrl === "string" ? args.agentUrl.trim() : "";
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!agentUrl || !task) throw new Error("agentUrl and task are required");
      const result = await service.delegateTask({ agentUrl, task });
      return textResult(JSON.stringify(result, null, 2), result);
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
      const service = requireService(getService());
      const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
      if (!taskId) throw new Error("taskId is required");
      const task = service.getTaskStatus(taskId);
      if (!task) throw new Error(`task not found: ${taskId}`);
      return textResult(JSON.stringify(task, null, 2), task);
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
        `Team "${team.teamName}" created (${team.teamId}).\nInvite code: ${invite}`,
        { team, inviteCode: invite },
      );
    },
  };

  const multiclawsTeamInvite: PluginTool = {
    name: "multiclaws_team_invite",
    description: "Generate an invite code for a team. Other agents can use this code to join.",
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
      const invite = await service.createInvite(teamId || undefined);
      return textResult(`Invite code: ${invite}`, { inviteCode: invite });
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
    description: "List all members of a team.",
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
    multiclawsAddAgent,
    multiclawsRemoveAgent,
    multiclawsDelegate,
    multiclawsTaskStatus,
    multiclawsTeamCreate,
    multiclawsTeamInvite,
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
  version: "0.3.0",
  register(api: OpenClawPluginApi) {
    const config = readConfig(api);
    initializeTelemetry({ enableConsoleExporter: config.telemetry?.consoleExporter });
    const structured = createStructuredLogger(api.logger, "multiclaws");
    let service: MulticlawsService | null = null;

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

    api.on("gateway_start", async () => {
      structured.logger.info("[multiclaws] gateway_start observed");

      // On first run: spawn a subagent to generate bio and notify user
      if (!service || !gatewayConfig) return;
      try {
        const pending = await service.getPendingProfileReview();
        if (!pending.pending) return;

        const profile = pending.profile;
        const ownerName = profile?.ownerName || "unknown";

        const task = [
          `You are initializing a MultiClaws agent profile for "${ownerName}" on first run.`,
          `MultiClaws enables multiple OpenClaw instances to collaborate as a team over A2A protocol.`,
          ``,
          `Complete all steps below, then send ONE message to the user summarizing everything.`,
          ``,
          `== STEP 1: Generate bio ==`,
          `Inspect the current environment:`,
          `- Available tools and skills (implies capabilities)`,
          `- Connected channels (Telegram, Gmail, Discord, etc.)`,
          `- Workspace contents (git repos, project folders, key files)`,
          `- Installed plugins`,
          `- Timezone and language`,
          ``,
          `Generate a bio in markdown — a "skill card" that other AI agents read to decide`,
          `whether to delegate tasks here. Include:`,
          `- One-line role description`,
          `- What this agent can handle`,
          `- What data/systems it has access to`,
          `- Timezone / language`,
          ``,
          `Call: multiclaws_profile_set(ownerName="${ownerName}", bio="<generated markdown>")`,
          ``,
          `== STEP 2: Check Tailscale ==`,
          `Call multiclaws_show_self_url() to get the current selfUrl and its source.`,
          `- If source is "tailscale": cross-network collaboration is ready, nothing needed.`,
          `- If source is "local" or "config" with a LAN IP (192.168.x.x / 10.x.x.x):`,
          `  LAN collaboration works, but cross-network requires Tailscale or a tunnel.`,
          ``,
          `== STEP 3: Send ONE confirmation message ==`,
          `Send a single friendly message to the user containing:`,
          ``,
          `1. **Name confirmation**: "Your name is set to '${ownerName}'. Is this correct?"`,
          `   (Mention they can change it anytime)`,
          ``,
          `2. **Bio preview**: Show the generated bio and ask if they want to adjust anything.`,
          ``,
          `3. **Network status** (one line based on Step 2):`,
          `   - Tailscale ready: "✅ Tailscale detected — cross-network collaboration is ready."`,
          `   - LAN only: "🌐 Running on LAN (${ownerName}'s local network). For cross-network collaboration, install Tailscale or run: npx cloudflared tunnel --url http://localhost:3100"`,
          ``,
          `Keep the message concise. The user just needs to confirm or adjust — don't overwhelm them.`,
        ].join("\n");

        await invokeGatewayTool({
          gateway: gatewayConfig,
          tool: "sessions_spawn",
          args: { task, mode: "run" },
          timeoutMs: 30_000,
        });
      } catch (err) {
        structured.logger.warn(`[multiclaws] bio init task failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    api.on("gateway_stop", () => {
      structured.logger.info("[multiclaws] gateway_stop observed");
    });
  },
};

export default plugin;
