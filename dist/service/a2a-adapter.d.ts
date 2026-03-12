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
    constructor(options: A2AAdapterOptions);
    execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void>;
    /**
     * Poll sessions_history until the subagent session completes.
     * Collects ALL assistant text messages and returns them joined.
     */
    private waitForCompletion;
    /**
     * Extract all assistant text from session history once the session is complete.
     * Returns null if the session is still running.
     * Returns all assistant text messages joined (not just the last one).
     *
     * Gateway /tools/invoke returns: { content: [...], details: { messages: [...], isComplete?: boolean } }
     */
    private extractCompletedResult;
    /** Extract text content from a single history message. */
    private extractTextFromHistoryMessage;
    cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void>;
    updateGatewayConfig(config: GatewayConfig): void;
    /** Send a notification to the local user via the gateway message tool. */
    private notifyUser;
    private publishMessage;
}
