import assert from "node:assert/strict";
import { test } from "node:test";
import { matchCommand } from "../src/ephemeral-policy.mjs";

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
