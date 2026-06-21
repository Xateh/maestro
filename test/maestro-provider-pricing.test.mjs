import assert from "node:assert/strict";
import { test } from "node:test";

import { priceFor } from "../src/provider-pricing.mjs";

test("priceFor returns undefined for unknown provider/model", () => {
  assert.equal(priceFor("nope", "nope", 1000), undefined);
});

test("priceFor estimates a non-negative cost for a known model", () => {
  const usd = priceFor("claude", "claude-opus-4-8", 1_000_000);
  assert.equal(typeof usd, "number");
  assert.ok(usd >= 0);
});

test("priceFor returns 0 for zero tokens on a known model", () => {
  assert.equal(priceFor("claude", "claude-opus-4-8", 0), 0);
});
