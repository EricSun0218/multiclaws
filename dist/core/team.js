"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeamManager = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const peer_id_1 = require("./peer-id");
const json_store_1 = require("../utils/json-store");
const DEFAULT_TEAM_STORE_RELATIVE = ".openclaw/multiclaws/teams.json";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let joseModulePromise = null;
async function loadJose() {
    if (!joseModulePromise) {
        joseModulePromise = Promise.resolve().then(() => __importStar(require("jose")));
    }
    return await joseModulePromise;
}
function defaultStorePath() {
    return node_path_1.default.join(node_os_1.default.homedir(), DEFAULT_TEAM_STORE_RELATIVE);
}
function emptyStore() {
    return {
        version: 1,
        teams: [],
    };
}
function randomId(prefix) {
    return `${prefix}_${node_crypto_1.default.randomBytes(6).toString("hex")}`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeInviteCode(inviteCode) {
    const normalized = inviteCode.trim().replace(/^TEAM-/, "");
    if (!normalized) {
        throw new Error("invalid invite code");
    }
    return normalized;
}
function decodeCompactPayload(token) {
    const parts = token.split(".");
    if (parts.length !== 3) {
        throw new Error("invalid invite code");
    }
    try {
        return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    }
    catch {
        throw new Error("invalid invite payload");
    }
}
function parseInvitePayload(input) {
    if (!isRecord(input)) {
        throw new Error("invalid invite payload");
    }
    const payload = {
        v: input.v,
        teamId: input.teamId,
        teamName: input.teamName,
        ownerPeerId: input.ownerPeerId,
        ownerAddress: input.ownerAddress,
        ownerPublicKey: input.ownerPublicKey,
        issuedAtMs: input.issuedAtMs,
        expiresAtMs: input.expiresAtMs,
    };
    if (payload.v !== 1 ||
        typeof payload.teamId !== "string" ||
        typeof payload.teamName !== "string" ||
        typeof payload.ownerPeerId !== "string" ||
        typeof payload.ownerAddress !== "string" ||
        typeof payload.ownerPublicKey !== "string" ||
        typeof payload.issuedAtMs !== "number" ||
        typeof payload.expiresAtMs !== "number") {
        throw new Error("invalid invite payload");
    }
    if (!payload.teamId || !payload.teamName || !payload.ownerPeerId || !payload.ownerAddress) {
        throw new Error("invalid invite payload");
    }
    if (payload.issuedAtMs > payload.expiresAtMs) {
        throw new Error("invalid invite payload");
    }
    return payload;
}
function normalizeMembers(members) {
    const deduped = new Map();
    for (const member of members) {
        if (!member ||
            typeof member.peerId !== "string" ||
            typeof member.displayName !== "string" ||
            typeof member.address !== "string" ||
            typeof member.joinedAtMs !== "number") {
            continue;
        }
        const normalized = {
            peerId: member.peerId,
            displayName: member.displayName.trim() || member.peerId,
            address: member.address.trim(),
            joinedAtMs: member.joinedAtMs,
        };
        const existing = deduped.get(normalized.peerId);
        if (!existing) {
            deduped.set(normalized.peerId, normalized);
            continue;
        }
        deduped.set(normalized.peerId, {
            peerId: normalized.peerId,
            displayName: normalized.displayName,
            address: normalized.address,
            joinedAtMs: Math.min(existing.joinedAtMs, normalized.joinedAtMs),
        });
    }
    return Array.from(deduped.values()).sort((a, b) => a.joinedAtMs - b.joinedAtMs);
}
function normalizeTeam(team) {
    if (!team ||
        typeof team.teamId !== "string" ||
        typeof team.teamName !== "string" ||
        typeof team.ownerPeerId !== "string" ||
        typeof team.createdAtMs !== "number" ||
        !Array.isArray(team.members)) {
        return null;
    }
    return {
        teamId: team.teamId,
        teamName: team.teamName.trim(),
        ownerPeerId: team.ownerPeerId,
        createdAtMs: team.createdAtMs,
        localInviteCode: typeof team.localInviteCode === "string" ? team.localInviteCode : undefined,
        members: normalizeMembers(team.members),
    };
}
function normalizeStore(raw) {
    const teamsRaw = Array.isArray(raw?.teams) ? raw.teams : [];
    const teams = [];
    for (const team of teamsRaw) {
        const normalized = normalizeTeam(team);
        if (normalized) {
            teams.push(normalized);
        }
    }
    return {
        version: 1,
        teams,
    };
}
function upsertMemberPreserveJoinedAt(members, member) {
    const index = members.findIndex((item) => item.peerId === member.peerId);
    if (index < 0) {
        return normalizeMembers([...members, member]);
    }
    const next = [...members];
    next[index] = {
        ...next[index],
        displayName: member.displayName,
        address: member.address,
    };
    return normalizeMembers(next);
}
function upsertMemberMinJoinedAt(members, member) {
    const index = members.findIndex((item) => item.peerId === member.peerId);
    if (index < 0) {
        return normalizeMembers([...members, member]);
    }
    const next = [...members];
    next[index] = {
        ...next[index],
        displayName: member.displayName,
        address: member.address,
        joinedAtMs: Math.min(next[index].joinedAtMs, member.joinedAtMs),
    };
    return normalizeMembers(next);
}
class TeamManager {
    filePath;
    constructor(filePath = defaultStorePath()) {
        this.filePath = filePath;
    }
    async readStore() {
        const raw = await (0, json_store_1.readJsonWithFallback)(this.filePath, emptyStore());
        return normalizeStore(raw);
    }
    async mutate(fn) {
        return await (0, json_store_1.withJsonLock)(this.filePath, emptyStore(), async () => {
            const store = await this.readStore();
            const result = await fn(store);
            await (0, json_store_1.writeJsonAtomically)(this.filePath, store);
            return result;
        });
    }
    async createTeam(params) {
        return await this.mutate(async (store) => {
            const now = Date.now();
            const created = {
                teamId: randomId("team"),
                teamName: params.teamName.trim(),
                ownerPeerId: params.ownerPeerId,
                createdAtMs: now,
                members: [
                    {
                        peerId: params.ownerPeerId,
                        displayName: params.ownerDisplayName,
                        address: params.ownerAddress,
                        joinedAtMs: now,
                    },
                ],
            };
            store.teams.push(created);
            return created;
        });
    }
    async listTeams() {
        const store = await this.readStore();
        return [...store.teams].sort((a, b) => b.createdAtMs - a.createdAtMs);
    }
    async getTeam(teamId) {
        const store = await this.readStore();
        return store.teams.find((team) => team.teamId === teamId) ?? null;
    }
    async createInvite(params) {
        const team = await this.getTeam(params.teamId);
        if (!team) {
            throw new Error(`unknown team: ${params.teamId}`);
        }
        const payload = {
            v: 1,
            teamId: team.teamId,
            teamName: team.teamName,
            ownerPeerId: params.ownerPeerId,
            ownerAddress: params.ownerAddress,
            ownerPublicKey: params.ownerPublicKey,
            issuedAtMs: Date.now(),
            expiresAtMs: Date.now() + INVITE_TTL_MS,
        };
        const { SignJWT, importPKCS8 } = await loadJose();
        const privateKey = await importPKCS8(params.ownerPrivateKey, "EdDSA");
        const token = await new SignJWT(payload)
            .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
            .sign(privateKey);
        return `TEAM-${token}`;
    }
    async parseInvite(inviteCode) {
        const compact = normalizeInviteCode(inviteCode);
        const unverifiedPayload = parseInvitePayload(decodeCompactPayload(compact));
        if ((0, peer_id_1.derivePeerId)(unverifiedPayload.ownerPublicKey) !== unverifiedPayload.ownerPeerId) {
            throw new Error("invalid invite payload: ownerPeerId does not match ownerPublicKey");
        }
        const { compactVerify, importSPKI } = await loadJose();
        const ownerPublicKey = await importSPKI(unverifiedPayload.ownerPublicKey, "EdDSA");
        let verifiedPayload;
        try {
            const { payload } = await compactVerify(compact, ownerPublicKey, {
                algorithms: ["EdDSA"],
            });
            verifiedPayload = parseInvitePayload(JSON.parse(Buffer.from(payload).toString("utf8")));
        }
        catch {
            throw new Error("invalid invite signature");
        }
        if (verifiedPayload.expiresAtMs < Date.now()) {
            throw new Error("invite expired");
        }
        return verifiedPayload;
    }
    async verifyInvite(inviteCode) {
        try {
            await this.parseInvite(inviteCode);
            return true;
        }
        catch {
            return false;
        }
    }
    async addMember(params) {
        return await this.mutate(async (store) => {
            const team = store.teams.find((entry) => entry.teamId === params.teamId);
            if (!team) {
                throw new Error(`unknown team: ${params.teamId}`);
            }
            team.members = upsertMemberPreserveJoinedAt(team.members, {
                peerId: params.peerId,
                displayName: params.displayName,
                address: params.address,
                joinedAtMs: Date.now(),
            });
            return team;
        });
    }
    async joinByInvite(params) {
        return await this.mutate(async (store) => {
            let team = store.teams.find((entry) => entry.teamId === params.invite.teamId);
            if (!team) {
                team = {
                    teamId: params.invite.teamId,
                    teamName: params.invite.teamName,
                    ownerPeerId: params.invite.ownerPeerId,
                    createdAtMs: params.invite.issuedAtMs,
                    localInviteCode: params.inviteCode,
                    members: [],
                };
                store.teams.push(team);
            }
            team.teamName = params.invite.teamName;
            team.ownerPeerId = params.invite.ownerPeerId;
            team.localInviteCode = params.inviteCode;
            team.members = upsertMemberMinJoinedAt(team.members, {
                peerId: params.invite.ownerPeerId,
                displayName: "owner",
                address: params.invite.ownerAddress,
                joinedAtMs: params.invite.issuedAtMs,
            });
            team.members = upsertMemberPreserveJoinedAt(team.members, {
                peerId: params.localPeerId,
                displayName: params.localDisplayName,
                address: params.localAddress,
                joinedAtMs: Date.now(),
            });
            return team;
        });
    }
    async updateMembers(teamId, members) {
        return await this.mutate(async (store) => {
            const team = store.teams.find((entry) => entry.teamId === teamId);
            if (!team) {
                throw new Error(`unknown team: ${teamId}`);
            }
            team.members = normalizeMembers(members);
            return team;
        });
    }
    async leaveTeam(params) {
        return await this.mutate(async (store) => {
            const index = store.teams.findIndex((entry) => entry.teamId === params.teamId);
            if (index < 0) {
                return null;
            }
            const team = store.teams[index];
            team.members = team.members.filter((member) => member.peerId !== params.peerId);
            if (team.members.length === 0) {
                store.teams.splice(index, 1);
                return null;
            }
            team.members = normalizeMembers(team.members);
            return team;
        });
    }
    get path() {
        return this.filePath;
    }
    close() {
        // JSON backend has no open handle.
    }
}
exports.TeamManager = TeamManager;
