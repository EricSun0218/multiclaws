import type { PermissionManager } from "../permission/manager";

export type LocalMemorySearchResult = {
  path: string;
  snippet: string;
  score: number;
};

export type LocalMemorySearcher = (params: {
  query: string;
  maxResults: number;
}) => Promise<LocalMemorySearchResult[]>;

function redactPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

function trimSnippet(snippet: string, maxChars = 320): string {
  const clean = snippet.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  return `${clean.slice(0, maxChars)}...`;
}

export class MulticlawsMemoryService {
  constructor(
    private readonly permissionManager: PermissionManager,
    private readonly searchLocal: LocalMemorySearcher,
  ) {}

  async handleInboundSearch(params: {
    fromPeerId: string;
    fromPeerDisplayName: string;
    query: string;
    maxResults?: number;
  }): Promise<{ results: LocalMemorySearchResult[] }> {
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
