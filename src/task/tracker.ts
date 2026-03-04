import { randomUUID } from "node:crypto";

export type TaskStatus = "queued" | "running" | "completed" | "failed";

export type TaskRecord = {
  taskId: string;
  fromPeerId: string;
  toPeerId: string;
  task: string;
  context?: string;
  status: TaskStatus;
  createdAtMs: number;
  updatedAtMs: number;
  result?: string;
  error?: string;
};

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TASKS = 10_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class TaskTracker {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly ttlMs: number;
  private readonly maxTasks: number;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: { ttlMs?: number; maxTasks?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxTasks = opts?.maxTasks ?? MAX_TASKS;
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    // Allow the timer to not block process exit
    if (this.pruneTimer && typeof this.pruneTimer === "object" && "unref" in this.pruneTimer) {
      this.pruneTimer.unref();
    }
  }

  create(params: { fromPeerId: string; toPeerId: string; task: string; context?: string }): TaskRecord {
    if (this.tasks.size >= this.maxTasks) {
      this.prune();
    }
    // If still over limit after prune, evict oldest finished tasks
    if (this.tasks.size >= this.maxTasks) {
      this.evictOldest();
    }
    const now = Date.now();
    const record: TaskRecord = {
      taskId: randomUUID(),
      fromPeerId: params.fromPeerId,
      toPeerId: params.toPeerId,
      task: params.task,
      context: params.context,
      status: "queued",
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.tasks.set(record.taskId, record);
    return record;
  }

  update(taskId: string, patch: Partial<Omit<TaskRecord, "taskId" | "createdAtMs">>): TaskRecord | null {
    const current = this.tasks.get(taskId);
    if (!current) {
      return null;
    }
    const next: TaskRecord = {
      ...current,
      ...patch,
      updatedAtMs: Date.now(),
    };
    this.tasks.set(taskId, next);
    return next;
  }

  get(taskId: string): TaskRecord | null {
    return this.tasks.get(taskId) ?? null;
  }

  list(): TaskRecord[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  destroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.tasks.clear();
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, task] of this.tasks) {
      if (task.updatedAtMs < cutoff && (task.status === "completed" || task.status === "failed")) {
        this.tasks.delete(id);
      }
    }
  }

  private evictOldest(): void {
    const sorted = Array.from(this.tasks.entries())
      .filter(([, t]) => t.status === "completed" || t.status === "failed")
      .sort(([, a], [, b]) => a.updatedAtMs - b.updatedAtMs);
    const toRemove = Math.max(1, Math.floor(sorted.length / 4));
    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      this.tasks.delete(sorted[i][0]);
    }
  }
}
