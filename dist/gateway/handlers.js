"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGatewayHandlers = createGatewayHandlers;
const zod_1 = require("zod");
const nonEmptyString = zod_1.z.string().trim().min(1);
const optionalString = zod_1.z.string().trim().min(1).optional();
const optionalFiniteNumber = zod_1.z
    .preprocess((value) => {
    if (typeof value === "number")
        return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
    }
    return undefined;
}, zod_1.z.number().finite())
    .optional();
const peerAddSchema = zod_1.z.object({
    address: nonEmptyString,
    peerId: optionalString,
    displayName: optionalString,
    publicKey: optionalString,
});
const peerIdSchema = zod_1.z.object({ peerId: nonEmptyString });
const memorySearchSchema = zod_1.z.object({
    peerId: nonEmptyString,
    query: nonEmptyString,
    maxResults: optionalFiniteNumber,
});
const taskDelegateSchema = zod_1.z.object({
    peerId: nonEmptyString,
    task: nonEmptyString,
    context: optionalString,
});
const taskStatusSchema = zod_1.z.object({ taskId: nonEmptyString });
const messageSendSchema = zod_1.z.object({
    peerId: nonEmptyString,
    message: nonEmptyString,
});
const teamCreateSchema = zod_1.z.object({
    teamName: nonEmptyString,
    localAddress: nonEmptyString,
});
const teamJoinSchema = zod_1.z.object({
    inviteCode: nonEmptyString,
    localAddress: nonEmptyString,
});
const teamMembersSchema = zod_1.z.object({ teamId: nonEmptyString });
const teamLeaveSchema = zod_1.z.object({ teamId: nonEmptyString });
const permissionResolveSchema = zod_1.z.object({
    requestId: nonEmptyString,
    decision: zod_1.z.enum(["allow-once", "allow-permanently", "deny"]),
});
const permissionSetSchema = zod_1.z.object({
    peerId: nonEmptyString,
    mode: zod_1.z.enum(["prompt", "allow-all", "blocked"]),
});
function safeHandle(respond, code, error) {
    respond(false, undefined, {
        code,
        message: error instanceof Error ? error.message : String(error),
    });
}
function createGatewayHandlers(getService) {
    const handlers = {
        "multiclaws.peer.handshake": async ({ respond }) => {
            const service = getService();
            respond(true, {
                localIdentity: service.identity,
            });
        },
        "multiclaws.peer.list": async ({ respond }) => {
            const service = getService();
            const peers = await service.listPeers();
            respond(true, { peers });
        },
        "multiclaws.peer.add": async ({ params, respond }) => {
            try {
                const parsed = peerAddSchema.parse(params);
                const service = getService();
                const peer = await service.addPeer(parsed);
                respond(true, peer);
            }
            catch (error) {
                safeHandle(respond, "invalid_params", error);
            }
        },
        "multiclaws.peer.remove": async ({ params, respond }) => {
            try {
                const parsed = peerIdSchema.parse(params);
                const service = getService();
                const removed = await service.removePeer(parsed.peerId);
                respond(true, { removed });
            }
            catch (error) {
                safeHandle(respond, "invalid_params", error);
            }
        },
        "multiclaws.memory.search": async ({ params, respond }) => {
            try {
                const parsed = memorySearchSchema.parse(params);
                const service = getService();
                const result = await service.multiclawsMemorySearch(parsed);
                respond(true, result);
            }
            catch (error) {
                safeHandle(respond, "memory_search_failed", error);
            }
        },
        "multiclaws.task.delegate": async ({ params, respond }) => {
            try {
                const parsed = taskDelegateSchema.parse(params);
                const service = getService();
                const result = await service.delegateTask(parsed);
                respond(true, result);
            }
            catch (error) {
                safeHandle(respond, "task_delegate_failed", error);
            }
        },
        "multiclaws.task.status": async ({ params, respond }) => {
            try {
                const parsed = taskStatusSchema.parse(params);
                const service = getService();
                const task = service.getTaskStatus(parsed.taskId);
                if (!task) {
                    respond(false, undefined, {
                        code: "not_found",
                        message: `task not found: ${parsed.taskId}`,
                    });
                    return;
                }
                respond(true, { task });
            }
            catch (error) {
                safeHandle(respond, "task_status_failed", error);
            }
        },
        "multiclaws.message.send": async ({ params, respond }) => {
            try {
                const parsed = messageSendSchema.parse(params);
                const service = getService();
                await service.sendDirectMessage({ peerId: parsed.peerId, text: parsed.message });
                respond(true, { delivered: true });
            }
            catch (error) {
                safeHandle(respond, "message_send_failed", error);
            }
        },
        "multiclaws.team.create": async ({ params, respond }) => {
            try {
                const parsed = teamCreateSchema.parse(params);
                const service = getService();
                const result = await service.createTeam(parsed);
                respond(true, result);
            }
            catch (error) {
                safeHandle(respond, "team_create_failed", error);
            }
        },
        "multiclaws.team.join": async ({ params, respond }) => {
            try {
                const parsed = teamJoinSchema.parse(params);
                const service = getService();
                const result = await service.joinTeam(parsed);
                respond(true, result);
            }
            catch (error) {
                safeHandle(respond, "team_join_failed", error);
            }
        },
        "multiclaws.team.members": async ({ params, respond }) => {
            try {
                const parsed = teamMembersSchema.parse(params);
                const service = getService();
                const members = await service.listTeamMembers(parsed.teamId);
                respond(true, { members });
            }
            catch (error) {
                safeHandle(respond, "team_members_failed", error);
            }
        },
        "multiclaws.team.leave": async ({ params, respond }) => {
            try {
                const parsed = teamLeaveSchema.parse(params);
                const service = getService();
                await service.leaveTeam(parsed.teamId);
                respond(true, { left: true });
            }
            catch (error) {
                safeHandle(respond, "team_leave_failed", error);
            }
        },
        "multiclaws.permission.pending": async ({ respond }) => {
            const service = getService();
            const pending = service.getPendingPermissions();
            respond(true, { requests: pending });
        },
        "multiclaws.permission.resolve": async ({ params, respond }) => {
            try {
                const parsed = permissionResolveSchema.parse(params);
                const service = getService();
                const resolved = service.resolvePermission(parsed.requestId, parsed.decision);
                if (!resolved) {
                    respond(false, undefined, {
                        code: "not_found",
                        message: `no pending request with id: ${parsed.requestId}`,
                    });
                    return;
                }
                respond(true, { resolved: true, requestId: parsed.requestId, decision: parsed.decision });
            }
            catch (error) {
                safeHandle(respond, "permission_resolve_failed", error);
            }
        },
        "multiclaws.permission.set": async ({ params, respond }) => {
            try {
                const parsed = permissionSetSchema.parse(params);
                const service = getService();
                await service.setPeerPermissionMode(parsed.peerId, parsed.mode);
                respond(true, { updated: true, mode: parsed.mode });
            }
            catch (error) {
                safeHandle(respond, "permission_set_failed", error);
            }
        },
    };
    return handlers;
}
