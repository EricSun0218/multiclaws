import { EventEmitter } from "node:events";
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
import type { AgentCard, Task, Message, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from "@a2a-js/sdk";
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

export type DelegateTaskResult = {
  taskId?: string;
  output?: string;
  status: string;
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
      version: "0.3.0",
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
    await new Promise<void>((resolve) => this.httpServer!.listen(listenPort, "0.0.0.0", resolve));

    this.started = true;
    this.log("info", `multiclaws A2A service listening on :${listenPort}`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    this.taskTracker.destroy();
    this.httpRateLimiter.destroy();

    await new Promise<void>((resolve) => {
      if (!this.httpServer) { resolve(); return; }
      this.httpServer.close(() => resolve());
    });
    this.httpServer = null;
  }

  updateGatewayConfig(config: GatewayConfig): void {
    this.agentExecutor?.updateGatewayConfig(config);
  }

  /* ---------------------------------------------------------------- */
  /*  Agent management                                                 */
  /* ---------------------------------------------------------------- */

  async listAgents(): Promise<AgentRecord[]> {
    return await this.agentRegistry.list();
  }

  async addAgent(params: { url: string; apiKey?: string }): Promise<AgentRecord> {
    const normalizedUrl = params.url.replace(/\/+$/, "");
    try {
      const client = await this.clientFactory.createFromUrl(normalizedUrl);
      const card = await client.getAgentCard();
      return await this.agentRegistry.add({
        url: normalizedUrl,
        name: card.name ?? normalizedUrl,
        description: card.description ?? "",
        skills: card.skills?.map((s) => s.name ?? s.id) ?? [],
        apiKey: params.apiKey,
      });
    } catch {
      return await this.agentRegistry.add({
        url: normalizedUrl,
        name: normalizedUrl,
        apiKey: params.apiKey,
      });
    }
  }

  async removeAgent(url: string): Promise<boolean> {
    return await this.agentRegistry.remove(url);
  }

  /* ---------------------------------------------------------------- */
  /*  Task delegation                                                  */
  /* ---------------------------------------------------------------- */

  async delegateTask(params: {
    agentUrl: string;
    task: string;
  }): Promise<DelegateTaskResult> {
    await this.requireCompleteProfile();
    const agentRecord = await this.agentRegistry.get(params.agentUrl);
    if (!agentRecord) {
      return { status: "failed", error: `unknown agent: ${params.agentUrl}` };
    }

    const track = this.taskTracker.create({
      fromPeerId: "local",
      toPeerId: params.agentUrl,
      task: params.task,
    });
    this.taskTracker.update(track.taskId, { status: "running" });

    try {
      const client = await this.createA2AClient(agentRecord);
      const result = await this.sendMessageWithStream(client, {
        kind: "message",
        role: "user",
        parts: [{ kind: "text", text: params.task }],
        messageId: track.taskId,
      });
      return this.processTaskResult(track.taskId, result);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.taskTracker.update(track.taskId, { status: "failed", error: errorMsg });
      return { taskId: track.taskId, status: "failed", error: errorMsg };
    }
  }

  getTaskStatus(taskId: string) {
    return this.taskTracker.get(taskId);
  }

  /* ---------------------------------------------------------------- */
  /*  Profile                                                          */
  /* ---------------------------------------------------------------- */

  async getProfile(): Promise<AgentProfile> {
    return await this.profileStore.load();
  }

  /**
   * Throws if the profile is incomplete (ownerName or bio missing).
   * Call this before any action that exposes the user's identity to other agents.
   */
  private async requireCompleteProfile(): Promise<void> {
    const profile = await this.profileStore.load();
    if (!profile.ownerName?.trim() || !profile.bio?.trim()) {
      throw new Error(
        "档案未完成设置。请先调用 multiclaws_profile_set(ownerName=\"你的名字\", bio=\"你的介绍\") 完成设置后再继续。",
      );
    }
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
      if (profile.ownerName?.trim()) {
        this.agentCard.name = profile.ownerName.trim();
      }
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
    await this.requireCompleteProfile();
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
    await this.requireCompleteProfile();
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
      await this.agentRegistry.remove(m.url);
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

        // Broadcast to other members if new
        if (!alreadyKnown) {
          const selfNormalized = this.selfUrl.replace(/\/+$/, "");
          const others = team.members.filter(
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
        await this.agentRegistry.remove(normalizedUrl);

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
      // Update self in team store
      await this.teamStore.addMember(team.teamId, {
        url: this.selfUrl,
        name: displayName,
        description: this.profileDescription,
        joinedAtMs: Date.now(),
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
              m.description = card.description;
            }
          } catch {
            this.log("warn", `failed to fetch Agent Card from ${m.url}`);
          }
        }),
    );

    await this.teamStore.saveTeam(team);
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
    }
  }

  private async createA2AClient(agent: AgentRecord): Promise<Client> {
    return await this.clientFactory.createFromUrl(agent.url);
  }

  /**
   * Send a message using A2A streaming to minimize latency.
   * Instead of a single blocking HTTP call, consume the SSE stream and
   * return the final Task or Message as soon as B signals completion.
   */
  private async sendMessageWithStream(
    client: Client,
    message: Parameters<Client["sendMessage"]>[0]["message"],
  ): Promise<Message | Task> {
    let lastTask: Task | undefined;
    let lastMessage: Message | undefined;

    const stream = client.sendMessageStream({ message });

    // A2AStreamEventData is a union: Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent
    for await (const event of stream) {
      if (event.kind === "task") {
        lastTask = event as Task;
      } else if (event.kind === "message") {
        lastMessage = event as Message;
      } else if (event.kind === "status-update") {
        const update = event as TaskStatusUpdateEvent;
        if (lastTask) {
          lastTask = { ...lastTask, status: update.status };
        }
        if (update.final) break;
      }
      // artifact-update: ignore, final output comes via task artifacts or message
    }

    // Return the best result available
    if (lastMessage) return lastMessage;
    if (lastTask) return lastTask;
    throw new Error("stream ended without a result");
  }

  private processTaskResult(
    trackId: string,
    result: Message | Task,
  ): DelegateTaskResult {
    if ("status" in result && result.status) {
      const task = result as Task;
      const state = task.status?.state ?? "unknown";
      const output = this.extractArtifactText(task);

      if (state === "completed") {
        this.taskTracker.update(trackId, { status: "completed", result: output });
      } else if (state === "failed") {
        this.taskTracker.update(trackId, { status: "failed", error: output || "remote task failed" });
      }

      return { taskId: task.id, output, status: state };
    }

    const msg = result as Message;
    const text = msg.parts
      ?.filter((p): p is { kind: "text"; text: string } => p.kind === "text")
      .map((p) => p.text)
      .join("\n") ?? "";

    this.taskTracker.update(trackId, { status: "completed", result: text });
    return { taskId: trackId, output: text, status: "completed" };
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
  let fallback: string | undefined;
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        if (addr.address.startsWith("192.168.")) return addr.address;
        fallback ??= addr.address;
      }
    }
  }

  return fallback ?? os.hostname();
}
