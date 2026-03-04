import { createGatewayHandlers } from "./gateway/handlers";
import {
  ApprovalRouteStore,
  routeFromInbound,
  sendChannelText,
} from "./messaging/channel-prompt";
import { MulticlawsService } from "./service/multiclaws-service";
import type { LocalMemorySearchResult } from "./utils/gateway-client";
import type { TaskExecutionResult } from "./task/delegation";
import {
  invokeGatewayTool,
  parseMemorySearchResult,
  parseSpawnTaskResult,
  type GatewayConfig,
} from "./utils/gateway-client";
import type { OpenClawPluginApi, PluginTool } from "./types/openclaw";

type PluginConfig = {
  port?: number;
  displayName?: string;
  localAddress?: string;
  knownPeers?: Array<{ peerId?: string; displayName?: string; address: string; publicKey?: string }>;
};

function readConfig(api: OpenClawPluginApi): PluginConfig {
  const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const knownPeers = Array.isArray(raw.knownPeers)
    ? raw.knownPeers
        .map((entry) => {
          const value = entry as Record<string, unknown>;
          if (typeof value.address !== "string" || !value.address.trim()) {
            return null;
          }
          return {
            address: value.address.trim(),
            peerId: typeof value.peerId === "string" ? value.peerId.trim() : undefined,
            displayName:
              typeof value.displayName === "string" ? value.displayName.trim() : undefined,
            publicKey: typeof value.publicKey === "string" ? value.publicKey.trim() : undefined,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : undefined;

  return {
    port: typeof raw.port === "number" ? raw.port : undefined,
    displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
    localAddress: typeof raw.localAddress === "string" ? raw.localAddress : undefined,
    knownPeers,
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

function createTools(getService: () => MulticlawsService | null, config: PluginConfig): PluginTool[] {
  const multiclawsPeers: PluginTool = {
    name: "multiclaws_peers",
    description: "List available MultiClaws peers and their status.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async () => {
      const service = requireService(getService());
      const peers = await service.listPeers();
      return textResult(JSON.stringify({ peers }, null, 2), { peers });
    },
  };

  const multiclawsMessage: PluginTool = {
    name: "multiclaws_message",
    description: "Send a direct message to a MultiClaws peer.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        peer: { type: "string" },
        message: { type: "string" },
      },
      required: ["peer", "message"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const peerName = typeof args.peer === "string" ? args.peer.trim() : "";
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!peerName || !message) {
        throw new Error("peer and message are required");
      }
      const peer = await service.resolvePeer(peerName);
      if (!peer) {
        throw new Error(`unknown peer: ${peerName}`);
      }
      await service.sendDirectMessage({ peerId: peer.peerId, text: message });
      return textResult(`Message sent to ${peer.displayName} (${peer.peerId}).`);
    },
  };

  const multiclawsSearch: PluginTool = {
    name: "multiclaws_search",
    description: "Search memory from one or more MultiClaws peers.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        peer: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["query"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        throw new Error("query is required");
      }
      const maxResults =
        typeof args.maxResults === "number" && Number.isFinite(args.maxResults)
          ? Math.max(1, Math.min(Math.floor(args.maxResults), 20))
          : 5;

      const requestedPeer = typeof args.peer === "string" ? args.peer.trim() : "";
      const peers = requestedPeer
        ? [await service.resolvePeer(requestedPeer)].filter(
            (entry): entry is NonNullable<typeof entry> => Boolean(entry),
          )
        : (await service.listPeers()).filter((entry) => entry.connected);

      if (peers.length === 0) {
        return textResult("No available MultiClaws peers.");
      }

      const results: Array<{ peerId: string; displayName: string; result?: unknown; error?: string }> = [];
      for (const peer of peers) {
        try {
          const result = await service.multiclawsMemorySearch({
            peerId: peer.peerId,
            query,
            maxResults,
          });
          results.push({ peerId: peer.peerId, displayName: peer.displayName, result });
        } catch (error) {
          results.push({
            peerId: peer.peerId,
            displayName: peer.displayName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return textResult(JSON.stringify({ query, results }, null, 2), { query, results });
    },
  };

  const multiclawsDelegate: PluginTool = {
    name: "multiclaws_delegate",
    description: "Delegate a task to a MultiClaws peer.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        peer: { type: "string" },
        task: { type: "string" },
        context: { type: "string" },
      },
      required: ["peer", "task"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const peerName = typeof args.peer === "string" ? args.peer.trim() : "";
      const task = typeof args.task === "string" ? args.task.trim() : "";
      const context = typeof args.context === "string" ? args.context.trim() : undefined;
      if (!peerName || !task) {
        throw new Error("peer and task are required");
      }
      const peer = await service.resolvePeer(peerName);
      if (!peer) {
        throw new Error(`unknown peer: ${peerName}`);
      }
      const result = await service.delegateTask({
        peerId: peer.peerId,
        task,
        context,
      });
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };

  // --- Team management tools ---

  const multiclawsTeamCreate: PluginTool = {
    name: "multiclaws_team_create",
    description: "Create a new MultiClaws team and generate an invite code for others to join.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        teamName: { type: "string" },
        localAddress: { type: "string" },
      },
      required: ["teamName"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const teamName = typeof args.teamName === "string" ? args.teamName.trim() : "";
      if (!teamName) throw new Error("teamName is required");
      const localAddress =
        (typeof args.localAddress === "string" ? args.localAddress.trim() : "") ||
        config.localAddress;
      if (!localAddress) {
        throw new Error(
          "localAddress is required — either set it in plugin config or pass it as a parameter",
        );
      }
      const result = await service.createTeam({ teamName, localAddress });
      return textResult(
        `Team "${result.teamName}" created.\nInvite code: ${result.inviteCode}\n\nShare this code with others. It expires in 7 days.`,
        result,
      );
    },
  };

  const multiclawsTeamJoin: PluginTool = {
    name: "multiclaws_team_join",
    description: "Join an existing MultiClaws team using an invite code.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        inviteCode: { type: "string" },
        localAddress: { type: "string" },
      },
      required: ["inviteCode"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const inviteCode = typeof args.inviteCode === "string" ? args.inviteCode.trim() : "";
      if (!inviteCode) throw new Error("inviteCode is required");
      const localAddress =
        (typeof args.localAddress === "string" ? args.localAddress.trim() : "") ||
        config.localAddress;
      if (!localAddress) {
        throw new Error(
          "localAddress is required — either set it in plugin config or pass it as a parameter",
        );
      }
      const result = await service.joinTeam({ inviteCode, localAddress });
      return textResult(
        `Joined team "${result.teamName}" (owner: ${result.ownerPeerId}). Connection established.`,
        result,
      );
    },
  };

  const multiclawsTeamMembers: PluginTool = {
    name: "multiclaws_team_members",
    description: "List members of a MultiClaws team.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        teamId: { type: "string" },
      },
      required: ["teamId"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const teamId = typeof args.teamId === "string" ? args.teamId.trim() : "";
      if (!teamId) throw new Error("teamId is required");
      const members = await service.listTeamMembers(teamId);
      return textResult(JSON.stringify({ teamId, members }, null, 2), { teamId, members });
    },
  };

  const multiclawsTeamLeave: PluginTool = {
    name: "multiclaws_team_leave",
    description: "Leave a MultiClaws team.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        teamId: { type: "string" },
      },
      required: ["teamId"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const teamId = typeof args.teamId === "string" ? args.teamId.trim() : "";
      if (!teamId) throw new Error("teamId is required");
      await service.leaveTeam(teamId);
      return textResult(`Left team ${teamId}.`);
    },
  };

  // --- Peer management tools ---

  const multiclawsPeerAdd: PluginTool = {
    name: "multiclaws_peer_add",
    description: "Manually add a MultiClaws peer by WebSocket address.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        address: { type: "string" },
        displayName: { type: "string" },
      },
      required: ["address"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const address = typeof args.address === "string" ? args.address.trim() : "";
      if (!address) throw new Error("address is required");
      const displayName = typeof args.displayName === "string" ? args.displayName.trim() : undefined;
      const peer = await service.addPeer({ address, displayName });
      return textResult(
        `Peer added: ${peer.displayName ?? peer.peerId} (${address}). Connecting...`,
        peer,
      );
    },
  };

  const multiclawsPeerRemove: PluginTool = {
    name: "multiclaws_peer_remove",
    description: "Remove a MultiClaws peer.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        peer: { type: "string" },
      },
      required: ["peer"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const peerName = typeof args.peer === "string" ? args.peer.trim() : "";
      if (!peerName) throw new Error("peer is required");
      const resolved = await service.resolvePeer(peerName);
      if (!resolved) throw new Error(`unknown peer: ${peerName}`);
      const removed = await service.removePeer(resolved.peerId);
      return textResult(
        removed
          ? `Peer ${resolved.displayName} (${resolved.peerId}) removed.`
          : `Peer ${peerName} not found.`,
      );
    },
  };

  // --- Permission tools ---

  const multiclawsPermissionSet: PluginTool = {
    name: "multiclaws_permission_set",
    description:
      'Set permission mode for a peer: "prompt" (ask each time), "allow-all" (trust), or "blocked" (reject all).',
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        peer: { type: "string" },
        mode: { type: "string" },
      },
      required: ["peer", "mode"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const peerName = typeof args.peer === "string" ? args.peer.trim() : "";
      const mode = typeof args.mode === "string" ? args.mode.trim() : "";
      if (!peerName || !mode) throw new Error("peer and mode are required");
      if (mode !== "prompt" && mode !== "allow-all" && mode !== "blocked") {
        throw new Error("mode must be prompt|allow-all|blocked");
      }
      const resolved = await service.resolvePeer(peerName);
      if (!resolved) throw new Error(`unknown peer: ${peerName}`);
      await service.setPeerPermissionMode(resolved.peerId, mode);
      return textResult(`Permission for ${resolved.displayName} set to "${mode}".`);
    },
  };

  const multiclawsPermissionPending: PluginTool = {
    name: "multiclaws_permission_pending",
    description: "List all pending permission approval requests from remote peers.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async () => {
      const service = requireService(getService());
      const requests = service.getPendingPermissions();
      if (requests.length === 0) {
        return textResult("No pending permission requests.");
      }
      return textResult(JSON.stringify({ requests }, null, 2), { requests });
    },
  };

  const multiclawsPermissionResolve: PluginTool = {
    name: "multiclaws_permission_resolve",
    description:
      'Approve or deny a pending permission request. Decision: "allow-once", "allow-permanently", or "deny".',
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        requestId: { type: "string" },
        decision: { type: "string" },
      },
      required: ["requestId", "decision"],
    },
    execute: async (_toolCallId, args) => {
      const service = requireService(getService());
      const requestId = typeof args.requestId === "string" ? args.requestId.trim() : "";
      const decision = typeof args.decision === "string" ? args.decision.trim() : "";
      if (!requestId || !decision) throw new Error("requestId and decision are required");
      if (decision !== "allow-once" && decision !== "allow-permanently" && decision !== "deny") {
        throw new Error("decision must be allow-once|allow-permanently|deny");
      }
      const resolved = service.resolvePermission(requestId, decision);
      if (!resolved) throw new Error(`no pending request with id: ${requestId}`);
      return textResult(`Permission request ${requestId} resolved: ${decision}.`);
    },
  };

  return [
    multiclawsPeers,
    multiclawsMessage,
    multiclawsSearch,
    multiclawsDelegate,
    multiclawsTeamCreate,
    multiclawsTeamJoin,
    multiclawsTeamMembers,
    multiclawsTeamLeave,
    multiclawsPeerAdd,
    multiclawsPeerRemove,
    multiclawsPermissionSet,
    multiclawsPermissionPending,
    multiclawsPermissionResolve,
  ];
}

