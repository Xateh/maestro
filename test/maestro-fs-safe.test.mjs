// Tests for src/fs-safe.mjs — the extracted path-safe fs helpers shared by the
// MCP server and the artifact index.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertInsideDir, assertInsideDirReal, isInsideDirReal, listDir, tailFile } from "../src/fs-safe.mjs";

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

test("assertInsideDirReal rejects a symlink inside parent that points outside (F3)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fs-real-"));
  try {
    const parent = path.join(root, "runs");
    await mkdir(parent, { recursive: true });
    const outside = path.join(root, "secret.txt");
    await writeFile(outside, "TOP SECRET");
    const evil = path.join(parent, "evil.stdout.log");
    await symlink(outside, evil);

    // lexical check passes (evil is lexically inside parent)...
    assert.doesNotThrow(() => assertInsideDir(parent, evil));
    // ...but the realpath check rejects it, and the non-throwing form is false.
    await assert.rejects(() => assertInsideDirReal(parent, evil), /path_traversal/);
    assert.equal(await isInsideDirReal(parent, evil), false);

    // A genuine file inside parent still passes.
    const real = path.join(parent, "real.stdout.log");
    await writeFile(real, "ok");
    assert.equal(await isInsideDirReal(parent, real), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
