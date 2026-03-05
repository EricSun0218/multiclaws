import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
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
 * 2. Calls OpenClaw's `sessions_spawn` (run mode) to execute the task
 * 3. Returns the spawn acceptance as a Message (result arrives async via auto-announce)
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
      this.publishMessage(eventBus, "Error: empty task received.");
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

    if (!this.gatewayConfig) {
      this.logger.error("[a2a-adapter] gateway config not available, cannot execute task");
      this.taskTracker.update(taskId, { status: "failed", error: "gateway config not available" });
      this.publishMessage(eventBus, "Error: gateway config not available, cannot execute task.");
      eventBus.finished();
      return;
    }

    // 2. Spawn the task (async — result arrives via auto-announce)
    try {
      this.logger.info(`[a2a-adapter] executing task ${taskId}: ${taskText.slice(0, 100)}`);

      const result = await invokeGatewayTool({
        gateway: this.gatewayConfig,
        tool: "sessions_spawn",
        args: {
          task: taskText,
          mode: "run",
        },
        timeoutMs: 10_000,
      });

      const output = parseSpawnTaskResult(result);
      this.taskTracker.update(taskId, { status: "running" });
      this.logger.info(`[a2a-adapter] task ${taskId} spawned successfully`);
      this.publishMessage(eventBus, output || "Task accepted and running.");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[a2a-adapter] task execution failed: ${errorMsg}`);
      this.taskTracker.update(taskId, { status: "failed", error: errorMsg });
      this.publishMessage(eventBus, `Error: ${errorMsg}`);
    }

    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.taskTracker.update(taskId, { status: "failed", error: "canceled" });
    this.publishMessage(eventBus, "Task was canceled.");
    eventBus.finished();
  }

  updateGatewayConfig(config: GatewayConfig): void {
    this.gatewayConfig = config;
  }

  private publishMessage(eventBus: ExecutionEventBus, text: string): void {
    const message: Message = {
      kind: "message",
      role: "agent",
      messageId: `msg-${Date.now()}`,
      parts: [{ kind: "text", text }],
    };
    eventBus.publish(message);
  }
}
