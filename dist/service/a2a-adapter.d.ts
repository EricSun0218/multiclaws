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
 * 2. Calls OpenClaw's `sessions_spawn` (run mode) to execute the task
 * 3. Polls for completion via `sessions_list`
 * 4. Fetches the result via `sessions_history`
 * 5. Publishes the result back as a Message via ExecutionEventBus
 */
export declare class OpenClawAgentExecutor implements AgentExecutor {
    private gatewayConfig;
    private readonly taskTracker;
    private readonly logger;
    constructor(options: A2AAdapterOptions);
    execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void>;
    /**
     * Poll sessions_list until the child session is no longer active,
     * then fetch history to get the final result.
     */
    private pollForResult;
    /**
     * Fetch session history and extract the last assistant message if the session has completed.
     * Returns null if still running.
     */
    private fetchSessionHistory;
    private fetchSessionResult;
    cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void>;
    updateGatewayConfig(config: GatewayConfig): void;
    /**
     * Publish a Message event to the event bus.
     * The A2A SDK's ResultManager picks this up as `finalMessageResult`,
     * which is returned by `getFinalResult()`.
     */
    private publishMessage;
}
