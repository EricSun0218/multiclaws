import { EventEmitter } from "node:events";
import crypto, { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { loadOrCreateIdentity, type PeerIdentity } from "../core/peer-id";
import { PeerConnection } from "../core/peer-connection";
import { PeerRegistry, type PeerRecord } from "../core/peer-registry";
import { TeamManager } from "../core/team";
import { Libp2pDiscovery } from "../core/libp2p-discovery";
import { PermissionStore } from "../permission/store";
import { PermissionManager } from "../permission/manager";
import type { DirectMessagePayload } from "../messaging/direct";
import { formatPermissionPrompt } from "../permission/types";
import { MulticlawsMemoryService, type LocalMemorySearchResult } from "../memory/multiclaws-query";
import { TaskTracker } from "../task/tracker";
import { TaskDelegationService, type TaskExecutionResult } from "../task/delegation";
import {
  MulticlawsProtocolHandlers,
  type TaskCompletedNotification,
} from "../protocol/handlers";
import type { MulticlawsFrame } from "../protocol/types";
import { RateLimiter } from "../utils/rate-limiter";
import { withSpan } from "../utils/telemetry";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type MulticlawsServiceOptions = {
  stateDir: string;
  port?: number;
  displayName?: string;
  gatewayVersion?: string;
  libp2pDiscovery?: {
    enabled?: boolean;
    listenPort?: number;
  };
  knownPeers?: Array<{ peerId?: string; displayName?: string; address: string; publicKey?: string }>;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    debug?: (message: string) => void;
  };
  memorySearch?: (params: {
    query: string;
    maxResults: number;
  }) => Promise<LocalMemorySearchResult[]>;
  taskExecutor?: (params: {
    task: string;
    context?: string;
    fromPeerId: string;
  }) => Promise<TaskExecutionResult>;
};

