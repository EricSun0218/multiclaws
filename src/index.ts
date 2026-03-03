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

function createTools(getService: () => MulticlawsService | null): PluginTool[] {
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

  return [multiclawsPeers, multiclawsMessage, multiclawsSearch, multiclawsDelegate];
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
