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
    constructor(filePath) {
        this.filePath = filePath;
    }
    async readStore() {
        const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, emptyStore());
        return normalizeStore(store);
    }
    async add(params) {
        return await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const normalizedUrl = params.url.replace(/\/+$/, "");
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
    }
    async remove(url) {
        return await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const normalizedUrl = url.replace(/\/+$/, "");
            const before = store.agents.length;
            store.agents = store.agents.filter((a) => a.url !== normalizedUrl);
            if (store.agents.length === before) {
                return false;
            }
            await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
            return true;
        });
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
    async addTeamSource(url, teamId) {
        await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const normalizedUrl = url.replace(/\/+$/, "");
            const agent = store.agents.find((a) => a.url === normalizedUrl);
            if (agent) {
                const teams = new Set(agent.teamIds ?? []);
                teams.add(teamId);
                agent.teamIds = [...teams];
                await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
            }
        });
    }
    /**
     * Remove a team source from an agent. Returns true if the agent
     * was fully removed (no remaining sources), false otherwise.
     * Manually-added agents (no teamIds) are never removed by this method.
     */
    async removeTeamSource(url, teamId) {
        return await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const normalizedUrl = url.replace(/\/+$/, "");
            const agent = store.agents.find((a) => a.url === normalizedUrl);
            if (!agent)
                return false;
            // Agent was manually added (no team tracking) — never auto-remove
            if (!agent.teamIds || agent.teamIds.length === 0)
                return false;
            const teams = new Set(agent.teamIds);
            teams.delete(teamId);
            if (teams.size === 0) {
                // No team sources remain — remove entirely
                store.agents = store.agents.filter((a) => a.url !== normalizedUrl);
                await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
                return true;
            }
            agent.teamIds = [...teams];
            await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
            return false;
        });
    }
    async updateDescription(url, description) {
        await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const normalizedUrl = url.replace(/\/+$/, "");
            const agent = store.agents.find((a) => a.url === normalizedUrl);
            if (agent) {
                agent.description = description;
                agent.lastSeenAtMs = Date.now();
                await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
            }
        });
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
