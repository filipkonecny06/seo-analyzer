'use strict';

class InMemoryRateLimiter {
  constructor(options = {}) {
    this.limit = options.limit || 10;
    this.windowMs = options.windowMs || 60_000;
    this.maxEntries = options.maxEntries || 10_000;
    this.clock = options.clock || Date.now;
    this.entries = new Map();
  }

  consume(key) {
    const now = this.clock();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
    }
    entry.count += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.prune(now);

    return {
      allowed: entry.count <= this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    };
  }

  prune(now) {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now || this.entries.size > this.maxEntries) this.entries.delete(key);
      if (this.entries.size <= this.maxEntries && entry.resetAt > now) break;
    }
  }
}

class ConcurrencyGate {
  constructor(limit = 4) {
    this.limit = limit;
    this.active = 0;
  }

  tryAcquire() {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
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
