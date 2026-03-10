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

const MAX_BREAKERS = 50;
const breakerCache = new Map<string, CircuitBreaker<any[], unknown>>();
let pRetryModulePromise: Promise<typeof import("p-retry")> | null = null;

async function loadPRetry() {
  if (!pRetryModulePromise) {
    pRetryModulePromise = import("p-retry");
  }
  return await pRetryModulePromise;
}

function getBreaker(key: string, timeoutMs: number): CircuitBreaker<any[], unknown> {
  const existing = breakerCache.get(key);
  if (existing) {
    return existing;
  }

  // Evict oldest entries when cache is full
  if (breakerCache.size >= MAX_BREAKERS) {
    const oldest = breakerCache.keys().next().value;
    if (oldest !== undefined) {
      const old = breakerCache.get(oldest);
      old?.shutdown();
      breakerCache.delete(oldest);
    }
  }

  const breaker = new CircuitBreaker<any[], unknown>(
    (operation: () => Promise<unknown>) => operation(),
    {
      timeout: false, // timeout handled by AbortController in the operation
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
  const pRetryModule = await loadPRetry();
  const pRetry = pRetryModule.default;
  const AbortError = (pRetryModule as unknown as { AbortError?: new (message: string) => Error }).AbortError;

  const breaker = getBreaker(params.key, params.timeoutMs);

  return (await pRetry(
    async () => {
      try {
        return (await breaker.fire(params.operation)) as T;
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
 *
 * Timeout is enforced via AbortController on the fetch call.
 * Circuit breaker tracks error rates per tool to fail fast on persistent failures.
 * p-retry handles transient errors with up to 2 retries.
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
