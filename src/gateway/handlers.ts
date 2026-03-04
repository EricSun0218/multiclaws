import type { GatewayRequestHandler } from "../types/openclaw";
import type { MulticlawsService } from "../service/multiclaws-service";

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} required`);
  }
  return value.trim();
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function createGatewayHandlers(
  getService: () => MulticlawsService,
): Record<string, GatewayRequestHandler> {
  const handlers: Record<string, GatewayRequestHandler> = {
    "multiclaws.peer.handshake": async ({ respond }) => {
      const service = getService();
      respond(true, {
        localIdentity: service.identity,
      });
    },

    "multiclaws.peer.list": async ({ respond }) => {
      const service = getService();
      const peers = await service.listPeers();
      respond(true, { peers });
    },

    "multiclaws.peer.add": async ({ params, respond }) => {
      try {
        const service = getService();
        const address = requireString(params, "address");
        const peer = await service.addPeer({
          address,
          peerId: optionalString(params, "peerId"),
          displayName: optionalString(params, "displayName"),
          publicKey: optionalString(params, "publicKey"),
        });
        respond(true, peer);
      } catch (error) {
        respond(false, undefined, {
          code: "invalid_params",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "multiclaws.peer.remove": async ({ params, respond }) => {
      try {
        const service = getService();
        const peerId = requireString(params, "peerId");
        const removed = await service.removePeer(peerId);
        respond(true, { removed });
      } catch (error) {
        respond(false, undefined, {
          code: "invalid_params",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "multiclaws.memory.search": async ({ params, respond }) => {
      try {
        const service = getService();
        const peerId = requireString(params, "peerId");
        const query = requireString(params, "query");
        const maxResults = optionalNumber(params, "maxResults");
        const result = await service.multiclawsMemorySearch({
          peerId,
          query,
          maxResults,
        });
        respond(true, result);
      } catch (error) {
        respond(false, undefined, {
          code: "memory_search_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "multiclaws.task.delegate": async ({ params, respond }) => {
      try {
        const service = getService();
        const peerId = requireString(params, "peerId");
        const task = requireString(params, "task");
        const context = optionalString(params, "context");
        const result = await service.delegateTask({ peerId, task, context });
        respond(true, result);
      } catch (error) {
        respond(false, undefined, {
          code: "task_delegate_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "multiclaws.task.status": async ({ params, respond }) => {
      try {
        const service = getService();
        const taskId = requireString(params, "taskId");
        const task = service.getTaskStatus(taskId);
        if (!task) {
          respond(false, undefined, {
            code: "not_found",
            message: `task not found: ${taskId}`,
          });
          return;
        }
        respond(true, { task });
      } catch (error) {
        respond(false, undefined, {
          code: "task_status_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "multiclaws.message.send": async ({ params, respond }) => {
      try {
        const service = getService();
        const peerId = requireString(params, "peerId");
        const text = requireString(params, "message");
        await service.sendDirectMessage({ peerId, text });
        respond(true, { delivered: true });
      } catch (error) {
        respond(false, undefined, {
          code: "message_send_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "multiclaws.team.create": async ({ params, respond }) => {
      try {
        const service = getService();
        const teamName = requireString(params, "teamName");
        const localAddress = requireString(params, "localAddress");
        const result = await service.createTeam({ teamName, localAddress });
        respond(true, result);
      } catch (error) {
        respond(false, undefined, {
          code: "team_create_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "multiclaws.team.join": async ({ params, respond }) => {
      try {
        const service = getService();
        const inviteCode = requireString(params, "inviteCode");
        const localAddress = requireString(params, "localAddress");
        const result = await service.joinTeam({ inviteCode, localAddress });
        respond(true, result);
      } catch (error) {
        respond(false, undefined, {
          code: "team_join_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "multiclaws.team.members": async ({ params, respond }) => {
      try {
        const service = getService();
        const teamId = requireString(params, "teamId");
        const members = await service.listTeamMembers(teamId);
        respond(true, { members });
      } catch (error) {
        respond(false, undefined, {
          code: "team_members_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "multiclaws.team.leave": async ({ params, respond }) => {
      try {
        const service = getService();
        const teamId = requireString(params, "teamId");
        await service.leaveTeam(teamId);
        respond(true, { left: true });
      } catch (error) {
        respond(false, undefined, {
          code: "team_leave_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "multiclaws.permission.pending": async ({ respond }) => {
      const service = getService();
      const pending = service.getPendingPermissions();
      respond(true, { requests: pending });
    },

    "multiclaws.permission.resolve": async ({ params, respond }) => {
      try {
        const service = getService();
        const requestId = requireString(params, "requestId");
        const decision = requireString(params, "decision");
        if (decision !== "allow-once" && decision !== "allow-permanently" && decision !== "deny") {
          throw new Error("decision must be allow-once|allow-permanently|deny");
        }
        const resolved = service.resolvePermission(requestId, decision);
        if (!resolved) {
          respond(false, undefined, {
            code: "not_found",
            message: `no pending request with id: ${requestId}`,
          });
          return;
        }
        respond(true, { resolved: true, requestId, decision });
      } catch (error) {
        respond(false, undefined, {
          code: "permission_resolve_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "multiclaws.permission.set": async ({ params, respond }) => {
      try {
        const service = getService();
        const peerId = requireString(params, "peerId");
        const mode = requireString(params, "mode");
        if (mode !== "prompt" && mode !== "allow-all" && mode !== "blocked") {
          throw new Error("mode must be prompt|allow-all|blocked");
        }
        await service.setPeerPermissionMode(peerId, mode);
        respond(true, { updated: true, mode });
      } catch (error) {
        respond(false, undefined, {
          code: "permission_set_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };

  return handlers;
}
