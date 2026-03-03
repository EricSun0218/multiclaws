export type GatewayConfig = {
    port: number;
    token: string;
};
export type InvokeToolResult = {
    ok: boolean;
    result?: unknown;
    error?: {
        type?: string;
        message?: string;
    };
};
/**
 * Call the local OpenClaw gateway's /tools/invoke endpoint.
 * Requires the tool to be allowed by gateway policy.
 */
export declare function invokeGatewayTool(params: {
    gateway: GatewayConfig;
    tool: string;
    args?: Record<string, unknown>;
    sessionKey?: string;
    timeoutMs?: number;
}): Promise<unknown>;
/**
 * Extract text content from a tool result that follows the
 * { content: [{ type: "text", text: "..." }] } shape.
 */
export declare function extractTextContent(result: unknown): string;
export type LocalMemorySearchResult = {
    path: string;
    snippet: string;
    score: number;
};
/**
 * Parse the text output of the `memory_search` tool into structured results.
 *
 * memory_search returns text like:
 *   Source: memory/2024-01-01.md#12
 *   Content: some snippet...
 *
 *   Source: MEMORY.md#5
 *   Content: another snippet...
 */
export declare function parseMemorySearchResult(result: unknown): LocalMemorySearchResult[];
/**
 * Extract a human-readable output string from a sessions_spawn (run mode) result.
 * The result may be a content array, a plain string, or an object with a text field.
 */
export declare function parseSpawnTaskResult(result: unknown): string;
