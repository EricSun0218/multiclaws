import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  buildHandshakePayload,
  randomNonce,
  signPayload,
  verifyPayload,
  type PeerIdentity,
} from "./peer-id";
import { decodeFrame, encodeFrame } from "../protocol/codec";
import type { MulticlawsFrame } from "../protocol/types";

const HANDSHAKE_MAX_SKEW_MS = 60_000;
const HEARTBEAT_MS = 30_000;

export type PeerConnectionState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "ready"
  | "closed";

export type PeerConnectionOptions = {
  localIdentity: PeerIdentity;
  privateKeyPem: string;
  expectedPeerId?: string;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
    debug?: (message: string) => void;
  };
};

export class PeerConnection extends EventEmitter {
  private socket: WebSocket | null = null;
  private state: PeerConnectionState = "idle";
  private remoteIdentity: PeerIdentity | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectUrl: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private localNonce = "";
  private lastPingTs = 0;
  private closedByUser = false;

  constructor(private readonly options: PeerConnectionOptions) {
    super();
  }

  get peerId(): string | null {
    return this.remoteIdentity?.peerId ?? null;
  }

  get peerIdentity(): PeerIdentity | null {
    return this.remoteIdentity;
  }

  get currentState(): PeerConnectionState {
    return this.state;
  }

  async connect(url: string): Promise<void> {
    this.closedByUser = false;
    this.connectUrl = url;
    await this.openSocket(new WebSocket(url), true);
  }

