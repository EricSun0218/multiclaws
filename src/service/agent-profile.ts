import { readJsonWithFallback, writeJsonAtomically } from "../infra/json-store";

export type DataSource = {
  type: string;
  name: string;
  description?: string;
};

export type AgentProfile = {
  ownerName: string;
  role: string;
  description?: string;
  dataSources: DataSource[];
};

function emptyProfile(): AgentProfile {
  return { ownerName: "", role: "", dataSources: [] };
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
    return await readJsonWithFallback<AgentProfile>(this.filePath, emptyProfile());
  }

  async save(profile: AgentProfile): Promise<void> {
    await writeJsonAtomically(this.filePath, profile);
  }

  async update(patch: Partial<Omit<AgentProfile, "dataSources">>): Promise<AgentProfile> {
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
}
