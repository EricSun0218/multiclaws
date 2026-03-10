"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MulticlawsService = void 0;
const node_events_1 = require("node:events");
const node_crypto_1 = require("node:crypto");
const node_os_1 = __importDefault(require("node:os"));
const node_http_1 = __importDefault(require("node:http"));
const node_path_1 = __importDefault(require("node:path"));
const promises_1 = __importDefault(require("node:fs/promises"));
const tailscale_1 = require("../infra/tailscale");
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
const session_store_1 = require("./session-store");
const zod_1 = require("zod");
const gateway_client_1 = require("../infra/gateway-client");
const rate_limiter_1 = require("../infra/rate-limiter");
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
    sessionStore;
    agentExecutor = null;
    a2aRequestHandler = null;
    agentCard = null;
    clientFactory = new client_1.ClientFactory();
    httpRateLimiter = new rate_limiter_1.RateLimiter({ windowMs: 60_000, maxRequests: 60 });
    selfUrl;
    profileDescription = "OpenClaw agent";
    constructor(options) {
        super();
        this.options = options;
        const multiclawsStateDir = node_path_1.default.join(options.stateDir, "multiclaws");
        this.agentRegistry = new agent_registry_1.AgentRegistry(node_path_1.default.join(multiclawsStateDir, "agents.json"));
        this.teamStore = new team_store_1.TeamStore(node_path_1.default.join(multiclawsStateDir, "teams.json"));
        this.profileStore = new agent_profile_1.ProfileStore(node_path_1.default.join(multiclawsStateDir, "profile.json"));
        this.taskTracker = new tracker_1.TaskTracker({
            filePath: node_path_1.default.join(multiclawsStateDir, "tasks.json"),
        });
        this.sessionStore = new session_store_1.SessionStore({
            filePath: node_path_1.default.join(multiclawsStateDir, "sessions.json"),
        });
        const port = options.port ?? 3100;
        // selfUrl resolved later in start() after Tailscale detection; use placeholder for now
        this.selfUrl = options.selfUrl ?? `http://${getLocalIp()}:${port}`;
    }
    async start() {
        if (this.started)
            return;
        // Auto-detect Tailscale if selfUrl not explicitly configured
        if (!this.options.selfUrl) {
            const port = this.options.port ?? 3100;
            // Fast path: Tailscale already active — just read from network interfaces, no subprocess
            const tsIp = (0, tailscale_1.getTailscaleIpFromInterfaces)();
            if (tsIp) {
                this.selfUrl = `http://${tsIp}:${port}`;
                this.log("info", `Tailscale IP detected: ${tsIp}`);
            }
            else {
                // Slow path: Tailscale not active — run full detection and notify user
                const tailscale = await (0, tailscale_1.detectTailscale)();
                if (tailscale.status === "ready") {
                    this.selfUrl = `http://${tailscale.ip}:${port}`;
                    this.log("info", `Tailscale IP detected: ${tailscale.ip}`);
                }
                else {
                    void this.notifyTailscaleSetup(tailscale);
                }
            }
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
    async stop() {
        if (!this.started)
            return;
        this.started = false;
        this.taskTracker.destroy();
        this.httpRateLimiter.destroy();
        await new Promise((resolve) => {
            if (!this.httpServer) {
                resolve();
                return;
            }
            this.httpServer.close(() => resolve());
        });
        this.httpServer = null;
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
        }
        catch {
            return await this.agentRegistry.add({
                url: normalizedUrl,
                name: normalizedUrl,
                apiKey: params.apiKey,
            });
        }
    }
    async removeAgent(url) {
        return await this.agentRegistry.remove(url);
    }
    /* ---------------------------------------------------------------- */
    /*  Task delegation                                                  */
    /* ---------------------------------------------------------------- */
    /* ---------------------------------------------------------------- */
    /*  Session management (multi-turn collaboration)                  */
    /* ---------------------------------------------------------------- */
    async startSession(params) {
        const agentRecord = await this.agentRegistry.get(params.agentUrl);
        if (!agentRecord) {
            return { sessionId: "", status: "failed", error: `unknown agent: ${params.agentUrl}` };
        }
        const contextId = (0, node_crypto_1.randomUUID)();
        const session = this.sessionStore.create({
            agentUrl: params.agentUrl,
            agentName: agentRecord.name,
            contextId,
        });
        this.sessionStore.appendMessage(session.sessionId, {
            role: "user",
            content: params.message,
            timestampMs: Date.now(),
        });
        void this.runSession({
            sessionId: session.sessionId,
            agentRecord,
            message: params.message,
            contextId,
            taskId: undefined,
        });
        return { sessionId: session.sessionId, status: "running" };
    }
    async sendSessionMessage(params) {
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
        void this.runSession({
            sessionId: params.sessionId,
            agentRecord,
            message: params.message,
            contextId: session.contextId,
            taskId: session.currentTaskId,
        });
        return { sessionId: params.sessionId, status: "ok" };
    }
    getSession(sessionId) {
        return this.sessionStore.get(sessionId);
    }
    listSessions() {
        return this.sessionStore.list();
    }
    endSession(sessionId) {
        const session = this.sessionStore.get(sessionId);
        if (!session)
            return false;
        this.sessionStore.update(sessionId, { status: "canceled" });
        return true;
    }
    async runSession(params) {
        const timeout = params.timeoutMs ?? 5 * 60 * 1000; // 5 min default
        const timeoutController = new AbortController();
        const timer = setTimeout(() => timeoutController.abort(), timeout);
        try {
            const client = await this.createA2AClient(params.agentRecord);
            const result = await Promise.race([
                client.sendMessage({
                    message: {
                        kind: "message",
                        role: "user",
                        parts: [{ kind: "text", text: params.message }],
                        messageId: (0, node_crypto_1.randomUUID)(),
                        contextId: params.contextId,
                        ...(params.taskId ? { taskId: params.taskId } : {}),
                    },
                }),
                new Promise((_, reject) => timeoutController.signal.addEventListener("abort", () => reject(new Error("session timeout")))),
            ]);
            await this.handleSessionResult(params.sessionId, result);
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this.sessionStore.update(params.sessionId, { status: "failed", error: errorMsg });
            await this.notifySessionUpdate(params.sessionId, "failed");
        }
        finally {
            clearTimeout(timer);
        }
    }
    async handleSessionResult(sessionId, result) {
        // Extract content
        let content = "";
        let state = "completed";
        let remoteTaskId;
        if ("status" in result && result.status) {
            const task = result;
            state = task.status?.state ?? "completed";
            remoteTaskId = task.id;
            content = this.extractArtifactText(task);
            // Also try to get text from task messages if artifacts empty
            if (!content && task.history?.length) {
                const lastAgentMsg = [...task.history].reverse().find((m) => m.role === "agent");
                if (lastAgentMsg) {
                    content = lastAgentMsg.parts
                        ?.filter((p) => p.kind === "text")
                        .map((p) => p.text)
                        .join("\n") ?? "";
                }
            }
        }
        else {
            const msg = result;
            remoteTaskId = msg.taskId;
            content = msg.parts
                ?.filter((p) => p.kind === "text")
                .map((p) => p.text)
                .join("\n") ?? "";
        }
        // Append agent message to history
        if (content) {
            this.sessionStore.appendMessage(sessionId, {
                role: "agent",
                content,
                timestampMs: Date.now(),
                taskId: remoteTaskId,
            });
        }
        // Update session state
        if (state === "input-required" || state === "auth-required") {
            this.sessionStore.update(sessionId, {
                status: "input-required",
                currentTaskId: remoteTaskId,
            });
            await this.notifySessionUpdate(sessionId, "input-required");
        }
        else if (state === "failed" || state === "rejected") {
            this.sessionStore.update(sessionId, {
                status: "failed",
                currentTaskId: remoteTaskId,
                error: content || "remote task failed",
            });
            await this.notifySessionUpdate(sessionId, "failed");
        }
        else if (state === "completed" || state === "canceled") {
            this.sessionStore.update(sessionId, {
                status: "completed",
                currentTaskId: remoteTaskId,
            });
            await this.notifySessionUpdate(sessionId, "completed");
        }
        else {
            // working / submitted / unknown — still in progress, no notification
            this.sessionStore.update(sessionId, { currentTaskId: remoteTaskId });
        }
    }
    async notifySessionUpdate(sessionId, event) {
        if (!this.options.gatewayConfig)
            return;
        const session = this.sessionStore.get(sessionId);
        if (!session)
            return;
        const lastAgentMsg = [...session.messages].reverse().find((m) => m.role === "agent");
        const content = lastAgentMsg?.content ?? "";
        const agentName = session.agentName;
        let message;
        if (event === "completed") {
            message = [`✅ **${agentName} 任务完成** (session: \`${sessionId}\`)`, "", content].join("\n");
        }
        else if (event === "input-required") {
            message = [
                `📨 **${agentName} 需要补充信息** (session: \`${sessionId}\`)`,
                "",
                content,
                "",
                `→ 回复请用 \`multiclaws_session_reply\` 工具，sessionId: \`${sessionId}\``,
            ].join("\n");
        }
        else {
            const error = session.error ?? content;
            message = [`❌ **${agentName} 任务失败** (session: \`${sessionId}\`)`, "", error].join("\n");
        }
        try {
            await (0, gateway_client_1.invokeGatewayTool)({
                gateway: this.options.gatewayConfig,
                tool: "message",
                args: { action: "send", message },
                timeoutMs: 5_000,
            });
        }
        catch {
            this.log("warn", `[multiclaws] failed to notify session update: ${sessionId}`);
        }
    }
    /* ---------------------------------------------------------------- */
    /*  Profile                                                          */
    /* ---------------------------------------------------------------- */
    async getProfile() {
        return await this.profileStore.load();
    }
    async setProfile(patch) {
        const profile = await this.profileStore.update(patch);
        this.updateProfileDescription(profile);
        await this.broadcastProfileToTeams();
        return profile;
    }
    updateProfileDescription(profile) {
        this.profileDescription = (0, agent_profile_1.renderProfileDescription)(profile);
        if (this.agentCard) {
            this.agentCard.description = this.profileDescription;
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
        const p = this.getPendingReviewPath();
        await (0, json_store_1.writeJsonAtomically)(p, { pending: true });
    }
    async clearPendingProfileReview() {
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
        const team = await this.teamStore.createTeam({
            teamName: name,
            selfUrl: this.selfUrl,
            selfName: this.options.displayName ?? node_os_1.default.hostname(),
            selfDescription: this.profileDescription,
        });
        this.log("info", `team created: ${team.teamId} (${team.teamName})`);
        return team;
    }
    async createInvite(teamId) {
        const team = teamId
            ? await this.teamStore.getTeam(teamId)
            : await this.teamStore.getFirstTeam();
        if (!team)
            throw new Error(teamId ? `team not found: ${teamId}` : "no team exists");
        return (0, team_store_1.encodeInvite)(team.teamId, this.selfUrl);
    }
    async joinTeam(inviteCode) {
        const invite = (0, team_store_1.decodeInvite)(inviteCode);
        const seedUrl = invite.u.replace(/\/+$/, "");
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
    async leaveTeam(teamId) {
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
                res.status(500).json({ error: String(err) });
            }
        });
        app.post("/team/:id/announce", async (req, res) => {
            try {
                const team = await this.teamStore.getTeam(req.params.id);
                if (!team) {
                    res.status(404).json({ error: "team not found" });
                    return;
                }
                const parsed = announceBodySchema.safeParse(req.body);
                if (!parsed.success) {
                    res.status(400).json({ error: parsed.error.message });
                    return;
                }
                const member = parsed.data;
                const normalizedUrl = member.url.replace(/\/+$/, "");
                const alreadyKnown = team.members.some((m) => m.url.replace(/\/+$/, "") === normalizedUrl);
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
                    const others = team.members.filter((m) => m.url.replace(/\/+$/, "") !== normalizedUrl &&
                        m.url.replace(/\/+$/, "") !== selfNormalized);
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
            }
            catch (err) {
                res.status(500).json({ error: String(err) });
            }
        });
        app.post("/team/:id/leave", async (req, res) => {
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
                res.status(500).json({ error: String(err) });
            }
        });
        // Profile update broadcast receiver
        app.post("/team/:id/profile-update", async (req, res) => {
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
                res.status(500).json({ error: String(err) });
            }
        });
    }
    /* ---------------------------------------------------------------- */
    /*  Private helpers                                                  */
    /* ---------------------------------------------------------------- */
    async broadcastProfileToTeams() {
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
    }
    async fetchMemberDescriptions(team) {
        const selfNormalized = this.selfUrl.replace(/\/+$/, "");
        await Promise.allSettled(team.members
            .filter((m) => m.url.replace(/\/+$/, "") !== selfNormalized && !m.description)
            .map(async (m) => {
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
    }
    async syncTeamToRegistry(team) {
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
    }
    async createA2AClient(agent) {
        return await this.clientFactory.createFromUrl(agent.url);
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
    async notifyTailscaleSetup(tailscale) {
        let message;
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
        }
        else {
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
                await (0, gateway_client_1.invokeGatewayTool)({
                    gateway: this.options.gatewayConfig,
                    tool: "message",
                    args: { action: "send", message },
                    timeoutMs: 5_000,
                });
            }
            catch {
                // Fallback to log
                this.log("warn", message.replace(/\*\*/g, "").replace(/```[^`]*```/gs, ""));
            }
        }
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
    log(level, message) {
        this.options.logger?.[level]?.(`[multiclaws] ${message}`);
    }
}
exports.MulticlawsService = MulticlawsService;
function getLocalIp() {
    // Prefer Tailscale IP if available
    const tsIp = (0, tailscale_1.getTailscaleIpFromInterfaces)();
    if (tsIp)
        return tsIp;
    const interfaces = node_os_1.default.networkInterfaces();
    for (const addrs of Object.values(interfaces)) {
        if (!addrs)
            continue;
        for (const addr of addrs) {
            if (addr.family === "IPv4" && !addr.internal)
                return addr.address;
        }
    }
    return node_os_1.default.hostname();
}
