"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MulticlawsMemoryService = void 0;
function redactPath(filePath) {
    const parts = filePath.split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join("/");
}
function trimSnippet(snippet, maxChars = 320) {
    const clean = snippet.replace(/\s+/g, " ").trim();
    if (clean.length <= maxChars) {
        return clean;
    }
    return `${clean.slice(0, maxChars)}...`;
}
class MulticlawsMemoryService {
    permissionManager;
    searchLocal;
    constructor(permissionManager, searchLocal) {
        this.permissionManager = permissionManager;
        this.searchLocal = searchLocal;
    }
    async handleInboundSearch(params) {
        const decision = await this.permissionManager.evaluateRequest({
            peerId: params.fromPeerId,
            peerDisplayName: params.fromPeerDisplayName,
            action: "memory.search",
            context: params.query,
        });
        if (decision === "deny") {
            throw new Error("permission denied");
        }
        const raw = await this.searchLocal({
            query: params.query,
            maxResults: Math.max(1, Math.min(params.maxResults ?? 5, 20)),
        });
        return {
            results: raw.map((entry) => ({
                path: redactPath(entry.path),
                snippet: trimSnippet(entry.snippet),
                score: entry.score,
            })),
        };
    }
}
exports.MulticlawsMemoryService = MulticlawsMemoryService;
