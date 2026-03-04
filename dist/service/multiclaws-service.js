"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MulticlawsService = void 0;
const node_events_1 = require("node:events");
const node_crypto_1 = __importStar(require("node:crypto"));
const node_path_1 = __importDefault(require("node:path"));
const ws_1 = require("ws");
const peer_id_1 = require("../core/peer-id");
const peer_connection_1 = require("../core/peer-connection");
const peer_registry_1 = require("../core/peer-registry");
const team_1 = require("../core/team");
const store_1 = require("../permission/store");
const manager_1 = require("../permission/manager");
const types_1 = require("../permission/types");
const multiclaws_query_1 = require("../memory/multiclaws-query");
const tracker_1 = require("../task/tracker");
const delegation_1 = require("../task/delegation");
const handlers_1 = require("../protocol/handlers");
const rate_limiter_1 = require("../utils/rate-limiter");
/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */
class MulticlawsService extends node_events_1.EventEmitter {
    options;
    started = false;
    wss = null;
    localIdentity = null;
    localPrivateKeyPem = "";
    registry;
    teamManager;
    permissionStore;
    permissionManager = null;
    taskTracker = new tracker_1.TaskTracker();
    connections = new Map();
    pendingResponses = new Map();
    connectingPeers = new Map();
    rateLimiter = new rate_limiter_1.RateLimiter({ windowMs: 60_000, maxRequests: 120 });
    protocolHandlers = null;
    constructor(options) {
        super();
        this.options = options;
        const multiclawsStateDir = node_path_1.default.join(options.stateDir, "multiclaws");
        this.registry = new peer_registry_1.PeerRegistry(node_path_1.default.join(multiclawsStateDir, "peers.json"));
        this.teamManager = new team_1.TeamManager(node_path_1.default.join(multiclawsStateDir, "teams.json"));
        this.permissionStore = new store_1.PermissionStore(node_path_1.default.join(multiclawsStateDir, "permissions.json"));
    }
    get identity() {
        return this.localIdentity;
    }
    async start() {
        if (this.started) {
            return;
        }
        const { identity, privateKeyPem } = await (0, peer_id_1.loadOrCreateIdentity)({
            stateDir: node_path_1.default.join(this.options.stateDir, "multiclaws"),
            displayName: this.options.displayName,
            gatewayVersion: this.options.gatewayVersion ?? "unknown",
        });
        this.localIdentity = identity;
        this.localPrivateKeyPem = privateKeyPem;
        this.permissionManager = new manager_1.PermissionManager(this.permissionStore, async (prompt) => {
            const text = (0, types_1.formatPermissionPrompt)({
                requestId: prompt.requestId,
                peerDisplayName: prompt.peerDisplayName,
                action: prompt.action,
                context: prompt.context,
            });
            this.emit("permission_prompt", {
                requestId: prompt.requestId,
                peerDisplayName: prompt.peerDisplayName,
                action: prompt.action,
                context: prompt.context,
                text,
            });
        });
        const memoryService = new multiclaws_query_1.MulticlawsMemoryService(this.permissionManager, this.options.memorySearch ?? (async () => []));
        const taskService = new delegation_1.TaskDelegationService(this.taskTracker, this.permissionManager, this.options.taskExecutor ??
            (async () => ({
                ok: false,
                error: "task executor not configured",
            })));
        this.protocolHandlers = new handlers_1.MulticlawsProtocolHandlers({
            memoryService,
            taskService,
            onDirectMessage: async (payload) => {
                this.emit("direct_message", payload);
            },
            onTaskCompleted: async (payload) => {
                await this.notifyDelegationRequester(payload);
            },
        });
        const listenPort = this.options.port ?? 39393;
        this.wss = new ws_1.WebSocketServer({ port: listenPort });
        this.wss.on("connection", (ws, req) => {
            void this.acceptIncomingSocket(ws, req);
        });
        this.started = true;
        this.log("info", `multiclaws service listening on :${listenPort}`);
        // Add known peers in parallel — they are independent operations
        await Promise.all((this.options.knownPeers ?? []).map((peer) => this.addPeer({
            address: peer.address,
            peerId: peer.peerId,
            displayName: peer.displayName,
            publicKey: peer.publicKey,
        })));
        // Reconnect to known peers in the background — do not block start()
        // so that gateway methods (e.g. team.create) are immediately available.
        // Each failed connection retries with exponential backoff automatically.
        const existingPeers = await this.registry.list();
        void Promise.all(existingPeers
            .filter((entry) => entry.trustLevel !== "blocked")
            .map(async (entry) => this.connectToPeer(entry).catch((err) => this.log("warn", `background reconnect failed for ${entry.peerId}: ${String(err)}`))));
    }
    async stop() {
        if (!this.started) {
            return;
        }
        this.started = false;
        this.taskTracker.destroy();
        this.rateLimiter.destroy();
        for (const [requestId, pending] of this.pendingResponses.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("multiclaws service stopped"));
            this.pendingResponses.delete(requestId);
        }
        for (const conn of this.connections.values()) {
            conn.close();
        }
        this.connections.clear();
        this.connectingPeers.clear();
        await new Promise((resolve) => {
            if (!this.wss) {
                resolve();
                return;
            }
            this.wss.close(() => resolve());
        });
        this.wss = null;
    }
    async handleUserApprovalReply(content) {
        if (!this.permissionManager) {
            return { handled: false };
        }
        const result = await this.permissionManager.handleUserReply(content);
        return {
            handled: result.handled,
            requestId: result.requestId,
            decision: result.decision,
        };
    }
    async listPeers() {
        const peers = await this.registry.list();
        return peers.map((peer) => ({
            ...peer,
            connected: this.connections.has(peer.peerId),
        }));
    }
    async addPeer(params) {
        const record = await this.registry.upsert({
            peerId: params.peerId ?? `pending_${node_crypto_1.default.createHash("sha256").update(params.address).digest("hex").slice(0, 16)}`,
            displayName: params.displayName ?? params.peerId ?? params.address,
            address: params.address,
            publicKey: params.publicKey,
            trustLevel: "unknown",
            capabilities: ["messaging.send", "messaging.receive", "memory.search", "task.delegate"],
            lastSeenAtMs: undefined,
        });
        return record;
    }
    async removePeer(peerId) {
        const existing = this.connections.get(peerId);
        if (existing) {
            existing.close();
            this.connections.delete(peerId);
        }
        this.rateLimiter.reset(peerId);
        return await this.registry.remove(peerId);
    }
    async resolvePeer(nameOrId) {
        return await this.registry.findByDisplayName(nameOrId);
    }
    async connectToPeer(peer) {
        if (!this.localIdentity) {
            throw new Error("multiclaws service not started");
        }
        if (this.connections.has(peer.peerId)) {
            return;
        }
        // Deduplicate concurrent connect attempts for the same peer
        const inflight = this.connectingPeers.get(peer.peerId);
        if (inflight) {
            return inflight;
        }
        const promise = this.doConnectToPeer(peer).finally(() => {
            this.connectingPeers.delete(peer.peerId);
        });
        this.connectingPeers.set(peer.peerId, promise);
        return promise;
    }
    async sendDirectMessage(params) {
        if (!this.localIdentity) {
            throw new Error("multiclaws service not started");
        }
        await this.requestPeer({
            peerId: params.peerId,
            method: "multiclaws.message.forward",
            params: {
                fromPeerId: this.localIdentity.peerId,
                fromDisplayName: this.localIdentity.displayName,
                text: params.text,
                sentAtMs: Date.now(),
            },
        });
    }
    async multiclawsMemorySearch(params) {
        return await this.requestPeer({
            peerId: params.peerId,
            method: "multiclaws.memory.search",
            params: {
                query: params.query,
                maxResults: params.maxResults ?? 5,
            },
        });
    }
    async delegateTask(params) {
        return await this.requestPeer({
            peerId: params.peerId,
            method: "multiclaws.task.delegate",
            params: {
                task: params.task,
                context: params.context,
            },
            timeoutMs: 120_000,
        });
    }
    async requestPeer(params) {
        const conn = await this.resolveConnection(params.peerId);
        const requestId = (0, node_crypto_1.randomUUID)();
        const timeoutMs = params.timeoutMs ?? 30_000;
        const responsePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingResponses.delete(requestId);
                reject(new Error(`request timeout: ${params.method}`));
            }, timeoutMs);
            this.pendingResponses.set(requestId, { peerId: params.peerId, resolve, reject, timer });
        });
        const sent = conn.send({
            type: "request",
            id: requestId,
            method: params.method,
            params: params.params,
        });
        if (!sent) {
            const pending = this.pendingResponses.get(requestId);
            if (pending) {
                clearTimeout(pending.timer);
                this.pendingResponses.delete(requestId);
            }
            throw new Error(`peer ${params.peerId} is not connected`);
        }
        return await responsePromise;
    }
    async createTeam(params) {
        if (!this.localIdentity) {
            throw new Error("multiclaws service not started");
        }
        const team = await this.teamManager.createTeam({
            teamName: params.teamName,
            ownerPeerId: this.localIdentity.peerId,
            ownerDisplayName: this.localIdentity.displayName,
            ownerAddress: params.localAddress,
        });
        const inviteCode = await this.teamManager.createInvite({
            teamId: team.teamId,
            ownerPeerId: this.localIdentity.peerId,
            ownerAddress: params.localAddress,
        });
        return {
            teamId: team.teamId,
            teamName: team.teamName,
            inviteCode,
        };
    }
    async joinTeam(params) {
        if (!this.localIdentity) {
            throw new Error("multiclaws service not started");
        }
        const invite = await this.teamManager.parseInvite(params.inviteCode);
        await this.teamManager.joinByInvite({
            invite,
            localPeerId: this.localIdentity.peerId,
            localDisplayName: this.localIdentity.displayName,
            localAddress: params.localAddress,
        });
        await this.addPeer({
            peerId: invite.ownerPeerId,
            displayName: "team-owner",
            address: invite.ownerAddress,
        });
        const ownerRecord = await this.registry.get(invite.ownerPeerId);
        if (ownerRecord) {
            await this.connectToPeer(ownerRecord).catch((error) => {
                this.log("warn", `failed to connect owner after join: ${String(error)}`);
            });
        }
        return {
            teamId: invite.teamId,
            teamName: invite.teamName,
            ownerPeerId: invite.ownerPeerId,
        };
    }
    async listTeamMembers(teamId) {
        const team = await this.teamManager.getTeam(teamId);
        if (!team) {
            throw new Error(`unknown team: ${teamId}`);
        }
        return team.members.map((member) => ({
            peerId: member.peerId,
            displayName: member.displayName,
            address: member.address,
        }));
    }
    async leaveTeam(teamId) {
        if (!this.localIdentity) {
            throw new Error("multiclaws service not started");
        }
        await this.teamManager.leaveTeam({
            teamId,
            peerId: this.localIdentity.peerId,
        });
    }
    hasPendingPermissions() {
        return (this.permissionManager?.getPendingSnapshot().length ?? 0) > 0;
    }
    async setPeerPermissionMode(peerId, mode) {
        if (!this.permissionManager) {
            throw new Error("permission manager not initialized");
        }
        await this.permissionManager.setPeerMode(peerId, mode);
    }
    getTaskStatus(taskId) {
        return this.taskTracker.get(taskId);
    }
    /* ---------------------------------------------------------------- */
    /*  Private — connection management                                  */
    /* ---------------------------------------------------------------- */
    async doConnectToPeer(peer) {
        if (!this.localIdentity) {
            throw new Error("multiclaws service not started");
        }
        const conn = new peer_connection_1.PeerConnection({
            localIdentity: this.localIdentity,
            privateKeyPem: this.localPrivateKeyPem,
            expectedPeerId: peer.peerId.startsWith("pending_") ? undefined : peer.peerId,
            logger: this.options.logger,
        });
        this.bindConnection(conn, peer.address);
        await conn.connect(peer.address);
        if (conn.currentState !== "ready") {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`connect timeout: ${peer.peerId}`)), 8_000);
                conn.once("ready", () => {
                    clearTimeout(timer);
                    resolve();
                });
                conn.once("close", () => {
                    clearTimeout(timer);
                    reject(new Error(`connection closed during handshake: ${peer.peerId}`));
                });
            });
        }
    }
    async notifyDelegationRequester(payload) {
        if (!this.localIdentity) {
            return;
        }
        await this.sendEventToPeer(payload.requesterPeerId, "multiclaws.task.completed", {
            requestId: payload.requestId,
            taskId: payload.result.taskId,
            task: payload.task,
            ok: payload.result.ok,
            output: payload.result.output,
            error: payload.result.error,
            completedAtMs: Date.now(),
            fromPeerId: this.localIdentity.peerId,
            fromPeerDisplayName: this.localIdentity.displayName,
        });
    }
    async sendEventToPeer(peerId, name, data) {
        const conn = this.connections.get(peerId) ?? (await this.resolveConnection(peerId).catch(() => null));
        if (!conn) {
            return;
        }
        conn.send({
            type: "event",
            name,
            data,
        });
    }
    handleIncomingEvent(frame) {
        if (frame.name === "multiclaws.task.completed") {
            this.emit("task_completed_notification", frame.data);
            return;
        }
        this.emit("multiclaws_event", frame);
    }
    async resolveConnection(peerId) {
        const existing = this.connections.get(peerId);
        if (existing) {
            return existing;
        }
        const peer = await this.registry.get(peerId);
        if (!peer) {
            throw new Error(`unknown peer: ${peerId}`);
        }
        await this.connectToPeer(peer);
        const connected = this.connections.get(peerId);
        if (!connected) {
            throw new Error(`failed to connect peer: ${peerId}`);
        }
        return connected;
    }
    bindConnection(conn, address) {
        conn.on("ready", async (identity) => {
            this.connections.set(identity.peerId, conn);
            // Resolve the best-known address: prefer the address we connected to;
            // for incoming connections ("incoming"), keep the existing registry address
            // if the peer was already known, to avoid overwriting a valid address.
            const existingRecord = await this.registry.get(identity.peerId);
            const resolvedAddress = address !== "incoming"
                ? address
                : (existingRecord?.address ?? "incoming");
            await this.registry.upsert({
                peerId: identity.peerId,
                displayName: identity.displayName,
                address: resolvedAddress,
                publicKey: identity.publicKey,
                trustLevel: existingRecord?.trustLevel ?? "unknown",
                capabilities: ["messaging.send", "messaging.receive", "memory.search", "task.delegate"],
                lastSeenAtMs: Date.now(),
            });
            // Clean up any pending_ placeholder entries for the same address
            if (!identity.peerId.startsWith("pending_")) {
                const allPeers = await this.registry.list();
                for (const peer of allPeers) {
                    if (peer.peerId.startsWith("pending_") && peer.address === address) {
                        await this.registry.remove(peer.peerId);
                        this.log("info", `cleaned up placeholder peer ${peer.peerId} -> ${identity.peerId}`);
                    }
                }
            }
            this.emit("peer_connected", identity);
        });
        conn.on("close", () => {
            const peerId = conn.peerId;
            if (peerId) {
                this.connections.delete(peerId);
                // Immediately reject all in-flight requests for this peer
                for (const [requestId, pending] of this.pendingResponses.entries()) {
                    if (pending.peerId === peerId) {
                        clearTimeout(pending.timer);
                        this.pendingResponses.delete(requestId);
                        pending.reject(new Error(`peer ${peerId} disconnected`));
                    }
                }
            }
        });
        conn.on("request", async (frame) => {
            const remote = conn.peerIdentity;
            if (!remote || !this.protocolHandlers) {
                conn.send({
                    type: "response",
                    id: frame.id,
                    ok: false,
                    error: "peer not authenticated",
                });
                return;
            }
            // Rate limit inbound requests per peer
            if (!this.rateLimiter.allow(remote.peerId)) {
                conn.send({
                    type: "response",
                    id: frame.id,
                    ok: false,
                    error: "rate limited",
                });
                return;
            }
            const result = await this.protocolHandlers.handleRequest({
                fromPeerId: remote.peerId,
                fromPeerDisplayName: remote.displayName,
                method: frame.method,
                requestId: frame.id,
                payload: frame.params,
            });
            conn.send({
                type: "response",
                id: frame.id,
                ok: result.ok,
                data: result.data,
                error: result.error,
            });
        });
        conn.on("response", (frame) => {
            const pending = this.pendingResponses.get(frame.id);
            if (!pending) {
                return;
            }
            clearTimeout(pending.timer);
            this.pendingResponses.delete(frame.id);
            if (!frame.ok) {
                pending.reject(new Error(frame.error || "peer request failed"));
                return;
            }
            pending.resolve(frame.data);
        });
        conn.on("event", (frame) => {
            this.handleIncomingEvent(frame);
        });
    }
    async acceptIncomingSocket(ws, req) {
        if (!this.localIdentity) {
            ws.close(4000, "service not initialized");
            return;
        }
        // Use the remote IP from the upgrade request (public API, not ws internals).
        // The port is the client's ephemeral port, not listen port, so we mark it
        // unknown. After the handshake, bindConnection will prefer the existing
        // registry address if the peer was already known.
        const rawRemoteAddress = req.socket.remoteAddress ?? "incoming";
        const incomingAddress = rawRemoteAddress !== "incoming"
            ? `ws://${rawRemoteAddress}:?`
            : "incoming";
        const conn = new peer_connection_1.PeerConnection({
            localIdentity: this.localIdentity,
            privateKeyPem: this.localPrivateKeyPem,
            logger: this.options.logger,
        });
        this.bindConnection(conn, incomingAddress);
        await conn.attach(ws);
    }
    log(level, message) {
        const logger = this.options.logger;
        logger?.[level]?.(`[multiclaws] ${message}`);
    }
}
exports.MulticlawsService = MulticlawsService;
