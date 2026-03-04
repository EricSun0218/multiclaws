"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendApprovalPrompt = exports.ApprovalRouteStore = void 0;
exports.routeFromInbound = routeFromInbound;
exports.sendChannelText = sendChannelText;
exports.deliverApprovalPrompt = deliverApprovalPrompt;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const gateway_client_1 = require("../utils/gateway-client");
// Route persisted to disk expires after 24 hours
const ROUTE_TTL_MS = 24 * 60 * 60 * 1000;
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
/**
 * Persistent route store — survives gateway restarts.
 * Routes older than ROUTE_TTL_MS are discarded on load.
 */
class ApprovalRouteStore {
    latestRoute = null;
    filePath;
    constructor(stateDir) {
        this.filePath = stateDir ? node_path_1.default.join(stateDir, "route.json") : null;
        if (this.filePath) {
            this.latestRoute = this.loadFromDisk();
        }
    }
    loadFromDisk() {
        if (!this.filePath)
            return null;
        try {
            const raw = node_fs_1.default.readFileSync(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed &&
                typeof parsed.channelId === "string" &&
                typeof parsed.conversationId === "string" &&
                typeof parsed.lastSeenAtMs === "number" &&
                Date.now() - parsed.lastSeenAtMs < ROUTE_TTL_MS) {
                return parsed;
            }
        }
        catch {
            // file missing or invalid — start fresh
        }
        return null;
    }
    saveToDisk(route) {
        if (!this.filePath)
            return;
        try {
            const dir = node_path_1.default.dirname(this.filePath);
            node_fs_1.default.mkdirSync(dir, { recursive: true });
            node_fs_1.default.writeFileSync(this.filePath, JSON.stringify(route, null, 2), "utf8");
        }
        catch {
            // best-effort
        }
    }
    update(route) {
        if (!route)
            return;
        this.latestRoute = route;
        this.saveToDisk(route);
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
async function sendChannelText(params) {
    const channelSend = params.runtime?.channel;
    if (!channelSend) {
        throw new Error("plugin runtime channel API unavailable");
    }
    const { route, text } = params;
    const sender = channelSenders[route.channelId];
    if (!sender) {
        throw new Error(`unsupported channel for approval prompt: ${route.channelId}`);
    }
    await sender(channelSend, route, text);
}
/**
 * Deliver an approval prompt using the best available method.
 *
 * Strategy — automatically adapts to whichever channel the user is active on:
 *
 * 1. Direct channel push — for channels with a registered sender
 *    (Telegram, Discord, WhatsApp, Slack, Signal, iMessage, LINE).
 *    Uses the most recently active route so the message reaches the
 *    channel the user is actually using right now.
 *
 * 2. Gateway session inject — for channels without a server-side push
 *    API (webchat, terminal/CLI, or any unrecognised channel).
 *    Calls sessions_send → main session → AI relays to ALL currently
 *    connected clients (webchat tab AND terminal simultaneously).
 *
 * 3. Disk fallback — if every delivery method fails, writes to
 *    pending-approvals.json so the request is never silently lost.
 */
async function deliverApprovalPrompt(params) {
    const { route, gatewayConfig, stateDir, text, requestId, logger, runtime } = params;
    // ── Step 1: direct channel push ───────────────────────────────────
    // Only attempt if we have a route AND a registered sender for that channel.
    // Channels without a sender (webchat, cli, terminal…) fall through automatically.
    if (route && channelSenders[route.channelId]) {
        try {
            await sendChannelText({ runtime, route, text });
            logger.info(`[multiclaws] approval prompt delivered via channel: ${route.channelId}`);
            return;
        }
        catch (err) {
            logger.warn(`[multiclaws] channel push failed (${route.channelId}): ${String(err)}`);
            // fall through to step 2
        }
    }
    // ── Step 2: gateway session inject (webchat + terminal + fallback) ─
    // sessions_send injects a message into the main AI session.
    // The AI's response is broadcast to ALL active clients for that
    // session — webchat tabs, CLI sessions, etc. — so the user sees it
    // regardless of which interface they are currently using.
    if (gatewayConfig) {
        try {
            await (0, gateway_client_1.invokeGatewayTool)({
                gateway: gatewayConfig,
                tool: "sessions_send",
                args: {
                    sessionKey: "main",
                    message: text,
                },
                timeoutMs: 8_000,
            });
            logger.info(`[multiclaws] approval prompt delivered via sessions_send (channel: ${route?.channelId ?? "unknown"})`);
            return;
        }
        catch (err) {
            logger.warn(`[multiclaws] sessions_send failed: ${String(err)}`);
            // fall through to step 3
        }
    }
    // ── Step 3: disk fallback ─────────────────────────────────────────
    // Last resort — write to disk so the request is never silently lost.
    logger.warn(`[multiclaws] ⚠️ all delivery methods failed — writing to pending-approvals.json`);
    try {
        const filePath = node_path_1.default.join(stateDir, "multiclaws", "pending-approvals.json");
        let existing = [];
        try {
            existing = JSON.parse(node_fs_1.default.readFileSync(filePath, "utf8"));
        }
        catch {
            // start fresh
        }
        existing.push({ requestId, text, savedAtMs: Date.now() });
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(filePath), { recursive: true });
        node_fs_1.default.writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf8");
    }
    catch (err) {
        logger.warn(`[multiclaws] disk fallback also failed: ${String(err)}`);
    }
}
exports.sendApprovalPrompt = sendChannelText;
