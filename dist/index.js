"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const handlers_1 = require("./gateway/handlers");
const multiclaws_service_1 = require("./service/multiclaws-service");
const logger_1 = require("./infra/logger");
const telemetry_1 = require("./infra/telemetry");
function readConfig(api) {
    const raw = (api.pluginConfig ?? {});
    return {
        port: typeof raw.port === "number" ? raw.port : undefined,
        displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
        selfUrl: typeof raw.selfUrl === "string" ? raw.selfUrl : undefined,
        telemetry: {
            consoleExporter: typeof raw.telemetry?.consoleExporter === "boolean"
                ? Boolean(raw.telemetry.consoleExporter)
                : undefined,
        },
    };
}
function textResult(text, details) {
    return {
        content: [{ type: "text", text }],
        ...(details === undefined ? {} : { details }),
    };
}
function requireService(service) {
    if (!service) {
        throw new Error("multiclaws service is not running yet");
    }
    return service;
}
function createTools(getService) {
    /* ── Agent tools ──────────────────────────────────────────────── */
    const multiclawsAgents = {
        name: "multiclaws_agents",
        description: "List known A2A agents and their capabilities.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {},
        },
        execute: async () => {
            const service = requireService(getService());
            const agents = await service.listAgents();
            return textResult(JSON.stringify({ agents }, null, 2), { agents });
        },
    };
    const multiclawsAddAgent = {
        name: "multiclaws_add_agent",
        description: "Add a remote A2A agent by URL. Automatically fetches its Agent Card.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                url: { type: "string" },
                apiKey: { type: "string" },
            },
            required: ["url"],
        },
        execute: async (_toolCallId, args) => {
            const service = requireService(getService());
            const url = typeof args.url === "string" ? args.url.trim() : "";
            if (!url)
                throw new Error("url is required");
            const apiKey = typeof args.apiKey === "string" ? args.apiKey.trim() : undefined;
            const agent = await service.addAgent({ url, apiKey });
            return textResult(`Agent added: ${agent.name} (${agent.url})`, agent);
        },
    };
    const multiclawsRemoveAgent = {
        name: "multiclaws_remove_agent",
        description: "Remove a known A2A agent by URL.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                url: { type: "string" },
            },
            required: ["url"],
        },
        execute: async (_toolCallId, args) => {
            const service = requireService(getService());
            const url = typeof args.url === "string" ? args.url.trim() : "";
            if (!url)
                throw new Error("url is required");
            const removed = await service.removeAgent(url);
            return textResult(removed ? `Agent ${url} removed.` : `Agent ${url} not found.`);
        },
    };
    const multiclawsDelegate = {
        name: "multiclaws_delegate",
        description: "Delegate a task to a remote A2A agent.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                agentUrl: { type: "string" },
                task: { type: "string" },
            },
            required: ["agentUrl", "task"],
        },
        execute: async (_toolCallId, args) => {
            const service = requireService(getService());
            const agentUrl = typeof args.agentUrl === "string" ? args.agentUrl.trim() : "";
            const task = typeof args.task === "string" ? args.task.trim() : "";
            if (!agentUrl || !task)
                throw new Error("agentUrl and task are required");
            const result = await service.delegateTask({ agentUrl, task });
            return textResult(JSON.stringify(result, null, 2), result);
        },
    };
    const multiclawsTaskStatus = {
        name: "multiclaws_task_status",
        description: "Check the status of a delegated task.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                taskId: { type: "string" },
            },
            required: ["taskId"],
        },
        execute: async (_toolCallId, args) => {
            const service = requireService(getService());
            const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
            if (!taskId)
                throw new Error("taskId is required");
            const task = service.getTaskStatus(taskId);
            if (!task)
                throw new Error(`task not found: ${taskId}`);
            return textResult(JSON.stringify(task, null, 2), task);
        },
    };
    /* ── Team tools ───────────────────────────────────────────────── */
    const multiclawsTeamCreate = {
        name: "multiclaws_team_create",
        description: "Create a new team. Returns teamId and invite code.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                name: { type: "string" },
            },
            required: ["name"],
        },
        execute: async (_toolCallId, args) => {
            const service = requireService(getService());
            const name = typeof args.name === "string" ? args.name.trim() : "";
            if (!name)
                throw new Error("name is required");
            const team = await service.createTeam(name);
            const invite = await service.createInvite(team.teamId);
            return textResult(`Team "${team.teamName}" created (${team.teamId}).\nInvite code: ${invite}`, { team, inviteCode: invite });
        },
    };
    const multiclawsTeamInvite = {
        name: "multiclaws_team_invite",
        description: "Generate an invite code for a team. Other agents can use this code to join.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                teamId: { type: "string" },
            },
        },
        execute: async (_toolCallId, args) => {
            const service = requireService(getService());
            const teamId = typeof args.teamId === "string" ? args.teamId.trim() : undefined;
            const invite = await service.createInvite(teamId || undefined);
            return textResult(`Invite code: ${invite}`, { inviteCode: invite });
        },
    };
    const multiclawsTeamJoin = {
        name: "multiclaws_team_join",
        description: "Join a team using an invite code. Automatically syncs all team members as agents.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                inviteCode: { type: "string" },
            },
            required: ["inviteCode"],
        },
        execute: async (_toolCallId, args) => {
            const service = requireService(getService());
            const inviteCode = typeof args.inviteCode === "string" ? args.inviteCode.trim() : "";
            if (!inviteCode)
                throw new Error("inviteCode is required");
            const team = await service.joinTeam(inviteCode);
            const memberNames = team.members.map((m) => m.name).join(", ");
            return textResult(`Joined team "${team.teamName}" with ${team.members.length} members: ${memberNames}`, { team });
        },
    };
    const multiclawsTeamLeave = {
        name: "multiclaws_team_leave",
        description: "Leave a team. Notifies all members and removes them from local agent registry.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                teamId: { type: "string" },
            },
        },
        execute: async (_toolCallId, args) => {
            const service = requireService(getService());
            const teamId = typeof args.teamId === "string" ? args.teamId.trim() : undefined;
            await service.leaveTeam(teamId || undefined);
            return textResult("Left team successfully.");
        },
    };
    const multiclawsTeamMembers = {
        name: "multiclaws_team_members",
        description: "List all members of a team.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                teamId: { type: "string" },
            },
        },
        execute: async (_toolCallId, args) => {
            const service = requireService(getService());
            const teamId = typeof args.teamId === "string" ? args.teamId.trim() : undefined;
            const result = await service.listTeamMembers(teamId || undefined);
            if (!result) {
                return textResult("No team found.");
            }
            return textResult(JSON.stringify(result, null, 2), result);
        },
    };
    /* ── Profile tools ──────────────────────────────────────────── */
    const multiclawsProfileSet = {
        name: "multiclaws_profile_set",
        description: "Set or update the owner profile (name and bio). Bio is free-form markdown describing role, capabilities, data sources, etc. Broadcasts to team members.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                ownerName: { type: "string" },
                bio: { type: "string" },
            },
        },
        execute: async (_toolCallId, args) => {
            const service = requireService(getService());
            const patch = {};
            if (typeof args.ownerName === "string")
                patch.ownerName = args.ownerName.trim();
            if (typeof args.bio === "string")
                patch.bio = args.bio;
            const profile = await service.setProfile(patch);
            return textResult(JSON.stringify(profile, null, 2), profile);
        },
    };
    const multiclawsProfileShow = {
        name: "multiclaws_profile_show",
        description: "Show the current owner profile.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {},
        },
        execute: async () => {
            const service = requireService(getService());
            const profile = await service.getProfile();
            return textResult(JSON.stringify(profile, null, 2), profile);
        },
    };
    const multiclawsProfilePendingReview = {
        name: "multiclaws_profile_pending_review",
        description: "Check if the user's profile was just initialized and is pending review. If pending, returns profile and a message to show the user and ask if they want to adjust.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {},
        },
        execute: async () => {
            const service = requireService(getService());
            const result = await service.getPendingProfileReview();
            return textResult(JSON.stringify(result, null, 2), result);
        },
    };
    const multiclawsProfileClearPendingReview = {
        name: "multiclaws_profile_clear_pending_review",
        description: "Clear the pending profile review flag after the user has confirmed or finished adjusting their profile.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {},
        },
        execute: async () => {
            const service = requireService(getService());
            await service.clearPendingProfileReview();
            return textResult("Pending profile review cleared.");
        },
    };
    return [
        multiclawsAgents,
        multiclawsAddAgent,
        multiclawsRemoveAgent,
        multiclawsDelegate,
        multiclawsTaskStatus,
        multiclawsTeamCreate,
        multiclawsTeamInvite,
        multiclawsTeamJoin,
        multiclawsTeamLeave,
        multiclawsTeamMembers,
        multiclawsProfileSet,
        multiclawsProfileShow,
        multiclawsProfilePendingReview,
        multiclawsProfileClearPendingReview,
    ];
}
const plugin = {
    id: "multiclaws",
    name: "MultiClaws",
    version: "0.3.0",
    register(api) {
        const config = readConfig(api);
        (0, telemetry_1.initializeTelemetry)({ enableConsoleExporter: config.telemetry?.consoleExporter });
        const structured = (0, logger_1.createStructuredLogger)(api.logger, "multiclaws");
        let service = null;
        const gatewayConfig = (() => {
            const gw = api.config?.gateway;
            const port = typeof gw?.port === "number" ? gw.port : 18789;
            const token = typeof gw?.auth?.token === "string" ? gw.auth.token : null;
            if (!token)
                return null;
            return { port, token };
        })();
        const pluginService = {
            id: "multiclaws-service",
            start: async (ctx) => {
                service = new multiclaws_service_1.MulticlawsService({
                    stateDir: ctx.stateDir,
                    port: config.port,
                    displayName: config.displayName,
                    selfUrl: config.selfUrl,
                    gatewayConfig: gatewayConfig ?? undefined,
                    logger: structured.logger,
                });
                await service.start();
            },
            stop: async () => {
                if (service) {
                    await service.stop();
                    service = null;
                }
            },
        };
        api.registerService(pluginService);
        const gatewayHandlers = (0, handlers_1.createGatewayHandlers)(() => requireService(service));
        for (const [method, handler] of Object.entries(gatewayHandlers)) {
            api.registerGatewayMethod(method, handler);
        }
        for (const tool of createTools(() => service)) {
            api.registerTool(tool);
        }
        api.registerHttpRoute({
            path: "/multiclaws/health",
            auth: "plugin",
            handler: (_req, res) => {
                const running = service !== null;
                res.statusCode = running ? 200 : 503;
                res.end(JSON.stringify({
                    ok: running,
                    plugin: "multiclaws",
                }));
            },
        });
        api.on("gateway_start", () => {
            structured.logger.info("[multiclaws] gateway_start observed");
        });
        api.on("gateway_stop", () => {
            structured.logger.info("[multiclaws] gateway_stop observed");
        });
    },
};
exports.default = plugin;
