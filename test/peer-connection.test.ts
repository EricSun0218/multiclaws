import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { loadOrCreateIdentity } from "../src/core/peer-id";
import { PeerConnection } from "../src/core/peer-connection";

async function mkTempDir(prefix: string) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function onceReady(conn: PeerConnection): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ready timeout")), 5_000);
    conn.once("ready", (identity: { peerId: string }) => {
      clearTimeout(timer);
      resolve(identity.peerId);
    });
  });
}

describe("peer connection", () => {
  it("establishes handshake between two peers", async () => {
    const dirA = await mkTempDir("multiclaws-conn-a-");
    const dirB = await mkTempDir("multiclaws-conn-b-");

    const a = await loadOrCreateIdentity({ stateDir: path.join(dirA, "state"), displayName: "A" });
    const b = await loadOrCreateIdentity({ stateDir: path.join(dirB, "state"), displayName: "B" });

    const wss = new WebSocketServer({ port: 0 });
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind websocket server");
    }
    const url = `ws://127.0.0.1:${address.port}`;

    const serverConn = new Promise<PeerConnection>((resolve) => {
      wss.once("connection", (socket) => {
        const conn = new PeerConnection({
          localIdentity: b.identity,
          privateKeyPem: b.privateKeyPem,
        });
        void conn.attach(socket).then(() => resolve(conn));
      });
    });

    const client = new PeerConnection({
      localIdentity: a.identity,
      privateKeyPem: a.privateKeyPem,
    });

    await client.connect(url);
    const server = await serverConn;

    const [serverPeerId, clientPeerId] = await Promise.all([onceReady(server), onceReady(client)]);

    expect(serverPeerId).toBe(a.identity.peerId);
    expect(clientPeerId).toBe(b.identity.peerId);

    client.close();
    server.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await Promise.all([
      fs.rm(dirA, { recursive: true, force: true }),
      fs.rm(dirB, { recursive: true, force: true }),
    ]);
  });
});
