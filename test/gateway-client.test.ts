import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// We need to reset modules between tests to get fresh circuit breaker state
let invokeGatewayTool: typeof import("../src/infra/gateway-client").invokeGatewayTool;

// Unique port counter to avoid circuit breaker cache collisions across tests
let portCounter = 30000;
function nextPort() {
  return portCounter++;
}

function mockFetchResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../src/infra/gateway-client");
  invokeGatewayTool = mod.invokeGatewayTool;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("gateway-client", () => {
  describe("invokeGatewayTool", () => {
    it("successful invoke returns result", async () => {
      const port = nextPort();
      const mockFetch = vi.fn().mockReturnValue(
        mockFetchResponse(200, { ok: true, result: { data: "hello" } }),
      );
      globalThis.fetch = mockFetch;

      const result = await invokeGatewayTool({
        gateway: { port, token: "test-token" },
        tool: "sessions_spawn",
        args: { task: "do something", mode: "run" },
        timeoutMs: 5000,
      });

      expect(result).toEqual({ data: "hello" });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`http://localhost:${port}/tools/invoke`);
      expect(opts.method).toBe("POST");
      expect(opts.headers["Authorization"]).toBe("Bearer test-token");
      expect(opts.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(opts.body);
      expect(body.tool).toBe("sessions_spawn");
      expect(body.action).toBe("json");
      expect(body.args).toEqual({ task: "do something", mode: "run" });
      expect(body.sessionKey).toBe("main");
    });

    it("uses custom sessionKey when provided", async () => {
      const port = nextPort();
      const mockFetch = vi.fn().mockReturnValue(
        mockFetchResponse(200, { ok: true, result: "ok" }),
      );
      globalThis.fetch = mockFetch;

      await invokeGatewayTool({
        gateway: { port, token: "t" },
        tool: "test_tool",
        sessionKey: "custom-session",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.sessionKey).toBe("custom-session");
    });

    it("4xx error throws without retry", async () => {
      const port = nextPort();
      const mockFetch = vi.fn().mockReturnValue(
        mockFetchResponse(400, { ok: false, error: { message: "bad request" } }),
      );
      globalThis.fetch = mockFetch;

      await expect(
        invokeGatewayTool({
          gateway: { port, token: "t" },
          tool: "bad_tool",
          timeoutMs: 5000,
        }),
      ).rejects.toThrow(/bad request/);

      // 4xx errors should NOT be retried (exactly 1 call)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("429 error IS retried", async () => {
      const port = nextPort();
      const mockFetch = vi
        .fn()
        .mockReturnValueOnce(
          mockFetchResponse(429, { ok: false, error: { message: "rate limited" } }),
        )
        .mockReturnValueOnce(mockFetchResponse(200, { ok: true, result: "ok" }));
      globalThis.fetch = mockFetch;

      const result = await invokeGatewayTool({
        gateway: { port, token: "t" },
        tool: "rate_limited_tool",
        timeoutMs: 5000,
      });

      expect(result).toBe("ok");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("5xx error is retried and eventually succeeds", async () => {
      const port = nextPort();
      const mockFetch = vi
        .fn()
        .mockReturnValueOnce(
          mockFetchResponse(500, { ok: false, error: { message: "server error" } }),
        )
        .mockReturnValueOnce(
          mockFetchResponse(500, { ok: false, error: { message: "server error" } }),
        )
        .mockReturnValueOnce(mockFetchResponse(200, { ok: true, result: "recovered" }));
      globalThis.fetch = mockFetch;

      const result = await invokeGatewayTool({
        gateway: { port, token: "t" },
        tool: "flaky_tool",
        timeoutMs: 10000,
      });

      expect(result).toBe("recovered");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("5xx error after all retries exhausted throws", async () => {
      const port = nextPort();
      const mockFetch = vi.fn().mockReturnValue(
        mockFetchResponse(500, { ok: false, error: { message: "persistent failure" } }),
      );
      globalThis.fetch = mockFetch;

      await expect(
        invokeGatewayTool({
          gateway: { port, token: "t" },
          tool: "always_fail_tool",
          timeoutMs: 10000,
        }),
      ).rejects.toThrow(/persistent failure/);

      // 1 original + 2 retries = 3 calls
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("timeout throws abort error", async () => {
      const port = nextPort();
      const mockFetch = vi.fn().mockImplementation(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => resolve(mockFetchResponse(200, { ok: true, result: "late" })),
              5000,
            );
            opts.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      );
      globalThis.fetch = mockFetch;

      await expect(
        invokeGatewayTool({
          gateway: { port, token: "t" },
          tool: "slow_tool",
          timeoutMs: 100,
        }),
      ).rejects.toThrow();
    }, 15000);

    it("uses correct URL with gateway port", async () => {
      const port = nextPort();
      const mockFetch = vi.fn().mockReturnValue(
        mockFetchResponse(200, { ok: true, result: "ok" }),
      );
      globalThis.fetch = mockFetch;

      await invokeGatewayTool({
        gateway: { port, token: "abc" },
        tool: "any_tool",
      });

      expect(mockFetch.mock.calls[0][0]).toBe(`http://localhost:${port}/tools/invoke`);
    });

    it("sends empty args when none provided", async () => {
      const port = nextPort();
      const mockFetch = vi.fn().mockReturnValue(
        mockFetchResponse(200, { ok: true, result: "ok" }),
      );
      globalThis.fetch = mockFetch;

      await invokeGatewayTool({
        gateway: { port, token: "t" },
        tool: "no_args_tool",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.args).toEqual({});
    });
  });
});
