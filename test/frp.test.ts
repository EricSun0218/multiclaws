import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";

// Import the module to test helper functions
// We test the exported utilities directly; FrpTunnelManager integration
// requires a running frpc binary, so we focus on unit-testable pieces.

describe("frp module", () => {
  const tmpDirs: string[] = [];

  function tmpDir(): string {
    const d = path.join(os.tmpdir(), `frp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(d, { recursive: true });
    tmpDirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  describe("detectFrpc", () => {
    it("returns boolean without throwing", async () => {
      // Dynamic import to avoid hoisting issues
      const { detectFrpc } = await import("../src/infra/frp");
      const result = detectFrpc();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("FrpTunnelConfig type", () => {
    it("accepts valid config shape", async () => {
      const { FrpTunnelManager } = await import("../src/infra/frp");
      const dir = tmpDir();

      // Just ensure constructor accepts the expected shape
      const manager = new FrpTunnelManager({
        config: {
          serverAddr: "127.0.0.1",
          serverPort: 7000,
          token: "test-token",
          portRangeStart: 7011,
          portRangeEnd: 7020,
        },
        localPort: 3100,
        stateDir: dir,
      });

      expect(manager.status.status).toBe("stopped");
      expect(manager.publicUrl).toBeNull();
    });
  });

  describe("FrpTunnelManager status lifecycle", () => {
    it("starts as stopped", async () => {
      const { FrpTunnelManager } = await import("../src/infra/frp");
      const dir = tmpDir();

      const manager = new FrpTunnelManager({
        config: {
          serverAddr: "127.0.0.1",
          serverPort: 7000,
          token: "test-token",
          portRangeStart: 7011,
          portRangeEnd: 7020,
        },
        localPort: 3100,
        stateDir: dir,
      });

      expect(manager.status).toEqual({ status: "stopped" });
    });

    it("stop() on an already-stopped manager is a no-op", async () => {
      const { FrpTunnelManager } = await import("../src/infra/frp");
      const dir = tmpDir();

      const manager = new FrpTunnelManager({
        config: {
          serverAddr: "127.0.0.1",
          serverPort: 7000,
          token: "test-token",
          portRangeStart: 7011,
          portRangeEnd: 7020,
        },
        localPort: 3100,
        stateDir: dir,
      });

      // Should not throw
      await manager.stop();
      expect(manager.status.status).toBe("stopped");
    });
  });

  describe("port range validation", () => {
    it("rejects when frpc is not available and download fails", async () => {
      const { FrpTunnelManager } = await import("../src/infra/frp");
      const dir = tmpDir();

      const manager = new FrpTunnelManager({
        config: {
          serverAddr: "127.0.0.1",
          serverPort: 7000,
          token: "test-token",
          portRangeStart: 9999,
          portRangeEnd: 9999,
        },
        localPort: 3100,
        stateDir: dir,
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      });

      // start() should fail because frpc is not available
      // (either not in PATH and download will fail in test environment)
      await expect(manager.start()).rejects.toThrow();
    }, 30_000);
  });
});
