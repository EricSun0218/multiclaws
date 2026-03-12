import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { BasicLogger } from "../infra/logger";

export type SessionStatus =
  | "active"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

export type SessionMessage = {
  role: "user" | "agent";
  content: string;
  timestampMs: number;
  taskId?: string;
};

export type ConversationSession = {
  sessionId: string;
  agentUrl: string;
  agentName: string;
  contextId: string;
  currentTaskId?: string;
  status: SessionStatus;
  messages: SessionMessage[];
  createdAtMs: number;
  updatedAtMs: number;
  error?: string;
};

type SessionStoreData = {
  version: 1;
  sessions: ConversationSession[];
};

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_SESSIONS = 1_000;
const MAX_MESSAGES_PER_SESSION = 200;

function emptyStore(): SessionStoreData {
  return { version: 1, sessions: [] };
}

function normalizeStore(raw: SessionStoreData): SessionStoreData {
  if (raw.version !== 1 || !Array.isArray(raw.sessions)) {
    return emptyStore();
  }
  return {
    version: 1,
    sessions: raw.sessions.filter(
      (s) =>
        s &&
        typeof s.sessionId === "string" &&
        typeof s.agentUrl === "string" &&
        typeof s.status === "string" &&
        typeof s.createdAtMs === "number" &&
        Array.isArray(s.messages),
    ),
  };
}

export class SessionStore {
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly logger?: BasicLogger;
  private store: SessionStoreData;
  private persistPending = false;

  constructor(opts: { filePath: string; ttlMs?: number; logger?: BasicLogger }) {
    this.filePath = opts.filePath;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.logger = opts.logger;
    this.store = this.loadSync();
  }

  create(params: {
    agentUrl: string;
    agentName: string;
    contextId: string;
  }): ConversationSession {
    this.prune();
    const now = Date.now();
    const session: ConversationSession = {
      sessionId: randomUUID(),
      agentUrl: params.agentUrl,
      agentName: params.agentName,
      contextId: params.contextId,
      status: "active",
      messages: [],
      createdAtMs: now,
      updatedAtMs: now,
    };
    if (this.store.sessions.length >= MAX_SESSIONS) {
      this.evictOldest();
    }
    this.store.sessions.push(session);
    this.schedulePersist();
    return session;
  }

  get(sessionId: string): ConversationSession | null {
    return this.store.sessions.find((s) => s.sessionId === sessionId) ?? null;
  }

  list(): ConversationSession[] {
    return [...this.store.sessions].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  update(sessionId: string, patch: Partial<Omit<ConversationSession, "sessionId" | "createdAtMs">>): ConversationSession | null {
    const idx = this.store.sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx < 0) return null;
    const next: ConversationSession = {
      ...this.store.sessions[idx],
      ...patch,
      updatedAtMs: Date.now(),
    };
    this.store.sessions[idx] = next;
    this.schedulePersist();
    return next;
  }

  appendMessage(sessionId: string, msg: SessionMessage): ConversationSession | null {
    const session = this.get(sessionId);
    if (!session) return null;
    let messages = [...session.messages, msg];
    // Truncate old messages, keeping the most recent ones
    if (messages.length > MAX_MESSAGES_PER_SESSION) {
      messages = messages.slice(-MAX_MESSAGES_PER_SESSION);
    }
    return this.update(sessionId, { messages });
  }

  private loadSync(): SessionStoreData {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as SessionStoreData;
      return normalizeStore(raw);
    } catch {
      const store = emptyStore();
      fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2), "utf8");
      return store;
    }
  }

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
    } catch (err) {
      // best-effort
      this.logger?.warn?.(`[session-store] persistAsync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    this.store.sessions = this.store.sessions.filter((s) => {
      if (s.updatedAtMs >= cutoff) return true;
      return s.status !== "completed" && s.status !== "failed" && s.status !== "canceled";
    });
  }

  private evictOldest(): void {
    const removable = [...this.store.sessions]
      .filter((s) => s.status === "completed" || s.status === "failed" || s.status === "canceled")
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
      .slice(0, Math.max(1, Math.floor(MAX_SESSIONS / 4)));
    const ids = new Set(removable.map((s) => s.sessionId));
    this.store.sessions = this.store.sessions.filter((s) => !ids.has(s.sessionId));
  }
}
