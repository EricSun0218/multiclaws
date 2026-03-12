import { EventEmitter } from "node:events";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { FrpTunnelManager, type FrpTunnelConfig } from "../infra/frp";
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
  tunnel?: FrpTunnelConfig & { type: "frp" };
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
/*  Delegation prompt builder                                          */
/* ------------------------------------------------------------------ */

function buildDelegationPrompt(agent: AgentRecord, task: string): string {
  const bioSnippet = agent.description
    ? `\n**智能体能力**: ${agent.description.slice(0, 500)}`
    : "";

  return `## 委派任务
向远端智能体发送任务并汇报结果。

**目标智能体**: ${agent.name} (${agent.url})${bioSnippet}
**任务内容**: ${task}

## 执行步骤
1. 调用 multiclaws_delegate_send(agentUrl="${agent.url}", task="${task.replace(/"/g, '\\"')}") 发送任务
2. 收到回复后，用 message 工具将结果汇报给用户
3. 如果需要进一步沟通，可再次调用 multiclaws_delegate_send（最多 5 轮）
4. 每次收到回复后立即用 message 汇报进展

## 规则
- 使用 multiclaws_delegate_send（不是 multiclaws_delegate）发送任务
- 最多 5 轮沟通
- 遇到错误时在汇报中说明原因`;
}

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
  private frpTunnel: FrpTunnelManager | null = null;
  private selfUrl: string;
  private profileDescription = "OpenClaw agent";
  private readonly gatewayConfig: GatewayConfig | null;

  constructor(private readonly options: MulticlawsServiceOptions) {
    super();
    const multiclawsStateDir = path.join(options.stateDir, "multiclaws");
    this.agentRegistry = new AgentRegistry(path.join(multiclawsStateDir, "agents.json"), options.logger);
    this.teamStore = new TeamStore(path.join(multiclawsStateDir, "teams.json"), options.logger);
    this.profileStore = new ProfileStore(path.join(multiclawsStateDir, "profile.json"), options.logger);
    this.taskTracker = new TaskTracker({
      filePath: path.join(multiclawsStateDir, "tasks.json"),
      logger: options.logger,
    });
    // selfUrl resolved later in start() after FRP tunnel setup
    this.selfUrl = options.selfUrl ?? "";
    this.gatewayConfig = options.gatewayConfig ?? null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.log("debug", `start(port=${this.options.port ?? 3100}, selfUrl=${this.options.selfUrl ?? "auto"})`);

    try {
      // Resolve selfUrl: explicit config > FRP tunnel
      if (!this.options.selfUrl) {
        const port = this.options.port ?? 3100;

        if (!this.options.tunnel || this.options.tunnel.type !== "frp") {
          throw new Error(
            "multiclaws requires either 'selfUrl' or 'tunnel' configuration. " +
            "Please configure tunnel in plugin settings.",
          );
        }

        this.frpTunnel = new FrpTunnelManager({
          config: this.options.tunnel,
          localPort: port,
          stateDir: path.join(this.options.stateDir, "multiclaws"),
          logger: this.options.logger,
        });
        const publicUrl = await this.frpTunnel.start();
        this.selfUrl = publicUrl;
        this.log("info", `FRP tunnel ready: ${publicUrl}`);
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
    } catch (err) {
      this.log("error", `start failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.log("debug", "stopping");
    try {
      this.started = false;

      this.taskTracker.destroy();
      this.httpRateLimiter.destroy();

      if (this.frpTunnel) {
        await this.frpTunnel.stop();
        this.frpTunnel = null;
      }

      await new Promise<void>((resolve) => {
        if (!this.httpServer) { resolve(); return; }
        this.httpServer.close(() => resolve());
      });
      this.httpServer = null;
      this.log("debug", "stopped");
    } catch (err) {
      this.log("error", `stop failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
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
    this.log("debug", `addAgent(url=${normalizedUrl})`);
    try {
      const client = await this.clientFactory.createFromUrl(normalizedUrl);
      const card = await client.getAgentCard();
      const result = await this.agentRegistry.add({
        url: normalizedUrl,
        name: card.name ?? normalizedUrl,
        description: card.description ?? "",
        skills: card.skills?.map((s) => s.name ?? s.id) ?? [],
        apiKey: params.apiKey,
      });
      this.log("debug", `addAgent completed, name=${result.name}`);
      return result;
    } catch {
      this.log("debug", `addAgent: card fetch failed for ${normalizedUrl}, adding with URL as name`);
      return await this.agentRegistry.add({
        url: normalizedUrl,
        name: normalizedUrl,
        apiKey: params.apiKey,
      });
    }
  }

  async removeAgent(url: string): Promise<boolean> {
    this.log("debug", `removeAgent(url=${url})`);
    try {
      const result = await this.agentRegistry.remove(url);
      this.log("debug", `removeAgent completed, result=${result}`);
      return result;
    } catch (err) {
      this.log("error", `removeAgent failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Task delegation                                                  */
  /* ---------------------------------------------------------------- */

  async delegateTask(params: {
      agentUrl: string;
      task: string;
    }): Promise<DelegateTaskResult> {
    this.log("info", `delegateTask(agentUrl=${params.agentUrl}, task=${params.task.slice(0, 80)})`);
    await this.requireCompleteProfile();
    const agentRecord = await this.agentRegistry.get(params.agentUrl);
    if (!agentRecord) {
      this.log("warn", `delegateTask: unknown agent ${params.agentUrl}`);
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

      // Fire-and-forget execution: keep running in the background so that
      // the gateway call can return quickly and the task can outlive
      // the gateway's HTTP timeout.
      void (async () => {
        try {
          const result = await client.sendMessage({
            message: {
              kind: "message",
              role: "user",
              parts: [{ kind: "text", text: params.task }],
              messageId: track.taskId,
            },
          });
          this.processTaskResult(track.taskId, result);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.taskTracker.update(track.taskId, { status: "failed", error: errorMsg });
          this.log(
            "warn",
            `delegateTask background execution for ${track.taskId} failed: ${errorMsg}`,
          );
        }
      })();

      // Return immediately so that gateway tool invocations are fast and
      // do not depend on the remote agent's total execution time.
      return { taskId: track.taskId, status: "running" };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.taskTracker.update(track.taskId, { status: "failed", error: errorMsg });
      this.log("error", `delegateTask failed for ${track.taskId}: ${errorMsg}`);
      return { taskId: track.taskId, status: "failed", error: errorMsg };
    }
  }

  /**
   * Synchronous delegation: sends A2A task and waits for the result.
   * Used by sub-agents internally via the multiclaws_delegate_send tool.
   */
  async delegateTaskSync(params: {
    agentUrl: string;
    task: string;
  }): Promise<DelegateTaskResult> {
    this.log("info", `delegateTaskSync(agentUrl=${params.agentUrl}, task=${params.task.slice(0, 80)})`);
    await this.requireCompleteProfile();
    const agentRecord = await this.agentRegistry.get(params.agentUrl);
    if (!agentRecord) {
      this.log("warn", `delegateTaskSync: unknown agent ${params.agentUrl}`);
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
      const result = await client.sendMessage({
        message: {
          kind: "message",
          role: "user",
          parts: [{ kind: "text", text: params.task }],
          messageId: track.taskId,
        },
      });
      const taskResult = this.processTaskResult(track.taskId, result);
      this.log("debug", `delegateTaskSync completed for ${track.taskId}`);
      return taskResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.taskTracker.update(track.taskId, { status: "failed", error: errorMsg });
      this.log("error", `delegateTaskSync failed for ${track.taskId}: ${errorMsg}`);
      return { taskId: track.taskId, status: "failed", error: errorMsg };
    }
  }

  /**
   * Spawn a sub-agent to handle delegation asynchronously.
   * The sub-agent uses multiclaws_delegate_send internally and
   * reports results back to the user via the message tool.
   */
  async spawnDelegation(params: {
    agentUrl: string;
    task: string;
  }): Promise<{ message: string }> {
    this.log("info", `spawnDelegation(agentUrl=${params.agentUrl}, task=${params.task.slice(0, 80)})`);
    await this.requireCompleteProfile();
    const agent = await this.agentRegistry.get(params.agentUrl);
    if (!agent) {
      this.log("warn", `spawnDelegation: unknown agent ${params.agentUrl}`);
      throw new Error(`unknown agent: ${params.agentUrl}`);
    }
    if (!this.gatewayConfig) {
      this.log("error", "spawnDelegation: gateway config not available");
      throw new Error("gateway config not available — cannot spawn sub-agent");
    }

    const prompt = buildDelegationPrompt(agent, params.task);

    await invokeGatewayTool({
      gateway: this.gatewayConfig,
      tool: "sessions_spawn",
      args: { task: prompt, mode: "run", cwd: os.homedir() },
      sessionKey: `delegate-${Date.now()}`,
      timeoutMs: 15_000,
    });

    this.log("info", `spawnDelegation completed: sub-agent spawned for ${agent.name}`);
    return { message: `已启动子 agent 向 ${agent.name} 委派任务` };
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
    this.log("debug", `setProfile(keys=${Object.keys(patch).join(",")})`);
    try {
      const profile = await this.profileStore.update(patch);
      this.updateProfileDescription(profile);
      await this.broadcastProfileToTeams();
      this.log("debug", "setProfile completed");
      return profile;
    } catch (err) {
      this.log("error", `setProfile failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
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
    this.log("debug", "setPendingProfileReview");
    try {
      const p = this.getPendingReviewPath();
      await writeJsonAtomically(p, { pending: true });
    } catch (err) {
      this.log("error", `setPendingProfileReview failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async clearPendingProfileReview(): Promise<void> {
    this.log("debug", "clearPendingProfileReview");
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
    this.log("debug", `createTeam(name=${name})`);
    try {
      await this.requireCompleteProfile();
      const team = await this.teamStore.createTeam({
        teamName: name,
        selfUrl: this.selfUrl,
        selfName: this.options.displayName ?? os.hostname(),
        selfDescription: this.profileDescription,
      });
      this.log("info", `team created: ${team.teamId} (${team.teamName})`);
      return team;
    } catch (err) {
      this.log("error", `createTeam failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async createInvite(teamId?: string): Promise<string> {
    this.log("debug", `createInvite(teamId=${teamId ?? "first"})`);
    try {
      const team = teamId
        ? await this.teamStore.getTeam(teamId)
        : await this.teamStore.getFirstTeam();
      if (!team) throw new Error(teamId ? `team not found: ${teamId}` : "no team exists");
      const code = encodeInvite(team.teamId, this.selfUrl);
      this.log("debug", "createInvite completed");
      return code;
    } catch (err) {
      this.log("error", `createInvite failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async joinTeam(inviteCode: string): Promise<TeamRecord> {
    this.log("info", "joinTeam starting");
    try {
      await this.requireCompleteProfile();
      const invite = decodeInvite(inviteCode);
      const seedUrl = invite.u.replace(/\/+$/, "");
      this.log("debug", `joinTeam: seedUrl=${seedUrl}, teamId=${invite.t}`);

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
    } catch (err) {
      this.log("error", `joinTeam failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async leaveTeam(teamId?: string): Promise<void> {
    this.log("info", `leaveTeam(teamId=${teamId ?? "first"})`);
    try {
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
    } catch (err) {
      this.log("error", `leaveTeam failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
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
        this.log("error", `GET /team/${req.params.id}/members failed: ${err instanceof Error ? err.message : String(err)}`);
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/team/:id/announce", async (req, res) => {
      this.log("debug", `POST /team/${req.params.id}/announce from ${(req.body as Record<string, unknown>)?.url}`);
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

          // Notify local user that a new member joined
          void this.notifyUser(
            `📢 **${member.name}** 已加入团队「${team.teamName}」`,
          );
        }

        res.json({ ok: true });
      } catch (err) {
        this.log("error", `POST /team/${req.params.id}/announce failed: ${err instanceof Error ? err.message : String(err)}`);
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/team/:id/leave", async (req, res) => {
      this.log("debug", `POST /team/${req.params.id}/leave from ${(req.body as Record<string, unknown>)?.url}`);
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
        this.log("error", `POST /team/${req.params.id}/leave failed: ${err instanceof Error ? err.message : String(err)}`);
        res.status(500).json({ error: String(err) });
      }
    });

    // Profile update broadcast receiver
    app.post("/team/:id/profile-update", async (req, res) => {
      this.log("debug", `POST /team/${req.params.id}/profile-update from ${(req.body as Record<string, unknown>)?.url}`);
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
        this.log("error", `POST /team/${req.params.id}/profile-update failed: ${err instanceof Error ? err.message : String(err)}`);
        res.status(500).json({ error: String(err) });
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                  */
  /* ---------------------------------------------------------------- */

  private async broadcastProfileToTeams(): Promise<void> {
    this.log("debug", "broadcastProfileToTeams");
    try {
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
      this.log("debug", "broadcastProfileToTeams completed");
    } catch (err) {
      this.log("error", `broadcastProfileToTeams failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  private async fetchMemberDescriptions(team: TeamRecord): Promise<void> {
    const selfNormalized = this.selfUrl.replace(/\/+$/, "");
    const membersToFetch = team.members.filter((m) => m.url.replace(/\/+$/, "") !== selfNormalized && !m.description);
    this.log("debug", `fetchMemberDescriptions(teamId=${team.teamId}, count=${membersToFetch.length})`);

    try {
      await Promise.allSettled(
        membersToFetch.map(async (m) => {
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
      this.log("debug", "fetchMemberDescriptions completed");
    } catch (err) {
      this.log("error", `fetchMemberDescriptions failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  private async syncTeamToRegistry(team: TeamRecord): Promise<void> {
    this.log("debug", `syncTeamToRegistry(teamId=${team.teamId})`);
    try {
      const selfNormalized = this.selfUrl.replace(/\/+$/, "");
      for (const member of team.members) {
        if (member.url.replace(/\/+$/, "") === selfNormalized) continue;
        await this.agentRegistry.add({
          url: member.url,
          name: member.name,
          description: member.description,
        });
      }
      this.log("debug", "syncTeamToRegistry completed");
    } catch (err) {
      this.log("error", `syncTeamToRegistry failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
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
  private processTaskResult(
    trackId: string,
    result: Message | Task,
  ): DelegateTaskResult {
    this.log("debug", `processTaskResult(trackId=${trackId})`);
    try {
      if ("status" in result && result.status) {
        const task = result as Task;
        const state = task.status?.state ?? "unknown";
        const output = this.extractArtifactText(task);

        if (state === "completed") {
          this.taskTracker.update(trackId, { status: "completed", result: output });
        } else if (state === "failed") {
          this.taskTracker.update(trackId, { status: "failed", error: output || "remote task failed" });
        } else {
          // For any other state (unknown, working, etc.), mark as failed to avoid
          // tasks stuck in "running" forever until TTL prune.
          this.taskTracker.update(trackId, { status: "failed", error: `unexpected remote state: ${state}` });
        }

        this.log("debug", `processTaskResult completed, status=${state}`);
        return { taskId: task.id, output, status: state };
      }

      const msg = result as Message;
      const text = msg.parts
        ?.filter((p): p is { kind: "text"; text: string } => p.kind === "text")
        .map((p) => p.text)
        .join("\n") ?? "";

      this.taskTracker.update(trackId, { status: "completed", result: text });
      this.log("debug", "processTaskResult completed, status=completed (message)");
      return { taskId: trackId, output: text, status: "completed" };
    } catch (err) {
      this.log("error", `processTaskResult failed for ${trackId}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  private extractArtifactText(task: Task): string {
    if (!task.artifacts?.length) return "";
    return task.artifacts
      .flatMap((a) => a.parts ?? [])
      .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
      .map((p) => p.text)
      .join("\n");
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

  /** Send a notification message to the local user via the gateway message tool. */
  private async notifyUser(message: string): Promise<void> {
    if (!this.gatewayConfig) return;
    try {
      await invokeGatewayTool({
        gateway: this.gatewayConfig,
        tool: "message",
        args: { action: "send", message },
        timeoutMs: 5_000,
      });
    } catch {
      this.log("warn", `notifyUser failed: ${message.slice(0, 80)}`);
    }
  }

  private log(level: "info" | "warn" | "error" | "debug", message: string): void {
    this.options.logger?.[level]?.(`[multiclaws] ${message}`);
  }
}
