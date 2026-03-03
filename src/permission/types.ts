export type PermissionMode = "prompt" | "allow-all" | "blocked";

export function formatPermissionPrompt(params: {
  requestId: string;
  peerDisplayName: string;
  action: string;
  context: string;
}): string {
  return [
    `[协作请求] ${params.peerDisplayName} 请求执行: ${params.action}`,
    `上下文: ${params.context}`,
    `请求ID: ${params.requestId}`,
    "回复方式:",
    `  /mc allow ${params.requestId} once`,
    `  /mc allow ${params.requestId} permanent`,
    `  /mc deny ${params.requestId}`,
  ].join("\n");
}
export type PermissionDecision = "allow-once" | "allow-permanently" | "deny";

export type PeerPermissionRecord = {
  peerId: string;
  mode: PermissionMode;
  updatedAtMs: number;
};

export type PermissionRequest = {
  requestId: string;
  peerId: string;
  peerDisplayName: string;
  action: string;
  context: string;
  createdAtMs: number;
  expiresAtMs: number;
  channelId?: string;
  conversationId?: string;
};

export type PermissionPromptMessage = {
  requestId: string;
  peerDisplayName: string;
  action: string;
  context: string;
};
