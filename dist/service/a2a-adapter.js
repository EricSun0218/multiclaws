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
 * 2. Calls OpenClaw's `sessions_spawn` to execute the task
 * 3. Publishes the result back as a Message via ExecutionEventBus
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
        // 2. Execute via gateway sessions_spawn
        try {
            this.logger.info(`[a2a-adapter] executing task ${taskId}: ${taskText.slice(0, 100)}`);
            const result = await (0, gateway_client_1.invokeGatewayTool)({
                gateway: this.gatewayConfig,
                tool: "sessions_spawn",
                args: {
                    task: taskText,
                    mode: "run",
                },
                timeoutMs: 120_000,
            });
            const output = (0, gateway_client_1.parseSpawnTaskResult)(result);
            // 3. Publish result as a message (ResultManager tracks this via finalMessageResult)
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
