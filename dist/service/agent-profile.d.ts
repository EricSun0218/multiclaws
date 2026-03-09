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
export declare function renderProfileDescription(profile: AgentProfile): string;
export declare class ProfileStore {
    private readonly filePath;
    constructor(filePath: string);
    load(): Promise<AgentProfile>;
    save(profile: AgentProfile): Promise<void>;
    update(patch: Partial<Omit<AgentProfile, "dataSources" | "capabilities">>): Promise<AgentProfile>;
    addDataSource(source: DataSource): Promise<AgentProfile>;
    removeDataSource(name: string): Promise<AgentProfile>;
    addCapability(cap: Capability): Promise<AgentProfile>;
    removeCapability(tag: string): Promise<AgentProfile>;
}
