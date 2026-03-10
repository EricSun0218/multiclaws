import { z } from "zod";
import type { GatewayRequestHandler } from "../types/openclaw";
import type { MulticlawsService } from "../service/multiclaws-service";

const nonEmptyString = z.string().trim().min(1);

const agentAddSchema = z.object({
  url: nonEmptyString,
  apiKey: z.string().trim().min(1).optional(),
});

const agentRemoveSchema = z.object({ url: nonEmptyString });

const sessionStartSchema = z.object({
  agentUrl: nonEmptyString,
  message: nonEmptyString,
});
const sessionReplySchema = z.object({
  sessionId: nonEmptyString,
  message: nonEmptyString,
});
const sessionStatusSchema = z.object({ sessionId: z.string().trim().min(1).optional() });
const sessionEndSchema = z.object({ sessionId: nonEmptyString });
const sessionWaitAllSchema = z.object({
  sessionIds: z.array(nonEmptyString).min(1),
  timeoutMs: z.number().positive().optional(),
});

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
): Record<string, GatewayRequestHandler> {
  const handlers: Record<string, GatewayRequestHandler> = {
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
      } catch (error) {
        safeHandle(respond, "invalid_params", error);
      }
    },

    "multiclaws.agent.remove": async ({ params, respond }) => {
      try {
        const parsed = agentRemoveSchema.parse(params);
        const service = getService();
        const removed = await service.removeAgent(parsed.url);
        respond(true, { removed });
      } catch (error) {
        safeHandle(respond, "invalid_params", error);
      }
    },

    /* ── Session handlers ───────────────────────────────────────── */

    "multiclaws.session.start": async ({ params, respond }) => {
      try {
        const parsed = sessionStartSchema.parse(params);
        const service = getService();
        const result = await service.startSession(parsed);
        respond(true, result);
      } catch (error) {
        safeHandle(respond, "session_start_failed", error);
      }
    },

    "multiclaws.session.reply": async ({ params, respond }) => {
      try {
        const parsed = sessionReplySchema.parse(params);
        const service = getService();
        const result = await service.sendSessionMessage(parsed);
        respond(true, result);
      } catch (error) {
        safeHandle(respond, "session_reply_failed", error);
      }
    },

    "multiclaws.session.status": async ({ params, respond }) => {
      try {
        const parsed = sessionStatusSchema.parse(params);
        const service = getService();
        if (parsed.sessionId) {
          const session = service.getSession(parsed.sessionId);
          if (!session) {
            respond(false, undefined, { code: "not_found", message: `session not found: ${parsed.sessionId}` });
            return;
          }
          respond(true, session);
        } else {
          const sessions = service.listSessions();
          respond(true, { sessions });
        }
      } catch (error) {
        safeHandle(respond, "session_status_failed", error);
      }
    },

    "multiclaws.session.wait_all": async ({ params, respond }) => {
      try {
        const parsed = sessionWaitAllSchema.parse(params);
        const service = getService();
        const result = await service.waitForSessions(parsed);
        respond(true, result);
      } catch (error) {
        safeHandle(respond, "session_wait_all_failed", error);
      }
    },

    "multiclaws.session.end": async ({ params, respond }) => {
      try {
        const parsed = sessionEndSchema.parse(params);
        const service = getService();
        const ok = service.endSession(parsed.sessionId);
        respond(true, { ended: ok });
      } catch (error) {
        safeHandle(respond, "session_end_failed", error);
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
      } catch (error) {
        safeHandle(respond, "team_create_failed", error);
      }
    },

    "multiclaws.team.join": async ({ params, respond }) => {
      try {
        const parsed = teamJoinSchema.parse(params);
        const service = getService();
        const team = await service.joinTeam(parsed.inviteCode);
        respond(true, { team });
      } catch (error) {
        safeHandle(respond, "team_join_failed", error);
      }
    },

    "multiclaws.team.leave": async ({ params, respond }) => {
      try {
        const parsed = teamLeaveSchema.parse(params);
        const service = getService();
        await service.leaveTeam(parsed.teamId || undefined);
        respond(true, { left: true });
      } catch (error) {
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
      } catch (error) {
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
      } catch (error) {
        safeHandle(respond, "profile_set_failed", error);
      }
    },

  };

  return handlers;
}
