import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MulticlawsService } from "../src/service/multiclaws-service";

async function mkTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "multiclaws-e2e-"));
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

describe("multiclaws service e2e", () => {
  it("supports direct messaging, memory search and task delegation", async () => {
    const dirA = await mkTempDir();
    const dirB = await mkTempDir();

    const [portA, portB] = await Promise.all([getFreePort(), getFreePort()]);

    const serviceA = new MulticlawsService({
      stateDir: dirA,
      port: portA,
      displayName: "Alice",
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    const serviceB = new MulticlawsService({
      stateDir: dirB,
      port: portB,
      displayName: "Bob",
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      memorySearch: async ({ query }) => [
        {
          path: "memory/frontend/react-notes.md",
          snippet: `Found note for ${query}`,
          score: 0.92,
        },
      ],
      taskExecutor: async ({ task }) => ({
        ok: true,
        output: `executed:${task}`,
      }),
    });

    serviceB.on("permission_prompt", async (event: { requestId: string }) => {
      await serviceB.handleUserApprovalReply(`/mc allow ${event.requestId} once`);
    });

    const directMessagePromise = new Promise<{ text: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("direct message timeout")), 10_000);
      serviceB.once("direct_message", (payload: { text: string }) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    try {
      await serviceA.start();
      await serviceB.start();

      if (!serviceB.identity) {
        throw new Error("serviceB identity missing");
      }

      await serviceA.addPeer({
        peerId: serviceB.identity.peerId,
        displayName: serviceB.identity.displayName,
        address: `ws://127.0.0.1:${portB}`,
        publicKey: serviceB.identity.publicKey,
      });

      await serviceA.sendDirectMessage({
        peerId: serviceB.identity.peerId,
        text: "hello from alice",
      });

      await expect(directMessagePromise).resolves.toMatchObject({ text: "hello from alice" });

      const search = await serviceA.multiclawsMemorySearch({
        peerId: serviceB.identity.peerId,
        query: "react",
        maxResults: 3,
      });
      expect(search).toMatchObject({
        results: [
          {
            path: "frontend/react-notes.md",
          },
        ],
      });

      const taskCompletedNotificationPromise = new Promise<{
        task?: string;
        ok?: boolean;
        fromPeerDisplayName?: string;
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("task completed notification timeout")), 10_000);
        serviceA.once(
          "task_completed_notification",
          (payload: { task?: string; ok?: boolean; fromPeerDisplayName?: string }) => {
            clearTimeout(timer);
            resolve(payload);
          },
        );
      });

      const delegated = (await serviceA.delegateTask({
        peerId: serviceB.identity.peerId,
        task: "summarize build status",
      })) as { ok: boolean; output?: string };
      expect(delegated.ok).toBe(true);
      expect(delegated.output).toContain("executed:summarize build status");
      await expect(taskCompletedNotificationPromise).resolves.toMatchObject({
        task: "summarize build status",
        ok: true,
        fromPeerDisplayName: "Bob",
      });
    } finally {
      await serviceA.stop().catch(() => undefined);
      await serviceB.stop().catch(() => undefined);
    }
  });
});
