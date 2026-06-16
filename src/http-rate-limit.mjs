// In-memory token-bucket rate limiter for the HTTP server. Zero deps, single
// process. Keyed by `${clientIp}:${routeClass}` so reads and writes get
// independent budgets per client. The clock is injectable so refill behaviour
// is unit-testable without sleeping.

const DEFAULT_MAX_BUCKETS = 10_000;

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now] - millisecond clock (default Date.now)
 * @param {number} [opts.maxBuckets] - sweep idle buckets once this many exist
 */
export function createRateLimiter({ now = Date.now, maxBuckets = DEFAULT_MAX_BUCKETS } = {}) {
  // key -> { tokens, updatedAt, capacity }
  const buckets = new Map();

  // Drop buckets that have refilled to full (idle) — they carry no state worth
  // keeping. Bounds memory when many distinct clients connect.
  function sweep() {
    for (const [key, bucket] of buckets) {
      if (bucket.tokens >= bucket.capacity) buckets.delete(key);
    }
  }

  // Last-resort bound: under a flood of distinct, all-active clients no bucket
  // is ever full, so sweep() frees nothing. Evict the least-recently-used one
  // so the map can never grow past maxBuckets. (F9)
  function evictOldest() {
    let oldestKey = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of buckets) {
      if (bucket.updatedAt < oldestTs) {
        oldestTs = bucket.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) buckets.delete(oldestKey);
  }

  /**
   * Consume one token for `key` under the given limits.
   * @returns {{ allowed: boolean, retryAfterMs: number }}
   */
  function check(key, { capacity, refillPerSec }) {
    const ts = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxBuckets) {
        sweep();
        if (buckets.size >= maxBuckets) evictOldest();
      }
      bucket = { tokens: capacity, updatedAt: ts, capacity };
      buckets.set(key, bucket);
    }
    // Refill based on elapsed time, capped at capacity.
    const elapsedSec = Math.max(0, (ts - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
    bucket.updatedAt = ts;
    bucket.capacity = capacity;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    // Time until one whole token is available.
    const deficit = 1 - bucket.tokens;
    const retryAfterMs = refillPerSec > 0 ? Math.ceil((deficit / refillPerSec) * 1000) : Infinity;
    return { allowed: false, retryAfterMs };
  }

  return { check, get size() { return buckets.size; } };
}
