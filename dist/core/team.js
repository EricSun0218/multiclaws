"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeamManager = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const json_store_1 = require("../utils/json-store");
const DEFAULT_TEAM_STORE_RELATIVE = ".openclaw/multiclaws/teams.json";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function defaultStorePath() {
    return node_path_1.default.join(node_os_1.default.homedir(), DEFAULT_TEAM_STORE_RELATIVE);
}
function randomId(prefix) {
    return `${prefix}_${node_crypto_1.default.randomBytes(6).toString("hex")}`;
}
function generateSecret() {
    return node_crypto_1.default.randomBytes(32).toString("base64url");
}
function encode(data) {
    return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}
function decode(value) {
    try {
        return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    }
    catch {
        return null;
    }
}
function sign(secret, payloadBase64) {
    return node_crypto_1.default.createHmac("sha256", secret).update(payloadBase64).digest("base64url");
}
function readStore(filePath) {
    return (0, json_store_1.readJsonWithFallback)(filePath, {
        version: 1,
        secret: generateSecret(),
        teams: [],
    });
}
class TeamManager {
    filePath;
    constructor(filePath = defaultStorePath()) {
        this.filePath = filePath;
    }
    async createTeam(params) {
        return await (0, json_store_1.withJsonLock)(this.filePath, {
            version: 1,
            secret: generateSecret(),
            teams: [],
        }, async () => {
            const store = await readStore(this.filePath);
            const now = Date.now();
            const team = {
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
            const teams = store.teams.filter((entry) => entry.teamId !== team.teamId);
            teams.push(team);
            await (0, json_store_1.writeJsonAtomically)(this.filePath, {
                version: 1,
                secret: store.secret,
                teams,
            });
            return team;
        });
    }
    async listTeams() {
        const store = await readStore(this.filePath);
        return store.teams;
    }
    async getTeam(teamId) {
        const teams = await this.listTeams();
        return teams.find((entry) => entry.teamId === teamId) ?? null;
    }
    async createInvite(params) {
        const store = await readStore(this.filePath);
        const team = store.teams.find((entry) => entry.teamId === params.teamId);
        if (!team) {
            throw new Error(`unknown team: ${params.teamId}`);
        }
        const payload = {
            v: 1,
            teamId: team.teamId,
            teamName: team.teamName,
            ownerPeerId: params.ownerPeerId,
            ownerAddress: params.ownerAddress,
            issuedAtMs: Date.now(),
            expiresAtMs: Date.now() + INVITE_TTL_MS,
        };
        const payloadB64 = encode(payload);
        const signature = sign(store.secret, payloadB64);
        return `TEAM-${payloadB64}.${signature}`;
    }
    async parseInvite(inviteCode) {
        const normalized = inviteCode.trim().replace(/^TEAM-/, "");
        const dotIndex = normalized.lastIndexOf(".");
        if (dotIndex < 0) {
            throw new Error("invalid invite code: missing signature");
        }
        const payloadB64 = normalized.slice(0, dotIndex);
        const signature = normalized.slice(dotIndex + 1);
        if (!payloadB64 || !signature) {
            throw new Error("invalid invite code");
        }
        // Structural + expiry validation
        const payload = decode(payloadB64);
        if (!payload ||
            payload.v !== 1 ||
            typeof payload.teamId !== "string" ||
            typeof payload.teamName !== "string" ||
            typeof payload.ownerPeerId !== "string" ||
            typeof payload.ownerAddress !== "string" ||
            typeof payload.issuedAtMs !== "number" ||
            typeof payload.expiresAtMs !== "number") {
            throw new Error("invalid invite payload");
        }
        if (payload.expiresAtMs < Date.now()) {
            throw new Error("invite expired");
        }
        // HMAC verification is only meaningful on the issuing node (owner has
        // the secret).  On a joining node the local secret won't match — that's
        // fine because the real identity guarantee comes from the Ed25519
        // handshake after connecting.  We skip HMAC verification here entirely;
        // use verifyInvite() on the owner node for full HMAC check.
        return payload;
    }
    async verifyInvite(inviteCode) {
        const normalized = inviteCode.trim().replace(/^TEAM-/, "");
        const dotIndex = normalized.lastIndexOf(".");
        if (dotIndex < 0) {
            return false;
        }
        const payloadB64 = normalized.slice(0, dotIndex);
        const signature = normalized.slice(dotIndex + 1);
        if (!payloadB64 || !signature) {
            return false;
        }
        const store = await readStore(this.filePath);
        const expected = sign(store.secret, payloadB64);
        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length || !node_crypto_1.default.timingSafeEqual(sigBuf, expBuf)) {
            return false;
        }
        const payload = decode(payloadB64);
        if (!payload || payload.v !== 1) {
            return false;
        }
        return payload.expiresAtMs >= Date.now();
    }
    async addMember(params) {
        return await (0, json_store_1.withJsonLock)(this.filePath, {
            version: 1,
            secret: generateSecret(),
            teams: [],
        }, async () => {
            const store = await readStore(this.filePath);
            const index = store.teams.findIndex((entry) => entry.teamId === params.teamId);
            if (index < 0) {
                throw new Error(`unknown team: ${params.teamId}`);
            }
            const team = store.teams[index];
            const exists = team.members.some((member) => member.peerId === params.peerId);
            if (!exists) {
                team.members.push({
                    peerId: params.peerId,
                    displayName: params.displayName,
                    address: params.address,
                    joinedAtMs: Date.now(),
                });
            }
            const teams = store.teams.slice();
            teams[index] = team;
            await (0, json_store_1.writeJsonAtomically)(this.filePath, {
                version: 1,
                secret: store.secret,
                teams,
            });
            return team;
        });
    }
    async joinByInvite(params) {
        return await (0, json_store_1.withJsonLock)(this.filePath, {
            version: 1,
            secret: generateSecret(),
            teams: [],
        }, async () => {
            const store = await readStore(this.filePath);
            const now = Date.now();
            const existing = store.teams.find((entry) => entry.teamId === params.invite.teamId) ??
                {
                    teamId: params.invite.teamId,
                    teamName: params.invite.teamName,
                    ownerPeerId: params.invite.ownerPeerId,
                    createdAtMs: params.invite.issuedAtMs,
                    members: [],
                };
            const mergedMembers = [
                ...existing.members,
                {
                    peerId: params.invite.ownerPeerId,
                    displayName: "owner",
                    address: params.invite.ownerAddress,
                    joinedAtMs: params.invite.issuedAtMs,
                },
                {
                    peerId: params.localPeerId,
                    displayName: params.localDisplayName,
                    address: params.localAddress,
                    joinedAtMs: now,
                },
            ];
            const dedupedMembers = Array.from(mergedMembers.reduce((acc, entry) => {
                acc.set(entry.peerId, entry);
                return acc;
            }, new Map()).values());
            const team = {
                ...existing,
                teamName: params.invite.teamName,
                ownerPeerId: params.invite.ownerPeerId,
                members: dedupedMembers,
                localInviteCode: params.inviteCode,
            };
            const teams = store.teams.filter((entry) => entry.teamId !== team.teamId);
            teams.push(team);
            await (0, json_store_1.writeJsonAtomically)(this.filePath, {
                version: 1,
                secret: store.secret,
                teams,
            });
            return team;
        });
    }
    async updateMembers(teamId, members) {
        return await (0, json_store_1.withJsonLock)(this.filePath, {
            version: 1,
            secret: generateSecret(),
            teams: [],
        }, async () => {
            const store = await readStore(this.filePath);
            const index = store.teams.findIndex((entry) => entry.teamId === teamId);
            if (index < 0) {
                throw new Error(`unknown team: ${teamId}`);
            }
            const team = { ...store.teams[index], members };
            const teams = store.teams.slice();
            teams[index] = team;
            await (0, json_store_1.writeJsonAtomically)(this.filePath, {
                version: 1,
                secret: store.secret,
                teams,
            });
            return team;
        });
    }
    async leaveTeam(params) {
        return await (0, json_store_1.withJsonLock)(this.filePath, {
            version: 1,
            secret: generateSecret(),
            teams: [],
        }, async () => {
            const store = await readStore(this.filePath);
            const index = store.teams.findIndex((entry) => entry.teamId === params.teamId);
            if (index < 0) {
                return null;
            }
            const team = store.teams[index];
            team.members = team.members.filter((member) => member.peerId !== params.peerId);
            const teams = store.teams.slice();
            if (team.members.length === 0) {
                teams.splice(index, 1);
            }
            else {
                teams[index] = team;
            }
            await (0, json_store_1.writeJsonAtomically)(this.filePath, {
                version: 1,
                secret: store.secret,
                teams,
            });
            return team.members.length === 0 ? null : team;
        });
    }
}
exports.TeamManager = TeamManager;
