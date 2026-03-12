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
 * 2. Calls OpenClaw's `sessions_spawn` (run mode) to start execution
 * 3. Waits for the sub-agent to call back via `multiclaws_a2a_callback`
 * 4. Returns the final result as a Message
 */
class OpenClawAgentExecutor {
    gatewayConfig;
    taskTracker;
    getChannelIds;
    logger;
    cwd;
    pendingCallbacks = new Map();
    constructor(options) {
        this.gatewayConfig = options.gatewayConfig;
        this.taskTracker = options.taskTracker;
        this.getChannelIds = options.getChannelIds ?? (() => new Set());
        this.logger = options.logger;
        this.cwd = options.cwd || process.cwd();
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
        // Notify local user about incoming task
        void this.notifyUser(`📨 收到来自 **${fromAgent}** 的委派任务：${taskText.slice(0, 200)}`);
        try {
            this.logger.info(`[a2a-adapter] executing task ${taskId}: ${taskText.slice(0, 100)}`);
            // Create a promise that resolves when sub-agent calls multiclaws_a2a_callback
            const resultPromise = this.createCallback(taskId, 180_000);
            // Spawn the subagent with instructions to call back when done
            const prompt = buildA2ASubagentPrompt(taskId, taskText);
            await (0, gateway_client_1.invokeGatewayTool)({
                gateway: this.gatewayConfig,
                tool: "sessions_spawn",
                args: {
                    task: prompt,
                    mode: "run",
                    cwd: this.cwd,
                },
                sessionKey: `a2a-${taskId}`,
                timeoutMs: 15_000,
            });
            this.logger.info(`[a2a-adapter] task ${taskId} spawned, waiting for callback...`);
            // Wait for the sub-agent to call back
            const output = await resultPromise;
            // Return result
            this.taskTracker.update(taskId, { status: "completed", result: output });
            this.logger.info(`[a2a-adapter] task ${taskId} completed, resultLen=${output.length}`);
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
     * Called by the `multiclaws_a2a_callback` tool when a sub-agent reports its result.
     * Returns true if a pending callback was found and resolved.
     */
    resolveCallback(taskId, result) {
        const pending = this.pendingCallbacks.get(taskId);
        if (!pending)
            return false;
        clearTimeout(pending.timer);
        this.pendingCallbacks.delete(taskId);
        pending.resolve(result);
        return true;
    }
    async cancelTask(taskId, eventBus) {
        this.logger.info(`[a2a-adapter] cancelTask(taskId=${taskId})`);
        // Reject pending callback if any
        const pending = this.pendingCallbacks.get(taskId);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingCallbacks.delete(taskId);
            pending.reject(new Error("canceled"));
        }
        this.taskTracker.update(taskId, { status: "failed", error: "canceled" });
        this.publishMessage(eventBus, "Task was canceled.");
        eventBus.finished();
    }
    updateGatewayConfig(config) {
        this.gatewayConfig = config;
    }
    /**
     * Create a pending callback that resolves when the sub-agent reports back,
     * or rejects on timeout.
     */
    createCallback(taskId, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingCallbacks.delete(taskId);
                reject(new Error(`task timed out after ${timeoutMs / 1000}s waiting for sub-agent callback`));
            }, timeoutMs);
            this.pendingCallbacks.set(taskId, { resolve, reject, timer });
        });
    }
    /** Send a notification to all known channels. Individual failures are silently ignored. */
    async notifyUser(message) {
        const channels = this.getChannelIds();
        if (!this.gatewayConfig || channels.size === 0)
            return;
        await Promise.allSettled([...channels].map((target) => (0, gateway_client_1.invokeGatewayTool)({
            gateway: this.gatewayConfig,
            tool: "message",
            args: { action: "send", target, message },
            timeoutMs: 5_000,
        })));
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
/**
 * Build the prompt for the sub-agent that handles an incoming A2A task.
 * The sub-agent must call `multiclaws_a2a_callback` to report its result.
 */
function buildA2ASubagentPrompt(taskId, taskText) {
    return `你收到了一个来自远端智能体的委派任务。请完成任务并汇报结果。

## 任务内容

${taskText}

## 完成后必做

完成任务后，你**必须**调用 \`multiclaws_a2a_callback\` 工具汇报结果：

\`\`\`
multiclaws_a2a_callback(taskId="${taskId}", result="你的完整回复内容")
\`\`\`

**重要**：
- 无论任务成功还是失败，都必须调用 \`multiclaws_a2a_callback\`
- result 参数填写你的完整回复文本
- 如果任务失败，在 result 中说明失败原因
- 这是唯一的结果回传方式，不调用则结果会丢失`;
}
