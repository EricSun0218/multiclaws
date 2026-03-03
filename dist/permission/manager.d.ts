import { PermissionStore } from "./store";
import type { PermissionDecision, PermissionPromptMessage, PermissionRequest } from "./types";
export declare class PermissionManager {
    private readonly store;
    private readonly notifyPrompt;
    private readonly pending;
    private readonly allowOnce;
    constructor(store: PermissionStore, notifyPrompt: (message: PermissionPromptMessage) => Promise<void>);
    evaluateRequest(params: {
        peerId: string;
        peerDisplayName: string;
        action: string;
        context: string;
        timeoutMs?: number;
    }): Promise<PermissionDecision>;
    consumeAllowOnce(requestId: string): boolean;
    getPendingSnapshot(): PermissionRequest[];
    setPeerMode(peerId: string, mode: "prompt" | "allow-all" | "blocked"): Promise<void>;
    handleUserReply(content: string): Promise<{
        handled: boolean;
        decision?: PermissionDecision;
        requestId?: string;
    }>;
}
export declare function parseApprovalReply(content: string, pending: PermissionRequest[]): {
    requestId: string;
    decision: PermissionDecision;
} | null;
