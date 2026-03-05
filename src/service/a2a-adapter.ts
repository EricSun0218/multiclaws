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

/**
 * Bridges the A2A protocol to OpenClaw's sessions_spawn gateway tool.
 *
 * When a remote agent sends a task via A2A `message/send`,
 * this executor:
 * 1. Records the task via TaskTracker
 * 2. Calls OpenClaw's `sessions_spawn` (run mode) to execute the task
 * 3. Polls for completion via `sessions_list`
 * 4. Fetches the result via `sessions_history`
 * 5. Publishes the result back as a Message via ExecutionEventBus
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

    // 2. Spawn the task
    try {
      this.logger.info(`[a2a-adapter] executing task ${taskId}: ${taskText.slice(0, 100)}`);

      const spawnResult = await invokeGatewayTool({
        gateway: this.gatewayConfig,
        tool: "sessions_spawn",
        args: {
          task: taskText,
          mode: "run",
          runTimeoutSeconds: 120,
        },
        timeoutMs: 10_000,
      });

      const spawn = spawnResult as Record<string, unknown> | null;
      const childSessionKey = spawn?.childSessionKey as string | undefined;

      if (!childSessionKey) {
        // sessions_spawn might have returned the result directly
        const directOutput = extractDirectResult(spawn);
        if (directOutput) {
          this.taskTracker.update(taskId, { status: "completed", result: directOutput });
          this.publishMessage(eventBus, directOutput);
          eventBus.finished();
          return;
        }
        throw new Error("sessions_spawn did not return a childSessionKey");
      }

      // 3. Poll for completion
      this.logger.info(`[a2a-adapter] task ${taskId} spawned, polling ${childSessionKey}`);
      const output = await this.pollForResult(childSessionKey, 120_000);

      // 4. Publish result
      this.taskTracker.update(taskId, { status: "completed", result: output });
      this.logger.info(`[a2a-adapter] task ${taskId} completed successfully`);
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
   * Poll sessions_list until the child session is no longer active,
   * then fetch history to get the final result.
   */
  private async pollForResult(sessionKey: string, timeoutMs: number): Promise<string> {
    const gateway = this.gatewayConfig!;
    const startTime = Date.now();
    const pollIntervalMs = 3_000;

    while (Date.now() - startTime < timeoutMs) {
      await sleep(pollIntervalMs);

      try {
        const listResult = await invokeGatewayTool({
          gateway,
          tool: "sessions_list",
          args: {
            limit: 50,
            messageLimit: 0,
          },
          timeoutMs: 8_000,
        });

        const list = listResult as Record<string, unknown> | null;
        const sessions = (list?.sessions ?? []) as Array<Record<string, unknown>>;

        // Find our session
        const session = sessions.find((s) => s.key === sessionKey);

        if (!session) {
          // Session not found in active list — it may have completed and been cleaned up
          // Try to fetch history directly
          return await this.fetchSessionResult(sessionKey);
        }

        // Check if session is still running by looking at recent activity
        // If sessions_list includes it, it might still be active
        // We'll also check via sessions_history for a final assistant message
        const historyResult = await this.fetchSessionHistory(sessionKey);
        if (historyResult !== null) {
          return historyResult;
        }
      } catch (err) {
        this.logger.warn(`[a2a-adapter] poll error: ${err instanceof Error ? err.message : err}`);
      }
    }

    throw new Error(`task timed out after ${timeoutMs}ms`);
  }

  /**
   * Fetch session history and extract the last assistant message if the session has completed.
   * Returns null if still running.
   */
  private async fetchSessionHistory(sessionKey: string): Promise<string | null> {
    const gateway = this.gatewayConfig!;

    const histResult = await invokeGatewayTool({
      gateway,
      tool: "sessions_history",
      args: {
        sessionKey,
        limit: 10,
        includeTools: false,
      },
      timeoutMs: 8_000,
    });

    const hist = histResult as Record<string, unknown> | null;
    const messages = (hist?.messages ?? []) as Array<Record<string, unknown>>;

    if (messages.length === 0) return null;

    // Find the last assistant message
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return null;

    // Extract text content
    const content = lastAssistant.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text);
      if (texts.length > 0) return texts.join("\n");
    }

    // Check if the session appears done (has a completion/result message)
    // A subagent run session is done when there's an assistant message after the user task
    const hasUserMessage = messages.some((m) => m.role === "user");
    const hasAssistantAfterUser = hasUserMessage && lastAssistant !== undefined;
    if (hasAssistantAfterUser && typeof lastAssistant.content === "string") {
      return lastAssistant.content;
    }

    return null;
  }

  private async fetchSessionResult(sessionKey: string): Promise<string> {
    try {
      const result = await this.fetchSessionHistory(sessionKey);
      return result ?? "Task completed but no result was found.";
    } catch {
      return "Task completed but could not fetch result.";
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.taskTracker.update(taskId, { status: "failed", error: "canceled" });
    this.publishMessage(eventBus, "Task was canceled.");
    eventBus.finished();
  }

  updateGatewayConfig(config: GatewayConfig): void {
    this.gatewayConfig = config;
  }

  /**
   * Publish a Message event to the event bus.
   * The A2A SDK's ResultManager picks this up as `finalMessageResult`,
   * which is returned by `getFinalResult()`.
   */
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

function extractDirectResult(result: Record<string, unknown> | null | undefined): string | undefined {
  if (!result) return undefined;
  if (typeof result.output === "string") return result.output;
  if (typeof result.result === "string") return result.result;
  if (Array.isArray(result.content)) {
    const texts = result.content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
