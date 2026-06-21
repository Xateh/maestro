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
  // capacity 1, refill 1000/sec ⇒ ~1ms per token. Two back-to-back acquires:
  // first immediate, second waits ~1ms.
  const lim = createProviderLimiter({ claude: { capacity: 1, refillPerSec: 1000 } });
  await lim.acquire("claude");
  const t0 = Date.now();
  await lim.acquire("claude");
  assert.ok(Date.now() - t0 >= 1);
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
