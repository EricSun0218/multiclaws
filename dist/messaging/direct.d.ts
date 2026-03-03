export type DirectMessagePayload = {
    fromPeerId: string;
    fromDisplayName: string;
    text: string;
    sentAtMs: number;
};
export declare function formatPermissionPrompt(params: {
    requestId: string;
    peerDisplayName: string;
    action: string;
    context: string;
}): string;
