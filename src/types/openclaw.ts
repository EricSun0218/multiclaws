export type GatewayRespond = (
  ok: boolean,
  payload?: unknown,
  error?: { code?: string; message?: string; details?: unknown },
) => void;

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
  stop?: (ctx: PluginServiceContext) => void | Promise<void>;
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

export type PluginTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
};

export type OpenClawPluginApi = {
  config?: { plugins?: Record<string, unknown> };
  pluginConfig?: Record<string, unknown>;
  runtime?: {
    channel: {
      telegram: {
        sendMessageTelegram: (
          to: string,
          text: string,
          opts?: { accountId?: string; messageThreadId?: number },
        ) => Promise<unknown>;
      };
      whatsapp: {
        sendMessageWhatsApp: (
          to: string,
          text: string,
          opts: { verbose: boolean; accountId?: string },
        ) => Promise<unknown>;
      };
      signal: {
        sendMessageSignal: (
          to: string,
          text: string,
          opts?: { accountId?: string },
        ) => Promise<unknown>;
      };
      imessage: {
        sendMessageIMessage: (
          to: string,
          text: string,
          opts?: { accountId?: string },
        ) => Promise<unknown>;
      };
      line: {
        sendMessageLine: (
          to: string,
          text: string,
          opts?: { accountId?: string; verbose?: boolean },
        ) => Promise<unknown>;
      };
      slack: {
        sendMessageSlack: (
          to: string,
          text: string,
          opts?: { accountId?: string; threadTs?: string },
        ) => Promise<unknown>;
      };
      discord: {
        sendMessageDiscord: (
          to: string,
          text: string,
          opts?: { accountId?: string },
        ) => Promise<unknown>;
      };
    };
  };
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
    handler: (req: unknown, res: { statusCode: number; end: (body?: string) => void }) => void;
  }) => void;
  on: <K extends "message_received" | "gateway_start" | "gateway_stop">(
    name: K,
    handler: K extends "message_received"
      ? (event: PluginHookMessageEvent, ctx: PluginHookMessageContext) => void | Promise<void>
      : K extends "gateway_start"
        ? (event: PluginHookGatewayStartEvent) => void | Promise<void>
        : (event: PluginHookGatewayStopEvent) => void | Promise<void>,
  ) => void;
};