type PendingResponse = {
  peerId: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface MulticlawsServiceEvents {
  permission_prompt: [{
    requestId: string;
    peerDisplayName: string;
    action: string;
    context: string;
    text: string;
  }];
  direct_message: [DirectMessagePayload];
  task_completed_notification: [Record<string, unknown>];
  peer_connected: [PeerIdentity];
  multiclaws_event: [Extract<MulticlawsFrame, { type: "event" }>];
}

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

export class MulticlawsService extends EventEmitter {
  private options: MulticlawsServiceOptions;
  private started = false;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private localIdentity: PeerIdentity | null = null;
  private localPrivateKeyPem = "";
  private readonly registry: PeerRegistry;
  private readonly teamManager: TeamManager;
  private readonly permissionStore: PermissionStore;
  private permissionManager: PermissionManager | null = null;
  private readonly taskTracker: TaskTracker;
  private readonly connections = new Map<string, PeerConnection>();
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private readonly connectingPeers = new Map<string, Promise<void>>();
  private libp2pDiscovery: Libp2pDiscovery | null = null;
  private readonly rateLimiter = new RateLimiter({ windowMs: 60_000, maxRequests: 120 });
  private readonly httpRateLimiter = new RateLimiter({ windowMs: 60_000, maxRequests: 30 });
  private protocolHandlers: MulticlawsProtocolHandlers | null = null;

  constructor(options: MulticlawsServiceOptions) {
    super();
    this.options = options;
    const multiclawsStateDir = path.join(options.stateDir, "multiclaws");
    this.registry = new PeerRegistry(path.join(multiclawsStateDir, "peers.json"));
    this.teamManager = new TeamManager(path.join(multiclawsStateDir, "teams.json"));
    this.permissionStore = new PermissionStore(path.join(multiclawsStateDir, "permissions.json"));
    this.taskTracker = new TaskTracker({
      filePath: path.join(multiclawsStateDir, "tasks.json"),
    });
  }

  get identity(): PeerIdentity | null {
    return this.localIdentity;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const { identity, privateKeyPem } = await loadOrCreateIdentity({
      stateDir: path.join(this.options.stateDir, "multiclaws"),
      displayName: this.options.displayName,
      gatewayVersion: this.options.gatewayVersion ?? "unknown",
    });
    this.localIdentity = identity;
    this.localPrivateKeyPem = privateKeyPem;

    this.permissionManager = new PermissionManager(this.permissionStore, async (prompt) => {
      const text = formatPermissionPrompt({
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

    const memoryService = new MulticlawsMemoryService(
      this.permissionManager,
      this.options.memorySearch ?? (async () => []),
    );
    const taskService = new TaskDelegationService(
      this.taskTracker,
      this.permissionManager,
      this.options.taskExecutor ??
        (async () => ({
          ok: false,
          error: "task executor not configured",
        })),
    );

    this.protocolHandlers = new MulticlawsProtocolHandlers({
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

    // Create HTTP server that handles both WebSocket upgrades and registry HTTP requests
    this.httpServer = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws, req) => {
      void this.acceptIncomingSocket(ws, req);
    });
    await new Promise<void>((resolve) => this.httpServer!.listen(listenPort, resolve));

    this.started = true;
    this.log("info", `multiclaws service listening on :${listenPort}`);

    // Periodic member sync: every 5 minutes, refresh member list from owner
    this.syncTimer = setInterval(() => {
      void this.syncAllTeamsFromOwner();
    }, 5 * 60 * 1000);
    // Allow the timer to not block process exit
    if (typeof this.syncTimer === "object" && this.syncTimer && "unref" in this.syncTimer) {
      (this.syncTimer as { unref(): void }).unref();
    }

    // Add known peers in parallel — they are independent operations
    await Promise.all(
      (this.options.knownPeers ?? []).map((peer) =>
        this.addPeer({
          address: peer.address,
          peerId: peer.peerId,
          displayName: peer.displayName,
          publicKey: peer.publicKey,
        }),
      ),
    );

    // Reconnect to known peers in the background — do not block start()
    // so that gateway methods (e.g. team.create) are immediately available.
    // Each failed connection retries with exponential backoff automatically.
    const existingPeers = await this.registry.list();
    void Promise.all(
      existingPeers
        .filter((entry) => entry.trustLevel !== "blocked")
        .map(async (entry) =>
          this.connectToPeer(entry).catch((err) =>
            this.log("warn", `background reconnect failed for ${entry.peerId}: ${String(err)}`),
          ),
        ),
    );

    // Optional libp2p mDNS discovery, then fallback to WS transport for protocol.
    if (this.options.libp2pDiscovery?.enabled) {
      const discoveryPort = this.options.libp2pDiscovery.listenPort ?? (listenPort + 1);
      this.libp2pDiscovery = new Libp2pDiscovery({
        listenPort: discoveryPort,
        logger: this.options.logger,
        onDiscoveredWsAddress: async (address) => {
          if (this.isLikelyLocalAddress(address, listenPort)) {
            return;
          }
          const existing = (await this.registry.list()).find((peer) => peer.address === address);
          const peer = existing ?? (await this.addPeer({ address }));
          await this.connectToPeer(peer).catch((error) => {
            this.log("debug", `libp2p discovered peer connect failed (${address}): ${String(error)}`);
          });
        },
      });
      await this.libp2pDiscovery.start().catch((error) => {
        this.log("warn", `libp2p discovery failed to start: ${String(error)}`);
        this.libp2pDiscovery = null;
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
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
    await new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => resolve());
    });
    this.wss = null;
    await new Promise<void>((resolve) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close(() => resolve());
    });
    this.httpServer = null;
    if (this.libp2pDiscovery) {
      await this.libp2pDiscovery.stop().catch(() => undefined);
      this.libp2pDiscovery = null;
    }
    this.registry.close();
    this.teamManager.close();
    this.permissionStore.close();
  }

  async handleUserApprovalReply(content: string): Promise<{
    handled: boolean;
    requestId?: string;
    decision?: string;
  }> {
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

  async listPeers(): Promise<Array<PeerRecord & { connected: boolean }>> {
    const peers = await this.registry.list();
    return peers.map((peer) => ({
      ...peer,
      connected: this.connections.has(peer.peerId),
    }));
  }

  async addPeer(params: {
    address: string;
    peerId?: string;
    displayName?: string;
    publicKey?: string;
  }): Promise<PeerRecord> {
    const record = await this.registry.upsert({
      peerId: params.peerId ?? `pending_${crypto.createHash("sha256").update(params.address).digest("hex").slice(0, 16)}`,
      displayName: params.displayName ?? params.peerId ?? params.address,
      address: params.address,
      publicKey: params.publicKey,
      trustLevel: "unknown",
      capabilities: ["messaging.send", "messaging.receive", "memory.search", "task.delegate"],
      lastSeenAtMs: undefined,
    });
    return record;
  }

  async removePeer(peerId: string): Promise<boolean> {
    const existing = this.connections.get(peerId);
    if (existing) {
      existing.close();
      this.connections.delete(peerId);
    }
    this.rateLimiter.reset(peerId);
    return await this.registry.remove(peerId);
  }

  async resolvePeer(nameOrId: string): Promise<PeerRecord | null> {
    return await this.registry.findByDisplayName(nameOrId);
  }

  async connectToPeer(peer: PeerRecord): Promise<void> {
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

  async sendDirectMessage(params: { peerId: string; text: string }): Promise<void> {
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
      } satisfies DirectMessagePayload,
    });
  }

  async multiclawsMemorySearch(params: {
    peerId: string;
    query: string;
    maxResults?: number;
  }): Promise<unknown> {
    return await this.requestPeer({
      peerId: params.peerId,
      method: "multiclaws.memory.search",
      params: {
        query: params.query,
        maxResults: params.maxResults ?? 5,
      },
    });
  }

  async delegateTask(params: { peerId: string; task: string; context?: string }): Promise<unknown> {
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

  async requestPeer(params: {
    peerId: string;
    method: string;
    params: unknown;
    timeoutMs?: number;
  }): Promise<unknown> {
    return await withSpan(
      "multiclaws.request_peer",
      { peerId: params.peerId, method: params.method },
      async () => {
        const conn = await this.resolveConnection(params.peerId);
        const requestId = randomUUID();
        const timeoutMs = params.timeoutMs ?? 30_000;

        const responsePromise = new Promise<unknown>((resolve, reject) => {
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
      },
    );
  }

  async createTeam(params: { teamName: string; localAddress: string }): Promise<{
    teamId: string;
    teamName: string;
    inviteCode: string;
  }> {
    return await withSpan(
      "multiclaws.team.create",
      { teamName: params.teamName },
      async () => {
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
          ownerPublicKey: this.localIdentity.publicKey,
          ownerPrivateKey: this.localPrivateKeyPem,
        });
        return {
          teamId: team.teamId,
          teamName: team.teamName,
          inviteCode,
        };
      },
    );
  }

  async joinTeam(params: { inviteCode: string; localAddress: string; }): Promise<{
    teamId: string;
    teamName: string;
    ownerPeerId: string;
  }> {
    return await withSpan("multiclaws.team.join", {}, async () => {
      if (!this.localIdentity) {
        throw new Error("multiclaws service not started");
      }
      const invite = await this.teamManager.parseInvite(params.inviteCode);
      await this.teamManager.joinByInvite({
        invite,
        localPeerId: this.localIdentity.peerId,
        localDisplayName: this.localIdentity.displayName,
        localAddress: params.localAddress,
        inviteCode: params.inviteCode,
      });

      // Register with owner via HTTP and get the full member list
      try {
        const members = await this.httpRegisterMember({
          ownerAddress: invite.ownerAddress,
          teamId: invite.teamId,
          peerId: this.localIdentity.peerId,
          displayName: this.localIdentity.displayName,
          address: params.localAddress,
          inviteCode: params.inviteCode,
        });
        if (members.length > 0) {
          await this.teamManager.updateMembers(invite.teamId, members);
          this.log("info", `synced ${members.length} members from owner for team ${invite.teamId}`);
        }
      } catch (error) {
        this.log("warn", `HTTP registration with owner failed, using local data: ${String(error)}`);
      }

      await this.addPeer({
        peerId: invite.ownerPeerId,
        displayName: "team-owner",
        address: invite.ownerAddress,
        publicKey: invite.ownerPublicKey,
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
    });
  }

  async listTeamMembers(teamId: string): Promise<Array<{ peerId: string; displayName: string; address: string }>> {
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

  async leaveTeam(teamId: string): Promise<void> {
    if (!this.localIdentity) {
      throw new Error("multiclaws service not started");
    }
    const team = await this.teamManager.getTeam(teamId);
    await this.teamManager.leaveTeam({
      teamId,
      peerId: this.localIdentity.peerId,
    });
    // Notify owner via HTTP
    if (team && team.ownerPeerId !== this.localIdentity.peerId) {
      const owner = team.members.find((m) => m.peerId === team.ownerPeerId);
      const inviteCode = team.localInviteCode;
      if (owner && inviteCode) {
        try {
          await this.httpDeleteMember({
            ownerAddress: owner.address,
            teamId,
            peerId: this.localIdentity.peerId,
            inviteCode,
          });
        } catch (error) {
          this.log("warn", `HTTP leave notification failed: ${String(error)}`);
        }
      }
    }
  }

  hasPendingPermissions(): boolean {
    return (this.permissionManager?.getPendingSnapshot().length ?? 0) > 0;
  }

  getPendingPermissions() {
    return this.permissionManager?.getPendingSnapshot() ?? [];
  }

  resolvePermission(requestId: string, decision: "allow-once" | "allow-permanently" | "deny"): boolean {
    if (!this.permissionManager) {
      throw new Error("permission manager not initialized");
    }
    return this.permissionManager.resolveRequest(requestId, decision);
  }

  async setPeerPermissionMode(peerId: string, mode: "prompt" | "allow-all" | "blocked"): Promise<void> {
    if (!this.permissionManager) {
      throw new Error("permission manager not initialized");
    }
    await this.permissionManager.setPeerMode(peerId, mode);
  }

  getTaskStatus(taskId: string) {
    return this.taskTracker.get(taskId);
  }

  /* ---------------------------------------------------------------- */
  /*  Private — connection management                                  */
  /* ---------------------------------------------------------------- */

  private async doConnectToPeer(peer: PeerRecord): Promise<void> {
    await withSpan(
      "multiclaws.peer.connect",
      { peerId: peer.peerId, address: peer.address },
      async () => {
        if (!this.localIdentity) {
          throw new Error("multiclaws service not started");
        }
        const conn = new PeerConnection({
          localIdentity: this.localIdentity,
          privateKeyPem: this.localPrivateKeyPem,
          expectedPeerId: peer.peerId.startsWith("pending_") ? undefined : peer.peerId,
          expectedPeerPublicKey: peer.publicKey,
          logger: this.options.logger,
        });
        this.bindConnection(conn, peer.address);
        await conn.connect(peer.address);
        if (conn.currentState !== "ready") {
          await new Promise<void>((resolve, reject) => {
            const onReady = () => {
              clearTimeout(timer);
              conn.off("close", onClose);
              resolve();
            };
            const onClose = () => {
              clearTimeout(timer);
              conn.off("ready", onReady);
              reject(new Error(`connection closed during handshake: ${peer.peerId}`));
            };
            const timer = setTimeout(() => {
              conn.off("ready", onReady);
              conn.off("close", onClose);
              conn.close();
              reject(new Error(`connect timeout: ${peer.peerId}`));
            }, 8_000);
            conn.once("ready", onReady);
            conn.once("close", onClose);
          });
        }
      },
    );
  }

  private async notifyDelegationRequester(payload: TaskCompletedNotification): Promise<void> {
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

  private async sendEventToPeer(peerId: string, name: string, data: unknown): Promise<void> {
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

  private handleIncomingEvent(frame: Extract<MulticlawsFrame, { type: "event" }>) {
    if (frame.name === "multiclaws.task.completed") {
      this.emit("task_completed_notification", frame.data);
      return;
    }
    this.emit("multiclaws_event", frame);
  }

  private async resolveConnection(peerId: string): Promise<PeerConnection> {
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

  private bindConnection(conn: PeerConnection, address: string): void {
    // Guard against unhandled "error" events that would crash the process.
    // PeerConnection now emits "socket_error" instead, but keep this as a
    // safety net in case of future regressions.
    conn.on("error", (err: unknown) => {
      this.log("warn", `unhandled connection error (peer=${conn.peerId ?? "unknown"}): ${String(err)}`);
    });

    conn.on("ready", async (identity: PeerIdentity) => {
      // Close any stale duplicate connection for this peer
      const existing = this.connections.get(identity.peerId);
      if (existing && existing !== conn) {
        this.log("info", `closing duplicate connection for peer ${identity.peerId}`);
        existing.close();
      }
      this.connections.set(identity.peerId, conn);

      // Resolve the best-known address: prefer the address we connected to;
      // for incoming connections ("incoming"), keep the existing registry address
      // if the peer was already known, to avoid overwriting a valid address.
      const existingRecord = await this.registry.get(identity.peerId);
      const resolvedAddress =
        address !== "incoming"
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

    conn.on("request", async (frame: Extract<MulticlawsFrame, { type: "request" }>) => {
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

    conn.on("response", (frame: Extract<MulticlawsFrame, { type: "response" }>) => {
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

    conn.on("event", (frame: Extract<MulticlawsFrame, { type: "event" }>) => {
      this.handleIncomingEvent(frame);
    });
  }

  private async acceptIncomingSocket(ws: WebSocket, req: IncomingMessage): Promise<void> {
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

    const conn = new PeerConnection({
      localIdentity: this.localIdentity,
      privateKeyPem: this.localPrivateKeyPem,
      logger: this.options.logger,
    });
    this.bindConnection(conn, incomingAddress);
    await conn.attach(ws);
  }

  // ----------------------------------------------------------------
  // HTTP Registry: owner-side handler
  // ----------------------------------------------------------------

  private async handleHttpRequest(req: IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader("Content-Type", "application/json");

    if (!this.localIdentity) {
      res.writeHead(503).end(JSON.stringify({ error: "not ready" }));
      return;
    }

    // Per-IP rate limiting on all HTTP endpoints
    const clientIp = req.socket.remoteAddress ?? "unknown";
    if (!this.httpRateLimiter.allow(clientIp)) {
      res.writeHead(429).end(JSON.stringify({ error: "rate limited" }));
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/team\/([^/]+)\/members(?:\/([^/]+))?$/);
    if (!match) {
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
      return;
    }
    const teamId = match[1];
    const memberPeerId = match[2];

    // Only serve teams where this node is owner (don't reveal whether other teams exist)
    const team = await this.teamManager.getTeam(teamId);
    if (!team || team.ownerPeerId !== this.localIdentity.peerId) {
      res.writeHead(404).end(JSON.stringify({ error: "team not found" }));
      return;
    }

    // GET /team/:id/members — public read, no auth required
    if (req.method === "GET" && !memberPeerId) {
      const members = team.members.map((m) => ({
        peerId: m.peerId,
        displayName: m.displayName,
        address: m.address,
        joinedAtMs: m.joinedAtMs,
      }));
      res.writeHead(200).end(JSON.stringify({ members }));
      return;
    }

    // POST and DELETE require a valid invite code as Bearer token
    const authHeader = req.headers["authorization"] ?? "";
    const inviteCode = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!inviteCode) {
      res.writeHead(401).end(JSON.stringify({ error: "Authorization header with invite code required" }));
      return;
    }
    try {
      const invite = await this.teamManager.parseInvite(inviteCode);
      if (invite.teamId !== teamId || invite.ownerPeerId !== team.ownerPeerId) {
        res.writeHead(403).end(JSON.stringify({ error: "invite code is not valid for this team" }));
        return;
      }
    } catch {
      res.writeHead(403).end(JSON.stringify({ error: "invalid or expired invite code" }));
      return;
    }

    // POST /team/:id/members
    if (req.method === "POST" && !memberPeerId) {
      let body: string;
      try {
        body = await readBody(req, 16 * 1024);
      } catch {
        res.writeHead(413).end(JSON.stringify({ error: "request body too large" }));
        return;
      }
      let parsed: { peerId?: string; displayName?: string; address?: string };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }
      if (!parsed.peerId || !parsed.displayName || !parsed.address) {
        res.writeHead(400).end(JSON.stringify({ error: "missing fields: peerId, displayName, address" }));
        return;
      }
      const updated = await this.teamManager.addMember({
        teamId,
        peerId: parsed.peerId,
        displayName: parsed.displayName,
        address: parsed.address,
      });
      const members = updated.members.map((m) => ({
        peerId: m.peerId,
        displayName: m.displayName,
        address: m.address,
        joinedAtMs: m.joinedAtMs,
      }));
      res.writeHead(200).end(JSON.stringify({ ok: true, members }));
      return;
    }

    // DELETE /team/:id/members/:peerId
    if (req.method === "DELETE" && memberPeerId) {
      await this.teamManager.leaveTeam({ teamId, peerId: memberPeerId });
      res.writeHead(200).end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(405).end(JSON.stringify({ error: "method not allowed" }));
  }

  // ----------------------------------------------------------------
  // HTTP Registry: client-side helpers
  // ----------------------------------------------------------------

  private wsAddressToHttp(wsAddress: string): string {
    return wsAddress.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://");
  }

  private async httpRegisterMember(params: {
    ownerAddress: string;
    teamId: string;
    peerId: string;
    displayName: string;
    address: string;
    inviteCode: string;
  }): Promise<Array<{ peerId: string; displayName: string; address: string; joinedAtMs: number }>> {
    const baseUrl = this.wsAddressToHttp(params.ownerAddress);
    const url = `${baseUrl}/team/${params.teamId}/members`;
    const body = JSON.stringify({
      peerId: params.peerId,
      displayName: params.displayName,
      address: params.address,
    });
    const data = await httpRequest(url, "POST", body, params.inviteCode);
    const parsed = JSON.parse(data) as { ok?: boolean; members?: Array<{ peerId: string; displayName: string; address: string; joinedAtMs: number }> };
    return parsed.members ?? [];
  }

  private async httpDeleteMember(params: {
    ownerAddress: string;
    teamId: string;
    peerId: string;
    inviteCode: string;
  }): Promise<void> {
    const baseUrl = this.wsAddressToHttp(params.ownerAddress);
    const url = `${baseUrl}/team/${params.teamId}/members/${params.peerId}`;
    await httpRequest(url, "DELETE", "", params.inviteCode);
  }

  private async httpGetMembers(params: {
    ownerAddress: string;
    teamId: string;
  }): Promise<Array<{ peerId: string; displayName: string; address: string; joinedAtMs: number }>> {
    const baseUrl = this.wsAddressToHttp(params.ownerAddress);
    const url = `${baseUrl}/team/${params.teamId}/members`;
    const data = await httpRequest(url, "GET", "");
    const parsed = JSON.parse(data) as { members?: Array<{ peerId: string; displayName: string; address: string; joinedAtMs: number }> };
    return parsed.members ?? [];
  }

  private async syncAllTeamsFromOwner(): Promise<void> {
    if (!this.localIdentity) return;
    const teams = await this.teamManager.listTeams();
    for (const team of teams) {
      // Skip teams where we are owner (we are the source of truth)
      if (team.ownerPeerId === this.localIdentity.peerId) continue;
      const owner = team.members.find((m) => m.peerId === team.ownerPeerId);
      if (!owner) continue;
      try {
        const members = await this.httpGetMembers({
          ownerAddress: owner.address,
          teamId: team.teamId,
        });
        if (members.length > 0) {
          await this.teamManager.updateMembers(team.teamId, members);
          this.log("info", `periodic sync: updated ${members.length} members for team ${team.teamId}`);
        }
      } catch (error) {
        this.log("debug", `periodic sync failed for team ${team.teamId}: ${String(error)}`);
      }
    }
  }

  private log(level: "info" | "warn" | "error" | "debug", message: string): void {
    const logger = this.options.logger;
    logger?.[level]?.(`[multiclaws] ${message}`);
  }

  private isLikelyLocalAddress(address: string, listenPort: number): boolean {
    try {
      const url = new URL(address);
      if (url.port !== String(listenPort)) {
        return false;
      }
      const host = url.hostname;
      return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    } catch {
      return false;
    }
  }
}

// ----------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------

function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function httpRequest(url: string, method: string, body: string, inviteCode?: string): Promise<string> {
  const mod = (url.startsWith("https://") ? https : http) as typeof http;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = url.startsWith("https://");
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (inviteCode) {
      headers["Authorization"] = `Bearer ${inviteCode}`;
    }
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: 10000,
    };
    const req = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        } else {
          resolve(text);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("HTTP request timed out")); });
    if (body) req.write(body);
    req.end();
  });
}
