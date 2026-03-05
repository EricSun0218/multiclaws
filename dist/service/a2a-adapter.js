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
 * 3. Publishes the result back via ExecutionEventBus
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
            this.publishStatusUpdate(eventBus, taskId, context.contextId, "failed");
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
        // 2. Execute via gateway
        this.publishStatusUpdate(eventBus, taskId, context.contextId, "working");
        if (!this.gatewayConfig) {
            this.logger.error("[a2a-adapter] gateway config not available, cannot execute task");
            this.publishStatusUpdate(eventBus, taskId, context.contextId, "failed");
            eventBus.finished();
            return;
        }
        try {
            const result = await (0, gateway_client_1.invokeGatewayTool)({
                gateway: this.gatewayConfig,
                tool: "sessions_spawn",
                args: {
                    sessionKey: `multiclaws-task-${taskId}`,
                    task: taskText,
                    mode: "run",
                },
                timeoutMs: 120_000,
            });
            const output = (0, gateway_client_1.parseSpawnTaskResult)(result);
            // 3. Publish result
            this.taskTracker.update(taskId, { status: "completed", result: output });
            const artifact = {
                kind: "artifact-update",
                taskId,
                contextId: context.contextId,
                artifact: {
                    artifactId: `result-${taskId}`,
                    parts: [{ kind: "text", text: output }],
                },
                lastChunk: true,
            };
            eventBus.publish(artifact);
            this.publishStatusUpdate(eventBus, taskId, context.contextId, "completed");
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this.logger.error(`[a2a-adapter] task execution failed: ${errorMsg}`);
            this.taskTracker.update(taskId, { status: "failed", error: errorMsg });
            this.publishStatusUpdate(eventBus, taskId, context.contextId, "failed");
        }
        eventBus.finished();
    }
    async cancelTask(taskId, eventBus) {
        this.taskTracker.update(taskId, { status: "failed", error: "canceled" });
        const cancelEvent = {
            kind: "status-update",
            taskId,
            contextId: "",
            status: { state: "canceled", timestamp: new Date().toISOString() },
            final: true,
        };
        eventBus.publish(cancelEvent);
        eventBus.finished();
    }
    updateGatewayConfig(config) {
        this.gatewayConfig = config;
    }
    publishStatusUpdate(eventBus, taskId, contextId, state) {
        const event = {
            kind: "status-update",
            taskId,
            contextId,
            status: { state: state, timestamp: new Date().toISOString() },
            final: state === "completed" || state === "failed" || state === "canceled" || state === "rejected",
        };
        eventBus.publish(event);
    }
}
exports.OpenClawAgentExecutor = OpenClawAgentExecutor;
