import type { OpenClawPluginApi, PluginHookMessageContext, PluginHookMessageEvent } from "../types/openclaw";
export type ApprovalRoute = {
    channelId: string;
    accountId?: string;
    conversationId: string;
    threadId?: string | number;
    lastSeenAtMs: number;
};
export declare function routeFromInbound(event: PluginHookMessageEvent, ctx: PluginHookMessageContext): ApprovalRoute | null;
export declare class ApprovalRouteStore {
    private latestRoute;
    update(route: ApprovalRoute | null): void;
    getLatest(): ApprovalRoute | null;
}
export declare function sendChannelText(params: {
    runtime: OpenClawPluginApi["runtime"];
    route: ApprovalRoute;
    text: string;
}): Promise<void>;
export declare const sendApprovalPrompt: typeof sendChannelText;
