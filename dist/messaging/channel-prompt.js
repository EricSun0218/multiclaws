"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendApprovalPrompt = exports.ApprovalRouteStore = void 0;
exports.routeFromInbound = routeFromInbound;
exports.sendChannelText = sendChannelText;
function asString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asThreadId(value) {
    if (typeof value === "string" && value.trim()) {
        return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    return undefined;
}
function routeFromInbound(event, ctx) {
    const channelId = ctx.channelId?.trim().toLowerCase();
    if (!channelId) {
        return null;
    }
    const metadata = (event.metadata ?? {});
    const conversationId = asString(ctx.conversationId) ?? asString(metadata.originatingTo) ?? asString(metadata.to) ??
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
class ApprovalRouteStore {
    latestRoute = null;
    update(route) {
        if (!route) {
            return;
        }
        this.latestRoute = route;
    }
    getLatest() {
        return this.latestRoute;
    }
}
exports.ApprovalRouteStore = ApprovalRouteStore;
function accountIdOpt(route) {
    return route.accountId ? { accountId: route.accountId } : {};
}
const channelSenders = {
    telegram: async (ch, route, text) => {
        if (!ch.telegram)
            throw new Error("telegram channel send API unavailable");
        const messageThreadId = typeof route.threadId === "number"
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
        if (!ch.whatsapp)
            throw new Error("whatsapp channel send API unavailable");
        await ch.whatsapp.sendMessageWhatsApp(route.conversationId, text, {
            verbose: false,
            ...accountIdOpt(route),
        });
    },
    signal: async (ch, route, text) => {
        if (!ch.signal)
            throw new Error("signal channel send API unavailable");
        await ch.signal.sendMessageSignal(route.conversationId, text, { ...accountIdOpt(route) });
    },
    imessage: async (ch, route, text) => {
        if (!ch.imessage)
            throw new Error("imessage channel send API unavailable");
        await ch.imessage.sendMessageIMessage(route.conversationId, text, { ...accountIdOpt(route) });
    },
    line: async (ch, route, text) => {
        if (!ch.line)
            throw new Error("line channel send API unavailable");
        await ch.line.sendMessageLine(route.conversationId, text, {
            verbose: false,
            ...accountIdOpt(route),
        });
    },
    slack: async (ch, route, text) => {
        if (!ch.slack)
            throw new Error("slack channel send API unavailable");
        const threadTs = typeof route.threadId === "string"
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
        if (!ch.discord)
            throw new Error("discord channel send API unavailable");
        await ch.discord.sendMessageDiscord(route.conversationId, text, { ...accountIdOpt(route) });
    },
};
// Silent channels — no server-side push available
const silentChannels = new Set(["webchat", "web"]);
async function sendChannelText(params) {
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
exports.sendApprovalPrompt = sendChannelText;
