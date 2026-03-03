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

export class TaskTracker {
  private readonly tasks = new Map<string, TaskRecord>();

  create(params: { fromPeerId: string; toPeerId: string; task: string; context?: string }): TaskRecord {
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
}
