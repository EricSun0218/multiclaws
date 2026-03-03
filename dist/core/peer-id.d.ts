export type PeerId = string;
export type PeerIdentity = {
    peerId: PeerId;
    displayName: string;
    networkHint?: string;
    publicKey: string;
    gatewayVersion: string;
    multiclawsProtocol: string;
};
export declare function loadOrCreateIdentity(params?: {
    stateDir?: string;
    displayName?: string;
    networkHint?: string;
    gatewayVersion?: string;
}): Promise<{
    identity: PeerIdentity;
    privateKeyPem: string;
}>;
export declare function signPayload(privateKeyPem: string, payload: string): string;
export declare function verifyPayload(publicKeyPem: string, payload: string, signatureBase64: string): boolean;
export declare function buildHandshakePayload(params: {
    peerId: string;
    nonce: string;
    ackNonce?: string;
    tsMs: number;
}): string;
export declare function randomNonce(size?: number): string;