  async attach(socket: WebSocket): Promise<void> {
    this.closedByUser = false;
    await this.openSocket(socket, false);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, "closed-by-user");
    }
    this.state = "closed";
  }

  send(frame: MulticlawsFrame): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(encodeFrame(frame));
    return true;
  }

  private async openSocket(socket: WebSocket, outgoing: boolean): Promise<void> {
    this.socket = socket;
    this.state = outgoing ? "connecting" : "handshaking";

    socket.on("open", () => {
      this.state = "handshaking";
      if (outgoing) {
        this.sendHandshake();
      }
    });

    socket.on("message", (data) => {
      const raw = typeof data === "string"
        ? data
        : (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)).toString("utf8");
      const frame = decodeFrame(raw);
      if (!frame) {
        this.log("warn", "received invalid multiclaws frame");
        return;
      }
      this.handleFrame(frame, outgoing);
    });

    socket.on("error", (error) => {
      this.log("error", `peer socket error: ${String(error)}`);
      this.emit("error", error);
    });

    socket.on("close", (code, reason) => {
      this.stopHeartbeat();
      this.state = "closed";
      this.emit("close", { code, reason: String(reason || "") });
      if (!this.closedByUser && this.connectUrl) {
        this.scheduleReconnect();
      }
    });

    if (!outgoing && socket.readyState === WebSocket.OPEN) {
      this.sendHandshake();
    }
  }

  private scheduleReconnect() {
    if (!this.connectUrl || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.connectUrl || this.closedByUser) {
        return;
      }
      void this.connect(this.connectUrl).catch((error) => {
        this.log("warn", `reconnect failed: ${String(error)}`);
      });
    }, delay);
  }

  private sendHandshake() {
    this.localNonce = randomNonce(12);
    const tsMs = Date.now();
    const payload = buildHandshakePayload({
      peerId: this.options.localIdentity.peerId,
      nonce: this.localNonce,
      tsMs,
    });
    const signature = signPayload(this.options.privateKeyPem, payload);
    this.send({
      type: "handshake",
      peer: this.options.localIdentity,
      nonce: this.localNonce,
      tsMs,
      signature,
    });
  }

  private handleFrame(frame: MulticlawsFrame, outgoing: boolean) {
    switch (frame.type) {
      case "handshake": {
        const verification = this.verifyHandshake(frame);
        if (!verification.ok) {
          this.send({ type: "error", code: "handshake_failed", message: verification.error });
          this.socket?.close(4001, verification.error);
          return;
        }
        this.remoteIdentity = frame.peer;
        const tsMs = Date.now();
        const ackNonce = randomNonce(12);
        const payload = buildHandshakePayload({
          peerId: this.options.localIdentity.peerId,
          nonce: frame.nonce,
          ackNonce,
          tsMs,
        });
        const signature = signPayload(this.options.privateKeyPem, payload);
        this.send({
          type: "handshake_ack",
          peer: this.options.localIdentity,
          nonce: frame.nonce,
          ackNonce,
          tsMs,
          signature,
        });
        this.markReady();
        return;
      }
      case "handshake_ack": {
        if (!outgoing) {
          return;
        }
        if (!this.remoteIdentity) {
          this.remoteIdentity = frame.peer;
        }
        const verification = this.verifyHandshakeAck(frame);
        if (!verification.ok) {
          this.send({ type: "error", code: "handshake_ack_failed", message: verification.error });
          this.socket?.close(4002, verification.error);
          return;
        }
        this.markReady();
        return;
      }
      case "ping": {
        this.lastPingTs = frame.tsMs;
        this.send({ type: "pong", tsMs: frame.tsMs });
        return;
      }
      case "pong": {
        return;
      }
      case "request": {
        this.emit("request", frame);
        return;
      }
      case "response": {
        this.emit("response", frame);
        return;
      }
      case "event": {
        this.emit("event", frame);
        return;
      }
      case "error": {
        this.log("warn", `peer error: ${frame.code ?? "unknown"} ${frame.message}`);
        this.emit("peer_error", frame);
        return;
      }
      default:
        return;
    }
  }

  private verifyHandshake(frame: Extract<MulticlawsFrame, { type: "handshake" }>): {
    ok: true;
  } | { ok: false; error: string } {
    if (Math.abs(Date.now() - frame.tsMs) > HANDSHAKE_MAX_SKEW_MS) {
      return { ok: false, error: "handshake timestamp skew too large" };
    }
    if (this.options.expectedPeerId && frame.peer.peerId !== this.options.expectedPeerId) {
      return { ok: false, error: `unexpected peer id: ${frame.peer.peerId}` };
    }
    const payload = buildHandshakePayload({
      peerId: frame.peer.peerId,
      nonce: frame.nonce,
      tsMs: frame.tsMs,
    });
    if (!verifyPayload(frame.peer.publicKey, payload, frame.signature)) {
      return { ok: false, error: "invalid handshake signature" };
    }
    return { ok: true };
  }

  private verifyHandshakeAck(frame: Extract<MulticlawsFrame, { type: "handshake_ack" }>): {
    ok: true;
  } | { ok: false; error: string } {
    if (!this.remoteIdentity) {
      return { ok: false, error: "missing remote identity" };
    }
    if (frame.peer.peerId !== this.remoteIdentity.peerId) {
      return { ok: false, error: "peer id mismatch in handshake ack" };
    }
    if (frame.nonce !== this.localNonce) {
      return { ok: false, error: "handshake nonce mismatch" };
    }
    if (Math.abs(Date.now() - frame.tsMs) > HANDSHAKE_MAX_SKEW_MS) {
      return { ok: false, error: "handshake ack timestamp skew too large" };
    }
    const payload = buildHandshakePayload({
      peerId: frame.peer.peerId,
      nonce: frame.nonce,
      ackNonce: frame.ackNonce,
      tsMs: frame.tsMs,
    });
    if (!verifyPayload(frame.peer.publicKey, payload, frame.signature)) {
      return { ok: false, error: "invalid handshake ack signature" };
    }
    return { ok: true };
  }

  private markReady() {
    if (this.state === "ready" || !this.remoteIdentity) {
      return;
    }
    this.state = "ready";
    this.reconnectAttempt = 0;
    this.startHeartbeat();
    this.emit("ready", this.remoteIdentity);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== "ready") {
        return;
      }
      this.send({ type: "ping", tsMs: Date.now() });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private log(level: "info" | "warn" | "error" | "debug", message: string) {
    const logger = this.options.logger;
    logger?.[level]?.(`[peer-connection] ${message}`);
  }
}
