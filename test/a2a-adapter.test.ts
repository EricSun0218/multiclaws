import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OpenClawAgentExecutor } from "../src/service/a2a-adapter";
import { invokeGatewayTool } from "../src/infra/gateway-client";

vi.mock("../src/infra/gateway-client", () => ({
  invokeGatewayTool: vi.fn(),
}));

const mockInvoke = vi.mocked(invokeGatewayTool);

function createMockEventBus() {
  const events: unknown[] = [];
  return {
    publish: vi.fn((event: unknown) => events.push(event)),
    finished: vi.fn(),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    events,
  };
}

function createMockContext(text: string, taskId = "test-task-1", contextId = "ctx-1") {
  return {
    userMessage: {
      kind: "message" as const,
      role: "user" as const,
      parts: [{ kind: "text" as const, text }],
      messageId: "msg-1",
    },
    taskId,
    contextId,
  } as any;
}

function createMockTracker() {
  return {
    create: vi.fn().mockImplementation((params: any) => ({
      taskId: params.toPeerId === "local" ? "track-inbound" : "track-out",
      ...params,
      status: "queued",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    })),
    update: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  };
}

function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const GATEWAY_CONFIG = { port: 18789, token: "test-token" };

/** Extract the text from a published message event */
function getPublishedText(bus: ReturnType<typeof createMockEventBus>): string {
  const lastCall = bus.publish.mock.calls[bus.publish.mock.calls.length - 1];
  if (!lastCall) return "";
  const msg = lastCall[0] as any;
  return msg?.parts?.[0]?.text ?? "";
}

