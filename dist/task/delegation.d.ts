import type { TaskTracker } from "./tracker";
import type { PermissionManager } from "../permission/manager";
export type TaskExecutionResult = {
    ok: boolean;
    output?: string;
    error?: string;
};
export type TaskExecutor = (params: {
    task: string;
    context?: string;
    fromPeerId: string;
}) => Promise<TaskExecutionResult>;
export declare class TaskDelegationService {
    private readonly tracker;
    private readonly permissionManager;
    private readonly executor;
    constructor(tracker: TaskTracker, permissionManager: PermissionManager, executor: TaskExecutor);
    acceptDelegatedTask(params: {
        fromPeerId: string;
        fromPeerDisplayName: string;
        task: string;
        context?: string;
    }): Promise<TaskExecutionResult & {
        taskId: string;
    }>;
}
