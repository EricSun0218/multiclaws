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
export declare class MulticlawsMemoryService {
    private readonly permissionManager;
    private readonly searchLocal;
    constructor(permissionManager: PermissionManager, searchLocal: LocalMemorySearcher);
    handleInboundSearch(params: {
        fromPeerId: string;
        fromPeerDisplayName: string;
        query: string;
        maxResults?: number;
    }): Promise<{
        results: LocalMemorySearchResult[];
    }>;
}
