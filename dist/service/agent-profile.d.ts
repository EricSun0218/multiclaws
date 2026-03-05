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
export declare function renderProfileDescription(profile: AgentProfile): string;
export declare class ProfileStore {
    private readonly filePath;
    constructor(filePath: string);
    load(): Promise<AgentProfile>;
    save(profile: AgentProfile): Promise<void>;
    update(patch: Partial<Omit<AgentProfile, "dataSources">>): Promise<AgentProfile>;
    addDataSource(source: DataSource): Promise<AgentProfile>;
    removeDataSource(name: string): Promise<AgentProfile>;
}
