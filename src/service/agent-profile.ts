import { readJsonWithFallback, writeJsonAtomically } from "../infra/json-store";

export type DataSource = {
  type: string;
  name: string;
  description?: string;
};

/**
 * 能力/领域标签：描述该 OpenClaw 能处理哪类任务（如财务、前端、数据分析等）。
 * 用于协作时默认找谁：同队成员做财务相关任务会优先找 profile 里带财务能力的人。
 * 可由安装的插件、配置的 skill、数据源等自动或手动维护。
 */
export type Capability = {
  /** 领域或能力标签，如 "finance"、"frontend"、"data-analysis" */
  tag: string;
  /** 可选简短说明，如 "财务相关技能与数据" */
  description?: string;
};

export type AgentProfile = {
  ownerName: string;
  role: string;
  description?: string;
  dataSources: DataSource[];
  /** 该 agent 能处理的领域/能力（独有数据），用于任务分配时默认选人 */
  capabilities: Capability[];
};

function emptyProfile(): AgentProfile {
  return { ownerName: "", role: "", dataSources: [], capabilities: [] };
}

export function renderProfileDescription(profile: AgentProfile): string {
  const parts: string[] = [];

  if (profile.ownerName && profile.role) {
    parts.push(`${profile.ownerName}, ${profile.role}`);
  } else if (profile.ownerName) {
    parts.push(profile.ownerName);
  } else if (profile.role) {
    parts.push(profile.role);
  }

  if (profile.description) {
    parts.push(profile.description);
  }

  const caps = profile.capabilities ?? [];
  if (caps.length > 0) {
    const capStr = caps
      .map((c) => (c.description ? `${c.tag} (${c.description})` : c.tag))
      .join(", ");
    parts.push(`capabilities: ${capStr}`);
  }

  if (profile.dataSources.length > 0) {
    const sources = profile.dataSources
      .map((s) => (s.description ? `${s.name} (${s.description})` : s.name))
      .join(", ");
    parts.push(`data sources: ${sources}`);
  }

  return parts.join(". ") || "OpenClaw agent";
}

export class ProfileStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<AgentProfile> {
    const raw = await readJsonWithFallback<AgentProfile>(this.filePath, emptyProfile());
    if (!Array.isArray(raw.capabilities)) raw.capabilities = [];
    return raw;
  }

  async save(profile: AgentProfile): Promise<void> {
    await writeJsonAtomically(this.filePath, profile);
  }

  async update(
    patch: Partial<Omit<AgentProfile, "dataSources" | "capabilities">>,
  ): Promise<AgentProfile> {
    const profile = await this.load();
    if (patch.ownerName !== undefined) profile.ownerName = patch.ownerName;
    if (patch.role !== undefined) profile.role = patch.role;
    if (patch.description !== undefined) profile.description = patch.description;
    await this.save(profile);
    return profile;
  }

  async addDataSource(source: DataSource): Promise<AgentProfile> {
    const profile = await this.load();
    const idx = profile.dataSources.findIndex(
      (s) => s.name.toLowerCase() === source.name.toLowerCase(),
    );
    if (idx >= 0) {
      profile.dataSources[idx] = source;
    } else {
      profile.dataSources.push(source);
    }
    await this.save(profile);
    return profile;
  }

  async removeDataSource(name: string): Promise<AgentProfile> {
    const profile = await this.load();
    profile.dataSources = profile.dataSources.filter(
      (s) => s.name.toLowerCase() !== name.toLowerCase(),
    );
    await this.save(profile);
    return profile;
  }

  async addCapability(cap: Capability): Promise<AgentProfile> {
    const profile = await this.load();
    if (!profile.capabilities) profile.capabilities = [];
    const tagLower = cap.tag.toLowerCase();
    const idx = profile.capabilities.findIndex((c) => c.tag.toLowerCase() === tagLower);
    if (idx >= 0) {
      profile.capabilities[idx] = cap;
    } else {
      profile.capabilities.push(cap);
    }
    await this.save(profile);
    return profile;
  }

  async removeCapability(tag: string): Promise<AgentProfile> {
    const profile = await this.load();
    if (!profile.capabilities) profile.capabilities = [];
    profile.capabilities = profile.capabilities.filter(
      (c) => c.tag.toLowerCase() !== tag.toLowerCase(),
    );
    await this.save(profile);
    return profile;
  }
}
