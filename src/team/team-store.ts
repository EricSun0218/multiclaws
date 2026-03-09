import { randomUUID } from "node:crypto";
import { readJsonWithFallback, withJsonLock, writeJsonAtomically } from "../infra/json-store";

export type TeamMember = {
  url: string;
  name: string;
  description?: string;
  joinedAtMs: number;
};

export type TeamRecord = {
  teamId: string;
  teamName: string;
  selfUrl: string;
  members: TeamMember[];
  createdAtMs: number;
};

type TeamStoreData = {
  version: 1;
  teams: TeamRecord[];
};

function emptyStore(): TeamStoreData {
  return { version: 1, teams: [] };
}

function normalizeStore(raw: TeamStoreData): TeamStoreData {
  if (raw.version !== 1 || !Array.isArray(raw.teams)) {
    return emptyStore();
  }
  return {
    version: 1,
    teams: raw.teams.filter(
      (t) =>
        t &&
        typeof t.teamId === "string" &&
        typeof t.teamName === "string" &&
        Array.isArray(t.members),
    ),
  };
}

// ── Invite code helpers ──────────────────────────────────────────────

const INVITE_PREFIX = "mc:";

export type InvitePayload = {
  /** teamId */
  t: string;
  /** seed URL */
  u: string;
};

export function encodeInvite(teamId: string, seedUrl: string): string {
  const payload: InvitePayload = { t: teamId, u: seedUrl };
  return INVITE_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeInvite(code: string): InvitePayload {
  const trimmed = code.trim();
  const body = trimmed.startsWith(INVITE_PREFIX)
    ? trimmed.slice(INVITE_PREFIX.length)
    : trimmed;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as InvitePayload;
    if (typeof parsed.t !== "string" || typeof parsed.u !== "string") {
      throw new Error("invalid invite payload");
    }
    return parsed;
  } catch {
    throw new Error("invalid invite code");
  }
}

// ── TeamStore ────────────────────────────────────────────────────────

export class TeamStore {
  constructor(private readonly filePath: string) {}

  private async readStore(): Promise<TeamStoreData> {
    const store = await readJsonWithFallback<TeamStoreData>(this.filePath, emptyStore());
    return normalizeStore(store);
  }

  async createTeam(params: { teamName: string; selfUrl: string; selfName: string; selfDescription?: string }): Promise<TeamRecord> {
    return await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const now = Date.now();
      const record: TeamRecord = {
        teamId: randomUUID(),
        teamName: params.teamName,
        selfUrl: params.selfUrl,
        members: [{ url: params.selfUrl, name: params.selfName, description: params.selfDescription, joinedAtMs: now }],
        createdAtMs: now,
      };
      store.teams.push(record);
      await writeJsonAtomically(this.filePath, store);
      return record;
    });
  }

  async getTeam(teamId: string): Promise<TeamRecord | null> {
    const store = await this.readStore();
    return store.teams.find((t) => t.teamId === teamId) ?? null;
  }

  async listTeams(): Promise<TeamRecord[]> {
    const store = await this.readStore();
    return [...store.teams];
  }

  async getFirstTeam(): Promise<TeamRecord | null> {
    const store = await this.readStore();
    return store.teams[0] ?? null;
  }

  async addMember(teamId: string, member: TeamMember): Promise<boolean> {
    return await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const team = store.teams.find((t) => t.teamId === teamId);
      if (!team) return false;

      const normalizedUrl = member.url.replace(/\/+$/, "");
      const existing = team.members.findIndex((m) => m.url.replace(/\/+$/, "") === normalizedUrl);
      if (existing >= 0) {
        team.members[existing].name = member.name;
        if (member.description !== undefined) {
          team.members[existing].description = member.description;
        }
        team.members[existing].joinedAtMs = member.joinedAtMs;
      } else {
        team.members.push({ ...member, url: normalizedUrl });
      }

      await writeJsonAtomically(this.filePath, store);
      return true;
    });
  }

  async removeMember(teamId: string, memberUrl: string): Promise<boolean> {
    return await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const team = store.teams.find((t) => t.teamId === teamId);
      if (!team) return false;

      const normalizedUrl = memberUrl.replace(/\/+$/, "");
      const before = team.members.length;
      team.members = team.members.filter((m) => m.url.replace(/\/+$/, "") !== normalizedUrl);
      if (team.members.length === before) return false;

      await writeJsonAtomically(this.filePath, store);
      return true;
    });
  }

  async deleteTeam(teamId: string): Promise<boolean> {
    return await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const before = store.teams.length;
      store.teams = store.teams.filter((t) => t.teamId !== teamId);
      if (store.teams.length === before) return false;
      await writeJsonAtomically(this.filePath, store);
      return true;
    });
  }

  async saveTeam(team: TeamRecord): Promise<void> {
    await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const idx = store.teams.findIndex((t) => t.teamId === team.teamId);
      if (idx >= 0) {
        store.teams[idx] = team;
      } else {
        store.teams.push(team);
      }
      await writeJsonAtomically(this.filePath, store);
    });
  }
}
