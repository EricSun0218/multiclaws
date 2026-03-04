"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = void 0;
/**
 * Simple sliding-window rate limiter keyed by peer ID.
 * Returns true if the request should be allowed, false if rate-limited.
 */
class RateLimiter {
    windowMs;
    maxRequests;
    windows = new Map();
    constructor(opts) {
        this.windowMs = opts?.windowMs ?? 60_000;
        this.maxRequests = opts?.maxRequests ?? 60;
    }
    allow(key) {
        const now = Date.now();
        const cutoff = now - this.windowMs;
        let timestamps = this.windows.get(key);
        if (!timestamps) {
            timestamps = [];
            this.windows.set(key, timestamps);
        }
        // Remove expired entries
        while (timestamps.length > 0 && timestamps[0] < cutoff) {
            timestamps.shift();
        }
        if (timestamps.length >= this.maxRequests) {
            return false;
        }
        timestamps.push(now);
        return true;
    }
    reset(key) {
        this.windows.delete(key);
    }
    destroy() {
        this.windows.clear();
    }
}
exports.RateLimiter = RateLimiter;
