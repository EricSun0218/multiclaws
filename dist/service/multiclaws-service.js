"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MulticlawsService = void 0;
const node_events_1 = require("node:events");
const node_os_1 = __importDefault(require("node:os"));
const node_http_1 = __importDefault(require("node:http"));
const node_path_1 = __importDefault(require("node:path"));
const promises_1 = __importDefault(require("node:fs/promises"));
const frp_1 = require("../infra/frp");
const json_store_1 = require("../infra/json-store");
const express_1 = __importDefault(require("express"));
const server_1 = require("@a2a-js/sdk/server");
const express_2 = require("@a2a-js/sdk/server/express");
const client_1 = require("@a2a-js/sdk/client");
const a2a_adapter_1 = require("./a2a-adapter");
const agent_registry_1 = require("./agent-registry");
const agent_profile_1 = require("./agent-profile");
const team_store_1 = require("../team/team-store");
const tracker_1 = require("../task/tracker");
const zod_1 = require("zod");
const gateway_client_1 = require("../infra/gateway-client");
const rate_limiter_1 = require("../infra/rate-limiter");
/* ------------------------------------------------------------------ */
/*  Delegation prompt builder                                          */
/* ------------------------------------------------------------------ */
function buildDelegationPrompt(agent, task) {
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
class MulticlawsService extends node_events_1.EventEmitter {
    options;
    started = false;
    httpServer = null;
    agentRegistry;
    teamStore;
    profileStore;
    taskTracker;
    agentExecutor = null;
    a2aRequestHandler = null;
    agentCard = null;
    clientFactory = new client_1.ClientFactory();
    httpRateLimiter = new rate_limiter_1.RateLimiter({ windowMs: 60_000, maxRequests: 60 });
    frpTunnel = null;
    selfUrl;
    profileDescription = "OpenClaw agent";
    gatewayConfig;
    resolvedCwd;
    activeChannelId = null;
    constructor(options) {
        super();
        this.options = options;
        const multiclawsStateDir = node_path_1.default.join(options.stateDir, "multiclaws");
        this.agentRegistry = new agent_registry_1.AgentRegistry(node_path_1.default.join(multiclawsStateDir, "agents.json"), options.logger);
        this.teamStore = new team_store_1.TeamStore(node_path_1.default.join(multiclawsStateDir, "teams.json"), options.logger);
        this.profileStore = new agent_profile_1.ProfileStore(node_path_1.default.join(multiclawsStateDir, "profile.json"), options.logger);
        this.taskTracker = new tracker_1.TaskTracker({
            filePath: node_path_1.default.join(multiclawsStateDir, "tasks.json"),
            logger: options.logger,
        });
        // selfUrl resolved later in start() after FRP tunnel setup
        this.selfUrl = options.selfUrl ?? "";
        this.gatewayConfig = options.gatewayConfig ?? null;
        this.resolvedCwd = options.cwd || node_os_1.default.homedir();
    }
    async start() {
        if (this.started)
            return;
        this.log("debug", `start(port=${this.options.port ?? 3100}, selfUrl=${this.options.selfUrl ?? "auto"})`);
        try {
            // Resolve selfUrl: explicit config > FRP tunnel
            if (!this.options.selfUrl) {
                const port = this.options.port ?? 3100;
                if (!this.options.tunnel || this.options.tunnel.type !== "frp") {
                    throw new Error("multiclaws requires either 'selfUrl' or 'tunnel' configuration. " +
                        "Please configure tunnel in plugin settings.");
                }
                this.frpTunnel = new frp_1.FrpTunnelManager({
                    config: this.options.tunnel,
                    localPort: port,
                    stateDir: node_path_1.default.join(this.options.stateDir, "multiclaws"),
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
                profile.ownerName = this.options.displayName ?? node_os_1.default.hostname();
                await this.profileStore.save(profile);
            }
            if (isIncompleteProfile) {
                await this.setPendingProfileReview();
            }
            this.profileDescription = (0, agent_profile_1.renderProfileDescription)(profile);
            const logger = this.options.logger ?? { info: () => { }, warn: () => { }, error: () => { } };
            this.agentExecutor = new a2a_adapter_1.OpenClawAgentExecutor({
                gatewayConfig: this.options.gatewayConfig ?? null,
                taskTracker: this.taskTracker,
                cwd: this.resolvedCwd,
                getActiveChannelId: () => this.activeChannelId,
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
            const taskStore = new server_1.InMemoryTaskStore();
            this.a2aRequestHandler = new server_1.DefaultRequestHandler(this.agentCard, taskStore, this.agentExecutor);
            const app = (0, express_1.default)();
            app.use(express_1.default.json({ limit: "1mb" }));
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
            app.use("/.well-known/agent-card.json", (0, express_2.agentCardHandler)({
                agentCardProvider: this.a2aRequestHandler,
            }));
            app.use("/", (0, express_2.jsonRpcHandler)({
                requestHandler: this.a2aRequestHandler,
                userBuilder: express_2.UserBuilder.noAuthentication,
            }));
            const listenPort = this.options.port ?? 3100;
            this.httpServer = node_http_1.default.createServer(app);
            await new Promise((resolve) => this.httpServer.listen(listenPort, "0.0.0.0", resolve));
            this.started = true;
            this.log("info", `multiclaws A2A service listening on :${listenPort}`);
        }
        catch (err) {
            this.log("error", `start failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async stop() {
        if (!this.started)
            return;
        this.log("debug", "stopping");
        try {
            this.started = false;
            this.taskTracker.destroy();
            this.httpRateLimiter.destroy();
            if (this.frpTunnel) {
                await this.frpTunnel.stop();
                this.frpTunnel = null;
            }
            await new Promise((resolve) => {
                if (!this.httpServer) {
                    resolve();
                    return;
                }
                this.httpServer.close(() => resolve());
            });
            this.httpServer = null;
            this.log("debug", "stopped");
        }
        catch (err) {
            this.log("error", `stop failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    updateGatewayConfig(config) {
        this.agentExecutor?.updateGatewayConfig(config);
    }
    /* ---------------------------------------------------------------- */
    /*  Agent management                                                 */
    /* ---------------------------------------------------------------- */
    async listAgents() {
        return await this.agentRegistry.list();
    }
    async addAgent(params) {
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
        }
        catch {
            this.log("debug", `addAgent: card fetch failed for ${normalizedUrl}, adding with URL as name`);
            return await this.agentRegistry.add({
                url: normalizedUrl,
                name: normalizedUrl,
                apiKey: params.apiKey,
            });
        }
    }
    async removeAgent(url) {
        this.log("debug", `removeAgent(url=${url})`);
        try {
            const result = await this.agentRegistry.remove(url);
            this.log("debug", `removeAgent completed, result=${result}`);
            return result;
        }
        catch (err) {
            this.log("error", `removeAgent failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    /* ---------------------------------------------------------------- */
    /*  Task delegation                                                  */
    /* ---------------------------------------------------------------- */
    async delegateTask(params) {
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
                }
                catch (err) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    this.taskTracker.update(track.taskId, { status: "failed", error: errorMsg });
                    this.log("warn", `delegateTask background execution for ${track.taskId} failed: ${errorMsg}`);
                }
            })();
            // Return immediately so that gateway tool invocations are fast and
            // do not depend on the remote agent's total execution time.
            return { taskId: track.taskId, status: "running" };
        }
        catch (err) {
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
    async delegateTaskSync(params) {
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
        }
        catch (err) {
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
    async spawnDelegation(params) {
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
        await (0, gateway_client_1.invokeGatewayTool)({
            gateway: this.gatewayConfig,
            tool: "sessions_spawn",
            args: { task: prompt, mode: "run", cwd: this.resolvedCwd },
            sessionKey: `delegate-${Date.now()}`,
            timeoutMs: 15_000,
        });
        this.log("info", `spawnDelegation completed: sub-agent spawned for ${agent.name}`);
        return { message: `已启动子 agent 向 ${agent.name} 委派任务` };
    }
    getTaskStatus(taskId) {
        return this.taskTracker.get(taskId);
    }
    /* ---------------------------------------------------------------- */
    /*  Profile                                                          */
    /* ---------------------------------------------------------------- */
    async getProfile() {
        return await this.profileStore.load();
    }
    /**
     * Throws if the profile is incomplete (ownerName or bio missing).
     * Call this before any action that exposes the user's identity to other agents.
     */
    async requireCompleteProfile() {
        const profile = await this.profileStore.load();
        if (!profile.ownerName?.trim() || !profile.bio?.trim()) {
            throw new Error("档案未完成设置。请先调用 multiclaws_profile_set(ownerName=\"你的名字\", bio=\"你的介绍\") 完成设置后再继续。");
        }
    }
    async setProfile(patch) {
        this.log("debug", `setProfile(keys=${Object.keys(patch).join(",")})`);
        try {
            const profile = await this.profileStore.update(patch);
            this.updateProfileDescription(profile);
            await this.broadcastProfileToTeams();
            this.log("debug", "setProfile completed");
            return profile;
        }
        catch (err) {
            this.log("error", `setProfile failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    updateProfileDescription(profile) {
        this.profileDescription = (0, agent_profile_1.renderProfileDescription)(profile);
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
    getPendingReviewPath() {
        return node_path_1.default.join(this.options.stateDir, "multiclaws", "pending-profile-review.json");
    }
    async getPendingProfileReview() {
        const p = this.getPendingReviewPath();
        const data = await (0, json_store_1.readJsonWithFallback)(p, {});
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
    async setPendingProfileReview() {
        this.log("debug", "setPendingProfileReview");
        try {
            const p = this.getPendingReviewPath();
            await (0, json_store_1.writeJsonAtomically)(p, { pending: true });
        }
        catch (err) {
            this.log("error", `setPendingProfileReview failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async clearPendingProfileReview() {
        this.log("debug", "clearPendingProfileReview");
        const p = this.getPendingReviewPath();
        try {
            await promises_1.default.unlink(p);
        }
        catch {
            // ignore if missing
        }
    }
    /* ---------------------------------------------------------------- */
    /*  Team management                                                  */
    /* ---------------------------------------------------------------- */
    async createTeam(name) {
        this.log("debug", `createTeam(name=${name})`);
        try {
            await this.requireCompleteProfile();
            const team = await this.teamStore.createTeam({
                teamName: name,
                selfUrl: this.selfUrl,
                selfName: this.options.displayName ?? node_os_1.default.hostname(),
                selfDescription: this.profileDescription,
            });
            this.log("info", `team created: ${team.teamId} (${team.teamName})`);
            return team;
        }
        catch (err) {
            this.log("error", `createTeam failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async createInvite(teamId) {
        this.log("debug", `createInvite(teamId=${teamId ?? "first"})`);
        try {
            const team = teamId
                ? await this.teamStore.getTeam(teamId)
                : await this.teamStore.getFirstTeam();
            if (!team)
                throw new Error(teamId ? `team not found: ${teamId}` : "no team exists");
            const code = (0, team_store_1.encodeInvite)(team.teamId, this.selfUrl);
            this.log("debug", "createInvite completed");
            return code;
        }
        catch (err) {
            this.log("error", `createInvite failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async joinTeam(inviteCode) {
        this.log("info", "joinTeam starting");
        try {
            await this.requireCompleteProfile();
            const invite = (0, team_store_1.decodeInvite)(inviteCode);
            const seedUrl = invite.u.replace(/\/+$/, "");
            this.log("debug", `joinTeam: seedUrl=${seedUrl}, teamId=${invite.t}`);
            // 1. Fetch member list from seed
            let membersRes;
            try {
                membersRes = await fetch(`${seedUrl}/team/${invite.t}/members`);
            }
            catch (err) {
                throw new Error(`Unable to reach team seed node at ${seedUrl}: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (!membersRes.ok) {
                throw new Error(`failed to fetch team members from ${seedUrl}: HTTP ${membersRes.status}`);
            }
            const { team: remoteTeam } = (await membersRes.json());
            // 2. Announce self to seed (seed broadcasts to others)
            const selfMember = {
                url: this.selfUrl,
                name: this.options.displayName ?? node_os_1.default.hostname(),
                description: this.profileDescription,
                joinedAtMs: Date.now(),
            };
            let announceRes;
            try {
                announceRes = await fetch(`${seedUrl}/team/${invite.t}/announce`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(selfMember),
                });
            }
            catch (err) {
                throw new Error(`Failed to announce self to seed ${seedUrl}: ${err instanceof Error ? err.message : String(err)}`);
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
            const team = {
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
        catch (err) {
            this.log("error", `joinTeam failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async leaveTeam(teamId) {
        this.log("info", `leaveTeam(teamId=${teamId ?? "first"})`);
        try {
            const team = teamId
                ? await this.teamStore.getTeam(teamId)
                : await this.teamStore.getFirstTeam();
            if (!team)
                throw new Error(teamId ? `team not found: ${teamId}` : "no team exists");
            const selfNormalized = this.selfUrl.replace(/\/+$/, "");
            const selfMember = {
                url: this.selfUrl,
                name: this.options.displayName ?? node_os_1.default.hostname(),
                joinedAtMs: 0,
            };
            const others = team.members.filter((m) => m.url.replace(/\/+$/, "") !== selfNormalized);
            await Promise.allSettled(others.map(async (m) => {
                try {
                    await fetch(`${m.url}/team/${team.teamId}/leave`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(selfMember),
                    });
                }
                catch {
                    this.log("warn", `failed to notify ${m.url} about leaving`);
                }
            }));
            for (const m of others) {
                await this.agentRegistry.remove(m.url);
            }
            await this.teamStore.deleteTeam(team.teamId);
            this.log("info", `left team ${team.teamId}`);
        }
        catch (err) {
            this.log("error", `leaveTeam failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async listTeamMembers(teamId) {
        if (teamId) {
            const team = await this.teamStore.getTeam(teamId);
            if (!team)
                return null;
            return { team, members: team.members };
        }
        const all = await this.teamStore.listTeams();
        if (all.length === 0)
            return null;
        if (all.length === 1)
            return { team: all[0], members: all[0].members };
        return { teams: all.map((team) => ({ team, members: team.members })) };
    }
    /* ---------------------------------------------------------------- */
    /*  Team REST routes                                                 */
    /* ---------------------------------------------------------------- */
    mountTeamRoutes(app) {
        const announceBodySchema = zod_1.z.object({
            url: zod_1.z.string().trim().min(1),
            name: zod_1.z.string().trim().min(1),
            description: zod_1.z.string().trim().optional(),
            joinedAtMs: zod_1.z.number().optional(),
        });
        const leaveBodySchema = zod_1.z.object({
            url: zod_1.z.string().trim().min(1),
        });
        const profileUpdateBodySchema = zod_1.z.object({
            url: zod_1.z.string().trim().min(1),
            name: zod_1.z.string().trim().optional(),
            description: zod_1.z.string().optional(),
        });
        app.get("/team/:id/members", async (req, res) => {
            try {
                const team = await this.teamStore.getTeam(req.params.id);
                if (!team) {
                    res.status(404).json({ error: "team not found" });
                    return;
                }
                res.json({ team: { teamName: team.teamName, members: team.members } });
            }
            catch (err) {
                this.log("error", `GET /team/${req.params.id}/members failed: ${err instanceof Error ? err.message : String(err)}`);
                res.status(500).json({ error: String(err) });
            }
        });
        app.post("/team/:id/announce", async (req, res) => {
            this.log("debug", `POST /team/${req.params.id}/announce from ${req.body?.url}`);
            try {
                const team = await this.teamStore.getTeam(req.params.id);
                if (!team) {
                    this.log("debug", `announce: team ${req.params.id} not found`);
                    res.status(404).json({ error: "team not found" });
                    return;
                }
                const parsed = announceBodySchema.safeParse(req.body);
                if (!parsed.success) {
                    this.log("debug", `announce: invalid body: ${parsed.error.message}`);
                    res.status(400).json({ error: parsed.error.message });
                    return;
                }
                const member = parsed.data;
                this.log("debug", `announce: member=${member.name}, url=${member.url}`);
                const normalizedUrl = member.url.replace(/\/+$/, "");
                const alreadyKnown = team.members.some((m) => m.url.replace(/\/+$/, "") === normalizedUrl);
                this.log("debug", `announce: alreadyKnown=${alreadyKnown}`);
                await this.teamStore.addMember(team.teamId, {
                    url: normalizedUrl,
                    name: member.name,
                    description: member.description,
                    joinedAtMs: member.joinedAtMs ?? Date.now(),
                });
                this.log("debug", `announce: addMember completed`);
                await this.agentRegistry.add({
                    url: normalizedUrl,
                    name: member.name,
                    description: member.description,
                });
                this.log("debug", `announce: agentRegistry.add completed`);
                // Broadcast to other members if new
                if (!alreadyKnown) {
                    const selfNormalized = this.selfUrl.replace(/\/+$/, "");
                    const others = team.members.filter((m) => m.url.replace(/\/+$/, "") !== normalizedUrl &&
                        m.url.replace(/\/+$/, "") !== selfNormalized);
                    this.log("debug", `announce: broadcasting to ${others.length} other members`);
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
                        }).catch((err) => {
                            this.log("warn", `broadcast to ${other.url} failed: ${err instanceof Error ? err.message : String(err)}`);
                        });
                    }
                    // Notify local user that a new member joined
                    this.log("debug", `announce: notifying local user about ${member.name}`);
                    void this.notifyUser(`📢 **${member.name}** 已加入团队「${team.teamName}」`);
                }
                this.log("debug", `announce: completed for ${member.name}`);
                res.json({ ok: true });
            }
            catch (err) {
                this.log("error", `POST /team/${req.params.id}/announce failed: ${err instanceof Error ? err.message : String(err)}`);
                res.status(500).json({ error: String(err) });
            }
        });
        app.post("/team/:id/leave", async (req, res) => {
            this.log("debug", `POST /team/${req.params.id}/leave from ${req.body?.url}`);
            try {
                const team = await this.teamStore.getTeam(req.params.id);
                if (!team) {
                    res.status(404).json({ error: "team not found" });
                    return;
                }
                const parsed = leaveBodySchema.safeParse(req.body);
                if (!parsed.success) {
                    res.status(400).json({ error: parsed.error.message });
                    return;
                }
                const normalizedUrl = parsed.data.url.replace(/\/+$/, "");
                await this.teamStore.removeMember(team.teamId, normalizedUrl);
                await this.agentRegistry.remove(normalizedUrl);
                res.json({ ok: true });
            }
            catch (err) {
                this.log("error", `POST /team/${req.params.id}/leave failed: ${err instanceof Error ? err.message : String(err)}`);
                res.status(500).json({ error: String(err) });
            }
        });
        // Profile update broadcast receiver
        app.post("/team/:id/profile-update", async (req, res) => {
            this.log("debug", `POST /team/${req.params.id}/profile-update from ${req.body?.url}`);
            try {
                const team = await this.teamStore.getTeam(req.params.id);
                if (!team) {
                    res.status(404).json({ error: "team not found" });
                    return;
                }
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
                    if (name)
                        existing.name = name;
                    if (description !== undefined)
                        existing.description = description;
                    await this.teamStore.saveTeam(team);
                }
                // Update agent registry description
                if (description !== undefined) {
                    await this.agentRegistry.updateDescription(normalizedUrl, description);
                }
                res.json({ ok: true });
            }
            catch (err) {
                this.log("error", `POST /team/${req.params.id}/profile-update failed: ${err instanceof Error ? err.message : String(err)}`);
                res.status(500).json({ error: String(err) });
            }
        });
    }
    /* ---------------------------------------------------------------- */
    /*  Private helpers                                                  */
    /* ---------------------------------------------------------------- */
    async broadcastProfileToTeams() {
        this.log("debug", "broadcastProfileToTeams");
        try {
            const teams = await this.teamStore.listTeams();
            const selfNormalized = this.selfUrl.replace(/\/+$/, "");
            const displayName = this.options.displayName ?? node_os_1.default.hostname();
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
        }
        catch (err) {
            this.log("error", `broadcastProfileToTeams failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async fetchMemberDescriptions(team) {
        const selfNormalized = this.selfUrl.replace(/\/+$/, "");
        const membersToFetch = team.members.filter((m) => m.url.replace(/\/+$/, "") !== selfNormalized && !m.description);
        this.log("debug", `fetchMemberDescriptions(teamId=${team.teamId}, count=${membersToFetch.length})`);
        try {
            await Promise.allSettled(membersToFetch.map(async (m) => {
                try {
                    const client = await this.clientFactory.createFromUrl(m.url);
                    const card = await client.getAgentCard();
                    if (card.description) {
                        m.description = card.description;
                    }
                }
                catch {
                    this.log("warn", `failed to fetch Agent Card from ${m.url}`);
                }
            }));
            await this.teamStore.saveTeam(team);
            this.log("debug", "fetchMemberDescriptions completed");
        }
        catch (err) {
            this.log("error", `fetchMemberDescriptions failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async syncTeamToRegistry(team) {
        this.log("debug", `syncTeamToRegistry(teamId=${team.teamId})`);
        try {
            const selfNormalized = this.selfUrl.replace(/\/+$/, "");
            for (const member of team.members) {
                if (member.url.replace(/\/+$/, "") === selfNormalized)
                    continue;
                await this.agentRegistry.add({
                    url: member.url,
                    name: member.name,
                    description: member.description,
                });
            }
            this.log("debug", "syncTeamToRegistry completed");
        }
        catch (err) {
            this.log("error", `syncTeamToRegistry failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async createA2AClient(agent) {
        return await this.clientFactory.createFromUrl(agent.url);
    }
    /**
     * Send a message using A2A streaming to minimize latency.
     * Instead of a single blocking HTTP call, consume the SSE stream and
     * return the final Task or Message as soon as B signals completion.
     */
    processTaskResult(trackId, result) {
        this.log("debug", `processTaskResult(trackId=${trackId})`);
        try {
            if ("status" in result && result.status) {
                const task = result;
                const state = task.status?.state ?? "unknown";
                const output = this.extractArtifactText(task);
                if (state === "completed") {
                    this.taskTracker.update(trackId, { status: "completed", result: output });
                }
                else if (state === "failed") {
                    this.taskTracker.update(trackId, { status: "failed", error: output || "remote task failed" });
                }
                else {
                    // For any other state (unknown, working, etc.), mark as failed to avoid
                    // tasks stuck in "running" forever until TTL prune.
                    this.taskTracker.update(trackId, { status: "failed", error: `unexpected remote state: ${state}` });
                }
                this.log("debug", `processTaskResult completed, status=${state}`);
                return { taskId: task.id, output, status: state };
            }
            const msg = result;
            const text = msg.parts
                ?.filter((p) => p.kind === "text")
                .map((p) => p.text)
                .join("\n") ?? "";
            this.taskTracker.update(trackId, { status: "completed", result: text });
            this.log("debug", "processTaskResult completed, status=completed (message)");
            return { taskId: trackId, output: text, status: "completed" };
        }
        catch (err) {
            this.log("error", `processTaskResult failed for ${trackId}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    extractArtifactText(task) {
        if (!task.artifacts?.length)
            return "";
        return task.artifacts
            .flatMap((a) => a.parts ?? [])
            .filter((p) => p.kind === "text")
            .map((p) => p.text)
            .join("\n");
    }
    /** Fetch with up to 2 retries and exponential backoff. */
    async fetchWithRetry(url, init, retries = 2) {
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const res = await fetch(url, init);
                if (res.ok || attempt === retries)
                    return res;
                lastError = new Error(`HTTP ${res.status}`);
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempt === retries)
                    break;
            }
            await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
        }
        throw lastError;
    }
    /** Update the most recently active channel for notifications. */
    setActiveChannelId(channelId) {
        this.activeChannelId = channelId;
        this.log("debug", `activeChannelId set to: ${channelId}`);
    }
    /** Send a notification to the most recently active channel. */
    async notifyUser(message) {
        if (!this.gatewayConfig || !this.activeChannelId)
            return;
        try {
            await (0, gateway_client_1.invokeGatewayTool)({
                gateway: this.gatewayConfig,
                tool: "message",
                args: { action: "send", target: this.activeChannelId, message },
                timeoutMs: 5_000,
            });
        }
        catch (err) {
            this.log("warn", `notifyUser failed: ${err instanceof Error ? err.message : String(err)} | msg=${message.slice(0, 80)}`);
        }
    }
    log(level, message) {
        this.options.logger?.[level]?.(`[multiclaws] ${message}`);
    }
}
exports.MulticlawsService = MulticlawsService;
