export type PermissionMode = "prompt" | "allow-all" | "blocked";
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
