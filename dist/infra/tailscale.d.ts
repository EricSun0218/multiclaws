export type TailscaleStatus = {
    status: "ready";
    ip: string;
} | {
    status: "needs_auth";
    authUrl: string;
} | {
    status: "not_installed";
} | {
    status: "unavailable";
    reason: string;
};
/**
 * Detect Tailscale status — does NOT install or modify system state.
 * Returns one of: ready | needs_auth | not_installed | unavailable
 */
export declare function detectTailscale(): Promise<TailscaleStatus>;
