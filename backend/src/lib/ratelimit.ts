/**
 * In-process fixed-window counters.
 *
 * Used for per-device ingest and per-user proxy limits, which are keyed by
 * something the HTTP-level IP limiter cannot see. State is per instance: with a
 * single Fly machine that is exact, and if the service is ever scaled
 * horizontally the effective limit multiplies by the instance count. That is an
 * acceptable ceiling for abuse control; moving to Redis is the fix if the
 * limits ever need to be exact across instances.
 */
interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  readonly #windows = new Map<string, Window>();
  readonly #limit: number;
  readonly #windowMs: number;
  #lastSweep = Date.now();

  constructor(limit: number, windowMs = 60_000) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** Returns the outcome and, when blocked, seconds until the window resets. */
  check(key: string): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const now = Date.now();
    this.#sweep(now);

    const existing = this.#windows.get(key);

    if (!existing || existing.resetAt <= now) {
      this.#windows.set(key, { count: 1, resetAt: now + this.#windowMs });
      return { allowed: true, remaining: this.#limit - 1, retryAfterSeconds: 0 };
    }

    if (existing.count >= this.#limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: this.#limit - existing.count,
      retryAfterSeconds: 0,
    };
  }

  /** Drop stale windows so an attacker cannot grow the map without bound. */
  #sweep(now: number): void {
    if (now - this.#lastSweep < this.#windowMs) return;
    this.#lastSweep = now;
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key);
    }
  }

  reset(): void {
    this.#windows.clear();
  }
}
