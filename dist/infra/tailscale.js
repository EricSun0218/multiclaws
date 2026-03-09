"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureTailscale = ensureTailscale;
const node_child_process_1 = require("node:child_process");
const node_os_1 = __importDefault(require("node:os"));
function run(cmd, timeoutMs = 10_000) {
    return (0, node_child_process_1.execSync)(cmd, { timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] })
        .toString()
        .trim();
}
function commandExists(cmd) {
    try {
        run(`which ${cmd}`);
        return true;
    }
    catch {
        return false;
    }
}
function getTailscaleIp() {
    // First: check network interfaces for Tailscale IP (100.x.x.x)
    const interfaces = node_os_1.default.networkInterfaces();
    for (const addrs of Object.values(interfaces)) {
        if (!addrs)
            continue;
        for (const addr of addrs) {
            if (addr.family === "IPv4" && addr.address.startsWith("100.")) {
                return addr.address;
            }
        }
    }
    // Fallback: ask tailscale CLI
    try {
        const ip = run("tailscale ip -4", 5_000).split("\n")[0];
        return ip || null;
    }
    catch {
        return null;
    }
}
function isAuthenticated() {
    try {
        const out = run("tailscale status --json", 5_000);
        const json = JSON.parse(out);
        return json.BackendState === "Running";
    }
    catch {
        return false;
    }
}
async function install(logger) {
    const platform = node_os_1.default.platform();
    logger.info("[tailscale] Tailscale not found, installing...");
    try {
        if (platform === "darwin") {
            if (commandExists("brew")) {
                logger.info("[tailscale] Installing via Homebrew...");
                run("brew install tailscale", 120_000);
                run("sudo brew services start tailscale", 15_000);
            }
            else {
                logger.warn("[tailscale] Homebrew not found. Please install Tailscale manually: https://tailscale.com/download/mac");
                return false;
            }
        }
        else if (platform === "linux") {
            logger.info("[tailscale] Installing via official script...");
            run("curl -fsSL https://tailscale.com/install.sh | sh", 120_000);
            run("sudo systemctl enable --now tailscaled", 15_000);
        }
        else {
            logger.warn(`[tailscale] Auto-install not supported on ${platform}. Please install manually: https://tailscale.com/download`);
            return false;
        }
        logger.info("[tailscale] Tailscale installed successfully.");
        return true;
    }
    catch (err) {
        logger.error(`[tailscale] Installation failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
function startAuth(logger) {
    return new Promise((resolve) => {
        logger.info("[tailscale] Starting Tailscale authentication...");
        const proc = (0, node_child_process_1.spawn)("tailscale", ["up", "--accept-routes"], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let resolved = false;
        const tryResolve = (text) => {
            const match = text.match(/https:\/\/login\.tailscale\.com\/[^\s]+/);
            if (match && !resolved) {
                resolved = true;
                resolve(match[0]);
            }
        };
        proc.stdout?.on("data", (d) => { output += d.toString(); tryResolve(output); });
        proc.stderr?.on("data", (d) => { output += d.toString(); tryResolve(output); });
        proc.on("close", () => { if (!resolved)
            resolve(null); });
        // Timeout after 10s waiting for URL
        setTimeout(() => { if (!resolved) {
            resolved = true;
            resolve(null);
        } }, 10_000);
    });
}
/**
 * Ensure Tailscale is installed and authenticated.
 * Returns the Tailscale IP if ready, or auth URL if login is needed.
 */
async function ensureTailscale(logger) {
    // 1. Check if already have a Tailscale IP (fastest path)
    const existingIp = getTailscaleIp();
    if (existingIp) {
        logger.info(`[tailscale] Using Tailscale IP: ${existingIp}`);
        return { status: "ready", ip: existingIp };
    }
    // 2. Install if missing
    if (!commandExists("tailscale")) {
        const installed = await install(logger);
        if (!installed) {
            return { status: "unavailable", reason: "installation failed or not supported" };
        }
    }
    // 3. Check auth
    if (isAuthenticated()) {
        const ip = getTailscaleIp();
        if (ip) {
            logger.info(`[tailscale] Using Tailscale IP: ${ip}`);
            return { status: "ready", ip };
        }
    }
    // 4. Need auth — get the login URL
    const authUrl = await startAuth(logger);
    if (authUrl) {
        return { status: "needs_auth", authUrl };
    }
    return { status: "unavailable", reason: "could not obtain auth URL" };
}