describe("OpenClawAgentExecutor", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  // ---- Existing tests ----

  it("publishes error message for empty task text", async () => {
    const executor = new OpenClawAgentExecutor({
      gatewayConfig: null,
      taskTracker: { create: vi.fn(), update: vi.fn() } as any,
      logger: createMockLogger(),
    });

    const bus = createMockEventBus();
    await executor.execute(createMockContext("   "), bus);

    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "message",
        role: "agent",
        parts: expect.arrayContaining([
          expect.objectContaining({ kind: "text", text: expect.stringContaining("empty task") }),
        ]),
      }),
    );
    expect(bus.finished).toHaveBeenCalled();
  });

  it("publishes error message when gateway config is null", async () => {
    const executor = new OpenClawAgentExecutor({
      gatewayConfig: null,
      taskTracker: { create: vi.fn().mockReturnValue({ taskId: "t1" }), update: vi.fn() } as any,
      logger: createMockLogger(),
    });

    const bus = createMockEventBus();
    await executor.execute(createMockContext("do something"), bus);

    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "message",
        role: "agent",
        parts: expect.arrayContaining([
          expect.objectContaining({ kind: "text", text: expect.stringContaining("gateway config not available") }),
        ]),
      }),
    );
    expect(bus.finished).toHaveBeenCalled();
  });

  it("cancels a task", async () => {
    const tracker = { create: vi.fn(), update: vi.fn() };
    const executor = new OpenClawAgentExecutor({
      gatewayConfig: null,
      taskTracker: tracker as any,
      logger: createMockLogger(),
    });

    const bus = createMockEventBus();
    await executor.cancelTask("task-123", bus);

    expect(tracker.update).toHaveBeenCalledWith("task-123", { status: "failed", error: "canceled" });
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "message",
        role: "agent",
        parts: expect.arrayContaining([
          expect.objectContaining({ kind: "text", text: "Task was canceled." }),
        ]),
      }),
    );
    expect(bus.finished).toHaveBeenCalled();
  });

  // ---- New tests: happy path with gateway ----

  describe("execute - happy path", () => {
    it("spawns session, polls until complete, returns assistant text", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      let historyCallCount = 0;
      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-1" } };
        }
        if (params.tool === "sessions_history") {
          historyCallCount++;
          if (historyCallCount <= 1) {
            return { details: { isComplete: false, messages: [] } };
          }
          return {
            details: {
              isComplete: true,
              messages: [
                { role: "assistant", content: [{ type: "text", text: "Task done!" }] },
              ],
            },
          };
        }
        return {};
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("do something"), bus);

      expect(getPublishedText(bus)).toBe("Task done!");
      expect(bus.finished).toHaveBeenCalled();
      expect(tracker.update).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "completed", result: "Task done!" }),
      );
    });

    it("collects multiple assistant messages in order", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-2" } };
        }
        return {
          details: {
            isComplete: true,
            messages: [
              { role: "user", content: "do X" },
              { role: "assistant", content: [{ type: "text", text: "Step 1 done" }] },
              { role: "user", content: "continue" },
              { role: "assistant", content: [{ type: "text", text: "Step 2 done" }] },
            ],
          },
        };
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("do X"), bus);

      expect(getPublishedText(bus)).toBe("Step 1 done\n\nStep 2 done");
    });

    it("handles assistant messages with string content", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-3" } };
        }
        return {
          details: {
            isComplete: true,
            messages: [{ role: "assistant", content: "simple text response" }],
          },
        };
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("ask"), bus);

      expect(getPublishedText(bus)).toBe("simple text response");
    });
  });

  // ---- New tests: session errors ----

  describe("execute - session errors", () => {
    it("appends session error to assistant text", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-err" } };
        }
        return {
          details: {
            isComplete: true,
            error: "something broke",
            messages: [
              { role: "assistant", content: [{ type: "text", text: "partial result" }] },
            ],
          },
        };
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("task"), bus);

      const text = getPublishedText(bus);
      expect(text).toContain("partial result");
      expect(text).toContain("[session error: something broke]");
    });

    it("returns error string when no assistant text and sessionError present", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-notext" } };
        }
        return {
          details: {
            isComplete: true,
            error: "total failure",
            messages: [],
          },
        };
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("task"), bus);

      expect(getPublishedText(bus)).toBe("Error: total failure");
    });

    it("returns error for failed session status without text", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-failed" } };
        }
        return {
          details: {
            isComplete: true,
            status: "failed",
            messages: [],
          },
        };
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("task"), bus);

      expect(getPublishedText(bus)).toContain('session ended with status "failed"');
    });

    it("returns default text when session completes with no output", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-empty" } };
        }
        return {
          details: { isComplete: true, messages: [] },
        };
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("task"), bus);

      expect(getPublishedText(bus)).toBe("(task completed with no text output)");
    });
  });

  // ---- New tests: spawn failures ----

  describe("execute - spawn failures", () => {
    it("errors when sessions_spawn returns no childSessionKey", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: {} };
        }
        return {};
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("task"), bus);

      expect(getPublishedText(bus)).toContain("childSessionKey");
      expect(bus.finished).toHaveBeenCalled();
      expect(tracker.update).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "failed" }),
      );
    });

    it("errors when sessions_spawn throws", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          throw new Error("network failure");
        }
        return {};
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("task"), bus);

      expect(getPublishedText(bus)).toContain("network failure");
      expect(tracker.update).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "failed" }),
      );
    });
  });

  // ---- New tests: timeout ----

  describe("execute - timeout", () => {
    it("throws timeout error when session never completes", async () => {
      vi.useFakeTimers();

      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-timeout" } };
        }
        // sessions_history always returns not complete
        return { details: { isComplete: false, messages: [] } };
      });

      const bus = createMockEventBus();
      const executePromise = executor.execute(createMockContext("task"), bus);

      // Advance time past the 180s timeout
      await vi.advanceTimersByTimeAsync(200_000);

      await executePromise;

      expect(getPublishedText(bus)).toContain("timed out");
      expect(bus.finished).toHaveBeenCalled();
      expect(tracker.update).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "failed" }),
      );

      vi.useRealTimers();
    });
  });

  // ---- New tests: poll error recovery ----

  describe("execute - poll error recovery", () => {
    it("recovers from transient poll errors and succeeds", async () => {
      const tracker = createMockTracker();
      const logger = createMockLogger();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger,
      });

      let historyCallCount = 0;
      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-retry" } };
        }
        if (params.tool === "sessions_history") {
          historyCallCount++;
          if (historyCallCount <= 2) {
            throw new Error("transient error");
          }
          return {
            details: {
              isComplete: true,
              messages: [
                { role: "assistant", content: [{ type: "text", text: "recovered result" }] },
              ],
            },
          };
        }
        return {};
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("task"), bus);

      expect(getPublishedText(bus)).toBe("recovered result");
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // ---- New tests: heuristics ----

  describe("execute - completion heuristics", () => {
    it("treats last message with only tool calls as still running", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      let historyCallCount = 0;
      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-heuristic1" } };
        }
        historyCallCount++;
        if (historyCallCount <= 1) {
          // No isComplete flag, last message is tool call only
          return {
            details: {
              messages: [
                { role: "assistant", content: [{ type: "toolCall", name: "some_tool" }] },
              ],
            },
          };
        }
        return {
          details: {
            isComplete: true,
            messages: [
              { role: "assistant", content: [{ type: "text", text: "final answer" }] },
            ],
          },
        };
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("task"), bus);

      expect(getPublishedText(bus)).toBe("final answer");
      // Confirm it polled more than once (first poll returned tool call = still running)
      expect(historyCallCount).toBeGreaterThan(1);
    });

    it("treats last message from user as still running", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      let historyCallCount = 0;
      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-heuristic2" } };
        }
        historyCallCount++;
        if (historyCallCount <= 1) {
          // No isComplete flag, last message is from user
          return {
            details: {
              messages: [
                { role: "assistant", content: [{ type: "text", text: "thinking..." }] },
                { role: "user", content: "more input" },
              ],
            },
          };
        }
        return {
          details: {
            isComplete: true,
            messages: [
              { role: "assistant", content: [{ type: "text", text: "done" }] },
            ],
          },
        };
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("task"), bus);

      expect(getPublishedText(bus)).toBe("done");
      expect(historyCallCount).toBeGreaterThan(1);
    });

    it("treats isComplete:false with assistant text as completed via heuristic", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-false-complete" } };
        }
        // isComplete is false, but assistant has final text → heuristic detects completion
        return {
          details: {
            isComplete: false,
            messages: [
              { role: "assistant", content: [{ type: "text", text: "result from sub-agent" }] },
            ],
          },
        };
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("task"), bus);

      expect(getPublishedText(bus)).toBe("result from sub-agent");
    });

    it("treats assistant message with text as completed when no isComplete flag", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return { details: { childSessionKey: "child-heuristic3" } };
        }
        // No isComplete flag, but assistant has text → treated as completed
        return {
          details: {
            messages: [
              { role: "assistant", content: [{ type: "text", text: "immediate answer" }] },
            ],
          },
        };
      });

      const bus = createMockEventBus();
      await executor.execute(createMockContext("task"), bus);

      expect(getPublishedText(bus)).toBe("immediate answer");
    });
  });
});
