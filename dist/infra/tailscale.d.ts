export type TailscaleResult = {
    status: "ready";
    ip: string;
} | {
    status: "needs_auth";
    authUrl: string;
} | {
    status: "unavailable";
    reason: string;
};
type Logger = {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
};
/**
 * Ensure Tailscale is installed and authenticated.
 * Returns the Tailscale IP if ready, or auth URL if login is needed.
 */
export declare function ensureTailscale(logger: Logger): Promise<TailscaleResult>;
export {};
