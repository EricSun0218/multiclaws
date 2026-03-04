import os from "node:os";
import path from "node:path";
import type { PeerPermissionRecord, PermissionMode } from "./types";
import {
  readJsonWithFallback,
  withJsonLock,
  writeJsonAtomically,
} from "../utils/json-store";

type PermissionStoreData = {
  version: 1;
  peers: PeerPermissionRecord[];
};

const DEFAULT_STORE_RELATIVE = ".openclaw/multiclaws/permissions.json";

function defaultStorePath() {
  return path.join(os.homedir(), DEFAULT_STORE_RELATIVE);
}

function emptyStore(): PermissionStoreData {
  return {
    version: 1,
    peers: [],
  };
}

function normalizeStore(raw: PermissionStoreData): PermissionStoreData {
  if (raw.version !== 1 || !Array.isArray(raw.peers)) {
    return emptyStore();
  }
  return {
    version: 1,
    peers: raw.peers.filter(
      (entry) =>
        entry &&
        typeof entry.peerId === "string" &&
        typeof entry.mode === "string" &&
        typeof entry.updatedAtMs === "number",
    ),
  };
}

export class PermissionStore {
  constructor(private readonly filePath: string = defaultStorePath()) {}

  private async readStore(): Promise<PermissionStoreData> {
    const store = await readJsonWithFallback<PermissionStoreData>(this.filePath, emptyStore());
    return normalizeStore(store);
  }

  async get(peerId: string): Promise<PeerPermissionRecord | null> {
    const store = await this.readStore();
    return store.peers.find((entry) => entry.peerId === peerId) ?? null;
  }

  async list(): Promise<PeerPermissionRecord[]> {
    const store = await this.readStore();
    return [...store.peers].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  async set(peerId: string, mode: PermissionMode): Promise<PeerPermissionRecord> {
    return await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const record: PeerPermissionRecord = {
        peerId,
        mode,
        updatedAtMs: Date.now(),
      };
      const index = store.peers.findIndex((entry) => entry.peerId === peerId);
      if (index >= 0) {
        store.peers[index] = record;
      } else {
        store.peers.push(record);
      }
      await writeJsonAtomically(this.filePath, store);
      return record;
    });
  }

  async clear(peerId: string): Promise<void> {
    await withJsonLock(this.filePath, emptyStore(), async () => {
      const store = await this.readStore();
      const next = store.peers.filter((entry) => entry.peerId !== peerId);
      if (next.length === store.peers.length) {
        return;
      }
      store.peers = next;
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
