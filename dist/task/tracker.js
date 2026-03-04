"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskTracker = void 0;
const node_crypto_1 = require("node:crypto");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TASKS = 10_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
class TaskTracker {
    tasks = new Map();
    ttlMs;
    maxTasks;
    pruneTimer = null;
    constructor(opts) {
        this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
        this.maxTasks = opts?.maxTasks ?? MAX_TASKS;
        this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
        // Allow the timer to not block process exit
        if (this.pruneTimer && typeof this.pruneTimer === "object" && "unref" in this.pruneTimer) {
            this.pruneTimer.unref();
        }
    }
    create(params) {
        if (this.tasks.size >= this.maxTasks) {
            this.prune();
        }
        // If still over limit after prune, evict oldest finished tasks
        if (this.tasks.size >= this.maxTasks) {
            this.evictOldest();
        }
        const now = Date.now();
        const record = {
            taskId: (0, node_crypto_1.randomUUID)(),
            fromPeerId: params.fromPeerId,
            toPeerId: params.toPeerId,
            task: params.task,
            context: params.context,
            status: "queued",
            createdAtMs: now,
            updatedAtMs: now,
        };
        this.tasks.set(record.taskId, record);
        return record;
    }
    update(taskId, patch) {
        const current = this.tasks.get(taskId);
        if (!current) {
            return null;
        }
        const next = {
            ...current,
            ...patch,
            updatedAtMs: Date.now(),
        };
        this.tasks.set(taskId, next);
        return next;
    }
    get(taskId) {
        return this.tasks.get(taskId) ?? null;
    }
    list() {
        return Array.from(this.tasks.values()).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    }
    destroy() {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
        this.tasks.clear();
    }
    prune() {
        const cutoff = Date.now() - this.ttlMs;
        for (const [id, task] of this.tasks) {
            if (task.updatedAtMs < cutoff && (task.status === "completed" || task.status === "failed")) {
                this.tasks.delete(id);
            }
        }
    }
    evictOldest() {
        const sorted = Array.from(this.tasks.entries())
            .filter(([, t]) => t.status === "completed" || t.status === "failed")
            .sort(([, a], [, b]) => a.updatedAtMs - b.updatedAtMs);
        const toRemove = Math.max(1, Math.floor(sorted.length / 4));
        for (let i = 0; i < toRemove && i < sorted.length; i++) {
            this.tasks.delete(sorted[i][0]);
        }
    }
}
exports.TaskTracker = TaskTracker;
