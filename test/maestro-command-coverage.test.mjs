import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commandRunner } from "../src/command-runner.mjs";

const TMP = join(tmpdir(), "maestro-cov-test-" + process.pid);

test("commandRunner with coverageSpec reads c8-json after exit", async () => {
  await mkdir(TMP, { recursive: true });
  const covFile = join(TMP, "coverage-summary.json");
  await writeFile(covFile, JSON.stringify({
    total: { lines: { pct: 91.5 } }
  }));

  const result = await commandRunner({
    run: "exit 0",
    cwd: TMP,
    timeoutMs: 5000,
    coverageSpec: { format: "c8-json", path: "coverage-summary.json" },
  });

  assert.equal(result.exit_code, 0);
  assert.equal(result.coverage_pct, 91.5);
  assert.equal(result.coverage_parse_error, undefined);

  await rm(TMP, { recursive: true, force: true });
});

test("commandRunner: missing coverage file → coverage_parse_error, no throw", async () => {
  await mkdir(TMP, { recursive: true });
  const result = await commandRunner({
    run: "exit 0",
    cwd: TMP,
    timeoutMs: 5000,
    coverageSpec: { format: "c8-json", path: "no-such-file.json" },
  });
  assert.equal(result.exit_code, 0);
  assert.ok(result.coverage_parse_error, "expected coverage_parse_error");
  assert.equal(result.coverage_pct, undefined);
  await rm(TMP, { recursive: true, force: true });
});

test("commandRunner: no coverageSpec → no coverage fields", async () => {
  const result = await commandRunner({
    run: "exit 0",
    cwd: tmpdir(),
    timeoutMs: 5000,
  });
  assert.equal(result.coverage_pct, undefined);
  assert.equal(result.coverage_parse_error, undefined);
});
