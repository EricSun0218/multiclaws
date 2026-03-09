"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGatewayHandlers = createGatewayHandlers;
const zod_1 = require("zod");
const nonEmptyString = zod_1.z.string().trim().min(1);
const agentAddSchema = zod_1.z.object({
    url: nonEmptyString,
    apiKey: zod_1.z.string().trim().min(1).optional(),
});
const agentRemoveSchema = zod_1.z.object({ url: nonEmptyString });
const taskDelegateSchema = zod_1.z.object({
    agentUrl: nonEmptyString,
    task: nonEmptyString,
});
const taskStatusSchema = zod_1.z.object({ taskId: nonEmptyString });
const profileSetSchema = zod_1.z.object({
    ownerName: zod_1.z.string().trim().optional(),
    bio: zod_1.z.string().optional(),
});
const teamCreateSchema = zod_1.z.object({ name: nonEmptyString });
const teamInviteSchema = zod_1.z.object({ teamId: zod_1.z.string().trim().min(1).optional() });
const teamJoinSchema = zod_1.z.object({ inviteCode: nonEmptyString });
const teamLeaveSchema = zod_1.z.object({ teamId: zod_1.z.string().trim().min(1).optional() });
const teamMembersSchema = zod_1.z.object({ teamId: zod_1.z.string().trim().min(1).optional() });
function safeHandle(respond, code, error) {
    respond(false, undefined, {
        code,
        message: error instanceof Error ? error.message : String(error),
    });
}
function createGatewayHandlers(getService) {
    const handlers = {
        /* ── Agent handlers ─────────────────────────────────────────── */
        "multiclaws.agent.list": async ({ respond }) => {
            const service = getService();
            const agents = await service.listAgents();
            respond(true, { agents });
        },
        "multiclaws.agent.add": async ({ params, respond }) => {
            try {
                const parsed = agentAddSchema.parse(params);
                const service = getService();
                const agent = await service.addAgent(parsed);
                respond(true, agent);
            }
            catch (error) {
                safeHandle(respond, "invalid_params", error);
            }
        },
        "multiclaws.agent.remove": async ({ params, respond }) => {
            try {
                const parsed = agentRemoveSchema.parse(params);
                const service = getService();
                const removed = await service.removeAgent(parsed.url);
                respond(true, { removed });
            }
            catch (error) {
                safeHandle(respond, "invalid_params", error);
            }
        },
        /* ── Task handlers ──────────────────────────────────────────── */
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
        /* ── Team handlers ──────────────────────────────────────────── */
        "multiclaws.team.create": async ({ params, respond }) => {
            try {
                const parsed = teamCreateSchema.parse(params);
                const service = getService();
                const team = await service.createTeam(parsed.name);
                const invite = await service.createInvite(team.teamId);
                respond(true, { team, inviteCode: invite });
            }
            catch (error) {
                safeHandle(respond, "team_create_failed", error);
            }
        },
        "multiclaws.team.invite": async ({ params, respond }) => {
            try {
                const parsed = teamInviteSchema.parse(params);
                const service = getService();
                const invite = await service.createInvite(parsed.teamId || undefined);
                respond(true, { inviteCode: invite });
            }
            catch (error) {
                safeHandle(respond, "team_invite_failed", error);
            }
        },
        "multiclaws.team.join": async ({ params, respond }) => {
            try {
                const parsed = teamJoinSchema.parse(params);
                const service = getService();
                const team = await service.joinTeam(parsed.inviteCode);
                respond(true, { team });
            }
            catch (error) {
                safeHandle(respond, "team_join_failed", error);
            }
        },
        "multiclaws.team.leave": async ({ params, respond }) => {
            try {
                const parsed = teamLeaveSchema.parse(params);
                const service = getService();
                await service.leaveTeam(parsed.teamId || undefined);
                respond(true, { left: true });
            }
            catch (error) {
                safeHandle(respond, "team_leave_failed", error);
            }
        },
        "multiclaws.team.members": async ({ params, respond }) => {
            try {
                const parsed = teamMembersSchema.parse(params);
                const service = getService();
                const result = await service.listTeamMembers(parsed.teamId || undefined);
                if (!result) {
                    respond(false, undefined, {
                        code: "not_found",
                        message: "no team found",
                    });
                    return;
                }
                respond(true, result);
            }
            catch (error) {
                safeHandle(respond, "team_members_failed", error);
            }
        },
        /* ── Profile handlers ───────────────────────────────────────── */
        "multiclaws.profile.show": async ({ respond }) => {
            const service = getService();
            const profile = await service.getProfile();
            respond(true, profile);
        },
        "multiclaws.profile.pending_review": async ({ respond }) => {
            const service = getService();
            const result = await service.getPendingProfileReview();
            respond(true, result);
        },
        "multiclaws.profile.clear_pending_review": async ({ respond }) => {
            const service = getService();
            await service.clearPendingProfileReview();
            respond(true, { cleared: true });
        },
        "multiclaws.profile.set": async ({ params, respond }) => {
            try {
                const parsed = profileSetSchema.parse(params);
                const service = getService();
                const profile = await service.setProfile(parsed);
                respond(true, profile);
            }
            catch (error) {
                safeHandle(respond, "profile_set_failed", error);
            }
        },
    };
    return handlers;
}
