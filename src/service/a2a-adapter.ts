import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import { invokeGatewayTool, type GatewayConfig } from "../infra/gateway-client";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the details object from a gateway /tools/invoke result.
 * The result shape is: { content: [...], details: { ...actual data... } }
 */
function extractDetails(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  // Direct details from /tools/invoke
  if (r.details && typeof r.details === "object") {
    return r.details as Record<string, unknown>;
  }
  // Fallback: result itself might be the details
  return r;
}

/**
 * Bridges the A2A protocol to OpenClaw's sessions_spawn gateway tool.
 *
 * When a remote agent sends a task via A2A `message/send`,
 * this executor:
 * 1. Records the task via TaskTracker
 * 2. Calls OpenClaw's `sessions_spawn` (run mode) to start execution
 * 3. Polls `sessions_history` until the subagent completes
 * 4. Returns the final result as a Message
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

    try {
      this.logger.info(`[a2a-adapter] executing task ${taskId}: ${taskText.slice(0, 100)}`);

      // 1. Spawn the subagent
      const spawnResult = await invokeGatewayTool({
        gateway: this.gatewayConfig,
        tool: "sessions_spawn",
        args: {
          task: taskText,
          mode: "run",
        },
        timeoutMs: 15_000,
      });

      // Extract details from gateway response: { content: [...], details: { childSessionKey, ... } }
      const details = extractDetails(spawnResult);
      const childSessionKey = details?.childSessionKey as string | undefined;

      if (!childSessionKey) {
        throw new Error("sessions_spawn did not return a childSessionKey");
      }

      // 2. Poll for completion
      this.logger.info(`[a2a-adapter] task ${taskId} spawned as ${childSessionKey}, waiting for result...`);
      const output = await this.waitForCompletion(childSessionKey, 180_000);

      // 3. Return result
      this.taskTracker.update(taskId, { status: "completed", result: output });
      this.logger.info(`[a2a-adapter] task ${taskId} completed`);
      this.publishMessage(eventBus, output || "Task completed with no output.");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[a2a-adapter] task execution failed: ${errorMsg}`);
      this.taskTracker.update(taskId, { status: "failed", error: errorMsg });
      this.publishMessage(eventBus, `Error: ${errorMsg}`);
    }

    eventBus.finished();
  }

  /**
   * Poll sessions_history until the subagent produces a final assistant message.
   * Uses backoff: 2s, 3s, 4s, then 5s intervals.
   */
  private async waitForCompletion(sessionKey: string, timeoutMs: number): Promise<string> {
    const gateway = this.gatewayConfig!;
    const startTime = Date.now();
    let attempt = 0;
    // Aggressive early polls, then back off: 300ms, 500ms, 1s, 2s, 3s, 3s...
    const pollDelays = [300, 500, 1000, 2000, 3000];

    while (Date.now() - startTime < timeoutMs) {
      const delay = pollDelays[Math.min(attempt, pollDelays.length - 1)];
      await sleep(delay);
      attempt++;

      try {
        const histResult = await invokeGatewayTool({
          gateway,
          tool: "sessions_history",
          args: {
            sessionKey,
            limit: 20,
            includeTools: false,
          },
          timeoutMs: 8_000,
        });

        const result = this.extractCompletedResult(histResult);
        if (result !== null) {
          return result;
        }

        this.logger.info(`[a2a-adapter] poll attempt ${attempt}: session ${sessionKey} still running...`);
      } catch (err) {
        this.logger.warn(`[a2a-adapter] poll attempt ${attempt} error: ${err instanceof Error ? err.message : err}`);
      }
    }

    throw new Error(`task timed out after ${Math.round(timeoutMs / 1000)}s waiting for subagent`);
  }

  /**
   * Extract the final assistant response from session history.
   * Returns null if the session is still running.
   *
   * Gateway /tools/invoke returns: { content: [...], details: { messages: [...] } }
   */
  private extractCompletedResult(histResult: unknown): string | null {
    const details = extractDetails(histResult);
    if (!details) return null;

    const messages = (details.messages ?? []) as Array<Record<string, unknown>>;
    if (messages.length === 0) return null;

    // Walk backwards to find the last assistant message with text content
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;

      const content = msg.content;

      if (typeof content === "string" && content.trim()) {
        return content;
      }

      if (Array.isArray(content)) {
        const textParts = content
          .filter((c: any) => c?.type === "text" && typeof c.text === "string" && c.text.trim())
          .map((c: any) => c.text);

        // Skip messages that only have tool calls (still executing)
        const hasToolCalls = content.some((c: any) => c?.type === "toolCall" || c?.type === "tool_use");
        if (textParts.length === 0 && hasToolCalls) continue;

        if (textParts.length > 0) {
          return textParts.join("\n");
        }
      }
    }

    return null;
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
