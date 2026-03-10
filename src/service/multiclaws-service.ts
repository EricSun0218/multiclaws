import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { detectTailscale, getTailscaleIpFromInterfaces } from "../infra/tailscale";
import { readJsonWithFallback, writeJsonAtomically } from "../infra/json-store";
import express from "express";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler, agentCardHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { ClientFactory } from "@a2a-js/sdk/client";
import type { AgentCard, Task, Message } from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import { OpenClawAgentExecutor } from "./a2a-adapter";
import { AgentRegistry, type AgentRecord } from "./agent-registry";
import {
  ProfileStore,
  renderProfileDescription,
  type AgentProfile,
} from "./agent-profile";
import { TeamStore, encodeInvite, decodeInvite, type TeamRecord, type TeamMember } from "../team/team-store";
import { TaskTracker } from "../task/tracker";
import { SessionStore, type ConversationSession } from "./session-store";
import { z } from "zod";
import type { GatewayConfig } from "../infra/gateway-client";
import { invokeGatewayTool } from "../infra/gateway-client";
import { RateLimiter } from "../infra/rate-limiter";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type MulticlawsServiceOptions = {
  stateDir: string;
  port?: number;
  displayName?: string;
  selfUrl?: string;
  gatewayConfig?: GatewayConfig;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    debug?: (message: string) => void;
  };
};

export type SessionStartResult = {
  sessionId: string;
  status: "running" | "failed";
  error?: string;
};

export type SessionReplyResult = {
  sessionId: string;
  status: "ok" | "failed";
  error?: string;
};

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

export class MulticlawsService extends EventEmitter {
  private started = false;
  private httpServer: http.Server | null = null;
  private readonly agentRegistry: AgentRegistry;
  private readonly teamStore: TeamStore;
  private readonly profileStore: ProfileStore;
  private readonly taskTracker: TaskTracker;
  private readonly sessionStore: SessionStore;
  // Fix #5: per-session lock to prevent concurrent runSession calls
  private readonly sessionLocks = new Map<string, Promise<void>>();
  // Per-session AbortController so endSession can cancel in-flight runSession
  private readonly sessionAborts = new Map<string, AbortController>();
  private agentExecutor: OpenClawAgentExecutor | null = null;
  private a2aRequestHandler: DefaultRequestHandler | null = null;
  private agentCard: AgentCard | null = null;
  private readonly clientFactory = new ClientFactory();
  private readonly httpRateLimiter = new RateLimiter({ windowMs: 60_000, maxRequests: 60 });
  private selfUrl: string;
  private profileDescription = "OpenClaw agent";

  constructor(private readonly options: MulticlawsServiceOptions) {
    super();
    const multiclawsStateDir = path.join(options.stateDir, "multiclaws");
    this.agentRegistry = new AgentRegistry(path.join(multiclawsStateDir, "agents.json"));
    this.teamStore = new TeamStore(path.join(multiclawsStateDir, "teams.json"));
    this.profileStore = new ProfileStore(path.join(multiclawsStateDir, "profile.json"));
    this.taskTracker = new TaskTracker({
      filePath: path.join(multiclawsStateDir, "tasks.json"),
    });
    this.sessionStore = new SessionStore({
      filePath: path.join(multiclawsStateDir, "sessions.json"),
    });
    const port = options.port ?? 3100;
    // selfUrl resolved later in start() after Tailscale detection; use placeholder for now
    this.selfUrl = options.selfUrl ?? `http://${getLocalIp()}:${port}`;
  }

