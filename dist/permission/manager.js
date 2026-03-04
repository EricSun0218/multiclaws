"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionManager = void 0;
exports.parseApprovalReply = parseApprovalReply;
const node_crypto_1 = require("node:crypto");
class PermissionManager {
    store;
    notifyPrompt;
    pending = new Map();
    allowOnce = new Set();
    constructor(store, notifyPrompt) {
        this.store = store;
        this.notifyPrompt = notifyPrompt;
    }
    async evaluateRequest(params) {
        const peerMode = (await this.store.get(params.peerId))?.mode ?? "prompt";
        if (peerMode === "blocked") {
            return "deny";
        }
        if (peerMode === "allow-all") {
            return "allow-permanently";
        }
        const requestId = (0, node_crypto_1.randomUUID)();
        const timeoutMs = params.timeoutMs ?? 60_000;
        const request = {
            requestId,
            peerId: params.peerId,
            peerDisplayName: params.peerDisplayName,
            action: params.action,
            context: params.context,
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + timeoutMs,
        };
        const decisionPromise = new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                resolve("deny");
            }, timeoutMs);
            this.pending.set(requestId, { request, resolve, timer });
        });
        await this.notifyPrompt({
            requestId,
            peerDisplayName: params.peerDisplayName,
            action: params.action,
            context: params.context,
        });
        const decision = await decisionPromise;
        if (decision === "allow-permanently") {
            await this.store.set(params.peerId, "allow-all");
        }
        if (decision === "allow-once") {
            this.allowOnce.add(requestId);
        }
        return decision;
    }
    consumeAllowOnce(requestId) {
        if (!this.allowOnce.has(requestId)) {
            return false;
        }
        this.allowOnce.delete(requestId);
        return true;
    }
    getPendingSnapshot() {
        return Array.from(this.pending.values()).map((entry) => entry.request);
    }
    async setPeerMode(peerId, mode) {
        await this.store.set(peerId, mode);
    }
    /**
     * Resolve a pending permission request by requestId and decision.
     * Returns true if the request was found and resolved.
     */
    resolveRequest(requestId, decision) {
        const pending = this.pending.get(requestId);
        if (!pending) {
            return false;
        }
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.resolve(decision);
        return true;
    }
    async handleUserReply(content) {
        const parsed = parseApprovalReply(content, this.getPendingSnapshot());
        if (!parsed) {
            return { handled: false };
        }
        const pending = this.pending.get(parsed.requestId);
        if (!pending) {
            return { handled: false };
        }
        clearTimeout(pending.timer);
        this.pending.delete(parsed.requestId);
        pending.resolve(parsed.decision);
        return {
            handled: true,
            decision: parsed.decision,
            requestId: parsed.requestId,
        };
    }
}
exports.PermissionManager = PermissionManager;
function parseApprovalReply(content, pending) {
    const text = content.trim().toLowerCase();
    if (!text) {
        return null;
    }
    const commandMatch = text.match(/^\/mc\s+(allow|deny)\s+([a-f0-9-]{6,})\s*(once|permanent)?$/i);
    if (commandMatch) {
        const requestId = commandMatch[2];
        const command = commandMatch[1];
        const mode = commandMatch[3];
        const decision = command === "deny"
            ? "deny"
            : mode === "permanent"
                ? "allow-permanently"
                : "allow-once";
        return { requestId, decision };
    }
    const tokenMatch = text.match(/\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i);
    const requestIdFromToken = tokenMatch?.[1];
    const singlePending = pending.length === 1 ? pending[0]?.requestId : undefined;
    const requestId = requestIdFromToken ?? singlePending;
    if (!requestId) {
        return null;
    }
    if (text === "1" || text.includes("allow once") || text.includes("允许一次") || text === "允许") {
        return { requestId, decision: "allow-once" };
    }
    if (text === "2" ||
        text.includes("allow always") ||
        text.includes("allow permanent") ||
        text.includes("永久允许") ||
        text.includes("总是允许")) {
        return { requestId, decision: "allow-permanently" };
    }
    if (text === "3" || text.includes("deny") || text.includes("拒绝")) {
        return { requestId, decision: "deny" };
    }
    return null;
}
