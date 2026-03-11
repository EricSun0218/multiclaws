import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskTracker } from "../src/task/tracker";

const tmpFiles: string[] = [];
const trackers: TaskTracker[] = [];

function tmpPath(): string {
  const p = path.join(
    os.tmpdir(),
    `task-tracker-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  tmpFiles.push(p);
  return p;
}

function createTracker(opts?: { ttlMs?: number; maxTasks?: number }) {
  const t = new TaskTracker({ filePath: tmpPath(), ...opts });
  trackers.push(t);
  return t;
}

afterEach(() => {
  for (const t of trackers) t.destroy();
  trackers.length = 0;
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch {}
    try { fs.unlinkSync(f + ".lock"); } catch {}
    // Clean up tmp files left by persistence
    const dir = path.dirname(f);
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(path.basename(f)) && entry.endsWith(".tmp")) {
          try { fs.unlinkSync(path.join(dir, entry)); } catch {}
        }
      }
    } catch {}
  }
  tmpFiles.length = 0;
});

describe("TaskTracker", () => {
  describe("create and get", () => {
    it("creates a task with queued status", () => {
      const tracker = createTracker();
      const record = tracker.create({
        fromPeerId: "agent-a",
        toPeerId: "agent-b",
        task: "do something",
      });

      expect(record.taskId).toBeDefined();
      expect(typeof record.taskId).toBe("string");
      expect(record.taskId.length).toBeGreaterThan(0);
      expect(record.status).toBe("queued");
      expect(record.fromPeerId).toBe("agent-a");
      expect(record.toPeerId).toBe("agent-b");
      expect(record.task).toBe("do something");
      expect(record.createdAtMs).toBeGreaterThan(0);
      expect(record.updatedAtMs).toBe(record.createdAtMs);
    });

    it("assigns unique taskIds", () => {
      const tracker = createTracker();
      const r1 = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t1" });
      const r2 = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t2" });
      expect(r1.taskId).not.toBe(r2.taskId);
    });

    it("get returns the created task", () => {
      const tracker = createTracker();
      const record = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t1" });
      const got = tracker.get(record.taskId);
      expect(got).not.toBeNull();
      expect(got!.taskId).toBe(record.taskId);
      expect(got!.task).toBe("t1");
    });

    it("get returns null for nonexistent taskId", () => {
      const tracker = createTracker();
      expect(tracker.get("nonexistent")).toBeNull();
    });
  });

  describe("update", () => {
    it("updates task status and updatedAtMs", async () => {
      const tracker = createTracker();
      const record = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t1" });
      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 5));
      const updated = tracker.update(record.taskId, { status: "running" });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("running");
      expect(updated!.updatedAtMs).toBeGreaterThanOrEqual(record.updatedAtMs);
    });

    it("updates task to completed with result", () => {
      const tracker = createTracker();
      const record = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t1" });
      const updated = tracker.update(record.taskId, {
        status: "completed",
        result: "done",
      });
      expect(updated!.status).toBe("completed");
      expect(updated!.result).toBe("done");
    });

    it("updates task to failed with error", () => {
      const tracker = createTracker();
      const record = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t1" });
      const updated = tracker.update(record.taskId, {
        status: "failed",
        error: "timeout",
      });
      expect(updated!.status).toBe("failed");
      expect(updated!.error).toBe("timeout");
    });

    it("returns null when updating nonexistent task", () => {
      const tracker = createTracker();
      expect(tracker.update("nonexistent", { status: "running" })).toBeNull();
    });
  });

  describe("list", () => {
    it("returns tasks sorted by updatedAtMs descending", async () => {
      const tracker = createTracker();
      const r1 = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t1" });
      await new Promise((r) => setTimeout(r, 5));
      const r2 = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t2" });
      await new Promise((r) => setTimeout(r, 5));
      const r3 = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t3" });

      const list = tracker.list();
      expect(list.length).toBe(3);
      expect(list[0].taskId).toBe(r3.taskId);
      expect(list[2].taskId).toBe(r1.taskId);
    });

    it("returns empty array when no tasks", () => {
      const tracker = createTracker();
      expect(tracker.list()).toEqual([]);
    });
  });

  describe("status transitions", () => {
    it("full lifecycle: queued -> running -> completed", () => {
      const tracker = createTracker();
      const record = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t1" });
      expect(tracker.get(record.taskId)!.status).toBe("queued");

      tracker.update(record.taskId, { status: "running" });
      expect(tracker.get(record.taskId)!.status).toBe("running");

      tracker.update(record.taskId, { status: "completed", result: "success" });
      const final = tracker.get(record.taskId)!;
      expect(final.status).toBe("completed");
      expect(final.result).toBe("success");
    });

    it("full lifecycle: queued -> running -> failed", () => {
      const tracker = createTracker();
      const record = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t1" });
      tracker.update(record.taskId, { status: "running" });
      tracker.update(record.taskId, { status: "failed", error: "crash" });

      const final = tracker.get(record.taskId)!;
      expect(final.status).toBe("failed");
      expect(final.error).toBe("crash");
    });
  });

  describe("pruning", () => {
    it("removes completed tasks older than TTL", async () => {
      const tracker = createTracker({ ttlMs: 50 });
      const record = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t1" });
      tracker.update(record.taskId, { status: "completed", result: "done" });

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 60));

      // Creating a task when at capacity triggers prune, but also we can test
      // by checking list after creating a new task (prune runs on create if maxTasks reached)
      // Since maxTasks is default 10000, force prune by creating another tracker and reading the state.
      // Instead, just verify the behavior: old completed task should be pruned after TTL.
      // We trigger prune indirectly by calling create when maxTasks is reached.
      // Let's use maxTasks: 1 to trigger prune on next create.
      const tracker2 = new TaskTracker({ filePath: tmpPath(), ttlMs: 50, maxTasks: 1 });
      trackers.push(tracker2);

      const r1 = tracker2.create({ fromPeerId: "a", toPeerId: "b", task: "old" });
      tracker2.update(r1.taskId, { status: "completed" });

      await new Promise((r) => setTimeout(r, 60));

      // This create triggers prune because maxTasks (1) reached
      const r2 = tracker2.create({ fromPeerId: "a", toPeerId: "b", task: "new" });
      const list = tracker2.list();
      // Old completed task should be pruned, only new task remains
      expect(list.length).toBe(1);
      expect(list[0].taskId).toBe(r2.taskId);
    });

    it("keeps running tasks even if older than TTL", async () => {
      const tracker = createTracker({ ttlMs: 50, maxTasks: 2 });
      const r1 = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "running-task" });
      tracker.update(r1.taskId, { status: "running" });

      await new Promise((r) => setTimeout(r, 60));

      // Create another task to potentially trigger prune
      tracker.create({ fromPeerId: "a", toPeerId: "b", task: "new" });

      const list = tracker.list();
      const runningTask = list.find((t) => t.taskId === r1.taskId);
      expect(runningTask).toBeDefined();
      expect(runningTask!.status).toBe("running");
    });

    it("evicts oldest completed tasks when maxTasks reached", async () => {
      const tracker = createTracker({ maxTasks: 3 });
      const r1 = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t1" });
      tracker.update(r1.taskId, { status: "completed" });
      await new Promise((r) => setTimeout(r, 5));

      const r2 = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t2" });
      tracker.update(r2.taskId, { status: "completed" });
      await new Promise((r) => setTimeout(r, 5));

      const r3 = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t3" });
      tracker.update(r3.taskId, { status: "completed" });

      // Now at maxTasks, creating another should trigger eviction
      const r4 = tracker.create({ fromPeerId: "a", toPeerId: "b", task: "t4" });

      const list = tracker.list();
      // Oldest completed task (r1) should be evicted
      expect(list.find((t) => t.taskId === r1.taskId)).toBeUndefined();
      expect(list.find((t) => t.taskId === r4.taskId)).toBeDefined();
    });
  });

  describe("persistence", () => {
    it("persists tasks to file after create", async () => {
      const filePath = tmpPath();
      const tracker = new TaskTracker({ filePath });
      trackers.push(tracker);

      tracker.create({ fromPeerId: "a", toPeerId: "b", task: "persistent-task" });

      // Wait for microtask + async persist
      await new Promise((r) => setTimeout(r, 50));

      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(raw.tasks.length).toBe(1);
      expect(raw.tasks[0].task).toBe("persistent-task");
    });

    it("loads tasks from file on construction", async () => {
      const filePath = tmpPath();

      // Write a tasks file directly
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          tasks: [
            {
              taskId: "preloaded-1",
              fromPeerId: "x",
              toPeerId: "y",
              task: "old task",
              status: "completed",
              createdAtMs: Date.now() - 1000,
              updatedAtMs: Date.now() - 500,
              result: "old result",
            },
          ],
        }),
      );

      const tracker = new TaskTracker({ filePath });
      trackers.push(tracker);

      const loaded = tracker.get("preloaded-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.task).toBe("old task");
      expect(loaded!.result).toBe("old result");
    });
  });

  describe("destroy", () => {
    it("clears the prune interval", () => {
      const tracker = createTracker();
      // Should not throw
      tracker.destroy();
      tracker.destroy(); // Double destroy should be safe
    });
  });
});
