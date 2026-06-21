import assert from "node:assert/strict";
import { test } from "node:test";
import { matchCommand, gatesAreWeaker } from "../src/ephemeral-policy.mjs";

test("matchCommand exact match (whitespace-normalized)", () => {
  assert.equal(matchCommand("npm test", ["npm test"]), true);
  assert.equal(matchCommand("npm  test", ["npm test"]), true);
  assert.equal(matchCommand("npm test --watch", ["npm test"]), false);
});

test("matchCommand prefix via trailing ' *'", () => {
  assert.equal(matchCommand("npm run lint", ["npm run *"]), true);
  assert.equal(matchCommand("npm run build:prod", ["npm run *"]), true);
  assert.equal(matchCommand("pnpm run lint", ["npm run *"]), false);
});

test("matchCommand regex via 're:' prefix", () => {
  assert.equal(matchCommand("pytest", ["re:^pytest( .*)?$"]), true);
  assert.equal(matchCommand("pytest -q tests/", ["re:^pytest( .*)?$"]), true);
  assert.equal(matchCommand("rm -rf /", ["re:^pytest( .*)?$"]), false);
});

test("matchCommand returns false against an empty allowlist", () => {
  assert.equal(matchCommand("npm test", []), false);
});

test("gatesAreWeaker flags disabling a baseline-true boolean gate", () => {
  const reasons = gatesAreWeaker(
    { require_distinct_reviewer: false },
    { require_distinct_reviewer: true },
  );
  assert.equal(reasons.length, 1);
});

test("gatesAreWeaker flags a min_coverage below baseline", () => {
  assert.equal(gatesAreWeaker({ min_coverage: 50 }, { min_coverage: 80 }).length, 1);
});

test("gatesAreWeaker allows equal-or-stricter gates", () => {
  assert.deepEqual(gatesAreWeaker(
    { min_coverage: 90, require_distinct_reviewer: true },
    { min_coverage: 80, require_distinct_reviewer: true },
  ), []);
});

test("gatesAreWeaker ignores gates the baseline does not pin", () => {
  assert.deepEqual(gatesAreWeaker({ min_coverage: 10 }, {}), []);
});
