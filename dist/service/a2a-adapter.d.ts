import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { type GatewayConfig } from "../infra/gateway-client";
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
export declare class OpenClawAgentExecutor implements AgentExecutor {
    private gatewayConfig;
    private readonly taskTracker;
    private readonly logger;
    private readonly a2aToTracker;
    constructor(options: A2AAdapterOptions);
    execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void>;
    /**
     * Poll sessions_history until the subagent produces a final assistant message.
     * Uses backoff: 2s, 3s, 4s, then 5s intervals.
     */
    private waitForCompletion;
    /**
     * Extract the final assistant response from session history.
     * Returns null if the session is still running.
     *
     * Gateway /tools/invoke returns: { content: [...], details: { messages: [...], isComplete?: boolean } }
     */
    private extractCompletedResult;
    cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void>;
    updateGatewayConfig(config: GatewayConfig): void;
    private publishMessage;
}
