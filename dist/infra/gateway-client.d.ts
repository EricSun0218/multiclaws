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
 *
 * Timeout is enforced via AbortController on the fetch call.
 * Circuit breaker tracks error rates per tool to fail fast on persistent failures.
 * p-retry handles transient errors with up to 2 retries.
 */
export declare function invokeGatewayTool(params: {
    gateway: GatewayConfig;
    tool: string;
    args?: Record<string, unknown>;
    sessionKey?: string;
    timeoutMs?: number;
}): Promise<unknown>;
