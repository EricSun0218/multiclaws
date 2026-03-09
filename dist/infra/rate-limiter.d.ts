/**
 * Simple sliding-window rate limiter keyed by peer ID.
 * Returns true if the request should be allowed, false if rate-limited.
 * Periodically prunes empty/stale keys to prevent unbounded memory growth.
 */
export declare class RateLimiter {
    private readonly windowMs;
    private readonly maxRequests;
    private readonly windows;
    private pruneTimer;
    constructor(opts?: {
        windowMs?: number;
        maxRequests?: number;
    });
    allow(key: string): boolean;
    reset(key: string): void;
    destroy(): void;
    private pruneStaleKeys;
}
