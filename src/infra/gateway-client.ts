import CircuitBreaker from "opossum";

export type GatewayConfig = {
  port: number;
  token: string;
};

export type InvokeToolResult = {
  ok: boolean;
  result?: unknown;
  error?: { type?: string; message?: string };
};

class NonRetryableError extends Error {}

const breakerCache = new Map<string, CircuitBreaker<any[], unknown>>();
let pRetryModulePromise: Promise<typeof import("p-retry")> | null = null;
let pTimeoutModulePromise: Promise<typeof import("p-timeout")> | null = null;

async function loadPRetry() {
  if (!pRetryModulePromise) {
    pRetryModulePromise = import("p-retry");
  }
  return await pRetryModulePromise;
}

async function loadPTimeout() {
  if (!pTimeoutModulePromise) {
    pTimeoutModulePromise = import("p-timeout");
  }
  return await pTimeoutModulePromise;
}

function getBreaker(key: string): CircuitBreaker<any[], unknown> {
  const existing = breakerCache.get(key);
  if (existing) {
    return existing;
  }

  const breaker = new CircuitBreaker<any[], unknown>(
    (operation: () => Promise<unknown>) => operation(),
    {
      timeout: 30_000,
      errorThresholdPercentage: 50,
      resetTimeout: 10_000,
      volumeThreshold: 5,
    },
  );

  breakerCache.set(key, breaker);
  return breaker;
}

async function executeResilient<T>(params: {
  key: string;
  timeoutMs: number;
  operation: () => Promise<T>;
}): Promise<T> {
  const [pRetryModule, pTimeoutModule] = await Promise.all([loadPRetry(), loadPTimeout()]);
  const pRetry = pRetryModule.default;
  const AbortError = (pRetryModule as unknown as { AbortError?: new (message: string) => Error }).AbortError;
  const pTimeout = pTimeoutModule.default as unknown as (
    promise: Promise<unknown>,
    options: { milliseconds: number; message?: string },
  ) => Promise<unknown>;

  const breaker = getBreaker(params.key);

  return (await pRetry(
    async () => {
      try {
        const fired = breaker.fire(params.operation);
        return (await pTimeout(fired, {
          milliseconds: params.timeoutMs,
          message: `operation timeout after ${params.timeoutMs}ms`,
        })) as T;
      } catch (error) {
        if (error instanceof NonRetryableError && AbortError) {
          throw new AbortError(error.message);
        }
        throw error;
      }
    },
    {
      retries: 2,
      factor: 2,
      minTimeout: 150,
      maxTimeout: 1200,
      randomize: true,
    },
  )) as T;
}

/**
 * Call the local OpenClaw gateway's /tools/invoke endpoint.
 * Requires the tool to be allowed by gateway policy.
 */
export async function invokeGatewayTool(params: {
  gateway: GatewayConfig;
  tool: string;
  args?: Record<string, unknown>;
  sessionKey?: string;
  timeoutMs?: number;
}): Promise<unknown> {
  const url = `http://localhost:${params.gateway.port}/tools/invoke`;
  const timeoutMs = params.timeoutMs ?? 8_000;
  const key = `${params.gateway.port}:${params.tool}`;

  return await executeResilient({
    key,
    timeoutMs,
    operation: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.gateway.token}`,
          },
          body: JSON.stringify({
            tool: params.tool,
            action: "json",
            args: params.args ?? {},
            sessionKey: params.sessionKey ?? "main",
          }),
          signal: controller.signal,
        });

        const json = (await response.json()) as InvokeToolResult;

        if (!response.ok || !json.ok) {
          const msg = json.error?.message ?? `HTTP ${response.status}`;
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new NonRetryableError(`invokeGatewayTool(${params.tool}) failed: ${msg}`);
          }
          throw new Error(`invokeGatewayTool(${params.tool}) failed: ${msg}`);
        }

        return json.result;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

/**
 * Extract text content from a tool result that follows the
 * { content: [{ type: "text", text: "..." }] } shape.
 */
export function extractTextContent(result: unknown): string {
  if (result == null) return "";
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    return r.content
      .filter((c): c is { type: string; text: string } => c?.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (typeof r.text === "string") return r.text;
  if (typeof r === "string") return r;
  return JSON.stringify(result);
}

/**
 * Extract a human-readable output string from a sessions_spawn (run mode) result.
 * The result may be a content array, a plain string, or an object with a text field.
 */
export function parseSpawnTaskResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;

  const r = result as Record<string, unknown>;

  // sessions_spawn run mode returns { output?: string } or content array
  if (typeof r.output === "string") return r.output;
  if (typeof r.result === "string") return r.result;

  const text = extractTextContent(result);
  if (text) return text;

  return JSON.stringify(result);
}
