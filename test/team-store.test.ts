import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { TeamStore, encodeInvite, decodeInvite } from "../src/team/team-store";

describe("TeamStore", () => {
  const tmpFiles: string[] = [];

  function tmpPath(): string {
    const p = path.join(os.tmpdir(), `team-store-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
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

  it("creates a team with self as first member", async () => {
    const store = new TeamStore(tmpPath());
    const team = await store.createTeam({
      teamName: "TestTeam",
      selfUrl: "http://localhost:3100",
      selfName: "Alice",
    });

    expect(team.teamId).toBeTruthy();
    expect(team.teamName).toBe("TestTeam");
    expect(team.members).toHaveLength(1);
    expect(team.members[0].url).toBe("http://localhost:3100");
    expect(team.members[0].name).toBe("Alice");
  });

  it("adds and removes members", async () => {
    const store = new TeamStore(tmpPath());
    const team = await store.createTeam({
      teamName: "TestTeam",
      selfUrl: "http://a:3100",
      selfName: "A",
    });

    await store.addMember(team.teamId, {
      url: "http://b:3100",
      name: "B",
      joinedAtMs: Date.now(),
    });

    const updated = await store.getTeam(team.teamId);
    expect(updated!.members).toHaveLength(2);
    expect(updated!.members[1].name).toBe("B");

    await store.removeMember(team.teamId, "http://b:3100");
    const afterRemove = await store.getTeam(team.teamId);
    expect(afterRemove!.members).toHaveLength(1);
  });

  it("upserts existing members", async () => {
    const store = new TeamStore(tmpPath());
    const team = await store.createTeam({
      teamName: "TestTeam",
      selfUrl: "http://a:3100",
      selfName: "A",
    });

    await store.addMember(team.teamId, { url: "http://b:3100", name: "B-old", joinedAtMs: 1000 });
    await store.addMember(team.teamId, { url: "http://b:3100", name: "B-new", joinedAtMs: 2000 });

    const updated = await store.getTeam(team.teamId);
    expect(updated!.members).toHaveLength(2);
    expect(updated!.members[1].name).toBe("B-new");
  });

  it("normalizes trailing slashes for members", async () => {
    const store = new TeamStore(tmpPath());
    const team = await store.createTeam({
      teamName: "TestTeam",
      selfUrl: "http://a:3100",
      selfName: "A",
    });

    await store.addMember(team.teamId, { url: "http://b:3100///", name: "B", joinedAtMs: Date.now() });
    const removed = await store.removeMember(team.teamId, "http://b:3100");
    expect(removed).toBe(true);
  });

  it("deletes a team", async () => {
    const store = new TeamStore(tmpPath());
    const team = await store.createTeam({
      teamName: "TestTeam",
      selfUrl: "http://a:3100",
      selfName: "A",
    });

    const deleted = await store.deleteTeam(team.teamId);
    expect(deleted).toBe(true);

    const after = await store.getTeam(team.teamId);
    expect(after).toBeNull();
  });

  it("lists teams", async () => {
    const store = new TeamStore(tmpPath());
    await store.createTeam({ teamName: "Team1", selfUrl: "http://a:3100", selfName: "A" });
    await store.createTeam({ teamName: "Team2", selfUrl: "http://a:3100", selfName: "A" });

    const teams = await store.listTeams();
    expect(teams).toHaveLength(2);
  });

  it("saves and retrieves team", async () => {
    const store = new TeamStore(tmpPath());
    const team = await store.createTeam({
      teamName: "TestTeam",
      selfUrl: "http://a:3100",
      selfName: "A",
    });

    team.members.push({ url: "http://b:3100", name: "B", joinedAtMs: Date.now() });
    await store.saveTeam(team);

    const retrieved = await store.getTeam(team.teamId);
    expect(retrieved!.members).toHaveLength(2);
  });
});

describe("invite code", () => {
  it("encodes and decodes invite", () => {
    const code = encodeInvite("team-123", "http://192.168.1.10:3100");
    expect(code.startsWith("mc:")).toBe(true);

    const decoded = decodeInvite(code);
    expect(decoded.t).toBe("team-123");
    expect(decoded.u).toBe("http://192.168.1.10:3100");
  });

  it("decodes without mc: prefix", () => {
    const code = encodeInvite("team-456", "http://example.com:3100");
    const withoutPrefix = code.replace("mc:", "");
    const decoded = decodeInvite(withoutPrefix);
    expect(decoded.t).toBe("team-456");
  });

  it("throws on invalid code", () => {
    expect(() => decodeInvite("garbage")).toThrow("invalid invite code");
  });
});
