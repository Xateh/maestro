// Tests for src/artifacts.mjs — classifyArtifact / buildArtifactIndex /
// resolveArtifact (the derived run_dir artifact index).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildArtifactIndex, classifyArtifact, compareArtifactIndexes, resolveArtifact } from "../src/artifacts.mjs";

test("classifyArtifact maps every known filename pattern", () => {
  assert.deepEqual(classifyArtifact("handoff.implementation.json"), { role: "implementation", kind: "handoff" });
  assert.deepEqual(classifyArtifact("implementation.stdout.log"), { role: "implementation", kind: "stdout" });
  assert.deepEqual(classifyArtifact("review.stderr.log"), { role: "review", kind: "stderr" });
  assert.deepEqual(classifyArtifact("planner.command.json"), { role: "planner", kind: "command" });
  assert.deepEqual(classifyArtifact("executor.prompt.txt"), { role: "executor", kind: "prompt" });
  assert.deepEqual(classifyArtifact("executor.exit.txt"), { role: "executor", kind: "exit" });
});

test("classifyArtifact returns {role:null,kind:'other'} for unknown names", () => {
  assert.deepEqual(classifyArtifact("notes.md"), { role: null, kind: "other" });
  assert.deepEqual(classifyArtifact(""), { role: null, kind: "other" });
  assert.deepEqual(classifyArtifact(undefined), { role: null, kind: "other" });
});

test("buildArtifactIndex returns entries with correct kind/bytes/sha256 and joined status", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "artifacts-"));
  try {
    const handoff = JSON.stringify({ summary: "did it" });
    const stdout = "hello world stdout log content";
    const other = "loose file";
    await writeFile(path.join(dir, "handoff.implementation.json"), handoff);
    await writeFile(path.join(dir, "implementation.stdout.log"), stdout);
    await writeFile(path.join(dir, "notes.md"), other);

    const task = {
      run_dir: dir,
      steps: [
        { role: "implementation", status: "running" },
        { role: "implementation", status: "succeeded" }, // later wins
      ],
    };
    const entries = await buildArtifactIndex(task);
    assert.equal(entries.length, 3);

    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    const ho = byName["handoff.implementation.json"];
    assert.equal(ho.kind, "handoff");
    assert.equal(ho.role, "implementation");
    assert.equal(ho.bytes, Buffer.byteLength(handoff));
    assert.equal(ho.status, "succeeded"); // later step wins
    assert.equal(ho.sha256, createHash("sha256").update(handoff).digest("hex"));

    const so = byName["implementation.stdout.log"];
    assert.equal(so.kind, "stdout");
    assert.equal(so.sha256, createHash("sha256").update(stdout).digest("hex"));

    const no = byName["notes.md"];
    assert.equal(no.kind, "other");
    assert.equal(no.role, null);
    assert.equal(no.status, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildArtifactIndex returns [] for a missing/absent run_dir", async () => {
  assert.deepEqual(await buildArtifactIndex({ run_dir: path.join(tmpdir(), "no-such-rundir-xyz") }), []);
  assert.deepEqual(await buildArtifactIndex({}), []);
  assert.deepEqual(await buildArtifactIndex(null), []);
});

test("buildArtifactIndex degrades sha256 to null when hashing throws, never throws", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "artifacts-hash-"));
  try {
    await writeFile(path.join(dir, "review.stdout.log"), "data");
    const entries = await buildArtifactIndex(
      { run_dir: dir, steps: [] },
      { hash: () => { throw new Error("boom"); } },
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sha256, null);
    assert.ok(Number.isInteger(entries[0].bytes));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveArtifact resolves by <role>.<kind> and by raw filename to the same entry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "artifacts-resolve-"));
  try {
    await writeFile(path.join(dir, "implementation.stdout.log"), "out");
    const task = { run_dir: dir, steps: [] };

    const bySelector = await resolveArtifact(task, "implementation.stdout");
    const byName = await resolveArtifact(task, "implementation.stdout.log");
    assert.ok(bySelector);
    assert.ok(byName);
    assert.equal(bySelector.path, byName.path);
    assert.equal(bySelector.entry.kind, "stdout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveArtifact returns null for traversal and unknown selectors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "artifacts-safe-"));
  try {
    await writeFile(path.join(dir, "executor.stdout.log"), "out");
    const task = { run_dir: dir, steps: [] };
    assert.equal(await resolveArtifact(task, "../escape"), null);
    assert.equal(await resolveArtifact(task, "../../etc/passwd"), null);
    assert.equal(await resolveArtifact(task, "nope.nope"), null);
    assert.equal(await resolveArtifact(task, ""), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── compareArtifactIndexes (SP6c) ────────────────────────────────────────────

const ENTRY = (role, kind, sha256) => ({ role, kind, sha256 });

test("compareArtifactIndexes: identical indexes ⇒ all MATCH", () => {
  const a = [ENTRY("impl", "command", "h1"), ENTRY("impl", "prompt", "h2")];
  const b = [ENTRY("impl", "command", "h1"), ENTRY("impl", "prompt", "h2")];
  const rows = compareArtifactIndexes(a, b);
  assert.deepEqual(rows.map((r) => r.result), ["MATCH", "MATCH"]);
});

test("compareArtifactIndexes: command/prompt MATCH while stdout DIFFERs", () => {
  const a = [ENTRY("impl", "command", "X"), ENTRY("impl", "prompt", "P"), ENTRY("impl", "stdout", "Y1")];
  const b = [ENTRY("impl", "command", "X"), ENTRY("impl", "prompt", "P"), ENTRY("impl", "stdout", "Y2")];
  const rows = compareArtifactIndexes(a, b);
  const byKey = Object.fromEntries(rows.map((r) => [`${r.role}.${r.kind}`, r.result]));
  assert.equal(byKey["impl.command"], "MATCH");
  assert.equal(byKey["impl.prompt"], "MATCH");
  assert.equal(byKey["impl.stdout"], "DIFFER");
});

test("compareArtifactIndexes: one-sided entries ⇒ ONLY-1 / ONLY-2", () => {
  const a = [ENTRY("planner", "command", "h")];
  const b = [ENTRY("reviewer", "stdout", "z")];
  const rows = compareArtifactIndexes(a, b);
  const byKey = Object.fromEntries(rows.map((r) => [`${r.role}.${r.kind}`, r.result]));
  assert.equal(byKey["planner.command"], "ONLY-1");
  assert.equal(byKey["reviewer.stdout"], "ONLY-2");
});

test("compareArtifactIndexes: null shas ⇒ DIFFER (never throws); empty ⇒ []", () => {
  assert.deepEqual(compareArtifactIndexes(undefined, null), []);
  assert.deepEqual(compareArtifactIndexes([], []), []);
  const rows = compareArtifactIndexes([ENTRY("r", "stdout", null)], [ENTRY("r", "stdout", null)]);
  assert.equal(rows[0].result, "DIFFER");
});

test("compareArtifactIndexes: deterministic order (sorted by role then kind)", () => {
  const a = [ENTRY("z", "stdout", "1"), ENTRY("a", "prompt", "2"), ENTRY("a", "command", "3")];
  const rows = compareArtifactIndexes(a, a);
  assert.deepEqual(
    rows.map((r) => `${r.role}.${r.kind}`),
    ["a.command", "a.prompt", "z.stdout"],
  );
});
