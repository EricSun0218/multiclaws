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

  reset(key: string): void {
    this.windows.delete(key);
  }

  destroy(): void {
    this.windows.clear();
  }
}
