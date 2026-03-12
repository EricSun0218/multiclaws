import { readJsonWithFallback, withJsonLock, writeJsonAtomically } from "../infra/json-store";
import type { BasicLogger } from "../infra/logger";

export type AgentRecord = {
  url: string;
  name: string;
  description: string;
  skills: string[];
  apiKey?: string;
  addedAtMs: number;
  lastSeenAtMs: number;
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
  constructor(
    private readonly filePath: string,
    private readonly logger?: BasicLogger,
  ) {}

  private log(level: "info" | "warn" | "error" | "debug", message: string): void {
    const fn = level === "debug" ? this.logger?.debug : this.logger?.[level];
    fn?.(`[agent-registry] ${message}`);
  }

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
    const normalizedUrl = params.url.replace(/\/+$/, "");
    this.log("debug", `add(url=${normalizedUrl}, name=${params.name})`);
    try {
      const result = await withJsonLock(this.filePath, emptyStore(), async () => {
        const store = await this.readStore();
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
      this.log("debug", `add completed, agent=${result.name}`);
      return result;
    } catch (err) {
      this.log("error", `add failed for url=${normalizedUrl}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async remove(url: string): Promise<boolean> {
    const normalizedUrl = url.replace(/\/+$/, "");
    this.log("debug", `remove(url=${normalizedUrl})`);
    try {
      const result = await withJsonLock(this.filePath, emptyStore(), async () => {
        const store = await this.readStore();
        const before = store.agents.length;
        store.agents = store.agents.filter((a) => a.url !== normalizedUrl);
        if (store.agents.length === before) {
          return false;
        }
        await writeJsonAtomically(this.filePath, store);
        return true;
      });
      this.log("debug", `remove completed, found=${result}`);
      return result;
    } catch (err) {
      this.log("error", `remove failed for url=${normalizedUrl}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
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

  async updateDescription(url: string, description: string): Promise<void> {
    const normalizedUrl = url.replace(/\/+$/, "");
    this.log("debug", `updateDescription(url=${normalizedUrl})`);
    try {
      await withJsonLock(this.filePath, emptyStore(), async () => {
        const store = await this.readStore();
        const agent = store.agents.find((a) => a.url === normalizedUrl);
        if (agent) {
          agent.description = description;
          agent.lastSeenAtMs = Date.now();
          await writeJsonAtomically(this.filePath, store);
        }
      });
    } catch (err) {
      this.log("error", `updateDescription failed for url=${normalizedUrl}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
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
