import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { derivePeerId } from "./peer-id";
import {
  readJsonWithFallback,
  withJsonLock,
  writeJsonAtomically,
} from "../utils/json-store";

const DEFAULT_TEAM_STORE_RELATIVE = ".openclaw/multiclaws/teams.json";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let joseModulePromise: Promise<typeof import("jose")> | null = null;

async function loadJose() {
  if (!joseModulePromise) {
    joseModulePromise = import("jose");
  }
  return await joseModulePromise;
}

export type TeamMember = {
  peerId: string;
  displayName: string;
  address: string;
  joinedAtMs: number;
};

export type TeamRecord = {
  teamId: string;
  teamName: string;
  ownerPeerId: string;
  createdAtMs: number;
  members: TeamMember[];
  /** Stored only on joining nodes — used for subsequent HTTP auth calls. */
  localInviteCode?: string;
};

export type InvitePayload = {
  v: 1;
  teamId: string;
  teamName: string;
  ownerPeerId: string;
  ownerAddress: string;
  ownerPublicKey: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

type TeamStore = {
  version: 1;
  teams: TeamRecord[];
};

type LegacyTeamStore = {
  version: 1;
  secret?: string;
  teams?: TeamRecord[];
};

function defaultStorePath() {
  return path.join(os.homedir(), DEFAULT_TEAM_STORE_RELATIVE);
}

function emptyStore(): TeamStore {
  return {
    version: 1,
    teams: [],
  };
}

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInviteCode(inviteCode: string): string {
  const normalized = inviteCode.trim().replace(/^TEAM-/, "");
  if (!normalized) {
    throw new Error("invalid invite code");
  }
  return normalized;
}

function decodeCompactPayload(token: string): unknown {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid invite code");
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid invite payload");
  }
}

function parseInvitePayload(input: unknown): InvitePayload {
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
  if (
    payload.v !== 1 ||
    typeof payload.teamId !== "string" ||
    typeof payload.teamName !== "string" ||
    typeof payload.ownerPeerId !== "string" ||
    typeof payload.ownerAddress !== "string" ||
    typeof payload.ownerPublicKey !== "string" ||
    typeof payload.issuedAtMs !== "number" ||
    typeof payload.expiresAtMs !== "number"
  ) {
    throw new Error("invalid invite payload");
  }
  if (!payload.teamId || !payload.teamName || !payload.ownerPeerId || !payload.ownerAddress) {
    throw new Error("invalid invite payload");
  }
  if (payload.issuedAtMs > payload.expiresAtMs) {
    throw new Error("invalid invite payload");
  }
  return payload as InvitePayload;
}

function normalizeMembers(members: TeamMember[]): TeamMember[] {
  const deduped = new Map<string, TeamMember>();
  for (const member of members) {
    if (
      !member ||
      typeof member.peerId !== "string" ||
      typeof member.displayName !== "string" ||
      typeof member.address !== "string" ||
      typeof member.joinedAtMs !== "number"
    ) {
      continue;
    }
    const normalized: TeamMember = {
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

function normalizeTeam(team: TeamRecord): TeamRecord | null {
  if (
    !team ||
    typeof team.teamId !== "string" ||
    typeof team.teamName !== "string" ||
    typeof team.ownerPeerId !== "string" ||
    typeof team.createdAtMs !== "number" ||
    !Array.isArray(team.members)
  ) {
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

function normalizeStore(raw: LegacyTeamStore | TeamStore): TeamStore {
  const teamsRaw = Array.isArray(raw?.teams) ? raw.teams : [];
  const teams: TeamRecord[] = [];
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

function upsertMemberPreserveJoinedAt(members: TeamMember[], member: TeamMember): TeamMember[] {
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

function upsertMemberMinJoinedAt(members: TeamMember[], member: TeamMember): TeamMember[] {
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

export class TeamManager {
  constructor(private readonly filePath: string = defaultStorePath()) {}

  private async readStore(): Promise<TeamStore> {
    const raw = await readJsonWithFallback<LegacyTeamStore>(this.filePath, emptyStore());
    return normalizeStore(raw);
  }

  private async mutate<T>(fn: (store: TeamStore) => Promise<T>): Promise<T> {
    return await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const result = await fn(store);
      await writeJsonAtomically(this.filePath, store);
      return result;
    });
  }

  async createTeam(params: {
    teamName: string;
    ownerPeerId: string;
    ownerDisplayName: string;
    ownerAddress: string;
  }): Promise<TeamRecord> {
    return await this.mutate(async (store) => {
      const now = Date.now();
      const created: TeamRecord = {
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

  async listTeams(): Promise<TeamRecord[]> {
    const store = await this.readStore();
    return [...store.teams].sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  async getTeam(teamId: string): Promise<TeamRecord | null> {
    const store = await this.readStore();
    return store.teams.find((team) => team.teamId === teamId) ?? null;
  }

  async createInvite(params: {
    teamId: string;
    ownerPeerId: string;
    ownerAddress: string;
    ownerPublicKey: string;
    ownerPrivateKey: string;
  }): Promise<string> {
    const team = await this.getTeam(params.teamId);
    if (!team) {
      throw new Error(`unknown team: ${params.teamId}`);
    }
    const payload: InvitePayload = {
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
    const token = await new SignJWT(payload as Record<string, unknown>)
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .sign(privateKey);

    return `TEAM-${token}`;
  }

  async parseInvite(inviteCode: string): Promise<InvitePayload> {
    const compact = normalizeInviteCode(inviteCode);

    const unverifiedPayload = parseInvitePayload(decodeCompactPayload(compact));
    if (derivePeerId(unverifiedPayload.ownerPublicKey) !== unverifiedPayload.ownerPeerId) {
      throw new Error("invalid invite payload: ownerPeerId does not match ownerPublicKey");
    }

    const { compactVerify, importSPKI } = await loadJose();
    const ownerPublicKey = await importSPKI(unverifiedPayload.ownerPublicKey, "EdDSA");

    let verifiedPayload: InvitePayload;
    try {
      const { payload } = await compactVerify(compact, ownerPublicKey, {
        algorithms: ["EdDSA"],
      });
      verifiedPayload = parseInvitePayload(JSON.parse(Buffer.from(payload).toString("utf8")));
    } catch {
      throw new Error("invalid invite signature");
    }

    if (verifiedPayload.expiresAtMs < Date.now()) {
      throw new Error("invite expired");
    }

    return verifiedPayload;
  }

  async verifyInvite(inviteCode: string): Promise<boolean> {
    try {
      await this.parseInvite(inviteCode);
      return true;
    } catch {
      return false;
    }
  }

  async addMember(params: {
    teamId: string;
    peerId: string;
    displayName: string;
    address: string;
  }): Promise<TeamRecord> {
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

  async joinByInvite(params: {
    invite: InvitePayload;
    localPeerId: string;
    localDisplayName: string;
    localAddress: string;
    inviteCode: string;
  }): Promise<TeamRecord> {
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

  async updateMembers(teamId: string, members: TeamMember[]): Promise<TeamRecord> {
    return await this.mutate(async (store) => {
      const team = store.teams.find((entry) => entry.teamId === teamId);
      if (!team) {
        throw new Error(`unknown team: ${teamId}`);
      }
      team.members = normalizeMembers(members);
      return team;
    });
  }

  async leaveTeam(params: { teamId: string; peerId: string }): Promise<TeamRecord | null> {
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

  get path(): string {
    return this.filePath;
  }

  close(): void {
    // JSON backend has no open handle.
  }
}
