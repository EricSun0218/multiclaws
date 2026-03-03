export type DirectMessagePayload = {
  fromPeerId: string;
  fromDisplayName: string;
  text: string;
  sentAtMs: number;
};

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
