"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRegistry = void 0;
const json_store_1 = require("../infra/json-store");
function emptyStore() {
    return { version: 1, agents: [] };
}
function normalizeStore(raw) {
    if (raw.version !== 1 || !Array.isArray(raw.agents)) {
        return emptyStore();
    }
    return {
        version: 1,
        agents: raw.agents.filter((a) => a &&
            typeof a.url === "string" &&
            typeof a.name === "string" &&
            typeof a.addedAtMs === "number"),
    };
}
class AgentRegistry {
    filePath;
    logger;
    constructor(filePath, logger) {
        this.filePath = filePath;
        this.logger = logger;
    }
    log(level, message) {
        const fn = level === "debug" ? this.logger?.debug : this.logger?.[level];
        fn?.(`[agent-registry] ${message}`);
    }
    async readStore() {
        const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, emptyStore());
        return normalizeStore(store);
    }
    async add(params) {
        const normalizedUrl = params.url.replace(/\/+$/, "");
        this.log("debug", `add(url=${normalizedUrl}, name=${params.name})`);
        try {
            const result = await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
                const store = await this.readStore();
                const existing = store.agents.findIndex((a) => a.url === normalizedUrl);
                const now = Date.now();
                const record = {
                    url: normalizedUrl,
                    name: params.name,
                    description: params.description ?? "",
                    skills: params.skills ?? [],
                    apiKey: params.apiKey,
                    addedAtMs: existing >= 0 ? store.agents[existing].addedAtMs : now,
                    lastSeenAtMs: now,
                };
                if (existing >= 0) {
                    store.agents[existing] = record;
                }
                else {
                    store.agents.push(record);
                }
                await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
                return record;
            });
            this.log("debug", `add completed, agent=${result.name}`);
            return result;
        }
        catch (err) {
            this.log("error", `add failed for url=${normalizedUrl}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async remove(url) {
        const normalizedUrl = url.replace(/\/+$/, "");
        this.log("debug", `remove(url=${normalizedUrl})`);
        try {
            const result = await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
                const store = await this.readStore();
                const before = store.agents.length;
                store.agents = store.agents.filter((a) => a.url !== normalizedUrl);
                if (store.agents.length === before) {
                    return false;
                }
                await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
                return true;
            });
            this.log("debug", `remove completed, found=${result}`);
            return result;
        }
        catch (err) {
            this.log("error", `remove failed for url=${normalizedUrl}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async list() {
        const store = await this.readStore();
        return [...store.agents].sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs);
    }
    async get(url) {
        const store = await this.readStore();
        const normalizedUrl = url.replace(/\/+$/, "");
        return store.agents.find((a) => a.url === normalizedUrl) ?? null;
    }
    async updateDescription(url, description) {
        const normalizedUrl = url.replace(/\/+$/, "");
        this.log("debug", `updateDescription(url=${normalizedUrl})`);
        try {
            await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
                const store = await this.readStore();
                const agent = store.agents.find((a) => a.url === normalizedUrl);
                if (agent) {
                    agent.description = description;
                    agent.lastSeenAtMs = Date.now();
                    await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
                }
            });
        }
        catch (err) {
            this.log("error", `updateDescription failed for url=${normalizedUrl}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async updateLastSeen(url) {
        await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const normalizedUrl = url.replace(/\/+$/, "");
            const agent = store.agents.find((a) => a.url === normalizedUrl);
            if (agent) {
                agent.lastSeenAtMs = Date.now();
                await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
            }
        });
    }
}
exports.AgentRegistry = AgentRegistry;
