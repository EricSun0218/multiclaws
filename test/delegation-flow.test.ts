import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MulticlawsService } from "../src/service/multiclaws-service";

// Mock the A2A client factory
vi.mock("@a2a-js/sdk/client", () => {
  const mockClient = {
    sendMessage: vi.fn(),
  };
  return {
    ClientFactory: vi.fn().mockImplementation(() => ({
      createFromUrl: vi.fn().mockResolvedValue(mockClient),
    })),
    __mockClient: mockClient,
  };
});

// Get the mock client reference
const { __mockClient: mockClient } = await import("@a2a-js/sdk/client") as any;

const tmpDirs: string[] = [];

function tmpStateDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `mc-delegation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function rmDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/** Write a complete profile to the state dir so requireCompleteProfile() passes */
function writeProfile(stateDir: string, profile = { ownerName: "Test User", bio: "Test bio" }) {
  const mcDir = path.join(stateDir, "multiclaws");
  fs.mkdirSync(mcDir, { recursive: true });
  fs.writeFileSync(path.join(mcDir, "profile.json"), JSON.stringify(profile));
}

/** Write an agent to agents.json so agentRegistry.get() finds it */
function writeAgent(stateDir: string, agent: { url: string; name?: string; description?: string }) {
  const mcDir = path.join(stateDir, "multiclaws");
  fs.mkdirSync(mcDir, { recursive: true });
  const agentsPath = path.join(mcDir, "agents.json");
  let store = { version: 1 as const, agents: [] as any[] };
  try {
    store = JSON.parse(fs.readFileSync(agentsPath, "utf8"));
  } catch {}
  store.agents.push({
    url: agent.url.replace(/\/+$/, ""),
    name: agent.name ?? "Remote Agent",
    description: agent.description ?? "A remote agent",
    skills: [],
    addedAtMs: Date.now(),
    lastSeenAtMs: Date.now(),
  });
  fs.writeFileSync(agentsPath, JSON.stringify(store));
}

function createService(stateDir: string) {
  return new MulticlawsService({
    stateDir,
    selfUrl: "http://localhost:3100",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tmpDirs) rmDir(dir);
  tmpDirs.length = 0;
});

describe("Delegation flow (outbound)", () => {
  describe("delegateTaskSync", () => {
    it("happy path: sendMessage returns Task with completed state and artifact text", async () => {
      const stateDir = tmpStateDir();
      writeProfile(stateDir);
      writeAgent(stateDir, { url: "http://remote:3100" });
      const service = createService(stateDir);

      mockClient.sendMessage.mockResolvedValue({
        id: "task-remote-1",
        status: { state: "completed" },
        artifacts: [
          {
            artifactId: "a1",
            parts: [{ kind: "text", text: "result from remote" }],
          },
        ],
      });

      const result = await service.delegateTaskSync({
        agentUrl: "http://remote:3100",
        task: "do something",
      });

      expect(result.status).toBe("completed");
      expect(result.output).toBe("result from remote");
      expect(result.taskId).toBe("task-remote-1");
    });

    it("happy path: sendMessage returns Message directly", async () => {
      const stateDir = tmpStateDir();
      writeProfile(stateDir);
      writeAgent(stateDir, { url: "http://remote:3100" });
      const service = createService(stateDir);

      mockClient.sendMessage.mockResolvedValue({
        kind: "message",
        role: "agent",
        messageId: "m1",
        parts: [{ kind: "text", text: "direct response" }],
      });

      const result = await service.delegateTaskSync({
        agentUrl: "http://remote:3100",
        task: "ask something",
      });

      expect(result.status).toBe("completed");
      expect(result.output).toBe("direct response");
    });

    it("returns error when agent not found in registry", async () => {
      const stateDir = tmpStateDir();
      writeProfile(stateDir);
      // Don't add any agent
      const service = createService(stateDir);

      const result = await service.delegateTaskSync({
        agentUrl: "http://unknown:3100",
        task: "something",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("unknown agent");
    });

    it("returns failed status when profile is incomplete (no ownerName)", async () => {
      const stateDir = tmpStateDir();
      writeProfile(stateDir, { ownerName: "", bio: "has bio" });
      writeAgent(stateDir, { url: "http://remote:3100" });
      const service = createService(stateDir);

      const result = await service.delegateTaskSync({
        agentUrl: "http://remote:3100",
        task: "something",
      });
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/档案未完成/);
    });

    it("allows delegation when profile has ownerName but no bio", async () => {
      const stateDir = tmpStateDir();
      writeProfile(stateDir, { ownerName: "Test", bio: "" });
      writeAgent(stateDir, { url: "http://remote:3100" });
      const service = createService(stateDir);

      mockClient.sendMessage.mockResolvedValue({
        kind: "message",
        role: "agent",
        parts: [{ kind: "text", text: "done" }],
        messageId: "msg-1",
      });

      const result = await service.delegateTaskSync({
        agentUrl: "http://remote:3100",
        task: "something",
      });

      expect(result.status).toBe("completed");
    });

    it("handles sendMessage throwing an error", async () => {
      const stateDir = tmpStateDir();
      writeProfile(stateDir);
      writeAgent(stateDir, { url: "http://remote:3100" });
      const service = createService(stateDir);

      mockClient.sendMessage.mockRejectedValue(new Error("connection refused"));

      const result = await service.delegateTaskSync({
        agentUrl: "http://remote:3100",
        task: "something",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("connection refused");
    });

    it("handles Task with failed state", async () => {
      const stateDir = tmpStateDir();
      writeProfile(stateDir);
      writeAgent(stateDir, { url: "http://remote:3100" });
      const service = createService(stateDir);

      mockClient.sendMessage.mockResolvedValue({
        id: "task-fail",
        status: { state: "failed" },
        artifacts: [],
      });

      const result = await service.delegateTaskSync({
        agentUrl: "http://remote:3100",
        task: "something",
      });

      expect(result.status).toBe("failed");
    });

    it("handles Task with unknown state and marks tracker as failed", async () => {
      const stateDir = tmpStateDir();
      writeProfile(stateDir);
      writeAgent(stateDir, { url: "http://remote:3100" });
      const service = createService(stateDir);

      mockClient.sendMessage.mockResolvedValue({
        id: "task-unknown",
        status: { state: "unknown" },
        artifacts: [],
      });

      const result = await service.delegateTaskSync({
        agentUrl: "http://remote:3100",
        task: "something",
      });

      expect(result.status).toBe("unknown");

      // processTaskResult returns remote task.id, not local tracker UUID.
      // Verify the tracker is updated by reading the tasks file directly.
      const tasksFile = path.join(stateDir, "multiclaws", "tasks.json");
      // Wait for async persist
      await new Promise((r) => setTimeout(r, 50));
      const stored = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
      const task = stored.tasks.find((t: any) => t.toPeerId === "http://remote:3100");
      expect(task).toBeDefined();
      expect(task.status).toBe("failed");
      expect(task.error).toContain("unexpected remote state");
    });

    it("extracts text from multiple artifacts", async () => {
      const stateDir = tmpStateDir();
      writeProfile(stateDir);
      writeAgent(stateDir, { url: "http://remote:3100" });
      const service = createService(stateDir);

      mockClient.sendMessage.mockResolvedValue({
        id: "task-multi",
        status: { state: "completed" },
        artifacts: [
          {
            artifactId: "a1",
            parts: [{ kind: "text", text: "first artifact" }],
          },
          {
            artifactId: "a2",
            parts: [{ kind: "text", text: "second artifact" }],
          },
        ],
      });

      const result = await service.delegateTaskSync({
        agentUrl: "http://remote:3100",
        task: "something",
      });

      expect(result.status).toBe("completed");
      expect(result.output).toContain("first artifact");
      expect(result.output).toContain("second artifact");
    });

    it("returns empty output when Task has no artifacts", async () => {
      const stateDir = tmpStateDir();
      writeProfile(stateDir);
      writeAgent(stateDir, { url: "http://remote:3100" });
      const service = createService(stateDir);

      mockClient.sendMessage.mockResolvedValue({
        id: "task-noart",
        status: { state: "completed" },
        artifacts: [],
      });

      const result = await service.delegateTaskSync({
        agentUrl: "http://remote:3100",
        task: "something",
      });

      expect(result.status).toBe("completed");
      expect(result.output).toBe("");
    });

    it("normalizes agent URL (trailing slash) for lookup", async () => {
      const stateDir = tmpStateDir();
      writeProfile(stateDir);
      writeAgent(stateDir, { url: "http://remote:3100" });
      const service = createService(stateDir);

      mockClient.sendMessage.mockResolvedValue({
        kind: "message",
        role: "agent",
        messageId: "m1",
        parts: [{ kind: "text", text: "ok" }],
      });

      // URL with trailing slash should still match
      const result = await service.delegateTaskSync({
        agentUrl: "http://remote:3100/",
        task: "something",
      });

      expect(result.status).toBe("completed");
    });
  });
});
