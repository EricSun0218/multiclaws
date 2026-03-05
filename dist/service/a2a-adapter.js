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
            const spawnResult = await (0, gateway_client_1.invokeGatewayTool)({
                gateway: this.gatewayConfig,
                tool: "sessions_spawn",
                args: {
                    task: taskText,
                    mode: "run",
                    runTimeoutSeconds: 120,
                },
                timeoutMs: 10_000,
            });
            const spawn = spawnResult;
            const childSessionKey = spawn?.childSessionKey;
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
     * Poll sessions_list until the child session is no longer active,
     * then fetch history to get the final result.
     */
    async pollForResult(sessionKey, timeoutMs) {
        const gateway = this.gatewayConfig;
        const startTime = Date.now();
        const pollIntervalMs = 3_000;
        while (Date.now() - startTime < timeoutMs) {
            await sleep(pollIntervalMs);
            try {
                const listResult = await (0, gateway_client_1.invokeGatewayTool)({
                    gateway,
                    tool: "sessions_list",
                    args: {
                        limit: 50,
                        messageLimit: 0,
                    },
                    timeoutMs: 8_000,
                });
                const list = listResult;
                const sessions = (list?.sessions ?? []);
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
            }
            catch (err) {
                this.logger.warn(`[a2a-adapter] poll error: ${err instanceof Error ? err.message : err}`);
            }
        }
        throw new Error(`task timed out after ${timeoutMs}ms`);
    }
    /**
     * Fetch session history and extract the last assistant message if the session has completed.
     * Returns null if still running.
     */
    async fetchSessionHistory(sessionKey) {
        const gateway = this.gatewayConfig;
        const histResult = await (0, gateway_client_1.invokeGatewayTool)({
            gateway,
            tool: "sessions_history",
            args: {
                sessionKey,
                limit: 10,
                includeTools: false,
            },
            timeoutMs: 8_000,
        });
        const hist = histResult;
        const messages = (hist?.messages ?? []);
        if (messages.length === 0)
            return null;
        // Find the last assistant message
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        if (!lastAssistant)
            return null;
        // Extract text content
        const content = lastAssistant.content;
        if (typeof content === "string")
            return content;
        if (Array.isArray(content)) {
            const texts = content
                .filter((c) => c?.type === "text" && typeof c.text === "string")
                .map((c) => c.text);
            if (texts.length > 0)
                return texts.join("\n");
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
    async fetchSessionResult(sessionKey) {
        try {
            const result = await this.fetchSessionHistory(sessionKey);
            return result ?? "Task completed but no result was found.";
        }
        catch {
            return "Task completed but could not fetch result.";
        }
    }
    async cancelTask(taskId, eventBus) {
        this.taskTracker.update(taskId, { status: "failed", error: "canceled" });
        this.publishMessage(eventBus, "Task was canceled.");
        eventBus.finished();
    }
    updateGatewayConfig(config) {
        this.gatewayConfig = config;
    }
    /**
     * Publish a Message event to the event bus.
     * The A2A SDK's ResultManager picks this up as `finalMessageResult`,
     * which is returned by `getFinalResult()`.
     */
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
function extractDirectResult(result) {
    if (!result)
        return undefined;
    if (typeof result.output === "string")
        return result.output;
    if (typeof result.result === "string")
        return result.result;
    if (Array.isArray(result.content)) {
        const texts = result.content
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => c.text);
        if (texts.length > 0)
            return texts.join("\n");
    }
    return undefined;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
