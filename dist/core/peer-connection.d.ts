import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { type PeerIdentity } from "./peer-id";
import type { MulticlawsFrame } from "../protocol/types";
export type PeerConnectionState = "idle" | "connecting" | "handshaking" | "ready" | "closed";
export type PeerConnectionOptions = {
    localIdentity: PeerIdentity;
    privateKeyPem: string;
    expectedPeerId?: string;
    expectedPeerPublicKey?: string;
    logger?: {
        info?: (message: string) => void;
        warn?: (message: string) => void;
        error?: (message: string) => void;
        debug?: (message: string) => void;
    };
};
export declare class PeerConnection extends EventEmitter {
    private readonly options;
    private socket;
    private state;
    private remoteIdentity;
    private heartbeatTimer;
    private connectUrl;
    private reconnectTimer;
    private reconnectAttempt;
    private localNonce;
    private lastPingTs;
    private closedByUser;
    constructor(options: PeerConnectionOptions);
    get peerId(): string | null;
    get peerIdentity(): PeerIdentity | null;
    get currentState(): PeerConnectionState;
    connect(url: string): Promise<void>;
    attach(socket: WebSocket): Promise<void>;
    close(): void;
    send(frame: MulticlawsFrame): boolean;
    private openSocket;
    private scheduleReconnect;
    private sendHandshake;
    private handleFrame;
    private verifyHandshake;
    private verifyHandshakeAck;
    private validatePeerIdentity;
    private markReady;
    private startHeartbeat;
    private stopHeartbeat;
    private log;
}
