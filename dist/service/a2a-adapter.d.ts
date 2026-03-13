import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { type GatewayConfig } from "../infra/gateway-client";
import type { TaskTracker } from "../task/tracker";
import type { NotificationTarget } from "./multiclaws-service";
export type A2AAdapterOptions = {
    gatewayConfig: GatewayConfig | null;
    taskTracker: TaskTracker;
    cwd?: string;
    getNotificationTargets?: () => ReadonlyMap<string, NotificationTarget>;
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
 * 1. Classifies the task risk (safe vs risky)
 * 2. Notifies the local human owner
 * 3. For risky tasks: waits for explicit human approval
 *    For safe tasks: executes immediately
 * 4. Calls OpenClaw's `sessions_spawn` (run mode) to start execution
 * 5. Waits for the sub-agent to call back via `multiclaws_a2a_callback`
 * 6. Returns the final result as a Message
 */
export declare class OpenClawAgentExecutor implements AgentExecutor {
    private gatewayConfig;
    private readonly taskTracker;
    private readonly getNotificationTargets;
    private readonly logger;
    private readonly cwd;
    private readonly pendingCallbacks;
    private readonly pendingApprovals;
    constructor(options: A2AAdapterOptions);
    execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void>;
    /**
     * Called by the `multiclaws_a2a_callback` tool when a sub-agent reports its result.
     * Returns true if a pending callback was found and resolved.
     */
    resolveCallback(taskId: string, result: string): boolean;
    /**
     * Called when the local human owner approves or rejects a pending risky task.
     * Returns true if a pending approval was found.
     */
    resolveApproval(taskId: string, approved: boolean): boolean;
    cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void>;
    updateGatewayConfig(config: GatewayConfig): void;
    /**
     * Create a pending callback that resolves when the sub-agent reports back,
     * or rejects on timeout.
     */
    private createCallback;
    /**
     * Create a pending approval that resolves when the human owner responds,
     * or rejects on timeout or cancellation.
     */
    private createApprovalCallback;
    /** Send a notification to all known targets. Individual failures are silently ignored. */
    private notifyUser;
    private publishMessage;
}
