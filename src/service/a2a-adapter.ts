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
      // Use a dedicated session key to avoid inheriting the main session's
      // thinking blocks, which would cause "thinking blocks cannot be modified"
      // errors from the Claude API.
      const spawnResult = await invokeGatewayTool({
        gateway: this.gatewayConfig,
        tool: "sessions_spawn",
        args: {
          task: taskText,
          mode: "run",
          cwd: process.cwd(),
        },
        sessionKey: `a2a-${taskId}`,
        timeoutMs: 15_000,
      });

      // Extract details from gateway response: { content: [...], details: { childSessionKey, ... } }
      const details = extractDetails(spawnResult);
      const childSessionKey = details?.childSessionKey as string | undefined;

      if (!childSessionKey) {
        throw new Error("sessions_spawn did not return a childSessionKey");
      }

      // 2. Poll for completion
      const gatewaySessionKey = `a2a-${taskId}`;
      this.logger.info(`[a2a-adapter] task ${taskId} spawned as ${childSessionKey}, waiting for result...`);
      const output = await this.waitForCompletion(childSessionKey, 180_000, gatewaySessionKey);

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
   * Poll sessions_history until the subagent session completes.
   * Collects ALL assistant text messages and returns them joined.
   */
  private async waitForCompletion(sessionKey: string, timeoutMs: number, gatewaySessionKey?: string): Promise<string> {
    this.logger.info(`[a2a-adapter] waitForCompletion(sessionKey=${sessionKey}, timeoutMs=${timeoutMs})`);
    const gateway = this.gatewayConfig!;
    const startTime = Date.now();
    let attempt = 0;
    const pollDelays = [100, 200, 300, 500];

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
            limit: 50,
            includeTools: false,
          },
          sessionKey: gatewaySessionKey,
          timeoutMs: 8_000,
        });

        const result = this.extractCompletedResult(histResult);
        if (result !== null) {
          return result;
        }

        // Log details every 50 attempts to help diagnose stuck sessions
        if (attempt % 50 === 0) {
          const details = extractDetails(histResult);
          const messages = (details?.messages ?? []) as Array<Record<string, unknown>>;
          const lastMsg = messages[messages.length - 1];
          this.logger.info(
            `[a2a-adapter] poll attempt ${attempt}: session ${sessionKey} still running. ` +
            `isComplete=${details?.isComplete}, status=${details?.status}, ` +
            `msgCount=${messages.length}, lastRole=${lastMsg?.role}, ` +
            `lastContentTypes=${JSON.stringify(
              Array.isArray(lastMsg?.content)
                ? (lastMsg.content as Array<Record<string, unknown>>).map((c) => c?.type)
                : typeof lastMsg?.content
            )}`,
          );
        } else {
          this.logger.info(`[a2a-adapter] poll attempt ${attempt}: session ${sessionKey} still running...`);
        }
      } catch (err) {
        this.logger.warn(`[a2a-adapter] poll attempt ${attempt} error: ${err instanceof Error ? err.message : err}`);
      }
    }

    throw new Error(`task timed out after ${Math.round(timeoutMs / 1000)}s waiting for subagent`);
  }

  /**
   * Extract all assistant text from session history once the session is complete.
   * Returns null if the session is still running.
   * Returns all assistant text messages joined (not just the last one).
   *
   * Gateway /tools/invoke returns: { content: [...], details: { messages: [...], isComplete?: boolean } }
   */
  private extractCompletedResult(histResult: unknown): string | null {
    const details = extractDetails(histResult);
    if (!details) return null;

    // Respect explicit completion flag from gateway
    if (details.isComplete === false) return null;

    // Check for session-level error/status from gateway
    const sessionError = details.error as string | undefined;
    const sessionStatus = details.status as string | undefined;

    const messages = (details.messages ?? []) as Array<Record<string, unknown>>;
    if (messages.length === 0 && !details.isComplete) return null;

    // If no explicit isComplete flag, use heuristic: check if the session is still executing
    if (details.isComplete === undefined) {
      if (messages.length === 0) return null;
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && Array.isArray(lastMsg.content)) {
        const content = lastMsg.content as Array<Record<string, unknown>>;
        const hasToolCalls = content.some(
          (c) => c?.type === "toolCall" || c?.type === "tool_use",
        );
        // If the last message only has tool calls (no text), still running
        const hasText = content.some(
          (c) => c?.type === "text" && typeof c.text === "string" && (c.text as string).trim(),
        );
        if (hasToolCalls && !hasText) return null;
      }
      // If the last message is a user message, the agent hasn't responded yet
      if (lastMsg?.role === "user") return null;
    }

    // Session is complete — collect ALL assistant text messages in order
    const allTexts: string[] = [];
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const text = this.extractTextFromHistoryMessage(msg);
      if (text) allTexts.push(text);
    }

    // If we have assistant text, return it (even if there's also an error)
    if (allTexts.length > 0) {
      // Append error info if present so the delegating agent sees both
      if (sessionError) {
        allTexts.push(`[session error: ${sessionError}]`);
      }
      return allTexts.join("\n\n");
    }

    // No assistant text — check if the session reported an error
    if (sessionError) {
      return `Error: ${sessionError}`;
    }
    if (sessionStatus === "failed" || sessionStatus === "error") {
      return `Error: session ended with status "${sessionStatus}"`;
    }

    // Session truly completed with no output at all
    return "(task completed with no text output)";
  }

  /** Extract text content from a single history message. */
  private extractTextFromHistoryMessage(msg: Record<string, unknown>): string | null {
    const content = msg.content;

    if (typeof content === "string" && content.trim()) {
      return content;
    }

    if (Array.isArray(content)) {
      const parts = content as Array<Record<string, unknown>>;
      const textParts = parts
        .filter((c) => c?.type === "text" && typeof c.text === "string" && (c.text as string).trim())
        .map((c) => c.text as string);

      if (textParts.length > 0) {
        return textParts.join("\n");
      }
    }

    return null;
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.logger.info(`[a2a-adapter] cancelTask(taskId=${taskId})`);
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
