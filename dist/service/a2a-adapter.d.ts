import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { type GatewayConfig } from "../infra/gateway-client";
import type { TaskTracker } from "../task/tracker";
import type { NotificationTarget } from "./multiclaws-service";
export type A2AAdapterOptions = {
    gatewayConfig: GatewayConfig | null;
    taskTracker: TaskTracker;
    cwd?: string;
    getNotificationTargets?: () => ReadonlyMap<string, NotificationTarget>;
    /** Called when a session is discovered via fallback; allows service to cache it for future use. */
    registerDiscoveredTarget?: (sessionKey: string) => void;
    logger: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
};
/**
 * Bridges the A2A protocol to OpenClaw's session injection mechanism.
 *
 * When a remote agent sends a task via A2A `message/send`,
 * this executor:
 * 1. Classifies the task risk (safe vs risky)
 * 2. For risky tasks: pushes approval request to the user's active session and waits
 *    For safe tasks: proceeds immediately
 * 3. Finds the target session (where user last sent a message, or main session)
 * 4. Injects the task into that session via sessions_send — no isolated sub-session created
 * 5. Waits for the session AI to call back via `multiclaws_a2a_callback`
 * 6. Returns the final result as a Message
 */
export declare class OpenClawAgentExecutor implements AgentExecutor {
    private gatewayConfig;
    private readonly taskTracker;
    private readonly getNotificationTargets;
    private readonly registerDiscoveredTarget;
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
    /**
     * Find the best target session for task injection:
     * 1. Prefer the session where the user most recently sent a message (role === "user")
     * 2. Fall back to the first non-internal active session (typically the main webchat session)
     * Never returns internal sessions (delegate-*, a2a-*).
     */
    private findTargetSession;
    /**
     * Discover the most recently active non-internal session via sessions_list.
     * Used as fallback when no notification targets have been registered yet
     * (e.g. right after a gateway restart before the user sends their first message).
     */
    private discoverActiveSession;
    /** Send a notification to all known targets. Individual failures are silently ignored. */
    private notifyUser;
    private publishMessage;
}
