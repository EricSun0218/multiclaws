"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PeerConnection = void 0;
const node_events_1 = require("node:events");
const ws_1 = __importDefault(require("ws"));
const peer_id_1 = require("./peer-id");
const codec_1 = require("../protocol/codec");
const HANDSHAKE_MAX_SKEW_MS = 60_000;
const HEARTBEAT_MS = 30_000;
class PeerConnection extends node_events_1.EventEmitter {
    options;
    socket = null;
    state = "idle";
    remoteIdentity = null;
    heartbeatTimer = null;
    connectUrl = null;
    reconnectTimer = null;
    reconnectAttempt = 0;
    localNonce = "";
    lastPingTs = 0;
    closedByUser = false;
    constructor(options) {
        super();
        this.options = options;
    }
    get peerId() {
        return this.remoteIdentity?.peerId ?? null;
    }
    get peerIdentity() {
        return this.remoteIdentity;
    }
    get currentState() {
        return this.state;
    }
    async connect(url) {
        this.closedByUser = false;
        this.connectUrl = url;
        await this.openSocket(new ws_1.default(url), true);
    }
    async attach(socket) {
        this.closedByUser = false;
        await this.openSocket(socket, false);
    }
    close() {
        this.closedByUser = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.stopHeartbeat();
        if (this.socket && this.socket.readyState === ws_1.default.OPEN) {
            this.socket.close(1000, "closed-by-user");
        }
        this.state = "closed";
    }
    send(frame) {
        if (!this.socket || this.socket.readyState !== ws_1.default.OPEN) {
            return false;
        }
        this.socket.send((0, codec_1.encodeFrame)(frame));
        return true;
    }
    async openSocket(socket, outgoing) {
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
                : (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString("utf8");
            const frame = (0, codec_1.decodeFrame)(raw);
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
        if (!outgoing && socket.readyState === ws_1.default.OPEN) {
            this.sendHandshake();
        }
    }
    scheduleReconnect() {
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
    sendHandshake() {
        this.localNonce = (0, peer_id_1.randomNonce)(12);
        const tsMs = Date.now();
        const payload = (0, peer_id_1.buildHandshakePayload)({
            peerId: this.options.localIdentity.peerId,
            nonce: this.localNonce,
            tsMs,
        });
        const signature = (0, peer_id_1.signPayload)(this.options.privateKeyPem, payload);
        this.send({
            type: "handshake",
            peer: this.options.localIdentity,
            nonce: this.localNonce,
            tsMs,
            signature,
        });
    }
    handleFrame(frame, outgoing) {
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
                const ackNonce = (0, peer_id_1.randomNonce)(12);
                const payload = (0, peer_id_1.buildHandshakePayload)({
                    peerId: this.options.localIdentity.peerId,
                    nonce: frame.nonce,
                    ackNonce,
                    tsMs,
                });
                const signature = (0, peer_id_1.signPayload)(this.options.privateKeyPem, payload);
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
    verifyHandshake(frame) {
        if (Math.abs(Date.now() - frame.tsMs) > HANDSHAKE_MAX_SKEW_MS) {
            return { ok: false, error: "handshake timestamp skew too large" };
        }
        if (this.options.expectedPeerId && frame.peer.peerId !== this.options.expectedPeerId) {
            return { ok: false, error: `unexpected peer id: ${frame.peer.peerId}` };
        }
        const payload = (0, peer_id_1.buildHandshakePayload)({
            peerId: frame.peer.peerId,
            nonce: frame.nonce,
            tsMs: frame.tsMs,
        });
        if (!(0, peer_id_1.verifyPayload)(frame.peer.publicKey, payload, frame.signature)) {
            return { ok: false, error: "invalid handshake signature" };
        }
        return { ok: true };
    }
    verifyHandshakeAck(frame) {
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
        const payload = (0, peer_id_1.buildHandshakePayload)({
            peerId: frame.peer.peerId,
            nonce: frame.nonce,
            ackNonce: frame.ackNonce,
            tsMs: frame.tsMs,
        });
        if (!(0, peer_id_1.verifyPayload)(frame.peer.publicKey, payload, frame.signature)) {
            return { ok: false, error: "invalid handshake ack signature" };
        }
        return { ok: true };
    }
    markReady() {
        if (this.state === "ready" || !this.remoteIdentity) {
            return;
        }
        this.state = "ready";
        this.reconnectAttempt = 0;
        this.startHeartbeat();
        this.emit("ready", this.remoteIdentity);
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.state !== "ready") {
                return;
            }
            this.send({ type: "ping", tsMs: Date.now() });
        }, HEARTBEAT_MS);
    }
    stopHeartbeat() {
        if (!this.heartbeatTimer) {
            return;
        }
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }
    log(level, message) {
        const logger = this.options.logger;
        logger?.[level]?.(`[peer-connection] ${message}`);
    }
}
exports.PeerConnection = PeerConnection;
