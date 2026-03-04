import { z } from "zod";
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

const memorySearchPayloadSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(20).optional(),
});

const delegatePayloadSchema = z.object({
  task: z.string().min(1),
  context: z.string().optional(),
});

const directMessagePayloadSchema = z.object({
  fromPeerId: z.string().min(1),
  fromDisplayName: z.string().min(1),
  text: z.string().min(1),
  sentAtMs: z.number().finite(),
});

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
          const parsed = memorySearchPayloadSchema.safeParse(params.payload);
          if (!parsed.success) {
            return { ok: false, error: "query required" };
          }
          const result = await this.deps.memoryService.handleInboundSearch({
            fromPeerId: params.fromPeerId,
            fromPeerDisplayName: params.fromPeerDisplayName,
            query: parsed.data.query,
            maxResults: parsed.data.maxResults,
          });
          return { ok: true, data: result };
        }
        case "multiclaws.task.delegate": {
          const parsed = delegatePayloadSchema.safeParse(params.payload);
          if (!parsed.success) {
            return { ok: false, error: "task required" };
          }
          const result = await this.deps.taskService.acceptDelegatedTask({
            fromPeerId: params.fromPeerId,
            fromPeerDisplayName: params.fromPeerDisplayName,
            task: parsed.data.task,
            context: parsed.data.context,
          });
          if (result.taskId) {
            await this.deps.onTaskCompleted?.({
              requesterPeerId: params.fromPeerId,
              requestId: params.requestId,
              task: parsed.data.task,
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
          const parsed = directMessagePayloadSchema.safeParse(params.payload);
          if (!parsed.success) {
            return { ok: false, error: "message text required" };
          }
          await this.deps.onDirectMessage(parsed.data);
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
