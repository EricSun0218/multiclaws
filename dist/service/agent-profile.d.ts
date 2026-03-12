import type { BasicLogger } from "../infra/logger";
export type AgentProfile = {
    ownerName: string;
    /** Free-form markdown describing this agent: role, capabilities, data sources, etc. */
    bio: string;
};
export declare function renderProfileDescription(profile: AgentProfile): string;
export declare class ProfileStore {
    private readonly filePath;
    private readonly logger?;
    constructor(filePath: string, logger?: BasicLogger | undefined);
    private log;
    load(): Promise<AgentProfile>;
    save(profile: AgentProfile): Promise<void>;
    update(patch: Partial<AgentProfile>): Promise<AgentProfile>;
}
