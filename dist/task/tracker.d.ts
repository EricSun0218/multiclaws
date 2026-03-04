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
    constructor(opts?: {
        ttlMs?: number;
        maxTasks?: number;
        filePath?: string;
        dbPath?: string;
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
    private loadStore;
    private persist;
    private persistStore;
    private prune;
    private evictOldest;
}
