import { execSync, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type FrpTunnelConfig = {
  serverAddr: string;
  serverPort: number;
  token: string;
  portRangeStart: number;
  portRangeEnd: number;
};

export type FrpTunnelStatus =
  | { status: "running"; publicUrl: string; remotePort: number }
  | { status: "starting" }
  | { status: "stopped" }
  | { status: "error"; reason: string };

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const FRP_VERSION = "0.61.1";
const ADMIN_API_POLL_INTERVAL_MS = 1_000;
const ADMIN_API_POLL_MAX_RETRIES = 15;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const PROCESS_KILL_TIMEOUT_MS = 3_000;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function run(cmd: string, timeoutMs = 5_000): string {
  return execSync(cmd, { timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** Check if frpc binary is available in system PATH */
export function detectFrpc(): boolean {
  try {
    const cmd = process.platform === "win32" ? "where frpc" : "which frpc";
    run(cmd);
    return true;
  } catch {
    return false;
  }
}

/** Find an available port by briefly binding to port 0 */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("failed to get port")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/** Parse remote port from frpc admin API response (format: ":12345" or "[::]:12345") */
function parseRemotePort(remoteAddr: string): number {
  const colonIdx = remoteAddr.lastIndexOf(":");
  if (colonIdx === -1) throw new Error(`unexpected remote_addr format: ${remoteAddr}`);
  const portStr = remoteAddr.slice(colonIdx + 1);
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port <= 0) throw new Error(`invalid port in remote_addr: ${remoteAddr}`);
  return port;
}

/** Get platform identifier for frp release download */
function getFrpPlatform(): { os: string; arch: string; ext: string } {
  const platform = process.platform;
  const arch = process.arch;

  let frpOs: string;
  if (platform === "linux") frpOs = "linux";
  else if (platform === "darwin") frpOs = "darwin";
  else if (platform === "win32") frpOs = "windows";
  else throw new Error(`unsupported platform: ${platform}`);

  let frpArch: string;
  if (arch === "x64") frpArch = "amd64";
  else if (arch === "arm64") frpArch = "arm64";
  else if (arch === "ia32") frpArch = "386";
  else throw new Error(`unsupported architecture: ${arch}`);

  const ext = platform === "win32" ? "zip" : "tar.gz";
  return { os: frpOs, arch: frpArch, ext };
}

/** Shuffle an array in place (Fisher-Yates) */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Generate a range of numbers [start, end) */
function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i < end; i++) result.push(i);
  return result;
}

/* ------------------------------------------------------------------ */
/*  FrpTunnelManager                                                   */
/* ------------------------------------------------------------------ */

export class FrpTunnelManager {
  private readonly config: FrpTunnelConfig;
  private readonly localPort: number;
  private readonly stateDir: string;
  private readonly logger: Logger;

  private frpcProcess: ChildProcess | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private _status: FrpTunnelStatus = { status: "stopped" };
  private _publicUrl: string | null = null;
  private configPath: string = "";
  private adminPort: number = 0;

  constructor(opts: {
    config: FrpTunnelConfig;
    localPort: number;
    stateDir: string;
    logger?: Logger;
  }) {
    this.config = opts.config;
    this.localPort = opts.localPort;
    this.stateDir = opts.stateDir;
    this.logger = opts.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  get status(): FrpTunnelStatus {
    return this._status;
  }

  get publicUrl(): string | null {
    return this._publicUrl;
  }

  /* ── Start ─────────────────────────────────────────────────────── */

  async start(): Promise<string> {
    this._status = { status: "starting" };

    // 1. Ensure frpc binary exists
    const frpcPath = await this.ensureFrpcBinary();
    this.logger.info(`[frp] using frpc binary: ${frpcPath}`);

    // 2. Find free port for admin API
    this.adminPort = await findFreePort();

    // 3. Try ports in random order from range
    const ports = shuffle(range(this.config.portRangeStart, this.config.portRangeEnd + 1));

    for (const port of ports) {
      try {
        const publicUrl = await this.tryStartWithPort(frpcPath, port);
        this._publicUrl = publicUrl;
        this._status = { status: "running", publicUrl, remotePort: port };

        // Start health monitoring
        this.startHealthCheck();

        return publicUrl;
      } catch (err) {
        this.logger.warn(
          `[frp] port ${port} unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Kill process if started, try next port
        await this.killProcess();
      }
    }

    this._status = {
      status: "error",
      reason: `all ports in range ${this.config.portRangeStart}-${this.config.portRangeEnd} exhausted`,
    };
    throw new Error(
      `FRP tunnel failed: all ports in range ${this.config.portRangeStart}-${this.config.portRangeEnd} are unavailable`,
    );
  }

  /* ── Stop ──────────────────────────────────────────────────────── */

  async stop(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    await this.killProcess();

    // Cleanup config file
    if (this.configPath) {
      try {
        await fs.unlink(this.configPath);
      } catch {
        // ignore if already removed
      }
    }

    this._status = { status: "stopped" };
    this._publicUrl = null;
  }

  /* ── Private: try a specific port ──────────────────────────────── */

  private async tryStartWithPort(frpcPath: string, remotePort: number): Promise<string> {
    const proxyName = `multiclaws-${randomBytes(4).toString("hex")}`;
    this.configPath = path.join(this.stateDir, "frpc.toml");

    const configContent = [
      `serverAddr = "${this.config.serverAddr}"`,
      `serverPort = ${this.config.serverPort}`,
      `auth.token = "${this.config.token}"`,
      ``,
      `webServer.addr = "127.0.0.1"`,
      `webServer.port = ${this.adminPort}`,
      ``,
      `[[proxies]]`,
      `name = "${proxyName}"`,
      `type = "tcp"`,
      `localIP = "127.0.0.1"`,
      `localPort = ${this.localPort}`,
      `remotePort = ${remotePort}`,
    ].join("\n");

    // Ensure stateDir exists
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(this.configPath, configContent, "utf8");

    // Spawn frpc
    this.frpcProcess = spawn(frpcPath, ["-c", this.configPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Capture stdout/stderr for logging
    this.frpcProcess.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.logger.info(`[frpc] ${line}`);
    });
    this.frpcProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.logger.warn(`[frpc:stderr] ${line}`);
    });

    this.frpcProcess.on("exit", (code, signal) => {
      if (this._status.status === "running") {
        this.logger.error(`[frp] frpc process exited unexpectedly (code=${code}, signal=${signal})`);
        this._status = { status: "error", reason: `frpc exited (code=${code})` };
      }
    });

    // Poll admin API to confirm proxy is running
    await this.waitForProxy(proxyName);

    return `http://${this.config.serverAddr}:${remotePort}`;
  }

  /* ── Private: poll admin API ──────────────────────────────────── */

  private async waitForProxy(proxyName: string): Promise<void> {
    const url = `http://127.0.0.1:${this.adminPort}/api/proxy/tcp`;

    for (let attempt = 0; attempt < ADMIN_API_POLL_MAX_RETRIES; attempt++) {
      await new Promise((r) => setTimeout(r, ADMIN_API_POLL_INTERVAL_MS));

      // Check if process has already exited
      if (!this.frpcProcess || this.frpcProcess.exitCode !== null) {
        throw new Error("frpc process exited before proxy became ready");
      }

      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        if (!res.ok) continue;

        // frpc 0.61.x admin API returns a flat array: [{name, status, ...}]
        const data = (await res.json()) as
          | Array<{ name: string; status: string; remote_addr?: string; err?: string }>
          | { proxies?: Array<{ name: string; status: string; remote_addr?: string; err?: string }> };

        const proxies = Array.isArray(data) ? data : data.proxies;
        const proxy = proxies?.find((p) => p.name === proxyName);
        if (!proxy) continue;

        if (proxy.status === "running") {
          this.logger.info(`[frp] proxy "${proxyName}" is running (remote_addr: ${proxy.remote_addr})`);
          return;
        }

        if (proxy.err) {
          throw new Error(`frp proxy error: ${proxy.err}`);
        }

        // status might be "new" or "wait_start" — keep polling
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("frp proxy error:")) {
          throw err;
        }
        // fetch failed (admin API not yet ready) — keep polling
      }
    }

    throw new Error("timeout waiting for frpc proxy to become running");
  }

  /* ── Private: health check ─────────────────────────────────────── */

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(async () => {
      if (this._status.status !== "running") return;

      try {
        const res = await fetch(
          `http://127.0.0.1:${this.adminPort}/api/proxy/tcp`,
          { signal: AbortSignal.timeout(5_000) },
        );
        if (!res.ok) {
          this.logger.warn("[frp] health check: admin API returned non-OK");
          this._status = { status: "error", reason: "admin API returned non-OK status" };
        }
      } catch {
        this.logger.warn("[frp] health check: failed to reach admin API");
        this._status = { status: "error", reason: "admin API unreachable" };
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    // Don't prevent Node from exiting
    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref();
    }
  }

  /* ── Private: kill process ─────────────────────────────────────── */

  private async killProcess(): Promise<void> {
    const proc = this.frpcProcess;
    if (!proc) return;
    this.frpcProcess = null;

    // Phase 1: graceful kill
    proc.kill();

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => proc.on("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PROCESS_KILL_TIMEOUT_MS)),
    ]);

    if (!exited) {
      // Phase 2: force kill
      try {
        if (process.platform === "win32" && proc.pid) {
          execSync(`taskkill /pid ${proc.pid} /f /t`, { stdio: "ignore" });
        } else {
          proc.kill("SIGKILL");
        }
      } catch {
        // process may have already exited
      }
    }
  }

  /* ── Private: ensure frpc binary ───────────────────────────────── */

  private async ensureFrpcBinary(): Promise<string> {
    const ext = process.platform === "win32" ? ".exe" : "";
    const localBinary = path.join(this.stateDir, `frpc${ext}`);

    // 1. Check stateDir
    try {
      await fs.access(localBinary);
      return localBinary;
    } catch {
      // not found locally
    }

    // 2. Check system PATH
    if (detectFrpc()) {
      return "frpc";
    }

    // 3. Auto-download
    this.logger.info(`[frp] frpc not found, downloading v${FRP_VERSION}...`);
    return await this.downloadFrpc(localBinary);
  }

  private async downloadFrpc(targetPath: string): Promise<string> {
    const { os: frpOs, arch: frpArch, ext } = getFrpPlatform();
    const archiveName = `frp_${FRP_VERSION}_${frpOs}_${frpArch}`;
    const url = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${archiveName}.${ext}`;

    const downloadDir = path.join(this.stateDir, "frpc-download");
    await fs.mkdir(downloadDir, { recursive: true });

    const archivePath = path.join(downloadDir, `${archiveName}.${ext}`);

    // Download
    this.logger.info(`[frp] downloading from ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`failed to download frpc: HTTP ${res.status} from ${url}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(archivePath, buffer);

    // Extract
    this.logger.info(`[frp] extracting ${archivePath}`);
    const binaryName = process.platform === "win32" ? "frpc.exe" : "frpc";

    try {
      if (ext === "tar.gz") {
        execSync(`tar -xzf "${archivePath}" -C "${downloadDir}"`, { stdio: "ignore" });
      } else {
        // Windows: use tar (available since Windows 10 1803)
        execSync(`tar -xf "${archivePath}" -C "${downloadDir}"`, { stdio: "ignore" });
      }

      // Move binary to target
      const extractedBinary = path.join(downloadDir, archiveName, binaryName);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(extractedBinary, targetPath);

      // Make executable on Unix
      if (process.platform !== "win32") {
        await fs.chmod(targetPath, 0o755);
      }

      this.logger.info(`[frp] frpc installed to ${targetPath}`);
    } finally {
      // Cleanup download directory
      try {
        await fs.rm(downloadDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }

    return targetPath;
  }
}
