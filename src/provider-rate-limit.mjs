// Per-provider call limiter built on the existing token bucket. One limiter
// instance for the whole run; keyed by provider. A provider with no configured
// limit is always allowed (today's behavior). Generalizes the SP9 GitHub backoff.

import { createRateLimiter } from "./http-rate-limit.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createProviderLimiter(limitsByProvider = {}, { now = Date.now } = {}) {
  // Validate at construction: a non-positive refillPerSec means a drained bucket
  // never refills, so acquire() would busy-spin forever (retryAfterMs=Infinity).
  for (const [provider, limit] of Object.entries(limitsByProvider)) {
    if (!limit) continue;
    if (!(Number(limit.capacity) > 0) || !(Number(limit.refillPerSec) > 0)) {
      throw new Error(`invalid_provider_rate_limit: ${provider} capacity and refillPerSec must be > 0`);
    }
  }
  const bucket = createRateLimiter({ now });
  async function acquire(provider) {
    const limit = limitsByProvider[provider];
    if (!limit) return;
    // Retry until a token frees up; bounded by retryAfterMs each loop.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { allowed, retryAfterMs } = bucket.check(provider, {
        capacity: limit.capacity,
        refillPerSec: limit.refillPerSec,
      });
      if (allowed) return;
      await sleep(Math.min(retryAfterMs, 1000));
    }
  }
  return { acquire };
}
