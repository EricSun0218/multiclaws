import type { MulticlawsMemoryService } from "../memory/multiclaws-query";
import type { TaskDelegationService } from "../task/delegation";
import type { DirectMessagePayload } from "../messaging/direct";

export type TaskCompletedNotification = {
  requesterPeerId: string;
  requestId: string;
  task: string;
  result: {
    ok: boolean;
    taskId: string;
    output?: string;
    error?: string;
  };
};

export type ProtocolHandlerDependencies = {
  memoryService: MulticlawsMemoryService;
  taskService: TaskDelegationService;
  onDirectMessage: (payload: DirectMessagePayload) => Promise<void>;
  onTaskCompleted?: (payload: TaskCompletedNotification) => Promise<void>;
};

export class MulticlawsProtocolHandlers {
  constructor(private readonly deps: ProtocolHandlerDependencies) {}

  async handleRequest(params: {
    fromPeerId: string;
    fromPeerDisplayName: string;
    method: string;
    requestId: string;
    payload: unknown;
  }): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    try {
      switch (params.method) {
        case "multiclaws.memory.search": {
          const payload = params.payload as { query?: string; maxResults?: number };
          if (!payload?.query || typeof payload.query !== "string") {
            return { ok: false, error: "query required" };
          }
          const result = await this.deps.memoryService.handleInboundSearch({
            fromPeerId: params.fromPeerId,
            fromPeerDisplayName: params.fromPeerDisplayName,
            query: payload.query,
            maxResults: payload.maxResults,
          });
          return { ok: true, data: result };
        }
        case "multiclaws.task.delegate": {
          const payload = params.payload as { task?: string; context?: string };
          if (!payload?.task || typeof payload.task !== "string") {
            return { ok: false, error: "task required" };
          }
          const result = await this.deps.taskService.acceptDelegatedTask({
            fromPeerId: params.fromPeerId,
            fromPeerDisplayName: params.fromPeerDisplayName,
            task: payload.task,
            context: payload.context,
          });
          if (result.taskId) {
            await this.deps.onTaskCompleted?.({
              requesterPeerId: params.fromPeerId,
              requestId: params.requestId,
              task: payload.task,
              result: {
                ok: result.ok,
                taskId: result.taskId,
                output: result.output,
                error: result.error,
              },
            });
          }
          return { ok: result.ok, data: result, error: result.error };
        }
        case "multiclaws.message.forward": {
          const payload = params.payload as DirectMessagePayload;
          if (!payload?.text || typeof payload.text !== "string") {
            return { ok: false, error: "message text required" };
          }
          await this.deps.onDirectMessage(payload);
          return { ok: true, data: { delivered: true } };
        }
        default:
          return { ok: false, error: `unsupported method: ${params.method}` };
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
