import assert from "node:assert/strict";
import { test } from "node:test";

import { boundedTail, appendBoundedTail } from "../src/bounded-tail.mjs";

test("boundedTail: under cap returns text unchanged", () => {
  assert.equal(boundedTail("hello", 1024), "hello");
});

test("boundedTail: over cap keeps last maxBytes", () => {
  assert.equal(boundedTail("abcdefghij", 4), "ghij");
});

test("boundedTail: strips leading replacement char from split multibyte", () => {
  // "é" is 2 bytes (0xC3 0xA9); capping at 1 byte splits it -> stripped.
  const out = boundedTail("aé", 1);
  assert.equal(out, "");
});

test("boundedTail: handles null/undefined as empty string", () => {
  assert.equal(boundedTail(undefined, 4), "");
  assert.equal(boundedTail(null, 4), "");
});

test("appendBoundedTail: incremental concat then bound", () => {
  const out = appendBoundedTail("abcd", Buffer.from("efgh", "utf8"), 4);
  assert.equal(out, "efgh");
});

test("appendBoundedTail: under cap returns full concat", () => {
  const out = appendBoundedTail("ab", Buffer.from("cd", "utf8"), 1024);
  assert.equal(out, "abcd");
});
