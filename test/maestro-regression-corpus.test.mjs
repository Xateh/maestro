/**
 * Unit tests for the SP4 regressionStore default fs impl + pure helpers:
 *   src/regression-corpus.mjs — slug / shortHash / deriveCaseId / loadCorpus /
 *   promoteFailures. Disk tests are hermetic (os.tmpdir).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  slug,
  shortHash,
  deriveCaseId,
  loadCorpus,
  promoteFailures,
} from "../src/regression-corpus.mjs";

// ── deriveCaseId / slug / shortHash ──────────────────────────────────────────

test("deriveCaseId: deterministic + stable for same {name, run}", () => {
  const f = { name: "lint", run: "npm run lint" };
  assert.equal(deriveCaseId(f), deriveCaseId({ ...f }));
});

test("deriveCaseId: distinct run ⇒ distinct id; distinct name ⇒ distinct id", () => {
  const base = { name: "lint", run: "a" };
  assert.notEqual(deriveCaseId(base), deriveCaseId({ name: "lint", run: "b" }));
  assert.notEqual(deriveCaseId(base), deriveCaseId({ name: "typecheck", run: "a" }));
});

test("slug: empty/undefined ⇒ stable non-empty 'case'", () => {
  assert.equal(slug(undefined), "case");
  assert.equal(slug(""), "case");
  assert.equal(slug("!!!"), "case");
});

test("slug: spaces / non-ascii collapse to '-'", () => {
  assert.equal(slug("Run Lint Now"), "run-lint-now");
  assert.equal(slug("café tests"), "caf-tests");
});

test("shortHash: 6 hex chars, stable", () => {
  const h = shortHash("npm run lint");
  assert.match(h, /^[0-9a-f]{6}$/);
  assert.equal(h, shortHash("npm run lint"));
});

// ── loadCorpus ───────────────────────────────────────────────────────────────

test("loadCorpus: missing dir ⇒ empty, no error", async () => {
  const res = await loadCorpus(path.join(tmpdir(), `does-not-exist-${Date.now()}`));
  assert.deepEqual(res, { cases: [], loadErrors: [] });
});

test("loadCorpus: malformed file + invalid-shape file ⇒ loadErrors; valid case kept", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-corpus-"));
  try {
    await writeFile(path.join(dir, "a-valid.json"), JSON.stringify({
      id: "lint-aaa", command: { run: "npm run lint" },
    }));
    await writeFile(path.join(dir, "b-broken.json"), "not json{");
    await writeFile(path.join(dir, "c-noshape.json"), JSON.stringify({ id: "x", command: {} }));
    const res = await loadCorpus(dir);
    assert.equal(res.cases.length, 1);
    assert.equal(res.cases[0].id, "lint-aaa");
    assert.equal(res.loadErrors.length, 2);
    const files = res.loadErrors.map((e) => path.basename(e.file)).sort();
    assert.deepEqual(files, ["b-broken.json", "c-noshape.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadCorpus: only reads *.json, sorted deterministically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-corpus-"));
  try {
    await writeFile(path.join(dir, "z.json"), JSON.stringify({ id: "z", command: { run: "z" } }));
    await writeFile(path.join(dir, "a.json"), JSON.stringify({ id: "a", command: { run: "a" } }));
    await writeFile(path.join(dir, "ignore.txt"), "nope");
    const res = await loadCorpus(dir);
    assert.deepEqual(res.cases.map((c) => c.id), ["a", "z"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── promoteFailures (fs round-trip) ──────────────────────────────────────────

test("promoteFailures: writes two distinct failures; loadCorpus reads them back", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-corpus-"));
  try {
    const failures = [
      { name: "lint", run: "npm run lint", category: "lint" },
      { name: "test", run: "npm test", category: "unit" },
    ];
    const res = await promoteFailures({ dir, failures, date: "2026-06-14", taskId: "t1" });
    assert.equal(res.promoted.length, 2);
    assert.equal(res.writeErrors.length, 0);
    assert.ok(res.promoted[0].path.endsWith(".json"));
    assert.equal(res.promoted[0].source, "evaluation.failures");

    const loaded = await loadCorpus(dir);
    assert.equal(loaded.cases.length, 2);
    const runs = loaded.cases.map((c) => c.command.run).sort();
    assert.deepEqual(runs, ["npm run lint", "npm test"]);
    // written file is valid JSON ending with newline
    const raw = await readFile(res.promoted[0].path, "utf8");
    assert.ok(raw.endsWith("\n"));
    assert.equal(JSON.parse(raw).origin_task, "t1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("promoteFailures: existingIds skips already-present id", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-corpus-"));
  try {
    const failure = { name: "lint", run: "npm run lint" };
    const id = deriveCaseId(failure);
    const res = await promoteFailures({ dir, failures: [failure], existingIds: new Set([id]) });
    assert.equal(res.promoted.length, 0);
    const loaded = await loadCorpus(dir);
    assert.equal(loaded.cases.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("promoteFailures: idempotent — second call with same input writes nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-corpus-"));
  try {
    const failures = [{ name: "lint", run: "npm run lint" }];
    const first = await promoteFailures({ dir, failures });
    assert.equal(first.promoted.length, 1);
    const existing = new Set((await loadCorpus(dir)).cases.map((c) => c.id));
    const second = await promoteFailures({ dir, failures, existingIds: existing });
    assert.equal(second.promoted.length, 0);
    assert.equal((await loadCorpus(dir)).cases.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("promoteFailures: dedups within a single batch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-corpus-"));
  try {
    const failures = [
      { name: "lint", run: "npm run lint" },
      { name: "lint", run: "npm run lint" }, // same id
    ];
    const res = await promoteFailures({ dir, failures });
    assert.equal(res.promoted.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("promoteFailures: write failure tolerated (dir path is a file) ⇒ writeErrors, no throw", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "maestro-corpus-"));
  try {
    // Make `dir` point at an existing FILE so mkdir(dir) fails (ENOTDIR/EEXIST).
    const filePath = path.join(base, "not-a-dir");
    await writeFile(filePath, "x");
    const res = await promoteFailures({ dir: filePath, failures: [{ name: "lint", run: "npm run lint" }] });
    assert.equal(res.promoted.length, 0);
    assert.equal(res.writeErrors.length, 1);
    assert.ok(res.writeErrors[0].id);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("promoteFailures: empty/absent failures ⇒ no-op", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-corpus-"));
  try {
    assert.deepEqual(await promoteFailures({ dir, failures: [] }), { promoted: [], writeErrors: [] });
    assert.deepEqual(await promoteFailures({ dir }), { promoted: [], writeErrors: [] });
    // nothing written
    await mkdir(dir, { recursive: true });
    assert.equal((await loadCorpus(dir)).cases.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
