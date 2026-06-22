import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderLimiter } from "../src/provider-rate-limit.mjs";

test("acquire is immediate when provider has no configured limit", async () => {
  const lim = createProviderLimiter({});
  const t0 = Date.now();
  await lim.acquire("claude");
  assert.ok(Date.now() - t0 < 20);
});

test("acquire backs off when a provider's bucket is empty", async () => {
  // capacity 1, refill 50/sec ⇒ ~20ms per token. Two back-to-back acquires:
  // first immediate, second waits ~20ms. A coarse interval keeps the lower-bound
  // assertion robust on fast CI runners (setTimeout never fires early), where a
  // ~1ms backoff would round to 0 against Date.now()'s millisecond granularity.
  const lim = createProviderLimiter({ claude: { capacity: 1, refillPerSec: 50 } });
  await lim.acquire("claude");
  const t0 = Date.now();
  await lim.acquire("claude");
  assert.ok(Date.now() - t0 >= 10);
});

test("providers limit independently", async () => {
  const lim = createProviderLimiter({
    claude: { capacity: 1, refillPerSec: 1 },
    codex: { capacity: 1, refillPerSec: 1 },
  });
  await lim.acquire("claude");
  const t0 = Date.now();
  await lim.acquire("codex"); // codex bucket still full ⇒ immediate
  assert.ok(Date.now() - t0 < 20);
});
