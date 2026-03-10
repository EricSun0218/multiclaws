import { EventEmitter } from "node:events";
import { type AgentRecord } from "./agent-registry";
import { type AgentProfile } from "./agent-profile";
import { type TeamRecord, type TeamMember } from "../team/team-store";
import type { GatewayConfig } from "../infra/gateway-client";
export type MulticlawsServiceOptions = {
    stateDir: string;
    port?: number;
    displayName?: string;
    selfUrl?: string;
    gatewayConfig?: GatewayConfig;
    logger?: {
        info: (message: string) => void;
        warn: (message: string) => void;
        error: (message: string) => void;
        debug?: (message: string) => void;
    };
};
export type DelegateTaskResult = {
    taskId?: string;
    output?: string;
    status: string;
    error?: string;
};
export declare class MulticlawsService extends EventEmitter {
    private readonly options;
    private started;
    private httpServer;
    private readonly agentRegistry;
    private readonly teamStore;
    private readonly profileStore;
    private readonly taskTracker;
    private agentExecutor;
    private a2aRequestHandler;
    private agentCard;
    private readonly clientFactory;
    private readonly httpRateLimiter;
    private selfUrl;
    private profileDescription;
    constructor(options: MulticlawsServiceOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    updateGatewayConfig(config: GatewayConfig): void;
    listAgents(): Promise<AgentRecord[]>;
    addAgent(params: {
        url: string;
        apiKey?: string;
    }): Promise<AgentRecord>;
    removeAgent(url: string): Promise<boolean>;
    delegateTask(params: {
        agentUrl: string;
        task: string;
    }): Promise<DelegateTaskResult>;
    private runDelegatedTask;
    private notifyTaskCompletion;
    getTaskStatus(taskId: string): import("../task/tracker").TaskRecord | null;
    getProfile(): Promise<AgentProfile>;
    setProfile(patch: {
        ownerName?: string;
        bio?: string;
    }): Promise<AgentProfile>;
    private updateProfileDescription;
    private getPendingReviewPath;
    getPendingProfileReview(): Promise<{
        pending: boolean;
        profile?: AgentProfile;
        message?: string;
    }>;
    setPendingProfileReview(): Promise<void>;
    clearPendingProfileReview(): Promise<void>;
    createTeam(name: string): Promise<TeamRecord>;
    createInvite(teamId?: string): Promise<string>;
    joinTeam(inviteCode: string): Promise<TeamRecord>;
    leaveTeam(teamId?: string): Promise<void>;
    listTeamMembers(teamId?: string): Promise<{
        team: TeamRecord;
        members: TeamMember[];
    } | {
        teams: Array<{
            team: TeamRecord;
            members: TeamMember[];
        }>;
    } | null>;
    private mountTeamRoutes;
    private broadcastProfileToTeams;
    private fetchMemberDescriptions;
    private syncTeamToRegistry;
    private createA2AClient;
    private processTaskResult;
    private extractArtifactText;
    private notifyTailscaleSetup;
    /** Fetch with up to 2 retries and exponential backoff. */
    private fetchWithRetry;
    private log;
}
