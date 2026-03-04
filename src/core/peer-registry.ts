import os from "node:os";
import path from "node:path";
import {
  readJsonWithFallback,
  withJsonLock,
  writeJsonAtomically,
} from "../utils/json-store";

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

function emptyStore(): PeerRegistryStore {
  return {
    version: 1,
    peers: [],
  };
}

function normalize(record: PeerRecord): PeerRecord {
  return {
    ...record,
    displayName: record.displayName.trim() || record.peerId,
    address: record.address.trim(),
    capabilities: Array.from(new Set(record.capabilities)),
  };
}

function normalizeStore(raw: PeerRegistryStore): PeerRegistryStore {
  if (raw.version !== 1 || !Array.isArray(raw.peers)) {
    return emptyStore();
  }
  const peers: PeerRecord[] = [];
  for (const item of raw.peers) {
    if (
      !item ||
      typeof item.peerId !== "string" ||
      typeof item.displayName !== "string" ||
      typeof item.address !== "string" ||
      typeof item.trustLevel !== "string" ||
      !Array.isArray(item.capabilities) ||
      typeof item.updatedAtMs !== "number"
    ) {
      continue;
    }
    peers.push(
      normalize({
        peerId: item.peerId,
        displayName: item.displayName,
        address: item.address,
        publicKey: typeof item.publicKey === "string" ? item.publicKey : undefined,
        trustLevel: item.trustLevel as PeerTrustLevel,
        capabilities: item.capabilities.filter(
          (capability): capability is PeerCapability => typeof capability === "string",
        ),
        lastSeenAtMs: typeof item.lastSeenAtMs === "number" ? item.lastSeenAtMs : undefined,
        updatedAtMs: item.updatedAtMs,
      }),
    );
  }
  return {
    version: 1,
    peers,
  };
}

export class PeerRegistry {
  constructor(private readonly filePath: string = defaultStorePath()) {}

  private async readStore(): Promise<PeerRegistryStore> {
    const store = await readJsonWithFallback<PeerRegistryStore>(this.filePath, emptyStore());
    return normalizeStore(store);
  }

  async list(): Promise<PeerRecord[]> {
    const store = await this.readStore();
    return [...store.peers].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  async get(peerId: string): Promise<PeerRecord | null> {
    const store = await this.readStore();
    return store.peers.find((record) => record.peerId === peerId) ?? null;
  }

  async findByDisplayName(nameOrId: string): Promise<PeerRecord | null> {
    const needle = nameOrId.trim().toLowerCase();
    if (!needle) {
      return null;
    }
    const store = await this.readStore();
    return (
      store.peers.find((entry) => entry.peerId.toLowerCase() === needle) ??
      store.peers.find((entry) => entry.displayName.toLowerCase() === needle) ??
      null
    );
  }

  async upsert(record: Omit<PeerRecord, "updatedAtMs">): Promise<PeerRecord> {
    return await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const now = Date.now();
      const resolved = normalize({ ...record, updatedAtMs: now });
      const index = store.peers.findIndex((item) => item.peerId === resolved.peerId);
      if (index >= 0) {
        store.peers[index] = resolved;
      } else {
        store.peers.push(resolved);
      }
      await writeJsonAtomically(this.filePath, store);
      return resolved;
    });
  }

  async remove(peerId: string): Promise<boolean> {
    return await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const before = store.peers.length;
      store.peers = store.peers.filter((entry) => entry.peerId !== peerId);
      const changed = store.peers.length !== before;
      if (changed) {
        await writeJsonAtomically(this.filePath, store);
      }
      return changed;
    });
  }

  async setTrust(peerId: string, trustLevel: PeerTrustLevel): Promise<PeerRecord | null> {
    return await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const index = store.peers.findIndex((item) => item.peerId === peerId);
      if (index < 0) {
        return null;
      }
      const next = {
        ...store.peers[index],
        trustLevel,
        updatedAtMs: Date.now(),
      };
      store.peers[index] = next;
      await writeJsonAtomically(this.filePath, store);
      return next;
    });
  }

  async touchSeen(peerId: string): Promise<void> {
    await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const index = store.peers.findIndex((item) => item.peerId === peerId);
      if (index < 0) {
        return;
      }
      const now = Date.now();
      store.peers[index] = {
        ...store.peers[index],
        lastSeenAtMs: now,
        updatedAtMs: now,
      };
      await writeJsonAtomically(this.filePath, store);
    });
  }

  get path(): string {
    return this.filePath;
  }

  close(): void {
    // JSON backend has no open handle.
  }
}
