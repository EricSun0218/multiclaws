import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { derivePeerId } from "../src/core/peer-id";
import { MulticlawsService } from "../src/service/multiclaws-service";

async function mkTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "multiclaws-http-"));
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { server.close(); reject(new Error("no port")); return; }
      const { port } = addr;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function httpReq(options: { port: number; method: string; path: string; body?: string; auth?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = options.body ?? "";
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(bodyStr),
    };
    if (options.auth) headers["Authorization"] = `Bearer ${options.auth}`;

    const req = http.request(
      { hostname: "127.0.0.1", port: options.port, path: options.path, method: options.method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function makeForgedInvite(params: {
  teamId: string;
  teamName: string;
  ownerAddress: string;
}): Promise<string> {
  const { SignJWT, importPKCS8 } = await import("jose");
  const keyPair = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const ownerPeerId = derivePeerId(keyPair.publicKey);
  const privateKey = await importPKCS8(keyPair.privateKey, "EdDSA");
  const token = await new SignJWT({
    v: 1,
    teamId: params.teamId,
    teamName: params.teamName,
    ownerPeerId,
    ownerAddress: params.ownerAddress,
    ownerPublicKey: keyPair.publicKey,
    issuedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .sign(privateKey);
  return `TEAM-${token}`;
}

describe("HTTP registry", () => {
  const services: MulticlawsService[] = [];

  afterEach(async () => {
    await Promise.all(services.map((s) => s.stop().catch(() => undefined)));
    services.length = 0;
  });

  async function makeOwner() {
    const dir = await mkTempDir();
    const port = await getFreePort();
    const svc = new MulticlawsService({
      stateDir: dir,
      port,
      displayName: "owner-node",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await svc.start();
    services.push(svc);
    return { svc, port, dir };
  }

  it("GET /team/:id/members returns member list without auth", async () => {
    const { svc, port } = await makeOwner();

    // Create team
    const team = await svc.createTeam({
      teamName: "test-team",
      localAddress: `ws://127.0.0.1:${port}`,
    });

    const res = await httpReq({ port, method: "GET", path: `/team/${team.teamId}/members` });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { members: Array<{ peerId: string; displayName: string; joinedAtMs: number }> };
    expect(parsed.members).toHaveLength(1);
    expect(parsed.members[0].displayName).toBe("owner-node");
    expect(typeof parsed.members[0].joinedAtMs).toBe("number");
  });

  it("GET /team/:id/members returns 404 for unknown team", async () => {
    const { port } = await makeOwner();
    const res = await httpReq({ port, method: "GET", path: "/team/team_nonexistent/members" });
    expect(res.status).toBe(404);
  });

  it("POST /team/:id/members rejects without auth", async () => {
    const { svc, port } = await makeOwner();
    const team = await svc.createTeam({ teamName: "test-team", localAddress: `ws://127.0.0.1:${port}` });

    const res = await httpReq({
      port, method: "POST", path: `/team/${team.teamId}/members`,
      body: JSON.stringify({ peerId: "oc_abc", displayName: "bob", address: "ws://127.0.0.1:9999" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /team/:id/members rejects with invalid invite code", async () => {
    const { svc, port } = await makeOwner();
    const team = await svc.createTeam({ teamName: "test-team", localAddress: `ws://127.0.0.1:${port}` });

    const res = await httpReq({
      port, method: "POST", path: `/team/${team.teamId}/members`,
      body: JSON.stringify({ peerId: "oc_abc", displayName: "bob", address: "ws://127.0.0.1:9999" }),
      auth: "TEAM-invalidcode",
    });
    expect(res.status).toBe(403);
  });

  it("POST /team/:id/members rejects invite signed by a non-owner key", async () => {
    const { svc, port } = await makeOwner();
    const { teamId, teamName } = await svc.createTeam({
      teamName: "test-team",
      localAddress: `ws://127.0.0.1:${port}`,
    });
    const forgedInvite = await makeForgedInvite({
      teamId,
      teamName,
      ownerAddress: `ws://127.0.0.1:${port}`,
    });

    const res = await httpReq({
      port,
      method: "POST",
      path: `/team/${teamId}/members`,
      body: JSON.stringify({ peerId: "oc_fake_peer", displayName: "fake", address: "ws://127.0.0.1:9999" }),
      auth: forgedInvite,
    });
    expect(res.status).toBe(403);
  });

  it("POST /team/:id/members registers member with valid invite code and returns full list with joinedAtMs", async () => {
    const { svc, port } = await makeOwner();
    const { teamId, inviteCode } = await svc.createTeam({
      teamName: "test-team",
      localAddress: `ws://127.0.0.1:${port}`,
    });

    const res = await httpReq({
      port, method: "POST", path: `/team/${teamId}/members`,
      body: JSON.stringify({ peerId: "oc_newpeer123", displayName: "alice", address: "ws://127.0.0.1:9998" }),
      auth: inviteCode,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { ok: boolean; members: Array<{ peerId: string; joinedAtMs: number }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.members).toHaveLength(2);
    const newMember = parsed.members.find((m) => m.peerId === "oc_newpeer123");
    expect(newMember).toBeDefined();
    expect(typeof newMember?.joinedAtMs).toBe("number");
  });

  it("POST /team/:id/members rejects invite code for wrong team", async () => {
    const { svc, port } = await makeOwner();
    const teamA = await svc.createTeam({ teamName: "team-a", localAddress: `ws://127.0.0.1:${port}` });
    const teamB = await svc.createTeam({ teamName: "team-b", localAddress: `ws://127.0.0.1:${port}` });

    // Use teamA invite code to try to register in teamB
    const res = await httpReq({
      port, method: "POST", path: `/team/${teamB.teamId}/members`,
      body: JSON.stringify({ peerId: "oc_xyz", displayName: "eve", address: "ws://127.0.0.1:9997" }),
      auth: teamA.inviteCode,
    });
    expect(res.status).toBe(403);
  });

  it("DELETE /team/:id/members/:peerId removes member with valid invite code", async () => {
    const { svc, port } = await makeOwner();
    const { teamId, inviteCode } = await svc.createTeam({
      teamName: "test-team",
      localAddress: `ws://127.0.0.1:${port}`,
    });

    // Register a member first
    await httpReq({
      port, method: "POST", path: `/team/${teamId}/members`,
      body: JSON.stringify({ peerId: "oc_leaveme", displayName: "leaver", address: "ws://127.0.0.1:9996" }),
      auth: inviteCode,
    });

    // Delete that member
    const res = await httpReq({
      port, method: "DELETE", path: `/team/${teamId}/members/oc_leaveme`,
      auth: inviteCode,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    // Verify member is gone
    const list = await httpReq({ port, method: "GET", path: `/team/${teamId}/members` });
    const listParsed = JSON.parse(list.body) as { members: Array<{ peerId: string }> };
    expect(listParsed.members.find((m) => m.peerId === "oc_leaveme")).toBeUndefined();
  });

  it("returns 429 when rate limited", async () => {
    const { svc, port } = await makeOwner();
    const team = await svc.createTeam({ teamName: "test-team", localAddress: `ws://127.0.0.1:${port}` });

    // Exhaust 30 requests
    const promises = Array.from({ length: 31 }, () =>
      httpReq({ port, method: "GET", path: `/team/${team.teamId}/members` }),
    );
    const results = await Promise.all(promises);
    const rateLimited = results.filter((r) => r.status === 429);
    expect(rateLimited.length).toBeGreaterThan(0);
  });
});
