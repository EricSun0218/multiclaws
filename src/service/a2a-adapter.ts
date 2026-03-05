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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

      const spawn = spawnResult as Record<string, unknown> | null;
      const childSessionKey = spawn?.childSessionKey as string | undefined;

      if (!childSessionKey) {
        // Might have returned result directly
        const directOutput = parseSpawnTaskResult(spawnResult);
        if (directOutput && directOutput !== "{}" && !directOutput.includes('"status":"accepted"')) {
          this.taskTracker.update(taskId, { status: "completed", result: directOutput });
          this.publishMessage(eventBus, directOutput);
          eventBus.finished();
          return;
        }
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
   * Uses exponential backoff: 1s, 2s, 3s, then 5s intervals.
   */
  private async waitForCompletion(sessionKey: string, timeoutMs: number): Promise<string> {
    const gateway = this.gatewayConfig!;
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < timeoutMs) {
      // Exponential backoff: 1s, 2s, 3s, then 5s
      const delay = attempt < 3 ? (attempt + 1) * 1000 : 5000;
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
      } catch (err) {
        // Non-fatal: session might not be ready yet
        this.logger.warn(`[a2a-adapter] poll attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    throw new Error(`task timed out after ${Math.round(timeoutMs / 1000)}s waiting for subagent`);
  }

  /**
   * Extract the final assistant response from session history.
   * Returns null if the session is still running.
   */
  private extractCompletedResult(histResult: unknown): string | null {
    const hist = histResult as Record<string, unknown> | null;
    if (!hist) return null;

    const messages = (hist.messages ?? []) as Array<Record<string, unknown>>;
    if (messages.length === 0) return null;

    // Look for the last assistant message with text content (not tool calls)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;

      const content = msg.content;

      // String content = direct result
      if (typeof content === "string" && content.trim()) {
        return content;
      }

      // Array content - look for text parts (skip tool call-only messages)
      if (Array.isArray(content)) {
        const textParts = content
          .filter((c: any) => c?.type === "text" && typeof c.text === "string" && c.text.trim())
          .map((c: any) => c.text);

        // If this message has ONLY tool calls and no text, skip it (still running)
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
