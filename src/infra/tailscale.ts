import { execSync } from "node:child_process";
import os from "node:os";

export type TailscaleStatus =
  | { status: "ready"; ip: string }
  | { status: "needs_auth"; authUrl: string }
  | { status: "not_installed" }
  | { status: "unavailable"; reason: string };

function run(cmd: string, timeoutMs = 5_000): string {
  return execSync(cmd, { timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function commandExists(cmd: string): boolean {
  try {
    run(`which ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

/** Check network interfaces for a Tailscale IP (100.x.x.x) — exported for fast-path checks */
export function getTailscaleIpFromInterfaces(): string | null {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && addr.address.startsWith("100.")) {
        return addr.address;
      }
    }
  }
  return null;
}

/** Ask tailscale CLI for the IP */
function getTailscaleIpFromCli(): string | null {
  try {
    const ip = run("tailscale ip -4").split("\n")[0];
    return ip || null;
  } catch {
    return null;
  }
}

/** Check if tailscale daemon is running and authenticated */
function isAuthenticated(): boolean {
  try {
    const out = run("tailscale status --json");
    const json = JSON.parse(out) as { BackendState?: string };
    return json.BackendState === "Running";
  } catch {
    return false;
  }
}

/** Get auth URL from `tailscale up` output (non-blocking, reads stderr/stdout for a few seconds) */
async function getAuthUrl(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      // tailscale up prints the auth URL to stderr
      const { spawn } = require("node:child_process");
      const proc = spawn("tailscale", ["up"], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let resolved = false;

      const tryResolve = (text: string) => {
        const match = text.match(/https:\/\/login\.tailscale\.com\/[^\s]+/);
        if (match && !resolved) {
          resolved = true;
          proc.kill();
          resolve(match[0]);
        }
      };

      proc.stdout?.on("data", (d: Buffer) => { output += d.toString(); tryResolve(output); });
      proc.stderr?.on("data", (d: Buffer) => { output += d.toString(); tryResolve(output); });
      proc.on("close", () => { if (!resolved) { resolved = true; resolve(null); } });
      setTimeout(() => { if (!resolved) { resolved = true; proc.kill(); resolve(null); } }, 8_000);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Detect Tailscale status — does NOT install or modify system state.
 * Returns one of: ready | needs_auth | not_installed | unavailable
 */
export async function detectTailscale(): Promise<TailscaleStatus> {
  // Fast path: check network interfaces first (no subprocess)
  const ifaceIp = getTailscaleIpFromInterfaces();
  if (ifaceIp) {
    return { status: "ready", ip: ifaceIp };
  }

  // Not installed
  if (!commandExists("tailscale")) {
    return { status: "not_installed" };
  }

  // Installed but check auth
  if (isAuthenticated()) {
    const ip = getTailscaleIpFromCli();
    if (ip) return { status: "ready", ip };
    return { status: "unavailable", reason: "authenticated but no IP assigned" };
  }

  // Needs auth — try to get login URL
  const authUrl = await getAuthUrl();
  if (authUrl) {
    return { status: "needs_auth", authUrl };
  }

  return { status: "unavailable", reason: "could not determine auth URL" };
}
