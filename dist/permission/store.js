"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionStore = void 0;
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const json_store_1 = require("../utils/json-store");
const DEFAULT_STORE_RELATIVE = ".openclaw/state/multiclaws/permissions.json";
function defaultStorePath() {
    return node_path_1.default.join(node_os_1.default.homedir(), DEFAULT_STORE_RELATIVE);
}
class PermissionStore {
    filePath;
    constructor(filePath = defaultStorePath()) {
        this.filePath = filePath;
    }
    async get(peerId) {
        const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, {
            version: 1,
            peers: [],
        });
        return store.peers.find((entry) => entry.peerId === peerId) ?? null;
    }
    async list() {
        const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, {
            version: 1,
            peers: [],
        });
        return Array.isArray(store.peers) ? store.peers : [];
    }
    async set(peerId, mode) {
        return await (0, json_store_1.withJsonLock)(this.filePath, {
            version: 1,
            peers: [],
        }, async () => {
            const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, {
                version: 1,
                peers: [],
            });
            const next = {
                peerId,
                mode,
                updatedAtMs: Date.now(),
            };
            const peers = (Array.isArray(store.peers) ? store.peers : []).filter((entry) => entry.peerId !== peerId);
            peers.push(next);
            await (0, json_store_1.writeJsonAtomically)(this.filePath, {
                version: 1,
                peers,
            });
            return next;
        });
    }
    async clear(peerId) {
        await (0, json_store_1.withJsonLock)(this.filePath, {
            version: 1,
            peers: [],
        }, async () => {
            const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, {
                version: 1,
                peers: [],
            });
            const peers = (Array.isArray(store.peers) ? store.peers : []).filter((entry) => entry.peerId !== peerId);
            await (0, json_store_1.writeJsonAtomically)(this.filePath, {
                version: 1,
                peers,
            });
        });
    }
    get path() {
        return this.filePath;
    }
}
exports.PermissionStore = PermissionStore;
