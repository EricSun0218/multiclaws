export type GatewayRespond = (ok: boolean, payload?: unknown, error?: {
    code?: string;
    message?: string;
    details?: unknown;
}) => void;
export type GatewayRequestHandler = (opts: {
    params: Record<string, unknown>;
    respond: GatewayRespond;
}) => void | Promise<void>;
export type PluginServiceContext = {
    stateDir: string;
    logger: {
        info: (message: string) => void;
        warn: (message: string) => void;
        error: (message: string) => void;
        debug?: (message: string) => void;
    };
};
export type PluginService = {
    id: string;
    start: (ctx: PluginServiceContext) => void | Promise<void>;
    stop?: (ctx?: PluginServiceContext) => void | Promise<void>;
};
export type PluginHookMessageContext = {
    channelId: string;
    accountId?: string;
    conversationId?: string;
};
export type PluginHookMessageEvent = {
    from: string;
    content: string;
    timestamp?: number;
    metadata?: Record<string, unknown>;
};
export type PluginHookGatewayStartEvent = {
    port: number;
};
export type PluginHookGatewayStopEvent = {
    reason?: string;
};
export type PluginHookAgentContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    channelId?: string;
    trigger?: string;
};
export type PluginHookBeforePromptBuildEvent = {
    prompt: string;
    messages: unknown[];
};
export type PluginHookBeforePromptBuildResult = {
    systemPrompt?: string;
    prependContext?: string;
    prependSystemContext?: string;
    appendSystemContext?: string;
};
export type PluginTool = {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, args: Record<string, unknown>) => Promise<{
        content: Array<{
            type: "text";
            text: string;
        }>;
        details?: unknown;
    }>;
};
export type OpenClawGatewayConfig = {
    port?: number;
    auth?: {
        mode?: string;
        token?: string;
        password?: string;
    };
};
export type OpenClawPluginApi = {
    config?: {
        plugins?: Record<string, unknown>;
        gateway?: OpenClawGatewayConfig;
        [key: string]: unknown;
    };
    pluginConfig?: Record<string, unknown>;
    logger: {
        info: (message: string) => void;
        warn: (message: string) => void;
        error: (message: string) => void;
        debug?: (message: string) => void;
    };
    registerService: (service: PluginService) => void;
    registerGatewayMethod: (method: string, handler: GatewayRequestHandler) => void;
    registerTool: (tool: PluginTool) => void;
    registerHttpRoute: (route: {
        path: string;
        auth?: "plugin" | "gateway";
        handler: (req: unknown, res: {
            statusCode: number;
            end: (body?: string) => void;
        }) => void;
    }) => void;
    on: {
        (name: "message_received", handler: (event: PluginHookMessageEvent, ctx: PluginHookMessageContext) => void | Promise<void>): void;
        (name: "gateway_start", handler: (event: PluginHookGatewayStartEvent) => void | Promise<void>): void;
        (name: "gateway_stop", handler: (event: PluginHookGatewayStopEvent) => void | Promise<void>): void;
        (name: "before_prompt_build", handler: (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => PluginHookBeforePromptBuildResult | void | Promise<PluginHookBeforePromptBuildResult | void>): void;
    };
};
