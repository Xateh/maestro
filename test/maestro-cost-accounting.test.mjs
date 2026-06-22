import assert from "node:assert/strict";
import { test } from "node:test";

import { accumulateCost } from "../src/cost-accounting.mjs";

test("accumulateCost sums tokens across steps", () => {
  let t = { tokens: 0 };
  t = accumulateCost(t, { provider: "claude", model: "x", tokens: 100 });
  t = accumulateCost(t, { provider: "codex", model: "y", tokens: 50 });
  assert.equal(t.tokens, 150);
});

test("accumulateCost handles missing/zero tokens", () => {
  const t = accumulateCost({ tokens: 10 }, { provider: "claude", model: "x", tokens: undefined });
  assert.equal(t.tokens, 10);
});
