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
    return await readJsonWithFallback<AgentProfile>(this.filePath, emptyProfile());
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
