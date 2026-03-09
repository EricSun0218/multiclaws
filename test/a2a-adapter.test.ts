import { describe, expect, it, vi } from "vitest";
import { OpenClawAgentExecutor } from "../src/service/a2a-adapter";

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

describe("OpenClawAgentExecutor", () => {
  it("publishes error message for empty task text", async () => {
    const executor = new OpenClawAgentExecutor({
      gatewayConfig: null,
      taskTracker: { create: vi.fn(), update: vi.fn() } as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
});
