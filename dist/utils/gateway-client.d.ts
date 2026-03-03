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
