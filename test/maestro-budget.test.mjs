import assert from "node:assert/strict";
import { test } from "node:test";
import { validateBudget, clampBudget } from "../src/budget.mjs";

test("validateBudget accepts positive fields and an empty budget", () => {
  assert.equal(validateBudget({}, {}).ok, true);
  assert.equal(validateBudget({ tokens: 1000, usd: 5, wall_clock_ms: 60000 }, {}).ok, true);
});

test("validateBudget rejects non-positive / non-numeric fields", () => {
  const r = validateBudget({ tokens: 0 }, {});
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "bad_budget_spec");
  assert.equal(validateBudget({ usd: "x" }, {}).errors[0].code, "bad_budget_spec");
});

test("validateBudget rejects a run cap below the operator floor", () => {
  const r = validateBudget({ tokens: 100 }, { floor: { tokens: 1000 } });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "budget_below_floor");
});

test("clampBudget lowers fields to the operator ceiling", () => {
  const c = clampBudget({ tokens: 10_000 }, { tokens: 5_000 });
  assert.equal(c.tokens, 5_000);
});

test("clampBudget leaves fields under the ceiling untouched", () => {
  const c = clampBudget({ tokens: 1_000 }, { tokens: 5_000 });
  assert.equal(c.tokens, 1_000);
});
