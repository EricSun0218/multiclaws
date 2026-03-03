import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionManager, parseApprovalReply } from "../src/permission/manager";
import { PermissionStore } from "../src/permission/store";

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "multiclaws-permission-"));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("permission manager", () => {

  it("resolves allow-once from command reply", async () => {
    const dir = await makeTempDir();
    const store = new PermissionStore(path.join(dir, "permissions.json"));

    let promptId = "";
    const manager = new PermissionManager(store, async (prompt) => {
      promptId = prompt.requestId;
    });

    const decisionPromise = manager.evaluateRequest({
      peerId: "peer-a",
      peerDisplayName: "Alice",
      action: "memory.search",
      context: "react performance",
      timeoutMs: 5_000,
    });

    await waitFor(() => promptId.length > 0);
    await manager.handleUserReply(`/mc allow ${promptId} once`);
    await expect(decisionPromise).resolves.toBe("allow-once");
  });

  it("persists allow-permanently mode", async () => {
    const dir = await makeTempDir();
    const store = new PermissionStore(path.join(dir, "permissions.json"));

    let promptId = "";
    const manager = new PermissionManager(store, async (prompt) => {
      promptId = prompt.requestId;
    });

    const decisionPromise = manager.evaluateRequest({
      peerId: "peer-b",
      peerDisplayName: "Bob",
      action: "task.delegate",
      context: "run smoke test",
      timeoutMs: 5_000,
    });

    await waitFor(() => promptId.length > 0);
    await manager.handleUserReply(`/mc allow ${promptId} permanent`);
    await expect(decisionPromise).resolves.toBe("allow-permanently");

    const saved = await store.get("peer-b");
    expect(saved?.mode).toBe("allow-all");

    await expect(
      manager.evaluateRequest({
        peerId: "peer-b",
        peerDisplayName: "Bob",
        action: "task.delegate",
        context: "another task",
      }),
    ).resolves.toBe("allow-permanently");
  });

  it("parses numeric reply when only one pending request exists", () => {
    const parsed = parseApprovalReply("2", [
      {
        requestId: "11111111-1111-4111-8111-111111111111",
        peerId: "peer-1",
        peerDisplayName: "Alice",
        action: "memory.search",
        context: "query",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 1000,
      },
    ]);
    expect(parsed).toEqual({
      requestId: "11111111-1111-4111-8111-111111111111",
      decision: "allow-permanently",
    });
  });
});
