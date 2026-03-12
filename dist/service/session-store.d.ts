import type { BasicLogger } from "../infra/logger";
export type SessionStatus = "active" | "input-required" | "completed" | "failed" | "canceled";
export type SessionMessage = {
    role: "user" | "agent";
    content: string;
    timestampMs: number;
    taskId?: string;
};
export type ConversationSession = {
    sessionId: string;
    agentUrl: string;
    agentName: string;
    contextId: string;
    currentTaskId?: string;
    status: SessionStatus;
    messages: SessionMessage[];
    createdAtMs: number;
    updatedAtMs: number;
    error?: string;
};
export declare class SessionStore {
    private readonly filePath;
    private readonly ttlMs;
    private readonly logger?;
    private store;
    private persistPending;
    constructor(opts: {
        filePath: string;
        ttlMs?: number;
        logger?: BasicLogger;
    });
    create(params: {
        agentUrl: string;
        agentName: string;
        contextId: string;
    }): ConversationSession;
    get(sessionId: string): ConversationSession | null;
    list(): ConversationSession[];
    update(sessionId: string, patch: Partial<Omit<ConversationSession, "sessionId" | "createdAtMs">>): ConversationSession | null;
    appendMessage(sessionId: string, msg: SessionMessage): ConversationSession | null;
    private loadSync;
    private schedulePersist;
    private persistAsync;
    private prune;
    private evictOldest;
}
