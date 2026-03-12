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
export declare class AgentRegistry {
    private readonly filePath;
    private readonly logger?;
    constructor(filePath: string, logger?: BasicLogger | undefined);
    private log;
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
    updateDescription(url: string, description: string): Promise<void>;
    updateLastSeen(url: string): Promise<void>;
}
