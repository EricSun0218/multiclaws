import os from "node:os";
import path from "node:path";
import { readJsonWithFallback, withJsonLock, writeJsonAtomically } from "../utils/json-store";

export type PeerTrustLevel = "unknown" | "pending" | "trusted" | "blocked";

export type PeerCapability =
  | "messaging.send"
  | "messaging.receive"
  | "memory.search"
  | "task.delegate"
  | "task.accept";

export type PeerRecord = {
  peerId: string;
  displayName: string;
  address: string;
  publicKey?: string;
  trustLevel: PeerTrustLevel;
  capabilities: PeerCapability[];
  lastSeenAtMs?: number;
  updatedAtMs: number;
};

type PeerRegistryStore = {
  version: 1;
  peers: PeerRecord[];
};

const DEFAULT_STORE_RELATIVE = ".openclaw/multiclaws/peers.json";

function defaultStorePath() {
  return path.join(os.homedir(), DEFAULT_STORE_RELATIVE);
}

function normalize(record: PeerRecord): PeerRecord {
  return {
    ...record,
    displayName: record.displayName.trim() || record.peerId,
    address: record.address.trim(),
    capabilities: Array.from(new Set(record.capabilities)),
  };
}

export class PeerRegistry {
  constructor(private readonly filePath: string = defaultStorePath()) {}

  async list(): Promise<PeerRecord[]> {
    const store = await readJsonWithFallback<PeerRegistryStore>(this.filePath, {
      version: 1,
      peers: [],
    });
    return Array.isArray(store.peers) ? [...store.peers] : [];
  }

  async get(peerId: string): Promise<PeerRecord | null> {
    const peers = await this.list();
    return peers.find((peer) => peer.peerId === peerId) ?? null;
  }

  async findByDisplayName(nameOrId: string): Promise<PeerRecord | null> {
    const needle = nameOrId.trim().toLowerCase();
    if (!needle) {
      return null;
    }
    const peers = await this.list();
    return (
      peers.find((peer) => peer.peerId.toLowerCase() === needle) ??
      peers.find((peer) => peer.displayName.toLowerCase() === needle) ??
      null
    );
  }

  async upsert(record: Omit<PeerRecord, "updatedAtMs">): Promise<PeerRecord> {
    return await withJsonLock(
      this.filePath,
      {
        version: 1,
        peers: [],
      },
      async () => {
        const store = await readJsonWithFallback<PeerRegistryStore>(this.filePath, {
          version: 1,
          peers: [],
        });
        const now = Date.now();
        const resolved = normalize({ ...record, updatedAtMs: now });
        const nextPeers = (Array.isArray(store.peers) ? store.peers : []).filter(
          (entry) => entry.peerId !== resolved.peerId,
        );
        nextPeers.push(resolved);
        const nextStore: PeerRegistryStore = {
          version: 1,
          peers: nextPeers,
        };
        await writeJsonAtomically(this.filePath, nextStore);
        return resolved;
      },
    );
  }

  async remove(peerId: string): Promise<boolean> {
    return await withJsonLock(
      this.filePath,
      {
        version: 1,
        peers: [],
      },
      async () => {
        const store = await readJsonWithFallback<PeerRegistryStore>(this.filePath, {
          version: 1,
          peers: [],
        });
        const before = Array.isArray(store.peers) ? store.peers : [];
        const after = before.filter((entry) => entry.peerId !== peerId);
        if (after.length === before.length) {
          return false;
        }
        await writeJsonAtomically(this.filePath, {
          version: 1,
          peers: after,
        });
        return true;
      },
    );
  }

  async setTrust(peerId: string, trustLevel: PeerTrustLevel): Promise<PeerRecord | null> {
    return await withJsonLock(
      this.filePath,
      {
        version: 1,
        peers: [],
      },
      async () => {
        const store = await readJsonWithFallback<PeerRegistryStore>(this.filePath, {
          version: 1,
          peers: [],
        });
        const peers = Array.isArray(store.peers) ? store.peers : [];
        const index = peers.findIndex((entry) => entry.peerId === peerId);
        if (index < 0) {
          return null;
        }
        const next = { ...peers[index], trustLevel, updatedAtMs: Date.now() };
        const updated = peers.slice();
        updated[index] = next;
        await writeJsonAtomically(this.filePath, {
          version: 1,
          peers: updated,
        });
        return next;
      },
    );
  }

  async touchSeen(peerId: string): Promise<void> {
    await withJsonLock(
      this.filePath,
      {
        version: 1,
        peers: [],
      },
      async () => {
        const store = await readJsonWithFallback<PeerRegistryStore>(this.filePath, {
          version: 1,
          peers: [],
        });
        const peers = Array.isArray(store.peers) ? store.peers : [];
        const index = peers.findIndex((entry) => entry.peerId === peerId);
        if (index < 0) {
          return;
        }
        const updated = peers.slice();
        updated[index] = {
          ...updated[index],
          lastSeenAtMs: Date.now(),
          updatedAtMs: Date.now(),
        };
        await writeJsonAtomically(this.filePath, {
          version: 1,
          peers: updated,
        });
      },
    );
  }

  get path(): string {
    return this.filePath;
  }
}
