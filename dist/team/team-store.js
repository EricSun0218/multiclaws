"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeamStore = void 0;
exports.encodeInvite = encodeInvite;
exports.decodeInvite = decodeInvite;
const node_crypto_1 = require("node:crypto");
const json_store_1 = require("../infra/json-store");
function emptyStore() {
    return { version: 1, teams: [] };
}
function normalizeStore(raw) {
    if (raw.version !== 1 || !Array.isArray(raw.teams)) {
        return emptyStore();
    }
    return {
        version: 1,
        teams: raw.teams.filter((t) => t &&
            typeof t.teamId === "string" &&
            typeof t.teamName === "string" &&
            Array.isArray(t.members)),
    };
}
// ── Invite code helpers ──────────────────────────────────────────────
const INVITE_PREFIX = "mc:";
function encodeInvite(teamId, seedUrl) {
    const payload = { t: teamId, u: seedUrl };
    return INVITE_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
}
function decodeInvite(code) {
    const trimmed = code.trim();
    const body = trimmed.startsWith(INVITE_PREFIX)
        ? trimmed.slice(INVITE_PREFIX.length)
        : trimmed;
    try {
        const json = Buffer.from(body, "base64url").toString("utf8");
        const parsed = JSON.parse(json);
        if (typeof parsed.t !== "string" || typeof parsed.u !== "string") {
            throw new Error("invalid invite payload");
        }
        return parsed;
    }
    catch {
        throw new Error("invalid invite code");
    }
}
// ── TeamStore ────────────────────────────────────────────────────────
class TeamStore {
    filePath;
    logger;
    constructor(filePath, logger) {
        this.filePath = filePath;
        this.logger = logger;
    }
    log(level, message) {
        const fn = level === "debug" ? this.logger?.debug : this.logger?.[level];
        fn?.(`[team-store] ${message}`);
    }
    async readStore() {
        const store = await (0, json_store_1.readJsonWithFallback)(this.filePath, emptyStore());
        return normalizeStore(store);
    }
    async createTeam(params) {
        this.log("debug", `createTeam(name=${params.teamName})`);
        try {
            const result = await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
                const store = await this.readStore();
                const now = Date.now();
                const record = {
                    teamId: (0, node_crypto_1.randomUUID)(),
                    teamName: params.teamName,
                    selfUrl: params.selfUrl,
                    members: [{ url: params.selfUrl, name: params.selfName, description: params.selfDescription, joinedAtMs: now }],
                    createdAtMs: now,
                };
                store.teams.push(record);
                await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
                return record;
            });
            this.log("debug", `createTeam completed, teamId=${result.teamId}`);
            return result;
        }
        catch (err) {
            this.log("error", `createTeam failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async getTeam(teamId) {
        const store = await this.readStore();
        return store.teams.find((t) => t.teamId === teamId) ?? null;
    }
    async listTeams() {
        const store = await this.readStore();
        return [...store.teams];
    }
    async getFirstTeam() {
        const store = await this.readStore();
        return store.teams[0] ?? null;
    }
    async addMember(teamId, member) {
        this.log("debug", `addMember(teamId=${teamId}, url=${member.url})`);
        try {
            const result = await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
                const store = await this.readStore();
                const team = store.teams.find((t) => t.teamId === teamId);
                if (!team)
                    return false;
                const normalizedUrl = member.url.replace(/\/+$/, "");
                const existing = team.members.findIndex((m) => m.url.replace(/\/+$/, "") === normalizedUrl);
                if (existing >= 0) {
                    team.members[existing].name = member.name;
                    if (member.description !== undefined) {
                        team.members[existing].description = member.description;
                    }
                    team.members[existing].joinedAtMs = member.joinedAtMs;
                }
                else {
                    team.members.push({ ...member, url: normalizedUrl });
                }
                await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
                return true;
            });
            this.log("debug", `addMember completed, result=${result}`);
            return result;
        }
        catch (err) {
            this.log("error", `addMember failed for teamId=${teamId}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async removeMember(teamId, memberUrl) {
        const normalizedUrl = memberUrl.replace(/\/+$/, "");
        this.log("debug", `removeMember(teamId=${teamId}, url=${normalizedUrl})`);
        try {
            const result = await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
                const store = await this.readStore();
                const team = store.teams.find((t) => t.teamId === teamId);
                if (!team)
                    return false;
                const before = team.members.length;
                team.members = team.members.filter((m) => m.url.replace(/\/+$/, "") !== normalizedUrl);
                if (team.members.length === before)
                    return false;
                await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
                return true;
            });
            this.log("debug", `removeMember completed, found=${result}`);
            return result;
        }
        catch (err) {
            this.log("error", `removeMember failed for teamId=${teamId}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async deleteTeam(teamId) {
        this.log("debug", `deleteTeam(teamId=${teamId})`);
        try {
            const result = await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
                const store = await this.readStore();
                const before = store.teams.length;
                store.teams = store.teams.filter((t) => t.teamId !== teamId);
                if (store.teams.length === before)
                    return false;
                await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
                return true;
            });
            this.log("debug", `deleteTeam completed, found=${result}`);
            return result;
        }
        catch (err) {
            this.log("error", `deleteTeam failed for teamId=${teamId}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async saveTeam(team) {
        this.log("debug", `saveTeam(teamId=${team.teamId})`);
        try {
            await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
                const store = await this.readStore();
                const idx = store.teams.findIndex((t) => t.teamId === team.teamId);
                if (idx >= 0) {
                    store.teams[idx] = team;
                }
                else {
                    store.teams.push(team);
                }
                await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
            });
        }
        catch (err) {
            this.log("error", `saveTeam failed for teamId=${team.teamId}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
}
exports.TeamStore = TeamStore;
