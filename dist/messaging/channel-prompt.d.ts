import type { OpenClawPluginApi, PluginHookMessageContext, PluginHookMessageEvent } from "../types/openclaw";
import { type GatewayConfig } from "../utils/gateway-client";
export type ApprovalRoute = {
    channelId: string;
    accountId?: string;
    conversationId: string;
    threadId?: string | number;
    lastSeenAtMs: number;
};
export declare function routeFromInbound(event: PluginHookMessageEvent, ctx: PluginHookMessageContext): ApprovalRoute | null;
/**
 * Persistent route store — survives gateway restarts.
 * Routes older than ROUTE_TTL_MS are discarded on load.
 */
export declare class ApprovalRouteStore {
    private latestRoute;
    private readonly filePath;
    constructor(stateDir?: string);
    private loadFromDisk;
    private saveToDisk;
    update(route: ApprovalRoute | null): void;
    getLatest(): ApprovalRoute | null;
}
export declare function sendChannelText(params: {
    runtime: OpenClawPluginApi["runtime"];
    route: ApprovalRoute;
    text: string;
}): Promise<void>;
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
export declare function deliverApprovalPrompt(params: {
    runtime: OpenClawPluginApi["runtime"];
    route: ApprovalRoute | null;
    gatewayConfig: GatewayConfig | null;
    stateDir: string;
    text: string;
    requestId: string;
    logger: {
        warn: (msg: string) => void;
        info: (msg: string) => void;
    };
}): Promise<void>;
export declare const sendApprovalPrompt: typeof sendChannelText;
