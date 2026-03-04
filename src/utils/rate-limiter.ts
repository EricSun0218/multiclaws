/**
 * Simple sliding-window rate limiter keyed by peer ID.
 * Returns true if the request should be allowed, false if rate-limited.
 */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly windows = new Map<string, number[]>();

  constructor(opts?: { windowMs?: number; maxRequests?: number }) {
    this.windowMs = opts?.windowMs ?? 60_000;
    this.maxRequests = opts?.maxRequests ?? 60;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Binary search for the first timestamp within the window, then
    // bulk-remove all expired entries in one splice (O(log n) + O(k)).
    let lo = 0;
    let hi = timestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (timestamps[mid] < cutoff) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) timestamps.splice(0, lo);

    if (timestamps.length >= this.maxRequests) {
      return false;
    }
    timestamps.push(now);
    return true;
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  destroy(): void {
    this.windows.clear();
  }
}
