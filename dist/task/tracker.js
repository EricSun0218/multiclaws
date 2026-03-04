"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskTracker = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = __importDefault(require("node:fs"));
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
function resolveJsonPath(filePath) {
    const parsed = node_path_1.default.parse(filePath);
    if (parsed.ext === ".json") {
        return filePath;
    }
    if (parsed.ext === ".db" || parsed.ext === ".sqlite") {
        return node_path_1.default.join(parsed.dir, `${parsed.name}.json`);
    }
    return `${filePath}.json`;
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
    constructor(opts) {
        this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
        this.maxTasks = opts?.maxTasks ?? MAX_TASKS;
        this.filePath = resolveJsonPath(opts?.filePath ?? opts?.dbPath ?? ".openclaw/multiclaws/tasks.json");
        this.store = this.loadStore();
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
        this.persist();
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
        this.persist();
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
    loadStore() {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.filePath), { recursive: true });
        try {
            const raw = JSON.parse(node_fs_1.default.readFileSync(this.filePath, "utf8"));
            return normalizeStore(raw);
        }
        catch {
            const store = emptyStore();
            this.persistStore(store);
            return store;
        }
    }
    persist() {
        this.persistStore(this.store);
    }
    persistStore(store) {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        node_fs_1.default.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
        node_fs_1.default.renameSync(tmp, this.filePath);
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
            this.persist();
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
        this.persist();
    }
}
exports.TaskTracker = TaskTracker;
