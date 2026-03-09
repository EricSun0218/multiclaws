export type TaskStatus = "queued" | "running" | "completed" | "failed";
export type TaskRecord = {
    taskId: string;
    fromPeerId: string;
    toPeerId: string;
    task: string;
    context?: string;
    status: TaskStatus;
    createdAtMs: number;
    updatedAtMs: number;
    result?: string;
    error?: string;
};
export declare class TaskTracker {
    private readonly filePath;
    private readonly ttlMs;
    private readonly maxTasks;
    private readonly store;
    private pruneTimer;
    private persistPending;
    constructor(opts?: {
        ttlMs?: number;
        maxTasks?: number;
        filePath?: string;
    });
    create(params: {
        fromPeerId: string;
        toPeerId: string;
        task: string;
        context?: string;
    }): TaskRecord;
    update(taskId: string, patch: Partial<Omit<TaskRecord, "taskId" | "createdAtMs">>): TaskRecord | null;
    get(taskId: string): TaskRecord | null;
    list(): TaskRecord[];
    destroy(): void;
    /** Sync load at startup — runs once before the event loop is busy. */
    private loadStoreSync;
    /** Coalesce rapid writes into a single async flush. */
    private schedulePersist;
    private persistAsync;
    private prune;
    private evictOldest;
}
