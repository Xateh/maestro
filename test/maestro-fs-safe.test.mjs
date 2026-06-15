// Tests for src/fs-safe.mjs — the extracted path-safe fs helpers shared by the
// MCP server and the artifact index.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertInsideDir, listDir, tailFile } from "../src/fs-safe.mjs";

test("tailFile bounds output to maxBytes and returns the file's suffix", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fs-safe-"));
  try {
    const file = path.join(dir, "big.log");
    const content = `${"x".repeat(100)}TAIL-END`;
    await writeFile(file, content);
    const maxBytes = 16;
    const out = await tailFile(file, maxBytes);
    assert.ok(out.length <= maxBytes, `tail length ${out.length} exceeds ${maxBytes}`);
    assert.equal(out, content.slice(-maxBytes));
    assert.match(out, /TAIL-END$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailFile returns null for a missing file", async () => {
  const out = await tailFile(path.join(tmpdir(), "does-not-exist-xyz.log"));
  assert.equal(out, null);
});

test("listDir returns [] for a missing directory and names for a real one", async () => {
  const missing = await listDir(path.join(tmpdir(), "no-such-dir-xyz"));
  assert.deepEqual(missing, []);

  const dir = await mkdtemp(path.join(tmpdir(), "fs-safe-list-"));
  try {
    await writeFile(path.join(dir, "a.txt"), "a");
    await writeFile(path.join(dir, "b.txt"), "b");
    const names = await listDir(dir);
    assert.deepEqual(names.slice().sort(), ["a.txt", "b.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("assertInsideDir allows paths inside and throws on traversal / absolute escape", () => {
  const parent = "/tmp/maestro/runs";
  assert.doesNotThrow(() => assertInsideDir(parent, "/tmp/maestro/runs/task-1/out.log"));
  assert.throws(() => assertInsideDir(parent, "/tmp/maestro/runs/../secret"), /path_traversal/);
  assert.throws(() => assertInsideDir(parent, "/etc/passwd"), /path_traversal/);
});
