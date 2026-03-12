import { z } from "zod";
import type { GatewayRequestHandler } from "../types/openclaw";
import type { MulticlawsService } from "../service/multiclaws-service";
import type { BasicLogger } from "../infra/logger";

const nonEmptyString = z.string().trim().min(1);

const agentAddSchema = z.object({
  url: nonEmptyString,
  apiKey: z.string().trim().min(1).optional(),
});

const agentRemoveSchema = z.object({ url: nonEmptyString });

const taskDelegateSchema = z.object({
  agentUrl: nonEmptyString,
  task: nonEmptyString,
});
const taskStatusSchema = z.object({ taskId: nonEmptyString });

const profileSetSchema = z.object({
  ownerName: z.string().trim().optional(),
  bio: z.string().optional(),
});

const teamCreateSchema = z.object({ name: nonEmptyString });
const teamJoinSchema = z.object({ inviteCode: nonEmptyString });
const teamLeaveSchema = z.object({ teamId: z.string().trim().min(1).optional() });
const teamMembersSchema = z.object({ teamId: z.string().trim().min(1).optional() });

function safeHandle(
  respond: Parameters<GatewayRequestHandler>[0]["respond"],
  code: string,
  error: unknown,
): void {
  respond(false, undefined, {
    code,
    message: error instanceof Error ? error.message : String(error),
  });
}

export function createGatewayHandlers(
  getService: () => MulticlawsService,
  logger?: BasicLogger,
): Record<string, GatewayRequestHandler> {
  const log = (level: "info" | "warn" | "error" | "debug", msg: string) => {
    const fn = level === "debug" ? logger?.debug : logger?.[level];
    fn?.(`[multiclaws:gw] ${msg}`);
  };

  const handlers: Record<string, GatewayRequestHandler> = {
    /* ── Agent handlers ─────────────────────────────────────────── */

    "multiclaws.agent.list": async ({ respond }) => {
      log("debug", "agent.list");
      try {
        const service = getService();
        const agents = await service.listAgents();
        respond(true, { agents });
      } catch (error) {
        log("error", `agent.list failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "agent_list_failed", error);
      }
    },

    "multiclaws.agent.add": async ({ params, respond }) => {
      log("debug", `agent.add(url=${(params as Record<string, unknown>)?.url})`);
      try {
        const parsed = agentAddSchema.parse(params);
        const service = getService();
        const agent = await service.addAgent(parsed);
        respond(true, agent);
      } catch (error) {
        log("error", `agent.add failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "invalid_params", error);
      }
    },

    "multiclaws.agent.remove": async ({ params, respond }) => {
      log("debug", `agent.remove(url=${(params as Record<string, unknown>)?.url})`);
      try {
        const parsed = agentRemoveSchema.parse(params);
        const service = getService();
        const removed = await service.removeAgent(parsed.url);
        respond(true, { removed });
      } catch (error) {
        log("error", `agent.remove failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "invalid_params", error);
      }
    },

    /* ── Task handlers ──────────────────────────────────────────── */

    "multiclaws.task.delegate": async ({ params, respond }) => {
      log("debug", `task.delegate(agentUrl=${(params as Record<string, unknown>)?.agentUrl})`);
      try {
        const parsed = taskDelegateSchema.parse(params);
        const service = getService();
        const result = await service.delegateTask(parsed);
        respond(true, result);
      } catch (error) {
        log("error", `task.delegate failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "task_delegate_failed", error);
      }
    },

    "multiclaws.task.status": async ({ params, respond }) => {
      log("debug", `task.status(taskId=${(params as Record<string, unknown>)?.taskId})`);
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
      } catch (error) {
        log("error", `task.status failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "task_status_failed", error);
      }
    },

    /* ── Team handlers ──────────────────────────────────────────── */

    "multiclaws.team.create": async ({ params, respond }) => {
      log("debug", `team.create(name=${(params as Record<string, unknown>)?.name})`);
      try {
        const parsed = teamCreateSchema.parse(params);
        const service = getService();
        const team = await service.createTeam(parsed.name);
        const invite = await service.createInvite(team.teamId);
        respond(true, { team, inviteCode: invite });
      } catch (error) {
        log("error", `team.create failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "team_create_failed", error);
      }
    },

    "multiclaws.team.join": async ({ params, respond }) => {
      log("debug", "team.join");
      try {
        const parsed = teamJoinSchema.parse(params);
        const service = getService();
        const team = await service.joinTeam(parsed.inviteCode);
        respond(true, { team });
      } catch (error) {
        log("error", `team.join failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "team_join_failed", error);
      }
    },

    "multiclaws.team.leave": async ({ params, respond }) => {
      log("debug", "team.leave");
      try {
        const parsed = teamLeaveSchema.parse(params);
        const service = getService();
        await service.leaveTeam(parsed.teamId || undefined);
        respond(true, { left: true });
      } catch (error) {
        log("error", `team.leave failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "team_leave_failed", error);
      }
    },

    "multiclaws.team.members": async ({ params, respond }) => {
      log("debug", `team.members(teamId=${(params as Record<string, unknown>)?.teamId})`);
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
      } catch (error) {
        log("error", `team.members failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "team_members_failed", error);
      }
    },

    /* ── Profile handlers ───────────────────────────────────────── */

    "multiclaws.profile.show": async ({ respond }) => {
      log("debug", "profile.show");
      try {
        const service = getService();
        const profile = await service.getProfile();
        respond(true, profile);
      } catch (error) {
        log("error", `profile.show failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "profile_show_failed", error);
      }
    },

    "multiclaws.profile.pending_review": async ({ respond }) => {
      log("debug", "profile.pending_review");
      try {
        const service = getService();
        const result = await service.getPendingProfileReview();
        respond(true, result);
      } catch (error) {
        log("error", `profile.pending_review failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "profile_pending_review_failed", error);
      }
    },

    "multiclaws.profile.clear_pending_review": async ({ respond }) => {
      log("debug", "profile.clear_pending_review");
      try {
        const service = getService();
        await service.clearPendingProfileReview();
        respond(true, { cleared: true });
      } catch (error) {
        log("error", `profile.clear_pending_review failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "profile_clear_pending_review_failed", error);
      }
    },

    "multiclaws.profile.set": async ({ params, respond }) => {
      log("debug", "profile.set");
      try {
        const parsed = profileSetSchema.parse(params);
        const service = getService();
        const profile = await service.setProfile(parsed);
        respond(true, profile);
      } catch (error) {
        log("error", `profile.set failed: ${error instanceof Error ? error.message : String(error)}`);
        safeHandle(respond, "profile_set_failed", error);
      }
    },

  };

  return handlers;
}
