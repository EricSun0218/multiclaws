"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PeerRegistry = void 0;
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const json_store_1 = require("../utils/json-store");
const DEFAULT_STORE_RELATIVE = ".openclaw/multiclaws/peers.json";
function defaultStorePath() {
    return node_path_1.default.join(node_os_1.default.homedir(), DEFAULT_STORE_RELATIVE);
}
function normalize(record) {
    return {
        ...record,
        displayName: record.displayName.trim() || record.peerId,
        address: record.address.trim(),
        capabilities: Array.from(new Set(record.capabilities)),
    };
}
class PeerRegistry {
    filePath;
    constructor(filePath = defaultStorePath()) {
        this.filePath = filePath;
    }
    async list() {
        const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, {
            version: 1,
            peers: [],
        });
        return Array.isArray(store.peers) ? [...store.peers] : [];
    }
    async get(peerId) {
        const peers = await this.list();
        return peers.find((peer) => peer.peerId === peerId) ?? null;
    }
    async findByDisplayName(nameOrId) {
        const needle = nameOrId.trim().toLowerCase();
        if (!needle) {
            return null;
        }
        const peers = await this.list();
        return (peers.find((peer) => peer.peerId.toLowerCase() === needle) ??
            peers.find((peer) => peer.displayName.toLowerCase() === needle) ??
            null);
    }
    async upsert(record) {
        return await (0, json_store_1.withJsonLock)(this.filePath, {
            version: 1,
            peers: [],
        }, async () => {
            const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, {
                version: 1,
                peers: [],
            });
            const now = Date.now();
            const resolved = normalize({ ...record, updatedAtMs: now });
            const nextPeers = (Array.isArray(store.peers) ? store.peers : []).filter((entry) => entry.peerId !== resolved.peerId);
            nextPeers.push(resolved);
            const nextStore = {
                version: 1,
                peers: nextPeers,
            };
            await (0, json_store_1.writeJsonAtomically)(this.filePath, nextStore);
            return resolved;
        });
    }
    async remove(peerId) {
        return await (0, json_store_1.withJsonLock)(this.filePath, {
            version: 1,
            peers: [],
        }, async () => {
            const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, {
                version: 1,
                peers: [],
            });
            const before = Array.isArray(store.peers) ? store.peers : [];
            const after = before.filter((entry) => entry.peerId !== peerId);
            if (after.length === before.length) {
                return false;
            }
            await (0, json_store_1.writeJsonAtomically)(this.filePath, {
                version: 1,
                peers: after,
            });
            return true;
        });
    }
    async setTrust(peerId, trustLevel) {
        return await (0, json_store_1.withJsonLock)(this.filePath, {
            version: 1,
            peers: [],
        }, async () => {
            const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, {
                version: 1,
                peers: [],
            });
            const peers = Array.isArray(store.peers) ? store.peers : [];
            const index = peers.findIndex((entry) => entry.peerId === peerId);
            if (index < 0) {
                return null;
            }
            const next = { ...peers[index], trustLevel, updatedAtMs: Date.now() };
            const updated = peers.slice();
            updated[index] = next;
            await (0, json_store_1.writeJsonAtomically)(this.filePath, {
                version: 1,
                peers: updated,
            });
            return next;
        });
    }
    async touchSeen(peerId) {
        await (0, json_store_1.withJsonLock)(this.filePath, {
            version: 1,
            peers: [],
        }, async () => {
            const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, {
                version: 1,
                peers: [],
            });
            const peers = Array.isArray(store.peers) ? store.peers : [];
            const index = peers.findIndex((entry) => entry.peerId === peerId);
            if (index < 0) {
                return;
            }
            const updated = peers.slice();
            updated[index] = {
                ...updated[index],
                lastSeenAtMs: Date.now(),
                updatedAtMs: Date.now(),
            };
            await (0, json_store_1.writeJsonAtomically)(this.filePath, {
                version: 1,
                peers: updated,
            });
        });
    }
    get path() {
        return this.filePath;
    }
}
exports.PeerRegistry = PeerRegistry;
