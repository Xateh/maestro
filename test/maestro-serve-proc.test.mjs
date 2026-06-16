import test from "node:test";
import assert from "node:assert/strict";

import { isAlive, readStartTime, verifyIdentity } from "../src/cli/serve/proc.mjs";

test("isAlive is true for the current process, false for an unused pid", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2 ** 30), false); // pid that cannot exist
});

test("readStartTime returns a positive number for the current process on linux", () => {
  if (process.platform !== "linux") return; // /proc only
  const st = readStartTime(process.pid);
  assert.equal(typeof st, "number");
  assert.ok(st > 0);
});

test("verifyIdentity: matching record passes, wrong startTime fails", () => {
  if (process.platform !== "linux") return;
  const st = readStartTime(process.pid);
  assert.equal(verifyIdentity({ pid: process.pid, startTimeMs: st }, "web"), true);
  assert.equal(verifyIdentity({ pid: process.pid, startTimeMs: st + 999999 }, "web"), false);
});

test("verifyIdentity fails for a dead pid", () => {
  assert.equal(verifyIdentity({ pid: 2 ** 30, startTimeMs: 1 }, "web"), false);
});
