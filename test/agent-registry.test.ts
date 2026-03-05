import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { AgentRegistry } from "../src/service/agent-registry";

describe("AgentRegistry", () => {
  const tmpFiles: string[] = [];

  function tmpPath(): string {
    const p = path.join(os.tmpdir(), `agent-registry-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    tmpFiles.push(p);
    return p;
  }

  afterEach(() => {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch {}
      try { fs.unlinkSync(f + ".lock"); } catch {}
    }
    tmpFiles.length = 0;
  });

  it("adds, lists, and removes agents", async () => {
    const registry = new AgentRegistry(tmpPath());

    const added = await registry.add({
      url: "http://localhost:3200/",
      name: "TestAgent",
      description: "A test agent",
      skills: ["coding"],
    });

    expect(added.url).toBe("http://localhost:3200");
    expect(added.name).toBe("TestAgent");

    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe("http://localhost:3200");

    const got = await registry.get("http://localhost:3200");
    expect(got).not.toBeNull();
    expect(got!.name).toBe("TestAgent");

    const removed = await registry.remove("http://localhost:3200");
    expect(removed).toBe(true);

    const listAfter = await registry.list();
    expect(listAfter).toHaveLength(0);
  });

  it("normalizes trailing slashes", async () => {
    const registry = new AgentRegistry(tmpPath());

    await registry.add({ url: "http://example.com///", name: "A" });
    const got = await registry.get("http://example.com");
    expect(got).not.toBeNull();
    expect(got!.name).toBe("A");
  });

  it("upserts on duplicate URL", async () => {
    const registry = new AgentRegistry(tmpPath());

    await registry.add({ url: "http://a.com", name: "V1" });
    await registry.add({ url: "http://a.com", name: "V2", description: "updated" });

    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("V2");
    expect(list[0].description).toBe("updated");
  });

  it("returns false when removing nonexistent agent", async () => {
    const registry = new AgentRegistry(tmpPath());
    const removed = await registry.remove("http://nope.com");
    expect(removed).toBe(false);
  });
});
