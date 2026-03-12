import { readJsonWithFallback, writeJsonAtomically } from "../infra/json-store";
import type { BasicLogger } from "../infra/logger";

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
  constructor(
    private readonly filePath: string,
    private readonly logger?: BasicLogger,
  ) {}

  private log(level: "info" | "warn" | "error" | "debug", message: string): void {
    const fn = level === "debug" ? this.logger?.debug : this.logger?.[level];
    fn?.(`[profile-store] ${message}`);
  }

  async load(): Promise<AgentProfile> {
    return await readJsonWithFallback<AgentProfile>(this.filePath, emptyProfile());
  }

  async save(profile: AgentProfile): Promise<void> {
    this.log("debug", `save(ownerName=${profile.ownerName})`);
    try {
      await writeJsonAtomically(this.filePath, profile);
    } catch (err) {
      this.log("error", `save failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async update(patch: Partial<AgentProfile>): Promise<AgentProfile> {
    this.log("debug", `update(keys=${Object.keys(patch).join(",")})`);
    try {
      const profile = await this.load();
      if (patch.ownerName !== undefined) profile.ownerName = patch.ownerName;
      if (patch.bio !== undefined) profile.bio = patch.bio;
      await this.save(profile);
      this.log("debug", `update completed`);
      return profile;
    } catch (err) {
      this.log("error", `update failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
