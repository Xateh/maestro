// Per-provider call limiter built on the existing token bucket. One limiter
// instance for the whole run; keyed by provider. A provider with no configured
// limit is always allowed (today's behavior). Generalizes the SP9 GitHub backoff.

import { createRateLimiter } from "./http-rate-limit.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createProviderLimiter(limitsByProvider = {}, { now = Date.now } = {}) {
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
