import { EventEmitter } from "node:events";
import { type PeerIdentity } from "../core/peer-id";
import { type PeerRecord } from "../core/peer-registry";
import { type LocalMemorySearchResult } from "../memory/multiclaws-query";
import { type TaskExecutionResult } from "../task/delegation";
export type MulticlawsServiceOptions = {
    stateDir: string;
    port?: number;
    displayName?: string;
    gatewayVersion?: string;
    knownPeers?: Array<{
        peerId?: string;
        displayName?: string;
        address: string;
        publicKey?: string;
    }>;
    logger?: {
        info: (message: string) => void;
        warn: (message: string) => void;
        error: (message: string) => void;
        debug?: (message: string) => void;
    };
    memorySearch?: (params: {
        query: string;
        maxResults: number;
    }) => Promise<LocalMemorySearchResult[]>;
    taskExecutor?: (params: {
        task: string;
        context?: string;
        fromPeerId: string;
    }) => Promise<TaskExecutionResult>;
};
export declare class MulticlawsService extends EventEmitter {
    private options;
    private started;
    private wss;
    private localIdentity;
    private localPrivateKeyPem;
    private readonly registry;
    private readonly teamManager;
    private readonly permissionStore;
    private permissionManager;
    private readonly taskTracker;
    private readonly connections;
    private readonly pendingResponses;
    private protocolHandlers;
    constructor(options: MulticlawsServiceOptions);
    get identity(): PeerIdentity | null;
    start(): Promise<void>;
    stop(): Promise<void>;
    handleUserApprovalReply(content: string): Promise<{
        handled: boolean;
        requestId?: string;
        decision?: string;
    }>;
    listPeers(): Promise<Array<PeerRecord & {
        connected: boolean;
    }>>;
    addPeer(params: {
        address: string;
        peerId?: string;
        displayName?: string;
        publicKey?: string;
    }): Promise<PeerRecord>;
    removePeer(peerId: string): Promise<boolean>;
    resolvePeer(nameOrId: string): Promise<PeerRecord | null>;
    connectToPeer(peer: PeerRecord): Promise<void>;
    sendDirectMessage(params: {
        peerId: string;
        text: string;
    }): Promise<void>;
    multiclawsMemorySearch(params: {
        peerId: string;
        query: string;
        maxResults?: number;
    }): Promise<unknown>;
    delegateTask(params: {
        peerId: string;
        task: string;
        context?: string;
    }): Promise<unknown>;
    requestPeer(params: {
        peerId: string;
        method: string;
        params: unknown;
        timeoutMs?: number;
    }): Promise<unknown>;
    createTeam(params: {
        teamName: string;
        localAddress: string;
    }): Promise<{
        teamId: string;
        teamName: string;
        inviteCode: string;
    }>;
    joinTeam(params: {
        inviteCode: string;
        localAddress: string;
    }): Promise<{
        teamId: string;
        teamName: string;
        ownerPeerId: string;
    }>;
    listTeamMembers(teamId: string): Promise<Array<{
        peerId: string;
        displayName: string;
        address: string;
    }>>;
    leaveTeam(teamId: string): Promise<void>;
    setPeerPermissionMode(peerId: string, mode: "prompt" | "allow-all" | "blocked"): Promise<void>;
    getTaskStatus(taskId: string): import("../task/tracker").TaskRecord | null;
    private notifyDelegationRequester;
    private sendEventToPeer;
    private handleIncomingEvent;
    private resolveConnection;
    private bindConnection;
    private acceptIncomingSocket;
    private log;
}
