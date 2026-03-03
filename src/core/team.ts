import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readJsonWithFallback, withJsonLock, writeJsonAtomically } from "../utils/json-store";

const DEFAULT_TEAM_STORE_RELATIVE = ".openclaw/state/multiclaws/teams.json";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
};

export type InvitePayload = {
  v: 1;
  teamId: string;
  teamName: string;
  ownerPeerId: string;
  ownerAddress: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

type TeamStore = {
  version: 1;
  secret: string;
  teams: TeamRecord[];
};

function defaultStorePath() {
  return path.join(os.homedir(), DEFAULT_TEAM_STORE_RELATIVE);
}

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function generateSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

function encode(data: object): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

function decode<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function sign(secret: string, payloadBase64: string): string {
  return crypto.createHmac("sha256", secret).update(payloadBase64).digest("base64url");
}

function readStore(filePath: string): Promise<TeamStore> {
  return readJsonWithFallback<TeamStore>(filePath, {
    version: 1,
    secret: generateSecret(),
    teams: [],
  });
}

export class TeamManager {
  constructor(private readonly filePath: string = defaultStorePath()) {}

  async createTeam(params: {
    teamName: string;
    ownerPeerId: string;
    ownerDisplayName: string;
    ownerAddress: string;
  }): Promise<TeamRecord> {
    return await withJsonLock(
      this.filePath,
      {
        version: 1,
        secret: generateSecret(),
        teams: [],
      },
      async () => {
        const store = await readStore(this.filePath);
        const now = Date.now();
        const team: TeamRecord = {
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
        await writeJsonAtomically(this.filePath, {
          version: 1,
          secret: store.secret,
          teams,
        });
        return team;
      },
    );
  }

  async listTeams(): Promise<TeamRecord[]> {
    const store = await readStore(this.filePath);
    return store.teams;
  }

  async getTeam(teamId: string): Promise<TeamRecord | null> {
    const teams = await this.listTeams();
    return teams.find((entry) => entry.teamId === teamId) ?? null;
  }

  async createInvite(params: {
    teamId: string;
    ownerPeerId: string;
    ownerAddress: string;
  }): Promise<string> {
    const store = await readStore(this.filePath);
    const team = store.teams.find((entry) => entry.teamId === params.teamId);
    if (!team) {
      throw new Error(`unknown team: ${params.teamId}`);
    }
    const payload: InvitePayload = {
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

  async parseInvite(inviteCode: string): Promise<InvitePayload> {
    const normalized = inviteCode.trim().replace(/^TEAM-/, "");
    const [payloadB64, signature] = normalized.split(".");
    if (!payloadB64 || !signature) {
      throw new Error("invalid invite code");
    }
    const payload = decode<InvitePayload>(payloadB64);
    if (!payload || payload.v !== 1) {
      throw new Error("invalid invite payload");
    }
    if (payload.expiresAtMs < Date.now()) {
      throw new Error("invite expired");
    }
    return payload;
  }

  async verifyInvite(inviteCode: string): Promise<boolean> {
    const normalized = inviteCode.trim().replace(/^TEAM-/, "");
    const [payloadB64, signature] = normalized.split(".");
    if (!payloadB64 || !signature) {
      return false;
    }
    const store = await readStore(this.filePath);
    const expected = sign(store.secret, payloadB64);
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      return false;
    }
    const payload = decode<InvitePayload>(payloadB64);
    if (!payload || payload.v !== 1) {
      return false;
    }
    return payload.expiresAtMs >= Date.now();
  }

  async addMember(params: {
    teamId: string;
    peerId: string;
    displayName: string;
    address: string;
  }): Promise<TeamRecord> {
    return await withJsonLock(
      this.filePath,
      {
        version: 1,
        secret: generateSecret(),
        teams: [],
      },
      async () => {
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
        await writeJsonAtomically(this.filePath, {
          version: 1,
          secret: store.secret,
          teams,
        });
        return team;
      },
    );
  }

  async joinByInvite(params: {
    invite: InvitePayload;
    localPeerId: string;
    localDisplayName: string;
    localAddress: string;
  }): Promise<TeamRecord> {
    return await withJsonLock(
      this.filePath,
      {
        version: 1,
        secret: generateSecret(),
        teams: [],
      },
      async () => {
        const store = await readStore(this.filePath);
        const now = Date.now();
        const existing =
          store.teams.find((entry) => entry.teamId === params.invite.teamId) ??
          ({
            teamId: params.invite.teamId,
            teamName: params.invite.teamName,
            ownerPeerId: params.invite.ownerPeerId,
            createdAtMs: params.invite.issuedAtMs,
            members: [],
          } as TeamRecord);
        const mergedMembers: TeamMember[] = [
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
        const dedupedMembers = Array.from(
          mergedMembers.reduce<Map<string, TeamMember>>((acc, entry) => {
            acc.set(entry.peerId, entry);
            return acc;
          }, new Map()).values(),
        );
        const team: TeamRecord = {
          ...existing,
          teamName: params.invite.teamName,
          ownerPeerId: params.invite.ownerPeerId,
          members: dedupedMembers,
        };
        const teams = store.teams.filter((entry) => entry.teamId !== team.teamId);
        teams.push(team);
        await writeJsonAtomically(this.filePath, {
          version: 1,
          secret: store.secret,
          teams,
        });
        return team;
      },
    );
  }

  async leaveTeam(params: { teamId: string; peerId: string }): Promise<TeamRecord | null> {
    return await withJsonLock(
      this.filePath,
      {
        version: 1,
        secret: generateSecret(),
        teams: [],
      },
      async () => {
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
        } else {
          teams[index] = team;
        }
        await writeJsonAtomically(this.filePath, {
          version: 1,
          secret: store.secret,
          teams,
        });
        return team.members.length === 0 ? null : team;
      },
    );
  }
}
