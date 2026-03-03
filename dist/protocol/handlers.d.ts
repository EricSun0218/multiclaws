import type { MulticlawsMemoryService } from "../memory/multiclaws-query";
import type { TaskDelegationService } from "../task/delegation";
import type { DirectMessagePayload } from "../messaging/direct";
export type TaskCompletedNotification = {
    requesterPeerId: string;
    requestId: string;
    task: string;
    result: {
        ok: boolean;
        taskId: string;
        output?: string;
        error?: string;
    };
};
export type ProtocolHandlerDependencies = {
    memoryService: MulticlawsMemoryService;
    taskService: TaskDelegationService;
    onDirectMessage: (payload: DirectMessagePayload) => Promise<void>;
    onTaskCompleted?: (payload: TaskCompletedNotification) => Promise<void>;
};
export declare class MulticlawsProtocolHandlers {
    private readonly deps;
    constructor(deps: ProtocolHandlerDependencies);
    handleRequest(params: {
        fromPeerId: string;
        fromPeerDisplayName: string;
        method: string;
        requestId: string;
        payload: unknown;
    }): Promise<{
        ok: boolean;
        data?: unknown;
        error?: string;
    }>;
}
