import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { loadOrCreateIdentity, type PeerIdentity } from "../core/peer-id";
import { PeerConnection } from "../core/peer-connection";
import { PeerRegistry, type PeerRecord } from "../core/peer-registry";
import { TeamManager } from "../core/team";
import { PermissionStore } from "../permission/store";
import { PermissionManager } from "../permission/manager";
import { formatPermissionPrompt, type DirectMessagePayload } from "../messaging/direct";
import { MulticlawsMemoryService, type LocalMemorySearchResult } from "../memory/multiclaws-query";
import { TaskTracker } from "../task/tracker";
import { TaskDelegationService, type TaskExecutionResult } from "../task/delegation";
import {
  MulticlawsProtocolHandlers,
  type TaskCompletedNotification,
} from "../protocol/handlers";
import type { MulticlawsFrame } from "../protocol/types";

export type MulticlawsServiceOptions = {
  stateDir: string;
  port?: number;
  displayName?: string;
  gatewayVersion?: string;
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
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class MulticlawsService extends EventEmitter {
  private options: MulticlawsServiceOptions;
  private started = false;
  private wss: WebSocketServer | null = null;
  private localIdentity: PeerIdentity | null = null;
  private localPrivateKeyPem = "";
  private readonly registry: PeerRegistry;
  private readonly teamManager: TeamManager;
  private readonly permissionStore: PermissionStore;
  private permissionManager: PermissionManager | null = null;
  private readonly taskTracker = new TaskTracker();
  private readonly connections = new Map<string, PeerConnection>();
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private protocolHandlers: MulticlawsProtocolHandlers | null = null;

  constructor(options: MulticlawsServiceOptions) {
    super();
    this.options = options;
    const multiclawsStateDir = path.join(options.stateDir, "multiclaws");
    this.registry = new PeerRegistry(path.join(multiclawsStateDir, "peers.json"));
    this.teamManager = new TeamManager(path.join(multiclawsStateDir, "teams.json"));
    this.permissionStore = new PermissionStore(path.join(multiclawsStateDir, "permissions.json"));
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
    this.wss = new WebSocketServer({ port: listenPort });
    this.wss.on("connection", (ws) => {
      void this.acceptIncomingSocket(ws);
    });

    this.started = true;
    this.log("info", `multiclaws service listening on :${listenPort}`);

    for (const peer of this.options.knownPeers ?? []) {
      await this.addPeer({
        address: peer.address,
        peerId: peer.peerId,
        displayName: peer.displayName,
        publicKey: peer.publicKey,
      });
    }

    const existingPeers = await this.registry.list();
    await Promise.all(
      existingPeers
        .filter((entry) => entry.trustLevel !== "blocked")
        .map(async (entry) => this.connectToPeer(entry).catch(() => undefined)),
    );
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    for (const [requestId, pending] of this.pendingResponses.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("multiclaws service stopped"));
      this.pendingResponses.delete(requestId);
    }
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => resolve());
    });
    this.wss = null;
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
      peerId: params.peerId ?? `pending_${Buffer.from(params.address).toString("hex").slice(0, 12)}`,
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
    const conn = new PeerConnection({
      localIdentity: this.localIdentity,
      privateKeyPem: this.localPrivateKeyPem,
      expectedPeerId: peer.peerId.startsWith("pending_") ? undefined : peer.peerId,
      logger: this.options.logger,
    });
    this.bindConnection(conn, peer.address);
    await conn.connect(peer.address);
    if (conn.currentState !== "ready") {
      await new Promise<void>((resolve, reject) => {
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
    const conn = await this.resolveConnection(params.peerId);
    const requestId = randomUUID();
    const timeoutMs = params.timeoutMs ?? 30_000;

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        reject(new Error(`request timeout: ${params.method}`));
      }, timeoutMs);
      this.pendingResponses.set(requestId, { resolve, reject, timer });
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

  async createTeam(params: { teamName: string; localAddress: string }): Promise<{
    teamId: string;
    teamName: string;
    inviteCode: string;
  }> {
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

  async joinTeam(params: { inviteCode: string; localAddress: string }): Promise<{
    teamId: string;
    teamName: string;
    ownerPeerId: string;
  }> {
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
    await this.teamManager.leaveTeam({
      teamId,
      peerId: this.localIdentity.peerId,
    });
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
    conn.on("ready", async (identity: PeerIdentity) => {
      this.connections.set(identity.peerId, conn);
      await this.registry.upsert({
        peerId: identity.peerId,
        displayName: identity.displayName,
        address,
        publicKey: identity.publicKey,
        trustLevel: "unknown",
        capabilities: ["messaging.send", "messaging.receive", "memory.search", "task.delegate"],
        lastSeenAtMs: Date.now(),
      });
      this.emit("peer_connected", identity);
    });

    conn.on("close", () => {
      const peerId = conn.peerId;
      if (peerId) {
        this.connections.delete(peerId);
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

  private async acceptIncomingSocket(ws: WebSocket): Promise<void> {
    if (!this.localIdentity) {
      ws.close(4000, "service not initialized");
      return;
    }
    const conn = new PeerConnection({
      localIdentity: this.localIdentity,
      privateKeyPem: this.localPrivateKeyPem,
      logger: this.options.logger,
    });
    this.bindConnection(conn, "incoming");
    await conn.attach(ws);
  }

  private log(level: "info" | "warn" | "error" | "debug", message: string): void {
    const logger = this.options.logger;
    logger?.[level]?.(`[multiclaws] ${message}`);
  }
}
