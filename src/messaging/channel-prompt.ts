import type {
  OpenClawPluginApi,
  PluginHookMessageContext,
  PluginHookMessageEvent,
  PluginRuntimeChannelSend,
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

type ChannelSender = (
  channelSend: PluginRuntimeChannelSend,
  route: ApprovalRoute,
  text: string,
) => Promise<void>;

function accountIdOpt(route: ApprovalRoute): { accountId: string } | Record<string, never> {
  return route.accountId ? { accountId: route.accountId } : {};
}

const channelSenders: Record<string, ChannelSender> = {
  telegram: async (ch, route, text) => {
    if (!ch.telegram) throw new Error("telegram channel send API unavailable");
    const messageThreadId =
      typeof route.threadId === "number"
        ? route.threadId
        : typeof route.threadId === "string" && /^\d+$/.test(route.threadId)
          ? Number(route.threadId)
          : undefined;
    await ch.telegram.sendMessageTelegram(route.conversationId, text, {
      ...accountIdOpt(route),
      ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    });
  },
  whatsapp: async (ch, route, text) => {
    if (!ch.whatsapp) throw new Error("whatsapp channel send API unavailable");
    await ch.whatsapp.sendMessageWhatsApp(route.conversationId, text, {
      verbose: false,
      ...accountIdOpt(route),
    });
  },
  signal: async (ch, route, text) => {
    if (!ch.signal) throw new Error("signal channel send API unavailable");
    await ch.signal.sendMessageSignal(route.conversationId, text, { ...accountIdOpt(route) });
  },
  imessage: async (ch, route, text) => {
    if (!ch.imessage) throw new Error("imessage channel send API unavailable");
    await ch.imessage.sendMessageIMessage(route.conversationId, text, { ...accountIdOpt(route) });
  },
  line: async (ch, route, text) => {
    if (!ch.line) throw new Error("line channel send API unavailable");
    await ch.line.sendMessageLine(route.conversationId, text, {
      verbose: false,
      ...accountIdOpt(route),
    });
  },
  slack: async (ch, route, text) => {
    if (!ch.slack) throw new Error("slack channel send API unavailable");
    const threadTs =
      typeof route.threadId === "string"
        ? route.threadId
        : typeof route.threadId === "number"
          ? String(route.threadId)
          : undefined;
    await ch.slack.sendMessageSlack(route.conversationId, text, {
      ...accountIdOpt(route),
      ...(threadTs ? { threadTs } : {}),
    });
  },
  discord: async (ch, route, text) => {
    if (!ch.discord) throw new Error("discord channel send API unavailable");
    await ch.discord.sendMessageDiscord(route.conversationId, text, { ...accountIdOpt(route) });
  },
};

// Silent channels — no server-side push available
const silentChannels = new Set(["webchat", "web"]);

export async function sendChannelText(params: {
  runtime: OpenClawPluginApi["runtime"];
  route: ApprovalRoute;
  text: string;
}): Promise<void> {
  const channelSend = params.runtime?.channel;
  if (!channelSend) {
    throw new Error("plugin runtime channel API unavailable");
  }
  const { route, text } = params;

  if (silentChannels.has(route.channelId)) {
    return;
  }

  const sender = channelSenders[route.channelId];
  if (!sender) {
    throw new Error(`unsupported channel for approval prompt: ${route.channelId}`);
  }

  await sender(channelSend, route, text);
}

export const sendApprovalPrompt = sendChannelText;
