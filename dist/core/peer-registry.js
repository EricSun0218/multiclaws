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
function emptyStore() {
    return {
        version: 1,
        peers: [],
    };
}
function normalize(record) {
    return {
        ...record,
        displayName: record.displayName.trim() || record.peerId,
        address: record.address.trim(),
        capabilities: Array.from(new Set(record.capabilities)),
    };
}
function normalizeStore(raw) {
    if (raw.version !== 1 || !Array.isArray(raw.peers)) {
        return emptyStore();
    }
    const peers = [];
    for (const item of raw.peers) {
        if (!item ||
            typeof item.peerId !== "string" ||
            typeof item.displayName !== "string" ||
            typeof item.address !== "string" ||
            typeof item.trustLevel !== "string" ||
            !Array.isArray(item.capabilities) ||
            typeof item.updatedAtMs !== "number") {
            continue;
        }
        peers.push(normalize({
            peerId: item.peerId,
            displayName: item.displayName,
            address: item.address,
            publicKey: typeof item.publicKey === "string" ? item.publicKey : undefined,
            trustLevel: item.trustLevel,
            capabilities: item.capabilities.filter((capability) => typeof capability === "string"),
            lastSeenAtMs: typeof item.lastSeenAtMs === "number" ? item.lastSeenAtMs : undefined,
            updatedAtMs: item.updatedAtMs,
        }));
    }
    return {
        version: 1,
        peers,
    };
}
class PeerRegistry {
    filePath;
    constructor(filePath = defaultStorePath()) {
        this.filePath = filePath;
    }
    async readStore() {
        const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, emptyStore());
        return normalizeStore(store);
    }
    async list() {
        const store = await this.readStore();
        return [...store.peers].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    }
    async get(peerId) {
        const store = await this.readStore();
        return store.peers.find((record) => record.peerId === peerId) ?? null;
    }
    async findByDisplayName(nameOrId) {
        const needle = nameOrId.trim().toLowerCase();
        if (!needle) {
            return null;
        }
        const store = await this.readStore();
        return (store.peers.find((entry) => entry.peerId.toLowerCase() === needle) ??
            store.peers.find((entry) => entry.displayName.toLowerCase() === needle) ??
            null);
    }
    async upsert(record) {
        return await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const now = Date.now();
            const resolved = normalize({ ...record, updatedAtMs: now });
            const index = store.peers.findIndex((item) => item.peerId === resolved.peerId);
            if (index >= 0) {
                store.peers[index] = resolved;
            }
            else {
                store.peers.push(resolved);
            }
            await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
            return resolved;
        });
    }
    async remove(peerId) {
        return await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const before = store.peers.length;
            store.peers = store.peers.filter((entry) => entry.peerId !== peerId);
            const changed = store.peers.length !== before;
            if (changed) {
                await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
            }
            return changed;
        });
    }
    async setTrust(peerId, trustLevel) {
        return await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const index = store.peers.findIndex((item) => item.peerId === peerId);
            if (index < 0) {
                return null;
            }
            const next = {
                ...store.peers[index],
                trustLevel,
                updatedAtMs: Date.now(),
            };
            store.peers[index] = next;
            await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
            return next;
        });
    }
    async touchSeen(peerId) {
        await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const index = store.peers.findIndex((item) => item.peerId === peerId);
            if (index < 0) {
                return;
            }
            const now = Date.now();
            store.peers[index] = {
                ...store.peers[index],
                lastSeenAtMs: now,
                updatedAtMs: now,
            };
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
exports.PeerRegistry = PeerRegistry;
