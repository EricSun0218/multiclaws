"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionStore = void 0;
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const json_store_1 = require("../utils/json-store");
const DEFAULT_STORE_RELATIVE = ".openclaw/multiclaws/permissions.json";
function defaultStorePath() {
    return node_path_1.default.join(node_os_1.default.homedir(), DEFAULT_STORE_RELATIVE);
}
function emptyStore() {
    return {
        version: 1,
        peers: [],
    };
}
function normalizeStore(raw) {
    if (raw.version !== 1 || !Array.isArray(raw.peers)) {
        return emptyStore();
    }
    return {
        version: 1,
        peers: raw.peers.filter((entry) => entry &&
            typeof entry.peerId === "string" &&
            typeof entry.mode === "string" &&
            typeof entry.updatedAtMs === "number"),
    };
}
class PermissionStore {
    filePath;
    constructor(filePath = defaultStorePath()) {
        this.filePath = filePath;
    }
    async readStore() {
        const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, emptyStore());
        return normalizeStore(store);
    }
    async get(peerId) {
        const store = await this.readStore();
        return store.peers.find((entry) => entry.peerId === peerId) ?? null;
    }
    async list() {
        const store = await this.readStore();
        return [...store.peers].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    }
    async set(peerId, mode) {
        return await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const record = {
                peerId,
                mode,
                updatedAtMs: Date.now(),
            };
            const index = store.peers.findIndex((entry) => entry.peerId === peerId);
            if (index >= 0) {
                store.peers[index] = record;
            }
            else {
                store.peers.push(record);
            }
            await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
            return record;
        });
    }
    async clear(peerId) {
        await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const next = store.peers.filter((entry) => entry.peerId !== peerId);
            if (next.length === store.peers.length) {
                return;
            }
            store.peers = next;
            await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
        });
    }
    get path() {
        return this.filePath;
    }
    close() {
        // JSON backend has no open handle.
    }
}
exports.PermissionStore = PermissionStore;
