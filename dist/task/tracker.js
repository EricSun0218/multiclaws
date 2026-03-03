"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskTracker = void 0;
const node_crypto_1 = require("node:crypto");
class TaskTracker {
    tasks = new Map();
    create(params) {
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
}
exports.TaskTracker = TaskTracker;
