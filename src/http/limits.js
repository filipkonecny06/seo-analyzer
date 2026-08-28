'use strict';

// Lightweight single-process admission controls protect the expensive analysis endpoint.

/**
 * Fixed-window rate limiter with a bounded in-memory key set.
 * It intentionally offers process-local protection; deployments needing shared limits must place a
 * distributed limiter or trusted reverse proxy in front of each instance.
 */
class InMemoryRateLimiter {
  /** @param {{limit?: number, windowMs?: number, maxEntries?: number, clock?: () => number}} [options] */
  constructor(options = {}) {
    this.limit = options.limit || 10;
    this.windowMs = options.windowMs || 60_000;
    this.maxEntries = options.maxEntries || 10_000;
    this.clock = options.clock || Date.now;
    this.entries = new Map();
  }

  /**
   * Records one attempt for a client key.
   *
   * @param {string} key
   * @returns {{allowed: boolean, remaining: number, retryAfterSeconds: number}}
   */
  consume(key) {
    const now = this.clock();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
    }
    entry.count += 1;
    // Reinsertion lets pruning remove expired entries from the oldest end and enforce the size bound.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.prune(now);

    return {
      allowed: entry.count <= this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    };
  }

  /** @param {number} now Removes expired entries and enforces the bound without a timer. */
  prune(now) {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now || this.entries.size > this.maxEntries) this.entries.delete(key);
      if (this.entries.size <= this.maxEntries && entry.resetAt > now) break;
    }
  }
}

/** Reject-only concurrency gate; callers never wait in an unbounded in-process queue. */
class ConcurrencyGate {
  constructor(limit = 4) {
    this.limit = limit;
    this.active = 0;
  }

  /**
   * Attempts to reserve one analysis slot.
   *
   * @returns {null|(() => void)} An idempotent release function, or null when at capacity.
   */
  tryAcquire() {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
    // Idempotence prevents duplicate cleanup paths from undercounting active requests.
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}

module.exports = {
  ConcurrencyGate,
  InMemoryRateLimiter
};