  async start(): Promise<void> {
    if (this.started) return;

    // Auto-detect Tailscale if selfUrl not explicitly configured
    if (!this.options.selfUrl) {
      const port = this.options.port ?? 3100;

      // Fast path: Tailscale already active — just read from network interfaces, no subprocess
      const tsIp = getTailscaleIpFromInterfaces();
      if (tsIp) {
        this.selfUrl = `http://${tsIp}:${port}`;
        this.log("info", `Tailscale IP detected: ${tsIp}`);
      } else {
        // Slow path: Tailscale not active — run full detection and notify user
        const tailscale = await detectTailscale();
        if (tailscale.status === "ready") {
          this.selfUrl = `http://${tailscale.ip}:${port}`;
          this.log("info", `Tailscale IP detected: ${tailscale.ip}`);
        } else {
          void this.notifyTailscaleSetup(tailscale);
        }
      }
    }

    // Load profile for AgentCard description
    let profile = await this.profileStore.load();
    const isIncompleteProfile = !profile.ownerName?.trim() || !profile.bio?.trim();
    if (!profile.ownerName?.trim()) {
      profile.ownerName = this.options.displayName ?? os.hostname();
      await this.profileStore.save(profile);
    }
    if (isIncompleteProfile) {
      await this.setPendingProfileReview();
    }
    this.profileDescription = renderProfileDescription(profile);

    const logger = this.options.logger ?? { info: () => {}, warn: () => {}, error: () => {} };

    this.agentExecutor = new OpenClawAgentExecutor({
      gatewayConfig: this.options.gatewayConfig ?? null,
      taskTracker: this.taskTracker,
      logger,
    });

    this.agentCard = {
      name: this.options.displayName ?? (profile.ownerName || "OpenClaw Agent"),
      description: this.profileDescription,
      url: this.selfUrl,
      version: "0.4.2",
      protocolVersion: "0.2.2",
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      capabilities: { streaming: false, pushNotifications: false },
      skills: [
        {
          id: "general",
          name: "General Task",
          description: "Execute any delegated task via OpenClaw",
          tags: ["task", "delegation", "general"],
        },
      ],
    };

    const taskStore = new InMemoryTaskStore();
    this.a2aRequestHandler = new DefaultRequestHandler(
      this.agentCard,
      taskStore,
      this.agentExecutor,
    );

    const app = express();
    app.use(express.json({ limit: "1mb" }));

    // Rate limiting
    app.use((req, res, next) => {
      const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
      if (!this.httpRateLimiter.allow(clientIp)) {
        res.status(429).json({ error: "rate limited" });
        return;
      }
      next();
    });

    // Team + profile REST endpoints
    this.mountTeamRoutes(app);

    // A2A endpoints
    app.use("/.well-known/agent-card.json", agentCardHandler({
      agentCardProvider: this.a2aRequestHandler,
    }));
    app.use("/", jsonRpcHandler({
      requestHandler: this.a2aRequestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }));

    const listenPort = this.options.port ?? 3100;
    this.httpServer = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(listenPort, "0.0.0.0", () => {
        this.httpServer!.removeListener("error", reject);
        resolve();
      });
    });

    this.started = true;
    this.log("info", `multiclaws A2A service listening on :${listenPort}`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Abort all in-flight sessions so they don't hang
    for (const [, abort] of this.sessionAborts) {
      abort.abort();
    }

    // Wait for session locks to drain (with a cap)
    if (this.sessionLocks.size > 0) {
      const pending = [...this.sessionLocks.values()];
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((r) => setTimeout(r, 5_000)),
      ]);
    }

    this.taskTracker.destroy();
    this.httpRateLimiter.destroy();

    await new Promise<void>((resolve) => {
      if (!this.httpServer) { resolve(); return; }
      this.httpServer.close(() => resolve());
    });
    this.httpServer = null;
  }

  updateGatewayConfig(config: GatewayConfig): void {
    this.options.gatewayConfig = config;
    this.agentExecutor?.updateGatewayConfig(config);
  }

  /* ---------------------------------------------------------------- */
  /*  Agent management                                                 */
  /* ---------------------------------------------------------------- */

  async listAgents(): Promise<AgentRecord[]> {
    return await this.agentRegistry.list();
  }

  async addAgent(params: { url: string; apiKey?: string }): Promise<AgentRecord & { reachable: boolean }> {
    const normalizedUrl = params.url.replace(/\/+$/, "");
    try {
      const client = await this.clientFactory.createFromUrl(normalizedUrl);
      const card = await client.getAgentCard();
      const record = await this.agentRegistry.add({
        url: normalizedUrl,
        name: card.name ?? normalizedUrl,
        description: card.description ?? "",
        skills: card.skills?.map((s) => s.name ?? s.id) ?? [],
        apiKey: params.apiKey,
      });
      return { ...record, reachable: true };
    } catch {
      this.log("warn", `agent at ${normalizedUrl} is not reachable, adding with limited info`);
      const record = await this.agentRegistry.add({
        url: normalizedUrl,
        name: normalizedUrl,
        apiKey: params.apiKey,
      });
      return { ...record, reachable: false };
    }
  }

  async removeAgent(url: string): Promise<boolean> {
    return await this.agentRegistry.remove(url);
  }

  /* ---------------------------------------------------------------- */
  /*  Task delegation                                                  */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /*  Session management (multi-turn collaboration)                  */
  /* ---------------------------------------------------------------- */

  async startSession(params: {
    agentUrl: string;
    message: string;
  }): Promise<SessionStartResult> {
    const agentRecord = await this.agentRegistry.get(params.agentUrl);
    // Fix #3: throw instead of returning empty sessionId
    if (!agentRecord) {
      throw new Error(`unknown agent: ${params.agentUrl}`);
    }

    // Fix #4: don't pre-generate contextId; let server assign it.
    // Use a local placeholder that gets replaced after first response.
    const session = this.sessionStore.create({
      agentUrl: params.agentUrl,
      agentName: agentRecord.name,
      contextId: "",  // will be filled in from server response
    });

    this.sessionStore.appendMessage(session.sessionId, {
      role: "user",
      content: params.message,
      timestampMs: Date.now(),
    });

    void this.acquireSessionLock(session.sessionId, () =>
      this.runSession({
        sessionId: session.sessionId,
        agentRecord,
        message: params.message,
        contextId: undefined,   // first message: no contextId
        taskId: undefined,
      }),
    );

    return { sessionId: session.sessionId, status: "running" };
  }

  async sendSessionMessage(params: {
    sessionId: string;
    message: string;
  }): Promise<SessionReplyResult> {
    const session = this.sessionStore.get(params.sessionId);
    if (!session) {
      return { sessionId: params.sessionId, status: "failed", error: "session not found" };
    }
    if (session.status !== "input-required" && session.status !== "active") {
      return { sessionId: params.sessionId, status: "failed", error: `session is ${session.status}, cannot send message` };
    }

    this.sessionStore.appendMessage(params.sessionId, {
      role: "user",
      content: params.message,
      timestampMs: Date.now(),
    });
    this.sessionStore.update(params.sessionId, { status: "active" });

    const agentRecord = await this.agentRegistry.get(session.agentUrl);
    if (!agentRecord) {
      this.sessionStore.update(params.sessionId, { status: "failed", error: "agent no longer registered" });
      return { sessionId: params.sessionId, status: "failed", error: "agent no longer registered" };
    }

    // Fix #5: acquire lock to prevent concurrent runSession on same session
    void this.acquireSessionLock(params.sessionId, () =>
      this.runSession({
        sessionId: params.sessionId,
        agentRecord,
        message: params.message,
        contextId: session.contextId || undefined,
        taskId: session.currentTaskId,
      }),
    );

    return { sessionId: params.sessionId, status: "ok" };
  }

  getSession(sessionId: string): ConversationSession | null {
    return this.sessionStore.get(sessionId);
  }

  listSessions(): ConversationSession[] {
    return this.sessionStore.list();
  }

  async waitForSessions(params: {
    sessionIds: string[];
    timeoutMs?: number;
  }): Promise<{
    results: Array<{
      sessionId: string;
      status: string;
      agentName: string;
      lastMessage?: string;
      error?: string;
    }>;
    timedOut: boolean;
  }> {
    const timeout = params.timeoutMs ?? 5 * 60 * 1000;
    const deadline = Date.now() + timeout;
    const terminalStates = new Set(["completed", "failed", "canceled"]);

    const getResults = () =>
      params.sessionIds.map((id) => {
        const session = this.sessionStore.get(id);
        if (!session) return { sessionId: id, agentName: "unknown", status: "not_found" };
        const lastAgent = [...session.messages].reverse().find((m) => m.role === "agent");
        return {
          sessionId: id,
          agentName: session.agentName,
          status: session.status,
          lastMessage: lastAgent?.content,
          error: session.error,
        };
      });

    while (Date.now() < deadline) {
      const results = getResults();
      const allSettled = results.every(
        (r) => terminalStates.has(r.status) || r.status === "not_found",
      );
      if (allSettled) return { results, timedOut: false };

      // Return early if any session needs input — AI must handle it before continuing
      const needsInput = results.some((r) => r.status === "input-required");
      if (needsInput) return { results, timedOut: false };

      await new Promise((r) => setTimeout(r, 1_000));
    }

    return { results: getResults(), timedOut: true };
  }

  endSession(sessionId: string): boolean {
    const session = this.sessionStore.get(sessionId);
    if (!session) return false;
    this.sessionStore.update(sessionId, { status: "canceled" });
    // Signal the in-flight runSession to abort
    const abort = this.sessionAborts.get(sessionId);
    if (abort) abort.abort();
    return true;
  }

  // Fix #5: serialise concurrent calls on the same session
  private async acquireSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    this.sessionLocks.set(sessionId, next);
    try {
      await prev;
      await fn();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === next) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  private async runSession(params: {
    sessionId: string;
    agentRecord: AgentRecord;
    message: string;
    contextId: string | undefined;   // Fix #4: undefined for first message
    taskId: string | undefined;
    timeoutMs?: number;
  }): Promise<void> {
    const timeout = params.timeoutMs ?? 5 * 60 * 1000;
    const deadline = Date.now() + timeout;
    const abortController = new AbortController();
    this.sessionAborts.set(params.sessionId, abortController);
    const timer = setTimeout(() => abortController.abort(), timeout);

    try {
      const client = await this.createA2AClient(params.agentRecord);

      const withAbort = <T>(p: Promise<T>): Promise<T> => {
        if (abortController.signal.aborted) {
          return Promise.reject(new Error("session canceled"));
        }
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            reject(new Error(
              this.sessionStore.get(params.sessionId)?.status === "canceled"
                ? "session canceled"
                : "session timeout",
            ));
          };
          abortController.signal.addEventListener("abort", onAbort, { once: true });
          p.then(
            (val) => { abortController.signal.removeEventListener("abort", onAbort); resolve(val); },
            (err) => { abortController.signal.removeEventListener("abort", onAbort); reject(err); },
          );
        });
      };

      let result = await withAbort(
        client.sendMessage({
          message: {
            kind: "message",
            role: "user",
            parts: [{ kind: "text", text: params.message }],
            messageId: randomUUID(),
            // Fix #4: only pass contextId if we have a server-assigned one
            ...(params.contextId ? { contextId: params.contextId } : {}),
            ...(params.taskId ? { taskId: params.taskId } : {}),
          },
        }),
      );

      // Fix #1: poll until terminal state if server returns working/submitted
      const POLL_DELAYS = [1000, 2000, 3000, 5000];
      let pollAttempt = 0;
      while (true) {
        const state = this.extractResultState(result);
        const remoteTaskId = "id" in result ? (result as Task).id : undefined;

        if (state !== "working" && state !== "submitted") break;
        if (!remoteTaskId) break; // can't poll without task id
        if (Date.now() >= deadline) throw new Error("session timeout");

        const delay = POLL_DELAYS[Math.min(pollAttempt, POLL_DELAYS.length - 1)];
        await new Promise((r) => setTimeout(r, delay));
        pollAttempt++;

        result = await withAbort(
          client.getTask({ id: remoteTaskId, historyLength: 10 }),
        );
      }

      // Check if session was canceled while we were running
      const current = this.sessionStore.get(params.sessionId);
      if (current?.status === "canceled") return;

      await this.handleSessionResult(params.sessionId, result);
    } catch (err) {
      // Don't overwrite a user-initiated cancel
      const current = this.sessionStore.get(params.sessionId);
      if (current?.status === "canceled") return;

      const errorMsg = err instanceof Error ? err.message : String(err);
      this.sessionStore.update(params.sessionId, { status: "failed", error: errorMsg });
      await this.notifySessionUpdate(params.sessionId, "failed");
    } finally {
      clearTimeout(timer);
      this.sessionAborts.delete(params.sessionId);
    }
  }

  private extractResultState(result: Message | Task): string {
    if ("status" in result && result.status) {
      return (result as Task).status?.state ?? "unknown";
    }
    return "completed"; // plain Message = completed
  }

  private async handleSessionResult(
    sessionId: string,
    result: Message | Task,
  ): Promise<void> {
    let content = "";
    let state = "completed";
    let remoteTaskId: string | undefined;
    let serverContextId: string | undefined;

    if ("status" in result && result.status) {
      const task = result as Task;
      state = task.status?.state ?? "completed";
      remoteTaskId = task.id;
      // Fix #4: capture server-assigned contextId
      serverContextId = task.contextId;
      content = this.extractArtifactText(task);
      if (!content && task.history?.length) {
        const lastAgentMsg = [...task.history].reverse().find((m) => m.role === "agent");
        if (lastAgentMsg) {
          content = lastAgentMsg.parts
            ?.filter((p): p is { kind: "text"; text: string } => p.kind === "text")
            .map((p) => p.text)
            .join("\n") ?? "";
        }
      }
    } else {
      const msg = result as Message;
      remoteTaskId = msg.taskId;
      serverContextId = msg.contextId;
      content = msg.parts
        ?.filter((p): p is { kind: "text"; text: string } => p.kind === "text")
        .map((p) => p.text)
        .join("\n") ?? "";
    }

    // Fix #6: always record agent message, use placeholder when content is empty
    this.sessionStore.appendMessage(sessionId, {
      role: "agent",
      content: content || "(no text output)",
      timestampMs: Date.now(),
      taskId: remoteTaskId,
    });

    // Fix #4: update contextId with server-assigned value
    const contextUpdate = serverContextId ? { contextId: serverContextId } : {};

    if (state === "input-required" || state === "auth-required") {
      this.sessionStore.update(sessionId, {
        ...contextUpdate,
        status: "input-required",
        currentTaskId: remoteTaskId,
      });
      await this.notifySessionUpdate(sessionId, "input-required");
    } else if (state === "failed" || state === "rejected") {
      this.sessionStore.update(sessionId, {
        ...contextUpdate,
        status: "failed",
        currentTaskId: remoteTaskId,
        error: content || "remote task failed",
      });
      await this.notifySessionUpdate(sessionId, "failed");
    } else if (state === "completed") {
      this.sessionStore.update(sessionId, {
        ...contextUpdate,
        status: "completed",
        currentTaskId: remoteTaskId,
      });
      await this.notifySessionUpdate(sessionId, "completed");
    } else if (state === "canceled") {
      // Fix #2: canceled remote task → local status "canceled", not "completed"
      this.sessionStore.update(sessionId, {
        ...contextUpdate,
        status: "canceled",
        currentTaskId: remoteTaskId,
        error: "remote task was canceled",
      });
      await this.notifySessionUpdate(sessionId, "failed");
    } else {
      // working / submitted / unknown: runSession's polling loop handles these
      this.sessionStore.update(sessionId, { ...contextUpdate, currentTaskId: remoteTaskId });
    }
  }

  private async notifySessionUpdate(
    sessionId: string,
    event: "completed" | "failed" | "input-required",
  ): Promise<void> {
    if (!this.options.gatewayConfig) {
      this.log("warn", `session ${sessionId} ${event} but gateway config unavailable — user won't be notified. Check gateway.auth.token in config.`);
      return;
    }
    const session = this.sessionStore.get(sessionId);
    if (!session) return;

    const lastAgentMsg = [...session.messages].reverse().find((m) => m.role === "agent");
    const rawContent = lastAgentMsg?.content ?? "";
    // Don't show the placeholder text in user-facing notifications
    const content = rawContent === "(no text output)" ? "" : rawContent;
    const agentName = session.agentName;

    let message: string;
    if (event === "completed") {
      message = content
        ? [`✅ **${agentName} 任务完成** (session: \`${sessionId}\`)`, "", content].join("\n")
        : `✅ **${agentName} 任务完成** (session: \`${sessionId}\`) — 任务已执行但无文本输出，可能产生了 artifacts。`;
    } else if (event === "input-required") {
      message = [
        `📨 **${agentName} 需要补充信息** (session: \`${sessionId}\`)`,
        "",
        content,
        "",
        `→ 回复请用 \`multiclaws_session_reply\` 工具，sessionId: \`${sessionId}\``,
      ].join("\n");
    } else {
      const error = session.error ?? content;
      message = [`❌ **${agentName} 任务失败** (session: \`${sessionId}\`)`, "", error].join("\n");
    }

    try {
      await invokeGatewayTool({
        gateway: this.options.gatewayConfig,
        tool: "message",
        args: { action: "send", message },
        timeoutMs: 5_000,
      });
    } catch {
      this.log("warn", `[multiclaws] failed to notify session update: ${sessionId}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Profile                                                          */
  /* ---------------------------------------------------------------- */

  async getProfile(): Promise<AgentProfile> {
    return await this.profileStore.load();
  }

  async setProfile(patch: { ownerName?: string; bio?: string }): Promise<AgentProfile> {
    const profile = await this.profileStore.update(patch);
    this.updateProfileDescription(profile);
    await this.broadcastProfileToTeams();
    return profile;
  }

  private updateProfileDescription(profile: AgentProfile): void {
    this.profileDescription = renderProfileDescription(profile);
    if (this.agentCard) {
      this.agentCard.description = this.profileDescription;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Pending profile review (install / first-run)                      */
  /* ---------------------------------------------------------------- */

  private getPendingReviewPath(): string {
    return path.join(this.options.stateDir, "multiclaws", "pending-profile-review.json");
  }

  async getPendingProfileReview(): Promise<{ pending: boolean; profile?: AgentProfile; message?: string }> {
    const p = this.getPendingReviewPath();
    const data = await readJsonWithFallback<{ pending?: boolean }>(p, {});
    if (data.pending !== true) {
      return { pending: false };
    }
    const profile = await this.profileStore.load();
    return {
      pending: true,
      profile,
      message: "这是您当前的 MultiClaws 档案，是否需要修改名字、角色、数据源或能力？",
    };
  }

  async setPendingProfileReview(): Promise<void> {
    const p = this.getPendingReviewPath();
    await writeJsonAtomically(p, { pending: true });
  }

  async clearPendingProfileReview(): Promise<void> {
    const p = this.getPendingReviewPath();
    try {
      await fs.unlink(p);
    } catch {
      // ignore if missing
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Team management                                                  */
  /* ---------------------------------------------------------------- */

  async createTeam(name: string): Promise<TeamRecord> {
    const team = await this.teamStore.createTeam({
      teamName: name,
      selfUrl: this.selfUrl,
      selfName: this.options.displayName ?? os.hostname(),
      selfDescription: this.profileDescription,
    });
    this.log("info", `team created: ${team.teamId} (${team.teamName})`);
    return team;
  }

  async createInvite(teamId?: string): Promise<string> {
    const team = teamId
      ? await this.teamStore.getTeam(teamId)
      : await this.teamStore.getFirstTeam();
    if (!team) throw new Error(teamId ? `team not found: ${teamId}` : "no team exists");
    return encodeInvite(team.teamId, this.selfUrl);
  }

  async joinTeam(inviteCode: string): Promise<TeamRecord> {
    const invite = decodeInvite(inviteCode);
    const seedUrl = invite.u.replace(/\/+$/, "");

    // 1. Fetch member list from seed
    let membersRes: Response;
    try {
      membersRes = await fetch(`${seedUrl}/team/${invite.t}/members`);
    } catch (err) {
      throw new Error(
        `Unable to reach team seed node at ${seedUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!membersRes.ok) {
      throw new Error(`failed to fetch team members from ${seedUrl}: HTTP ${membersRes.status}`);
    }
    const { team: remoteTeam } = (await membersRes.json()) as {
      team: { teamName: string; members: TeamMember[] };
    };

    // 2. Announce self to seed (seed broadcasts to others)
    const selfMember: TeamMember = {
      url: this.selfUrl,
      name: this.options.displayName ?? os.hostname(),
      description: this.profileDescription,
      joinedAtMs: Date.now(),
    };

    let announceRes: Response;
    try {
      announceRes = await fetch(`${seedUrl}/team/${invite.t}/announce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selfMember),
      });
    } catch (err) {
      throw new Error(
        `Failed to announce self to seed ${seedUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!announceRes.ok) {
      throw new Error(`failed to announce to seed ${seedUrl}: HTTP ${announceRes.status}`);
    }

    // 3. Store team locally
    const allMembers = [...remoteTeam.members];
    const selfNormalized = this.selfUrl.replace(/\/+$/, "");
    if (!allMembers.some((m) => m.url.replace(/\/+$/, "") === selfNormalized)) {
      allMembers.push(selfMember);
    }

    const team: TeamRecord = {
      teamId: invite.t,
      teamName: remoteTeam.teamName,
      selfUrl: this.selfUrl,
      members: allMembers,
      createdAtMs: Date.now(),
    };
    await this.teamStore.saveTeam(team);

    // 4. Fetch Agent Cards for members without descriptions, then sync to registry
    await this.fetchMemberDescriptions(team);
    await this.syncTeamToRegistry(team);

    this.log("info", `joined team ${team.teamId} (${team.teamName}) with ${allMembers.length} members`);
    return team;
  }

  async leaveTeam(teamId?: string): Promise<void> {
    const team = teamId
      ? await this.teamStore.getTeam(teamId)
      : await this.teamStore.getFirstTeam();
    if (!team) throw new Error(teamId ? `team not found: ${teamId}` : "no team exists");

    const selfNormalized = this.selfUrl.replace(/\/+$/, "");
    const selfMember: TeamMember = {
      url: this.selfUrl,
      name: this.options.displayName ?? os.hostname(),
      joinedAtMs: 0,
    };

    const others = team.members.filter((m) => m.url.replace(/\/+$/, "") !== selfNormalized);
    await Promise.allSettled(
      others.map(async (m) => {
        try {
          await fetch(`${m.url}/team/${team.teamId}/leave`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(selfMember),
          });
        } catch {
          this.log("warn", `failed to notify ${m.url} about leaving`);
        }
      }),
    );

    for (const m of others) {
      await this.agentRegistry.removeTeamSource(m.url, team.teamId);
    }

    await this.teamStore.deleteTeam(team.teamId);
    this.log("info", `left team ${team.teamId}`);
  }

  async listTeamMembers(teamId?: string): Promise<
    | { team: TeamRecord; members: TeamMember[] }
    | { teams: Array<{ team: TeamRecord; members: TeamMember[] }> }
    | null
  > {
    if (teamId) {
      const team = await this.teamStore.getTeam(teamId);
      if (!team) return null;
      return { team, members: team.members };
    }
    const all = await this.teamStore.listTeams();
    if (all.length === 0) return null;
    if (all.length === 1) return { team: all[0], members: all[0].members };
    return { teams: all.map((team) => ({ team, members: team.members })) };
  }

  /* ---------------------------------------------------------------- */
  /*  Team REST routes                                                 */
  /* ---------------------------------------------------------------- */

  private mountTeamRoutes(app: express.Express): void {
    const announceBodySchema = z.object({
      url: z.string().trim().min(1),
      name: z.string().trim().min(1),
      description: z.string().trim().optional(),
      joinedAtMs: z.number().optional(),
    });

    const leaveBodySchema = z.object({
      url: z.string().trim().min(1),
    });

    const profileUpdateBodySchema = z.object({
      url: z.string().trim().min(1),
      name: z.string().trim().optional(),
      description: z.string().optional(),
    });

    app.get("/team/:id/members", async (req, res) => {
      try {
        const team = await this.teamStore.getTeam(req.params.id);
        if (!team) { res.status(404).json({ error: "team not found" }); return; }
        res.json({ team: { teamName: team.teamName, members: team.members } });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/team/:id/announce", async (req, res) => {
      try {
        const team = await this.teamStore.getTeam(req.params.id);
        if (!team) { res.status(404).json({ error: "team not found" }); return; }

        const parsed = announceBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.message });
          return;
        }
        const member = parsed.data;

        const normalizedUrl = member.url.replace(/\/+$/, "");
        const alreadyKnown = team.members.some(
          (m) => m.url.replace(/\/+$/, "") === normalizedUrl,
        );

        await this.teamStore.addMember(team.teamId, {
          url: normalizedUrl,
          name: member.name,
          description: member.description,
          joinedAtMs: member.joinedAtMs ?? Date.now(),
        });
        await this.agentRegistry.add({
          url: normalizedUrl,
          name: member.name,
          description: member.description,
        });
        await this.agentRegistry.addTeamSource(normalizedUrl, team.teamId);

        // Broadcast to other members if new
        if (!alreadyKnown) {
          const selfNormalized = this.selfUrl.replace(/\/+$/, "");
          // Re-read team after addMember to get the latest member list,
          // avoiding missed broadcasts when multiple members join concurrently
          const freshTeam = await this.teamStore.getTeam(team.teamId);
          const others = (freshTeam?.members ?? team.members).filter(
            (m) =>
              m.url.replace(/\/+$/, "") !== normalizedUrl &&
              m.url.replace(/\/+$/, "") !== selfNormalized,
          );
          for (const other of others) {
            void this.fetchWithRetry(`${other.url}/team/${team.teamId}/announce`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: normalizedUrl,
                name: member.name,
                description: member.description,
                joinedAtMs: member.joinedAtMs ?? Date.now(),
              }),
            }).catch(() => {
              this.log("warn", `broadcast to ${other.url} failed`);
            });
          }
        }

        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/team/:id/leave", async (req, res) => {
      try {
        const team = await this.teamStore.getTeam(req.params.id);
        if (!team) { res.status(404).json({ error: "team not found" }); return; }

        const parsed = leaveBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.message });
          return;
        }

        const normalizedUrl = parsed.data.url.replace(/\/+$/, "");
        await this.teamStore.removeMember(team.teamId, normalizedUrl);
        await this.agentRegistry.removeTeamSource(normalizedUrl, team.teamId);

        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // Profile update broadcast receiver
    app.post("/team/:id/profile-update", async (req, res) => {
      try {
        const team = await this.teamStore.getTeam(req.params.id);
        if (!team) { res.status(404).json({ error: "team not found" }); return; }

        const parsed = profileUpdateBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.message });
          return;
        }
        const { url, name, description } = parsed.data;
        const normalizedUrl = url.replace(/\/+$/, "");

        // Update team member description
        const existing = team.members.find((m) => m.url.replace(/\/+$/, "") === normalizedUrl);
        if (existing) {
          if (name) existing.name = name;
          if (description !== undefined) existing.description = description;
          await this.teamStore.saveTeam(team);
        }

        // Update agent registry description
        if (description !== undefined) {
          await this.agentRegistry.updateDescription(normalizedUrl, description);
        }

        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                  */
  /* ---------------------------------------------------------------- */

  private async broadcastProfileToTeams(): Promise<void> {
    const teams = await this.teamStore.listTeams();
    const selfNormalized = this.selfUrl.replace(/\/+$/, "");
    const displayName = this.options.displayName ?? os.hostname();

    for (const team of teams) {
      // Update self in team store, preserving original joinedAtMs
      const selfMember = team.members.find(
        (m) => m.url.replace(/\/+$/, "") === selfNormalized,
      );
      await this.teamStore.addMember(team.teamId, {
        url: this.selfUrl,
        name: displayName,
        description: this.profileDescription,
        joinedAtMs: selfMember?.joinedAtMs ?? Date.now(),
      });

      // Broadcast to other members
      const others = team.members.filter((m) => m.url.replace(/\/+$/, "") !== selfNormalized);
      for (const member of others) {
        void this.fetchWithRetry(`${member.url}/team/${team.teamId}/profile-update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: this.selfUrl,
            name: displayName,
            description: this.profileDescription,
          }),
        }).catch(() => {
          this.log("warn", `profile broadcast to ${member.url} failed`);
        });
      }
    }
  }

  private async fetchMemberDescriptions(team: TeamRecord): Promise<void> {
    const selfNormalized = this.selfUrl.replace(/\/+$/, "");

    await Promise.allSettled(
      team.members
        .filter((m) => m.url.replace(/\/+$/, "") !== selfNormalized && !m.description)
        .map(async (m) => {
          try {
            const client = await this.clientFactory.createFromUrl(m.url);
            const card = await client.getAgentCard();
            if (card.description) {
              // Use addMember (which uses withJsonLock) instead of saveTeam
              // to avoid overwriting concurrent member additions
              await this.teamStore.addMember(team.teamId, {
                url: m.url,
                name: m.name,
                description: card.description,
                joinedAtMs: m.joinedAtMs,
              });
            }
          } catch {
            this.log("warn", `failed to fetch Agent Card from ${m.url}`);
          }
        }),
    );
  }

  private async syncTeamToRegistry(team: TeamRecord): Promise<void> {
    const selfNormalized = this.selfUrl.replace(/\/+$/, "");
    for (const member of team.members) {
      if (member.url.replace(/\/+$/, "") === selfNormalized) continue;
      await this.agentRegistry.add({
        url: member.url,
        name: member.name,
        description: member.description,
      });
      await this.agentRegistry.addTeamSource(member.url, team.teamId);
    }
  }

  private async createA2AClient(agent: AgentRecord): Promise<Client> {
    return await this.clientFactory.createFromUrl(agent.url);
  }

  private extractArtifactText(task: Task): string {
    if (!task.artifacts?.length) return "";
    return task.artifacts
      .flatMap((a) => a.parts ?? [])
      .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
      .map((p) => p.text)
      .join("\n");
  }

  private async notifyTailscaleSetup(tailscale: { status: string; authUrl?: string }): Promise<void> {
    let message: string;

    if (tailscale.status === "needs_auth") {
      message = [
        "🔗 **MultiClaws: Tailscale 登录**",
        "",
        "Tailscale 已安装但未登录，跨网络协作需要完成登录。",
        "",
        `👉 **请在浏览器打开：** ${tailscale.authUrl}`,
        "",
        "登录完成后重启 OpenClaw 即可。",
        "_(局域网内协作无需此步骤，现在即可使用)_",
      ].join("\n");
    } else {
      // not_installed or unavailable
      message = [
        "🌐 **MultiClaws: 跨网络协作提示**",
        "",
        "**局域网内已可直接协作，无需任何配置。**",
        "",
        "如需跨网络（不同局域网间）协作，请安装 Tailscale：",
        "https://tailscale.com/download",
        "",
        "安装并登录后重启 OpenClaw，将自动配置跨网络连接。",
      ].join("\n");
    }

    // Send to user via gateway (best-effort, don't throw)
    if (this.options.gatewayConfig) {
      try {
        await invokeGatewayTool({
          gateway: this.options.gatewayConfig,
          tool: "message",
          args: { action: "send", message },
          timeoutMs: 5_000,
        });
      } catch {
        // Fallback to log
        this.log("warn", message.replace(/\*\*/g, "").replace(/```[^`]*```/gs, ""));
      }
    }
  }

  /** Fetch with up to 2 retries and exponential backoff. */
  private async fetchWithRetry(url: string, init: RequestInit, retries = 2): Promise<Response> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, init);
        if (res.ok || attempt === retries) return res;
        lastError = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === retries) break;
      }
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    }
    throw lastError!;
  }

  private log(level: "info" | "warn" | "error" | "debug", message: string): void {
    this.options.logger?.[level]?.(`[multiclaws] ${message}`);
  }
}

function getLocalIp(): string {
  // Prefer Tailscale IP if available
  const tsIp = getTailscaleIpFromInterfaces();
  if (tsIp) return tsIp;

  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }

  return os.hostname();
}
