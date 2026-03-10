"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStore = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = __importDefault(require("node:fs"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_SESSIONS = 1_000;
const MAX_MESSAGES_PER_SESSION = 200;
function emptyStore() {
    return { version: 1, sessions: [] };
}
function normalizeStore(raw) {
    if (raw.version !== 1 || !Array.isArray(raw.sessions)) {
        return emptyStore();
    }
    return {
        version: 1,
        sessions: raw.sessions.filter((s) => s &&
            typeof s.sessionId === "string" &&
            typeof s.agentUrl === "string" &&
            typeof s.status === "string" &&
            typeof s.createdAtMs === "number" &&
            Array.isArray(s.messages)),
    };
}
class SessionStore {
    filePath;
    ttlMs;
    store;
    persistPending = false;
    constructor(opts) {
        this.filePath = opts.filePath;
        this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
        this.store = this.loadSync();
    }
    create(params) {
        this.prune();
        const now = Date.now();
        const session = {
            sessionId: (0, node_crypto_1.randomUUID)(),
            agentUrl: params.agentUrl,
            agentName: params.agentName,
            contextId: params.contextId,
            status: "active",
            messages: [],
            createdAtMs: now,
            updatedAtMs: now,
        };
        if (this.store.sessions.length >= MAX_SESSIONS) {
            this.evictOldest();
        }
        this.store.sessions.push(session);
        this.schedulePersist();
        return session;
    }
    get(sessionId) {
        return this.store.sessions.find((s) => s.sessionId === sessionId) ?? null;
    }
    list() {
        return [...this.store.sessions].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    }
    update(sessionId, patch) {
        const idx = this.store.sessions.findIndex((s) => s.sessionId === sessionId);
        if (idx < 0)
            return null;
        const next = {
            ...this.store.sessions[idx],
            ...patch,
            updatedAtMs: Date.now(),
        };
        this.store.sessions[idx] = next;
        this.schedulePersist();
        return next;
    }
    appendMessage(sessionId, msg) {
        const session = this.get(sessionId);
        if (!session)
            return null;
        let messages = [...session.messages, msg];
        // Truncate old messages, keeping the most recent ones
        if (messages.length > MAX_MESSAGES_PER_SESSION) {
            messages = messages.slice(-MAX_MESSAGES_PER_SESSION);
        }
        return this.update(sessionId, { messages });
    }
    loadSync() {
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
            // best-effort
        }
    }
    prune() {
        const cutoff = Date.now() - this.ttlMs;
        this.store.sessions = this.store.sessions.filter((s) => {
            if (s.updatedAtMs >= cutoff)
                return true;
            return s.status !== "completed" && s.status !== "failed" && s.status !== "canceled";
        });
    }
    evictOldest() {
        const removable = [...this.store.sessions]
            .filter((s) => s.status === "completed" || s.status === "failed" || s.status === "canceled")
            .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
            .slice(0, Math.max(1, Math.floor(MAX_SESSIONS / 4)));
        const ids = new Set(removable.map((s) => s.sessionId));
        this.store.sessions = this.store.sessions.filter((s) => !ids.has(s.sessionId));
    }
}
exports.SessionStore = SessionStore;
