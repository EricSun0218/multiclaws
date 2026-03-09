import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

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

type TaskStore = {
  version: 1;
  tasks: TaskRecord[];
};

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TASKS = 10_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

function emptyStore(): TaskStore {
  return {
    version: 1,
    tasks: [],
  };
}

function normalizeTask(task: TaskRecord): TaskRecord | null {
  if (
    !task ||
    typeof task.taskId !== "string" ||
    typeof task.fromPeerId !== "string" ||
    typeof task.toPeerId !== "string" ||
    typeof task.task !== "string" ||
    typeof task.status !== "string" ||
    typeof task.createdAtMs !== "number" ||
    typeof task.updatedAtMs !== "number"
  ) {
    return null;
  }

  return {
    taskId: task.taskId,
    fromPeerId: task.fromPeerId,
    toPeerId: task.toPeerId,
    task: task.task,
    context: typeof task.context === "string" ? task.context : undefined,
    status: task.status as TaskStatus,
    createdAtMs: task.createdAtMs,
    updatedAtMs: task.updatedAtMs,
    result: typeof task.result === "string" ? task.result : undefined,
    error: typeof task.error === "string" ? task.error : undefined,
  };
}

function normalizeStore(raw: TaskStore): TaskStore {
  if (raw.version !== 1 || !Array.isArray(raw.tasks)) {
    return emptyStore();
  }
  const tasks: TaskRecord[] = [];
  for (const task of raw.tasks) {
    const normalized = normalizeTask(task);
    if (normalized) {
      tasks.push(normalized);
    }
  }
  return {
    version: 1,
    tasks,
  };
}

export class TaskTracker {
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly maxTasks: number;
  private readonly store: TaskStore;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private persistPending = false;

  constructor(opts?: { ttlMs?: number; maxTasks?: number; filePath?: string }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxTasks = opts?.maxTasks ?? MAX_TASKS;
    this.filePath = opts?.filePath ?? ".openclaw/multiclaws/tasks.json";
    // Sync load at startup is acceptable (runs once)
    this.store = this.loadStoreSync();

    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    if (this.pruneTimer && typeof this.pruneTimer === "object" && "unref" in this.pruneTimer) {
      this.pruneTimer.unref();
    }
  }

  create(params: { fromPeerId: string; toPeerId: string; task: string; context?: string }): TaskRecord {
    if (this.store.tasks.length >= this.maxTasks) {
      this.prune();
    }
    if (this.store.tasks.length >= this.maxTasks) {
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

    this.store.tasks.push(record);
    this.schedulePersist();
    return record;
  }

  update(taskId: string, patch: Partial<Omit<TaskRecord, "taskId" | "createdAtMs">>): TaskRecord | null {
    const index = this.store.tasks.findIndex((entry) => entry.taskId === taskId);
    if (index < 0) {
      return null;
    }

    const next: TaskRecord = {
      ...this.store.tasks[index],
      ...patch,
      updatedAtMs: Date.now(),
    };
    this.store.tasks[index] = next;
    this.schedulePersist();
    return next;
  }

  get(taskId: string): TaskRecord | null {
    return this.store.tasks.find((entry) => entry.taskId === taskId) ?? null;
  }

  list(): TaskRecord[] {
    return [...this.store.tasks].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  destroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  /** Sync load at startup — runs once before the event loop is busy. */
  private loadStoreSync(): TaskStore {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as TaskStore;
      return normalizeStore(raw);
    } catch {
      const store = emptyStore();
      fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2), "utf8");
      return store;
    }
  }

  /** Coalesce rapid writes into a single async flush. */
  private schedulePersist(): void {
    if (this.persistPending) return;
    this.persistPending = true;
    queueMicrotask(() => {
      this.persistPending = false;
      void this.persistAsync();
    });
  }

  private async persistAsync(): Promise<void> {
    try {
      await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await fsPromises.writeFile(tmp, JSON.stringify(this.store, null, 2), "utf8");
      await fsPromises.rename(tmp, this.filePath);
    } catch {
      // best-effort persistence — in-memory state is authoritative
    }
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    const before = this.store.tasks.length;
    this.store.tasks = this.store.tasks.filter((task) => {
      if (task.updatedAtMs >= cutoff) {
        return true;
      }
      return task.status !== "completed" && task.status !== "failed";
    });
    if (this.store.tasks.length !== before) {
      this.schedulePersist();
    }
  }

  private evictOldest(): void {
    const removable = [...this.store.tasks]
      .filter((task) => task.status === "completed" || task.status === "failed")
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
      .slice(0, Math.max(1, Math.floor(this.maxTasks / 4)));

    if (removable.length === 0) {
      return;
    }

    const removeIds = new Set(removable.map((entry) => entry.taskId));
    this.store.tasks = this.store.tasks.filter((entry) => !removeIds.has(entry.taskId));
    this.schedulePersist();
  }
}
