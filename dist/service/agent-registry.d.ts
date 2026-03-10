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
export declare class AgentRegistry {
    private readonly filePath;
    constructor(filePath: string);
    private readStore;
    add(params: {
        url: string;
        name: string;
        description?: string;
        skills?: string[];
        apiKey?: string;
    }): Promise<AgentRecord>;
    remove(url: string): Promise<boolean>;
    list(): Promise<AgentRecord[]>;
    get(url: string): Promise<AgentRecord | null>;
    addTeamSource(url: string, teamId: string): Promise<void>;
    /**
     * Remove a team source from an agent. Returns true if the agent
     * was fully removed (no remaining sources), false otherwise.
     * Manually-added agents (no teamIds) are never removed by this method.
     */
    removeTeamSource(url: string, teamId: string): Promise<boolean>;
    updateDescription(url: string, description: string): Promise<void>;
    updateLastSeen(url: string): Promise<void>;
}
