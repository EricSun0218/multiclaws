import { readJsonWithFallback, withJsonLock, writeJsonAtomically } from "../infra/json-store";

export type AgentRecord = {
  url: string;
  name: string;
  description: string;
  skills: string[];
  apiKey?: string;
  addedAtMs: number;
  lastSeenAtMs: number;
  /** Which teams synced this agent. Empty or undefined = manually added. */
  teamIds?: string[];
};

type AgentRegistryStore = {
  version: 1;
  agents: AgentRecord[];
};

function emptyStore(): AgentRegistryStore {
  return { version: 1, agents: [] };
}

function normalizeStore(raw: AgentRegistryStore): AgentRegistryStore {
  if (raw.version !== 1 || !Array.isArray(raw.agents)) {
    return emptyStore();
  }
  return {
    version: 1,
    agents: raw.agents.filter(
      (a) =>
        a &&
        typeof a.url === "string" &&
        typeof a.name === "string" &&
        typeof a.addedAtMs === "number",
    ),
  };
}

export class AgentRegistry {
  constructor(private readonly filePath: string) {}

  private async readStore(): Promise<AgentRegistryStore> {
    const store = await readJsonWithFallback<AgentRegistryStore>(this.filePath, emptyStore());
    return normalizeStore(store);
  }

  async add(params: {
    url: string;
    name: string;
    description?: string;
    skills?: string[];
    apiKey?: string;
  }): Promise<AgentRecord> {
    return await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const normalizedUrl = params.url.replace(/\/+$/, "");
      const existing = store.agents.findIndex((a) => a.url === normalizedUrl);

      const now = Date.now();
      const record: AgentRecord = {
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
      } else {
        store.agents.push(record);
      }

      await writeJsonAtomically(this.filePath, store);
      return record;
    });
  }

  async remove(url: string): Promise<boolean> {
    return await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const normalizedUrl = url.replace(/\/+$/, "");
      const before = store.agents.length;
      store.agents = store.agents.filter((a) => a.url !== normalizedUrl);
      if (store.agents.length === before) {
        return false;
      }
      await writeJsonAtomically(this.filePath, store);
      return true;
    });
  }

  async list(): Promise<AgentRecord[]> {
    const store = await this.readStore();
    return [...store.agents].sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs);
  }

  async get(url: string): Promise<AgentRecord | null> {
    const store = await this.readStore();
    const normalizedUrl = url.replace(/\/+$/, "");
    return store.agents.find((a) => a.url === normalizedUrl) ?? null;
  }

  async addTeamSource(url: string, teamId: string): Promise<void> {
    await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const normalizedUrl = url.replace(/\/+$/, "");
      const agent = store.agents.find((a) => a.url === normalizedUrl);
      if (agent) {
        const teams = new Set(agent.teamIds ?? []);
        teams.add(teamId);
        agent.teamIds = [...teams];
        await writeJsonAtomically(this.filePath, store);
      }
    });
  }

  /**
   * Remove a team source from an agent. Returns true if the agent
   * was fully removed (no remaining sources), false otherwise.
   * Manually-added agents (no teamIds) are never removed by this method.
   */
  async removeTeamSource(url: string, teamId: string): Promise<boolean> {
    return await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const normalizedUrl = url.replace(/\/+$/, "");
      const agent = store.agents.find((a) => a.url === normalizedUrl);
      if (!agent) return false;

      // Agent was manually added (no team tracking) — never auto-remove
      if (!agent.teamIds || agent.teamIds.length === 0) return false;

      const teams = new Set(agent.teamIds);
      teams.delete(teamId);

      if (teams.size === 0) {
        // No team sources remain — remove entirely
        store.agents = store.agents.filter((a) => a.url !== normalizedUrl);
        await writeJsonAtomically(this.filePath, store);
        return true;
      }

      agent.teamIds = [...teams];
      await writeJsonAtomically(this.filePath, store);
      return false;
    });
  }

  async updateDescription(url: string, description: string): Promise<void> {
    await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const normalizedUrl = url.replace(/\/+$/, "");
      const agent = store.agents.find((a) => a.url === normalizedUrl);
      if (agent) {
        agent.description = description;
        agent.lastSeenAtMs = Date.now();
        await writeJsonAtomically(this.filePath, store);
      }
    });
  }

  async updateLastSeen(url: string): Promise<void> {
    await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const normalizedUrl = url.replace(/\/+$/, "");
      const agent = store.agents.find((a) => a.url === normalizedUrl);
      if (agent) {
        agent.lastSeenAtMs = Date.now();
        await writeJsonAtomically(this.filePath, store);
      }
    });
  }
}