const plugin = {
  id: "multiclaws",
  name: "MultiClaws",
  version: "0.1.0",
  register(api: OpenClawPluginApi) {
    const config = readConfig(api);
    let service: MulticlawsService | null = null;
    const routeStore = new ApprovalRouteStore();

    // Resolve local gateway config for tool invocations
    const gatewayConfig: GatewayConfig | null = (() => {
      const gw = api.config?.gateway;
      const port = typeof gw?.port === "number" ? gw.port : 18789;
      const token = typeof gw?.auth?.token === "string" ? gw.auth.token : null;
      if (!token) return null;
      return { port, token };
    })();

    // memorySearch: search local memory via /tools/invoke → memory_search
    async function memorySearch(params: {
      query: string;
      maxResults: number;
    }): Promise<LocalMemorySearchResult[]> {
      if (!gatewayConfig) {
        api.logger.warn("[multiclaws] memorySearch: gateway config unavailable, returning empty");
        return [];
      }
      try {
        const result = await invokeGatewayTool({
          gateway: gatewayConfig,
          tool: "memory_search",
          args: { query: params.query, maxResults: params.maxResults },
          timeoutMs: 8_000,
        });
        return parseMemorySearchResult(result);
      } catch (error) {
        api.logger.warn(`[multiclaws] memorySearch failed: ${String(error)}`);
        return [];
      }
    }

    // taskExecutor: run a delegated task via /tools/invoke → sessions_spawn (run mode)
    async function taskExecutor(params: {
      task: string;
      context?: string;
      fromPeerId: string;
    }): Promise<TaskExecutionResult> {
      if (!gatewayConfig) {
        return { ok: false, error: "gateway config unavailable — cannot execute task" };
      }
      const taskText = params.context
        ? `${params.task}\n\nContext (from peer ${params.fromPeerId}):\n${params.context}`
        : params.task;
      try {
        const result = await invokeGatewayTool({
          gateway: gatewayConfig,
          tool: "sessions_spawn",
          args: {
            task: taskText,
            mode: "run",
            runtime: "subagent",
          },
          timeoutMs: 120_000,
        });
        const output = parseSpawnTaskResult(result);
        return { ok: true, output };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }

    const pluginService = {
      id: "multiclaws-service",
      start: async (ctx: { stateDir: string; logger: OpenClawPluginApi["logger"] }) => {
        const logger = ctx.logger;
        service = new MulticlawsService({
          stateDir: ctx.stateDir,
          port: config.port,
          displayName: config.displayName,
          knownPeers: config.knownPeers,
          logger,
          memorySearch,
          taskExecutor,
        });
        service.on("permission_prompt", async (event: { text: string }) => {
          logger.info(`[multiclaws][approval]\n${event.text}`);
          const route = routeStore.getLatest();
          if (!route) {
            logger.warn("[multiclaws] no channel route available for approval prompt delivery");
            return;
          }
          try {
            await sendChannelText({
              runtime: api.runtime,
              route,
              text: event.text,
            });
          } catch (error) {
            logger.warn(
              `[multiclaws] failed to send approval prompt via channel ${route.channelId}: ${String(error)}`,
            );
          }
        });
        service.on("direct_message", (event: { fromDisplayName: string; text: string }) => {
          logger.info(`[multiclaws][message] from=${event.fromDisplayName} text=${event.text}`);
        });
        service.on(
          "task_completed_notification",
          async (event: {
            fromPeerDisplayName?: string;
            taskId?: string;
            task?: string;
            ok?: boolean;
            output?: string;
            error?: string;
          }) => {
            const source = event.fromPeerDisplayName || "peer";
            const status = event.ok ? "成功" : "失败";
            const taskLine = event.task ? `任务: ${event.task}` : undefined;
            const resultLine = event.ok
              ? event.output
                ? `结果: ${String(event.output).slice(0, 500)}`
                : undefined
              : event.error
                ? `错误: ${String(event.error).slice(0, 500)}`
                : undefined;
            const text = [
              `[协作任务完成] 来自 ${source} 的委派任务已完成 (${status})`,
              ...(event.taskId ? [`任务ID: ${event.taskId}`] : []),
              ...(taskLine ? [taskLine] : []),
              ...(resultLine ? [resultLine] : []),
            ].join("\n");
            logger.info(`[multiclaws][task-completed]\n${text}`);
            const route = routeStore.getLatest();
            if (!route) {
              return;
            }
            try {
              await sendChannelText({
                runtime: api.runtime,
                route,
                text,
              });
            } catch (error) {
              logger.warn(
                `[multiclaws] failed to send task completion notification via channel ${route.channelId}: ${String(error)}`,
              );
            }
          },
        );
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

    for (const tool of createTools(() => service, config)) {
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

    api.registerHttpRoute({
      path: "/multiclaws/ws",
      auth: "plugin",
      handler: (_req, res) => {
        res.statusCode = 426;
        res.end("MultiClaws WebSocket runs on the plugin service port.");
      },
    });

    api.on("message_received", async (event, ctx) => {
      routeStore.update(routeFromInbound(event, ctx));
      if (!service) {
        return;
      }
      // Skip parsing if there are no pending permission requests — avoids
      // running regex on every inbound message in high-traffic channels
      if (!service.hasPendingPermissions()) {
        return;
      }
      const handled = await service.handleUserApprovalReply(event.content);
      if (handled.handled) {
        api.logger.info(
          `[multiclaws] resolved approval request ${handled.requestId ?? "unknown"} -> ${handled.decision ?? "unknown"}`,
        );
      }
    });

    api.on("gateway_start", () => {
      api.logger.info("[multiclaws] gateway_start observed");
    });

    api.on("gateway_stop", () => {
      api.logger.info("[multiclaws] gateway_stop observed");
    });
  },
};

export default plugin;
