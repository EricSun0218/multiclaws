import { EventEmitter } from "node:events";
import { type FrpTunnelConfig } from "../infra/frp";
import { type AgentRecord } from "./agent-registry";
import { type AgentProfile } from "./agent-profile";
import { type TeamRecord, type TeamMember } from "../team/team-store";
import type { GatewayConfig } from "../infra/gateway-client";
export type MulticlawsServiceOptions = {
    stateDir: string;
    port?: number;
    displayName?: string;
    selfUrl?: string;
    cwd?: string;
    tunnel?: FrpTunnelConfig & {
        type: "frp";
    };
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
    private frpTunnel;
    private selfUrl;
    private profileDescription;
    private readonly gatewayConfig;
    private readonly resolvedCwd;
    private activeChannelId;
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
    /**
     * Synchronous delegation: sends A2A task and waits for the result.
     * Used by sub-agents internally via the multiclaws_delegate_send tool.
     */
    delegateTaskSync(params: {
        agentUrl: string;
        task: string;
    }): Promise<DelegateTaskResult>;
    /**
     * Spawn a sub-agent to handle delegation asynchronously.
     * The sub-agent uses multiclaws_delegate_send internally and
     * reports results back to the user via the message tool.
     */
    spawnDelegation(params: {
        agentUrl: string;
        task: string;
    }): Promise<{
        message: string;
    }>;
    getTaskStatus(taskId: string): import("../task/tracker").TaskRecord | null;
    getProfile(): Promise<AgentProfile>;
    /**
     * Throws if the profile is incomplete (ownerName or bio missing).
     * Call this before any action that exposes the user's identity to other agents.
     */
    private requireCompleteProfile;
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
    /**
     * Send a message using A2A streaming to minimize latency.
     * Instead of a single blocking HTTP call, consume the SSE stream and
     * return the final Task or Message as soon as B signals completion.
     */
    private processTaskResult;
    private extractArtifactText;
    /** Fetch with up to 2 retries and exponential backoff. */
    private fetchWithRetry;
    /** Update the most recently active channel for notifications. */
    setActiveChannelId(channelId: string): void;
    /** Send a notification to the most recently active channel. */
    private notifyUser;
    private log;
}
