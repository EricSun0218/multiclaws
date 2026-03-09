"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskTracker = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = __importDefault(require("node:fs"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TASKS = 10_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
function emptyStore() {
    return {
        version: 1,
        tasks: [],
    };
}
function normalizeTask(task) {
    if (!task ||
        typeof task.taskId !== "string" ||
        typeof task.fromPeerId !== "string" ||
        typeof task.toPeerId !== "string" ||
        typeof task.task !== "string" ||
        typeof task.status !== "string" ||
        typeof task.createdAtMs !== "number" ||
        typeof task.updatedAtMs !== "number") {
        return null;
    }
    return {
        taskId: task.taskId,
        fromPeerId: task.fromPeerId,
        toPeerId: task.toPeerId,
        task: task.task,
        context: typeof task.context === "string" ? task.context : undefined,
        status: task.status,
        createdAtMs: task.createdAtMs,
        updatedAtMs: task.updatedAtMs,
        result: typeof task.result === "string" ? task.result : undefined,
        error: typeof task.error === "string" ? task.error : undefined,
    };
}
function normalizeStore(raw) {
    if (raw.version !== 1 || !Array.isArray(raw.tasks)) {
        return emptyStore();
    }
    const tasks = [];
    for (const task of raw.tasks) {
        const normalized = normalizeTask(task);
        if (normalized) {
            tasks.push(normalized);
        }
    }
    return {
        version: 1,
        tasks,
    };
}
class TaskTracker {
    filePath;
    ttlMs;
    maxTasks;
    store;
    pruneTimer = null;
    persistPending = false;
    constructor(opts) {
        this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
        this.maxTasks = opts?.maxTasks ?? MAX_TASKS;
        this.filePath = opts?.filePath ?? ".openclaw/multiclaws/tasks.json";
        // Sync load at startup is acceptable (runs once)
        this.store = this.loadStoreSync();
        this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
        if (this.pruneTimer && typeof this.pruneTimer === "object" && "unref" in this.pruneTimer) {
            this.pruneTimer.unref();
        }
    }
    create(params) {
        if (this.store.tasks.length >= this.maxTasks) {
            this.prune();
        }
        if (this.store.tasks.length >= this.maxTasks) {
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
        this.store.tasks.push(record);
        this.schedulePersist();
        return record;
    }
    update(taskId, patch) {
        const index = this.store.tasks.findIndex((entry) => entry.taskId === taskId);
        if (index < 0) {
            return null;
        }
        const next = {
            ...this.store.tasks[index],
            ...patch,
            updatedAtMs: Date.now(),
        };
        this.store.tasks[index] = next;
        this.schedulePersist();
        return next;
    }
    get(taskId) {
        return this.store.tasks.find((entry) => entry.taskId === taskId) ?? null;
    }
    list() {
        return [...this.store.tasks].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    }
    destroy() {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
    }
    /** Sync load at startup — runs once before the event loop is busy. */
    loadStoreSync() {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.filePath), { recursive: true });
        try {
            const raw = JSON.parse(node_fs_1.default.readFileSync(this.filePath, "utf8"));
            return normalizeStore(raw);
        }
        catch {
            const store = emptyStore();
            node_fs_1.default.writeFileSync(this.filePath, JSON.stringify(store, null, 2), "utf8");
            return store;
        }
    }
    /** Coalesce rapid writes into a single async flush. */
    schedulePersist() {
        if (this.persistPending)
            return;
        this.persistPending = true;
        queueMicrotask(() => {
            this.persistPending = false;
            void this.persistAsync();
        });
    }
    async persistAsync() {
        try {
            await promises_1.default.mkdir(node_path_1.default.dirname(this.filePath), { recursive: true });
            const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
            await promises_1.default.writeFile(tmp, JSON.stringify(this.store, null, 2), "utf8");
            await promises_1.default.rename(tmp, this.filePath);
        }
        catch {
            // best-effort persistence — in-memory state is authoritative
        }
    }
    prune() {
        const cutoff = Date.now() - this.ttlMs;
        const before = this.store.tasks.length;
        this.store.tasks = this.store.tasks.filter((task) => {
            if (task.updatedAtMs >= cutoff) {
                return true;
            }
            return task.status !== "completed" && task.status !== "failed";
        });
        if (this.store.tasks.length !== before) {
            this.schedulePersist();
        }
    }
    evictOldest() {
        const removable = [...this.store.tasks]
            .filter((task) => task.status === "completed" || task.status === "failed")
            .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
            .slice(0, Math.max(1, Math.floor(this.maxTasks / 4)));
        if (removable.length === 0) {
            return;
        }
        const removeIds = new Set(removable.map((entry) => entry.taskId));
        this.store.tasks = this.store.tasks.filter((entry) => !removeIds.has(entry.taskId));
        this.schedulePersist();
    }
}
exports.TaskTracker = TaskTracker;
