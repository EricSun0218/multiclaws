import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from "@a2a-js/sdk";
import { invokeGatewayTool, parseSpawnTaskResult, type GatewayConfig } from "../infra/gateway-client";
import type { TaskTracker } from "../task/tracker";

export type A2AAdapterOptions = {
  gatewayConfig: GatewayConfig | null;
  taskTracker: TaskTracker;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
};

function extractTextFromMessage(message: Message): string {
  if (!message.parts) return "";
  return message.parts
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Bridges the A2A protocol to OpenClaw's sessions_spawn gateway tool.
 *
 * When a remote agent sends a task via A2A `message/send`,
 * this executor:
 * 1. Records the task via TaskTracker
 * 2. Calls OpenClaw's `sessions_spawn` to execute the task
 * 3. Publishes the result back via ExecutionEventBus
 */
export class OpenClawAgentExecutor implements AgentExecutor {
  private gatewayConfig: GatewayConfig | null;
  private readonly taskTracker: TaskTracker;
  private readonly logger: A2AAdapterOptions["logger"];

  constructor(options: A2AAdapterOptions) {
    this.gatewayConfig = options.gatewayConfig;
    this.taskTracker = options.taskTracker;
    this.logger = options.logger;
  }

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const taskText = extractTextFromMessage(context.userMessage);
    const taskId = context.taskId;

    if (!taskText.trim()) {
      this.publishStatusUpdate(eventBus, taskId, context.contextId, "failed");
      eventBus.finished();
      return;
    }

    const fromAgent = (context.userMessage.metadata?.agentUrl as string) ?? "unknown";

    // 1. Record task
    this.taskTracker.create({
      fromPeerId: fromAgent,
      toPeerId: "local",
      task: taskText,
    });

    // 2. Execute via gateway
    this.publishStatusUpdate(eventBus, taskId, context.contextId, "working");

    if (!this.gatewayConfig) {
      this.logger.error("[a2a-adapter] gateway config not available, cannot execute task");
      this.publishStatusUpdate(eventBus, taskId, context.contextId, "failed");
      eventBus.finished();
      return;
    }

    try {
      const result = await invokeGatewayTool({
        gateway: this.gatewayConfig,
        tool: "sessions_spawn",
        args: {
          sessionKey: `multiclaws-task-${taskId}`,
          message: taskText,
          mode: "run",
        },
        timeoutMs: 120_000,
      });

      const output = parseSpawnTaskResult(result);

      // 3. Publish result
      this.taskTracker.update(taskId, { status: "completed", result: output });

      const artifact: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId,
        contextId: context.contextId,
        artifact: {
          artifactId: `result-${taskId}`,
          parts: [{ kind: "text", text: output }],
        },
        lastChunk: true,
      };
      eventBus.publish(artifact);
      this.publishStatusUpdate(eventBus, taskId, context.contextId, "completed");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[a2a-adapter] task execution failed: ${errorMsg}`);
      this.taskTracker.update(taskId, { status: "failed", error: errorMsg });
      this.publishStatusUpdate(eventBus, taskId, context.contextId, "failed");
    }

    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.taskTracker.update(taskId, { status: "failed", error: "canceled" });
    const cancelEvent: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId,
      contextId: "",
      status: { state: "canceled", timestamp: new Date().toISOString() },
      final: true,
    };
    eventBus.publish(cancelEvent);
    eventBus.finished();
  }

  updateGatewayConfig(config: GatewayConfig): void {
    this.gatewayConfig = config;
  }

  private publishStatusUpdate(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    state: string,
  ): void {
    const event: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId,
      contextId,
      status: { state: state as any, timestamp: new Date().toISOString() },
      final: state === "completed" || state === "failed" || state === "canceled" || state === "rejected",
    };
    eventBus.publish(event);
  }
}
