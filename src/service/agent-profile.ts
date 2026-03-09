import { readJsonWithFallback, writeJsonAtomically } from "../infra/json-store";

export type AgentProfile = {
  ownerName: string;
  /** Free-form markdown describing this agent: role, capabilities, data sources, etc. */
  bio: string;
};

function emptyProfile(): AgentProfile {
  return { ownerName: "", bio: "" };
}

export function renderProfileDescription(profile: AgentProfile): string {
  const parts: string[] = [];
  if (profile.ownerName) parts.push(profile.ownerName);
  if (profile.bio) parts.push(profile.bio);
  return parts.join("\n\n") || "OpenClaw agent";
}

export class ProfileStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<AgentProfile> {
    const raw = await readJsonWithFallback<Record<string, unknown>>(this.filePath, {});
    // Migrate legacy profile format (role/description/dataSources/capabilities → bio)
    if (typeof raw.bio !== "string") {
      const parts: string[] = [];
      if (typeof raw.role === "string" && raw.role) parts.push(`**Role:** ${raw.role}`);
      if (typeof raw.description === "string" && raw.description) parts.push(raw.description);
      if (Array.isArray(raw.capabilities) && raw.capabilities.length > 0) {
        const caps = (raw.capabilities as Array<{ tag: string; description?: string }>)
          .map((c) => (c.description ? `- ${c.tag}: ${c.description}` : `- ${c.tag}`))
          .join("\n");
        parts.push(`**Capabilities:**\n${caps}`);
      }
      if (Array.isArray(raw.dataSources) && raw.dataSources.length > 0) {
        const sources = (raw.dataSources as Array<{ name: string; description?: string }>)
          .map((s) => (s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`))
          .join("\n");
        parts.push(`**Data Sources:**\n${sources}`);
      }
      raw.bio = parts.join("\n\n");
    }
    return {
      ownerName: typeof raw.ownerName === "string" ? raw.ownerName : "",
      bio: typeof raw.bio === "string" ? raw.bio : "",
    };
  }

  async save(profile: AgentProfile): Promise<void> {
    await writeJsonAtomically(this.filePath, profile);
  }

  async update(patch: Partial<AgentProfile>): Promise<AgentProfile> {
    const profile = await this.load();
    if (patch.ownerName !== undefined) profile.ownerName = patch.ownerName;
    if (patch.bio !== undefined) profile.bio = patch.bio;
    await this.save(profile);
    return profile;
  }
}
