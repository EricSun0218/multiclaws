import type {
  OpenClawPluginApi,
  PluginHookMessageContext,
  PluginHookMessageEvent,
} from "../types/openclaw";

export type ApprovalRoute = {
  channelId: string;
  accountId?: string;
  conversationId: string;
  threadId?: string | number;
  lastSeenAtMs: number;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asThreadId(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return undefined;
}

export function routeFromInbound(
  event: PluginHookMessageEvent,
  ctx: PluginHookMessageContext,
): ApprovalRoute | null {
  const channelId = ctx.channelId?.trim().toLowerCase();
  if (!channelId) {
    return null;
  }
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  const conversationId =
    asString(ctx.conversationId) ?? asString(metadata.originatingTo) ?? asString(metadata.to) ??
    asString(event.from);
  if (!conversationId) {
    return null;
  }
  return {
    channelId,
    accountId: asString(ctx.accountId),
    conversationId,
    threadId: asThreadId(metadata.threadId),
    lastSeenAtMs: Date.now(),
  };
}

export class ApprovalRouteStore {
  private latestRoute: ApprovalRoute | null = null;

  update(route: ApprovalRoute | null) {
    if (!route) {
      return;
    }
    this.latestRoute = route;
  }

  getLatest(): ApprovalRoute | null {
    return this.latestRoute;
  }
}

export async function sendChannelText(params: {
  runtime: OpenClawPluginApi["runtime"];
  route: ApprovalRoute;
  text: string;
}): Promise<void> {
  const runtime = params.runtime;
  if (!runtime?.channel) {
    throw new Error("plugin runtime channel API unavailable");
  }
  const route = params.route;
  const text = params.text;

  switch (route.channelId) {
    case "telegram": {
      const messageThreadId =
        typeof route.threadId === "number"
          ? route.threadId
          : typeof route.threadId === "string" && /^\d+$/.test(route.threadId)
            ? Number(route.threadId)
            : undefined;
      await runtime.channel.telegram.sendMessageTelegram(route.conversationId, text, {
        ...(route.accountId ? { accountId: route.accountId } : {}),
        ...(messageThreadId !== undefined ? { messageThreadId } : {}),
      });
      return;
    }
    case "whatsapp": {
      await runtime.channel.whatsapp.sendMessageWhatsApp(route.conversationId, text, {
        verbose: false,
        ...(route.accountId ? { accountId: route.accountId } : {}),
      });
      return;
    }
    case "signal": {
      await runtime.channel.signal.sendMessageSignal(route.conversationId, text, {
        ...(route.accountId ? { accountId: route.accountId } : {}),
      });
      return;
    }
    case "imessage": {
      await runtime.channel.imessage.sendMessageIMessage(route.conversationId, text, {
        ...(route.accountId ? { accountId: route.accountId } : {}),
      });
      return;
    }
    case "line": {
      await runtime.channel.line.sendMessageLine(route.conversationId, text, {
        verbose: false,
        ...(route.accountId ? { accountId: route.accountId } : {}),
      });
      return;
    }
    case "slack": {
      const threadTs =
        typeof route.threadId === "string"
          ? route.threadId
          : typeof route.threadId === "number"
            ? String(route.threadId)
            : undefined;
      await runtime.channel.slack.sendMessageSlack(route.conversationId, text, {
        ...(route.accountId ? { accountId: route.accountId } : {}),
        ...(threadTs ? { threadTs } : {}),
      });
      return;
    }
    case "discord": {
      await runtime.channel.discord.sendMessageDiscord(route.conversationId, text, {
        ...(route.accountId ? { accountId: route.accountId } : {}),
      });
      return;
    }
    default:
      throw new Error(`unsupported channel for approval prompt: ${route.channelId}`);
  }
}

export const sendApprovalPrompt = sendChannelText;
