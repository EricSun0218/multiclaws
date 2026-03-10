import { EventEmitter } from "node:events";
import { type AgentRecord } from "./agent-registry";
import { type AgentProfile } from "./agent-profile";
import { type TeamRecord, type TeamMember } from "../team/team-store";
import { type ConversationSession } from "./session-store";
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
export type SessionStartResult = {
    sessionId: string;
    status: "running" | "failed";
    error?: string;
};
export type SessionReplyResult = {
    sessionId: string;
    status: "ok" | "failed";
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
    private readonly sessionStore;
    private readonly sessionLocks;
    private readonly sessionAborts;
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
    }): Promise<AgentRecord & {
        reachable: boolean;
    }>;
    removeAgent(url: string): Promise<boolean>;
    startSession(params: {
        agentUrl: string;
        message: string;
    }): Promise<SessionStartResult>;
    sendSessionMessage(params: {
        sessionId: string;
        message: string;
    }): Promise<SessionReplyResult>;
    getSession(sessionId: string): ConversationSession | null;
    listSessions(): ConversationSession[];
    waitForSessions(params: {
        sessionIds: string[];
        timeoutMs?: number;
    }): Promise<{
        results: Array<{
            sessionId: string;
            status: string;
            agentName: string;
            lastMessage?: string;
            error?: string;
        }>;
        timedOut: boolean;
    }>;
    endSession(sessionId: string): boolean;
    private acquireSessionLock;
    private runSession;
    private extractResultState;
    private handleSessionResult;
    private notifySessionUpdate;
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
    private extractArtifactText;
    private notifyTailscaleSetup;
    /** Fetch with up to 2 retries and exponential backoff. */
    private fetchWithRetry;
    private log;
}
