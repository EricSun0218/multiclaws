"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenClawAgentExecutor = void 0;
const gateway_client_1 = require("../infra/gateway-client");
function extractTextFromMessage(message) {
    if (!message.parts)
        return "";
    return message.parts
        .filter((p) => p.kind === "text")
        .map((p) => p.text)
        .join("\n");
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Extract the details object from a gateway /tools/invoke result.
 * The result shape is: { content: [...], details: { ...actual data... } }
 */
function extractDetails(result) {
    if (!result || typeof result !== "object")
        return null;
    const r = result;
    // Direct details from /tools/invoke
    if (r.details && typeof r.details === "object") {
        return r.details;
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
class OpenClawAgentExecutor {
    gatewayConfig;
    taskTracker;
    logger;
    constructor(options) {
        this.gatewayConfig = options.gatewayConfig;
        this.taskTracker = options.taskTracker;
        this.logger = options.logger;
    }
    async execute(context, eventBus) {
        const taskText = extractTextFromMessage(context.userMessage);
        const taskId = context.taskId;
        if (!taskText.trim()) {
            this.publishMessage(eventBus, "Error: empty task received.");
            eventBus.finished();
            return;
        }
        const fromAgent = context.userMessage.metadata?.agentUrl ?? "unknown";
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
            const spawnResult = await (0, gateway_client_1.invokeGatewayTool)({
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
            const childSessionKey = details?.childSessionKey;
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
        }
        catch (err) {
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
    async waitForCompletion(sessionKey, timeoutMs) {
        const gateway = this.gatewayConfig;
        const startTime = Date.now();
        let attempt = 0;
        const pollDelays = [100, 200, 300, 500];
        while (Date.now() - startTime < timeoutMs) {
            const delay = pollDelays[Math.min(attempt, pollDelays.length - 1)];
            await sleep(delay);
            attempt++;
            try {
                const histResult = await (0, gateway_client_1.invokeGatewayTool)({
                    gateway,
                    tool: "sessions_history",
                    args: {
                        sessionKey,
                        limit: 50,
                        includeTools: false,
                    },
                    timeoutMs: 8_000,
                });
                const result = this.extractCompletedResult(histResult);
                if (result !== null) {
                    return result;
                }
                this.logger.info(`[a2a-adapter] poll attempt ${attempt}: session ${sessionKey} still running...`);
            }
            catch (err) {
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
    extractCompletedResult(histResult) {
        const details = extractDetails(histResult);
        if (!details)
            return null;
        // Respect explicit completion flag from gateway
        if (details.isComplete === false)
            return null;
        // Check for session-level error/status from gateway
        const sessionError = details.error;
        const sessionStatus = details.status;
        const messages = (details.messages ?? []);
        if (messages.length === 0 && !details.isComplete)
            return null;
        // If no explicit isComplete flag, use heuristic: check if the session is still executing
        if (details.isComplete === undefined) {
            if (messages.length === 0)
                return null;
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && Array.isArray(lastMsg.content)) {
                const content = lastMsg.content;
                const hasToolCalls = content.some((c) => c?.type === "toolCall" || c?.type === "tool_use");
                // If the last message only has tool calls (no text), still running
                const hasText = content.some((c) => c?.type === "text" && typeof c.text === "string" && c.text.trim());
                if (hasToolCalls && !hasText)
                    return null;
            }
            // If the last message is a user message, the agent hasn't responded yet
            if (lastMsg?.role === "user")
                return null;
        }
        // Session is complete — collect ALL assistant text messages in order
        const allTexts = [];
        for (const msg of messages) {
            if (msg.role !== "assistant")
                continue;
            const text = this.extractTextFromHistoryMessage(msg);
            if (text)
                allTexts.push(text);
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
    extractTextFromHistoryMessage(msg) {
        const content = msg.content;
        if (typeof content === "string" && content.trim()) {
            return content;
        }
        if (Array.isArray(content)) {
            const parts = content;
            const textParts = parts
                .filter((c) => c?.type === "text" && typeof c.text === "string" && c.text.trim())
                .map((c) => c.text);
            if (textParts.length > 0) {
                return textParts.join("\n");
            }
        }
        return null;
    }
    async cancelTask(taskId, eventBus) {
        this.taskTracker.update(taskId, { status: "failed", error: "canceled" });
        this.publishMessage(eventBus, "Task was canceled.");
        eventBus.finished();
    }
    updateGatewayConfig(config) {
        this.gatewayConfig = config;
    }
    publishMessage(eventBus, text) {
        const message = {
            kind: "message",
            role: "agent",
            messageId: `msg-${Date.now()}`,
            parts: [{ kind: "text", text }],
        };
        eventBus.publish(message);
    }
}
exports.OpenClawAgentExecutor = OpenClawAgentExecutor;
