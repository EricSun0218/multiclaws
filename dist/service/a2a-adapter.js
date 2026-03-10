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
function buildTaskWithHistory(context) {
    const currentText = extractTextFromMessage(context.userMessage);
    const history = context.task?.history ?? [];
    if (history.length <= 1) {
        // First message — no prior context
        return currentText;
    }
    // Build context from previous exchanges (exclude the last message, that's currentText)
    const prior = history
        .slice(0, -1)
        .slice(-8) // keep last 8 messages max to avoid huge prompts
        .map((m) => {
        const text = extractTextFromMessage(m);
        const role = m.role === "agent" ? "[agent]" : "[user]";
        return `[${role}]: ${text}`;
    })
        .filter((line) => line.length > 10)
        .join("\n");
    if (!prior)
        return currentText;
    return [
        "[conversation history]",
        prior,
        "",
        "[latest message]",
        currentText,
    ].join("\n");
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
        const taskText = buildTaskWithHistory(context);
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
     * Poll sessions_history until the subagent produces a final assistant message.
     * Uses backoff: 2s, 3s, 4s, then 5s intervals.
     */
    async waitForCompletion(sessionKey, timeoutMs) {
        const gateway = this.gatewayConfig;
        const startTime = Date.now();
        let attempt = 0;
        // Aggressive early polls, then back off: 300ms, 500ms, 1s, 2s, 3s, 3s...
        const pollDelays = [300, 500, 1000, 2000, 3000];
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
            }
            catch (err) {
                this.logger.warn(`[a2a-adapter] poll attempt ${attempt} error: ${err instanceof Error ? err.message : err}`);
            }
        }
        throw new Error(`task timed out after ${Math.round(timeoutMs / 1000)}s waiting for subagent`);
    }
    /**
     * Extract the final assistant response from session history.
     * Returns null if the session is still running.
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
        const messages = (details.messages ?? []);
        if (messages.length === 0)
            return null;
        // If no explicit flag, check the last message for signs of ongoing execution
        if (details.isComplete === undefined) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && Array.isArray(lastMsg.content)) {
                const content = lastMsg.content;
                const hasToolCalls = content.some((c) => c?.type === "toolCall" || c?.type === "tool_use");
                const hasText = content.some((c) => c?.type === "text" && typeof c.text === "string" && c.text.trim());
                if (hasToolCalls && !hasText)
                    return null;
            }
        }
        // Walk backwards to find the last assistant message with text content
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role !== "assistant")
                continue;
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
