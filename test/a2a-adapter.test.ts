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

  // ---- Basic tests ----

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

  // ---- Callback-based happy path ----

  describe("execute - callback happy path", () => {
    it("spawns session, waits for callback, returns result", async () => {
      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          // Simulate sub-agent calling back shortly after spawn
          setTimeout(() => {
            executor.resolveCallback("test-task-1", "Task done!");
          }, 10);
          return {};
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

    it("resolveCallback returns false for unknown taskId", () => {
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: createMockTracker() as any,
        logger: createMockLogger(),
      });

      expect(executor.resolveCallback("nonexistent", "result")).toBe(false);
    });
  });

  // ---- Spawn failures ----

  describe("execute - spawn failures", () => {
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

  // ---- Timeout ----

  describe("execute - timeout", () => {
    it("throws timeout error when no callback arrives", async () => {
      vi.useFakeTimers();

      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          return {};
        }
        return {};
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

  // ---- Cancel with pending callback ----

  describe("execute - cancel with pending callback", () => {
    it("rejects pending callback on cancel", async () => {
      vi.useFakeTimers();

      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      mockInvoke.mockImplementation(async () => ({}));

      const bus = createMockEventBus();
      const executePromise = executor.execute(createMockContext("task", "task-cancel-test"), bus);

      // Let spawn complete
      await vi.advanceTimersByTimeAsync(100);

      // Cancel the task while waiting for callback
      const cancelBus = createMockEventBus();
      await executor.cancelTask("task-cancel-test", cancelBus);

      await executePromise;

      // The execute should have caught the cancel error
      expect(getPublishedText(bus)).toContain("canceled");
      expect(bus.finished).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  // ---- Prompt content ----

  describe("execute - prompt construction", () => {
    it("includes taskId and task text in spawn prompt", async () => {
      vi.useFakeTimers();

      const tracker = createMockTracker();
      const executor = new OpenClawAgentExecutor({
        gatewayConfig: GATEWAY_CONFIG,
        taskTracker: tracker as any,
        logger: createMockLogger(),
      });

      let spawnArgs: any = null;
      mockInvoke.mockImplementation(async (params: any) => {
        if (params.tool === "sessions_spawn") {
          spawnArgs = params.args;
          // Resolve immediately
          setTimeout(() => executor.resolveCallback("prompt-task", "ok"), 0);
        }
        return {};
      });

      const bus = createMockEventBus();
      const promise = executor.execute(createMockContext("check the desktop", "prompt-task"), bus);
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(spawnArgs).not.toBeNull();
      expect(spawnArgs.task).toContain("check the desktop");
      expect(spawnArgs.task).toContain("prompt-task");
      expect(spawnArgs.task).toContain("multiclaws_a2a_callback");

      vi.useRealTimers();
    });
  });
});
