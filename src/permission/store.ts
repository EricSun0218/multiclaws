import os from "node:os";
import path from "node:path";
import type { PeerPermissionRecord, PermissionMode } from "./types";
import { readJsonWithFallback, withJsonLock, writeJsonAtomically } from "../utils/json-store";

type PermissionStoreData = {
  version: 1;
  peers: PeerPermissionRecord[];
};

const DEFAULT_STORE_RELATIVE = ".openclaw/state/multiclaws/permissions.json";

function defaultStorePath() {
  return path.join(os.homedir(), DEFAULT_STORE_RELATIVE);
}

export class PermissionStore {
  constructor(private readonly filePath: string = defaultStorePath()) {}

  async get(peerId: string): Promise<PeerPermissionRecord | null> {
    const store = await readJsonWithFallback<PermissionStoreData>(this.filePath, {
      version: 1,
      peers: [],
    });
    return store.peers.find((entry) => entry.peerId === peerId) ?? null;
  }

  async list(): Promise<PeerPermissionRecord[]> {
    const store = await readJsonWithFallback<PermissionStoreData>(this.filePath, {
      version: 1,
      peers: [],
    });
    return Array.isArray(store.peers) ? store.peers : [];
  }

  async set(peerId: string, mode: PermissionMode): Promise<PeerPermissionRecord> {
    return await withJsonLock(
      this.filePath,
      {
        version: 1,
        peers: [],
      },
      async () => {
        const store = await readJsonWithFallback<PermissionStoreData>(this.filePath, {
          version: 1,
          peers: [],
        });
        const next: PeerPermissionRecord = {
          peerId,
          mode,
          updatedAtMs: Date.now(),
        };
        const peers = (Array.isArray(store.peers) ? store.peers : []).filter(
          (entry) => entry.peerId !== peerId,
        );
        peers.push(next);
        await writeJsonAtomically(this.filePath, {
          version: 1,
          peers,
        });
        return next;
      },
    );
  }

  async clear(peerId: string): Promise<void> {
    await withJsonLock(
      this.filePath,
      {
        version: 1,
        peers: [],
      },
      async () => {
        const store = await readJsonWithFallback<PermissionStoreData>(this.filePath, {
          version: 1,
          peers: [],
        });
        const peers = (Array.isArray(store.peers) ? store.peers : []).filter(
          (entry) => entry.peerId !== peerId,
        );
        await writeJsonAtomically(this.filePath, {
          version: 1,
          peers,
        });
      },
    );
  }

  get path(): string {
    return this.filePath;
  }
}
