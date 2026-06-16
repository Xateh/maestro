import assert from "node:assert/strict";
import { test } from "node:test";

import { boundedTail, appendBoundedTail, createBoundedTail } from "../src/bounded-tail.mjs";

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

test("createBoundedTail: reassembles a multibyte codepoint split across chunks (F8)", () => {
  // "é" is 0xC3 0xA9 in UTF-8; split it across two writes.
  const bytes = Buffer.from("aé", "utf8"); // 61 c3 a9
  const tail = createBoundedTail(1024);
  tail.push(bytes.subarray(0, 2)); // "a" + first byte of é
  tail.push(bytes.subarray(2));    // second byte of é
  assert.equal(tail.value(), "aé", "split codepoint must reassemble, not mangle");
  // Per-chunk decode (the old behavior) would have produced replacement chars.
  const naive = bytes.subarray(0, 2).toString("utf8") + bytes.subarray(2).toString("utf8");
  assert.notEqual(naive, "aé");
});

test("createBoundedTail: still bounds to the last maxBytes", () => {
  const tail = createBoundedTail(4);
  tail.push(Buffer.from("abcdefghij", "utf8"));
  assert.equal(tail.value(), "ghij");
});
