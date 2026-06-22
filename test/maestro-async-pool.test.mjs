import assert from "node:assert/strict";
import { test } from "node:test";
import { runPool } from "../src/async-pool.mjs";

test("runPool caps concurrency and preserves input order", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fn = async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  };
  const results = await runPool([1, 2, 3, 4, 5], 2, fn);
  assert.equal(maxInFlight, 2);
  assert.deepEqual(results.map((r) => r.value), [2, 4, 6, 8, 10]);
  assert.ok(results.every((r) => r.status === "fulfilled"));
});

test("runPool reports rejections like allSettled, in order", async () => {
  const fn = async (n) => {
    if (n === 2) {
      throw new Error("boom");
    }
    return n;
  };
  const results = await runPool([1, 2, 3], 3, fn);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.message, "boom");
  assert.equal(results[2].value, 3);
});

test("runPool with limit >= length behaves like allSettled", async () => {
  const results = await runPool([1, 2], 10, async (n) => n);
  assert.deepEqual(results.map((r) => r.value), [1, 2]);
});
