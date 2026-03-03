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
async function sendChannelText(params) {
    const runtime = params.runtime;
    const channelSend = runtime?.channel;
    if (!channelSend) {
        throw new Error("plugin runtime channel API unavailable");
    }
    const route = params.route;
    const text = params.text;
    switch (route.channelId) {
        case "telegram": {
            if (!channelSend.telegram) {
                throw new Error("telegram channel send API unavailable");
            }
            const messageThreadId = typeof route.threadId === "number"
                ? route.threadId
                : typeof route.threadId === "string" && /^\d+$/.test(route.threadId)
                    ? Number(route.threadId)
                    : undefined;
            await channelSend.telegram.sendMessageTelegram(route.conversationId, text, {
                ...(route.accountId ? { accountId: route.accountId } : {}),
                ...(messageThreadId !== undefined ? { messageThreadId } : {}),
            });
            return;
        }
        case "whatsapp": {
            if (!channelSend.whatsapp) {
                throw new Error("whatsapp channel send API unavailable");
            }
            await channelSend.whatsapp.sendMessageWhatsApp(route.conversationId, text, {
                verbose: false,
                ...(route.accountId ? { accountId: route.accountId } : {}),
            });
            return;
        }
        case "signal": {
            if (!channelSend.signal) {
                throw new Error("signal channel send API unavailable");
            }
            await channelSend.signal.sendMessageSignal(route.conversationId, text, {
                ...(route.accountId ? { accountId: route.accountId } : {}),
            });
            return;
        }
        case "imessage": {
            if (!channelSend.imessage) {
                throw new Error("imessage channel send API unavailable");
            }
            await channelSend.imessage.sendMessageIMessage(route.conversationId, text, {
                ...(route.accountId ? { accountId: route.accountId } : {}),
            });
            return;
        }
        case "line": {
            if (!channelSend.line) {
                throw new Error("line channel send API unavailable");
            }
            await channelSend.line.sendMessageLine(route.conversationId, text, {
                verbose: false,
                ...(route.accountId ? { accountId: route.accountId } : {}),
            });
            return;
        }
        case "slack": {
            if (!channelSend.slack) {
                throw new Error("slack channel send API unavailable");
            }
            const threadTs = typeof route.threadId === "string"
                ? route.threadId
                : typeof route.threadId === "number"
                    ? String(route.threadId)
                    : undefined;
            await channelSend.slack.sendMessageSlack(route.conversationId, text, {
                ...(route.accountId ? { accountId: route.accountId } : {}),
                ...(threadTs ? { threadTs } : {}),
            });
            return;
        }
        case "discord": {
            if (!channelSend.discord) {
                throw new Error("discord channel send API unavailable");
            }
            await channelSend.discord.sendMessageDiscord(route.conversationId, text, {
                ...(route.accountId ? { accountId: route.accountId } : {}),
            });
            return;
        }
        case "webchat":
        case "web": {
            // webchat is a local browser UI — no server-side push available; silently skip
            return;
        }
        default:
            // Unknown channel: log a warning instead of throwing, to avoid crashing the service
            // when new channels are added without updating this switch.
            throw new Error(`unsupported channel for approval prompt: ${route.channelId}`);
    }
}
exports.sendApprovalPrompt = sendChannelText;
