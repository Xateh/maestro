import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runLocalMaestroCommand } from "../bin/maestro.mjs";
import { LocalTaskStore } from "../src/task-store.mjs";
import {
  findUnknownFlags,
  parseActionArgs,
  parseEditActionArgs,
  parseInspectArgs,
  parseProjectArgs,
  parseTaskArgs,
} from "../src/cli/parse-args.mjs";

const CWD = "/tmp/maestro-args-test";

async function withTempStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-args-"));
  const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
  try {
    return await fn({ dir, store });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function captureWriter() {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join("") };
}

// --- findUnknownFlags utility -------------------------------------------------

test("findUnknownFlags returns only unrecognized --flags", () => {
  const result = findUnknownFlags(
    ["--json", "positional", "--bogus", "-x", "--also-bad"],
    new Set(["--json"]),
  );
  assert.deepEqual(result, ["--bogus", "--also-bad"]);
});

test("findUnknownFlags ignores positionals and short flags", () => {
  assert.deepEqual(findUnknownFlags(["plain", "-v", "value"], new Set()), []);
});

test("findUnknownFlags returns empty when every flag is known", () => {
  assert.deepEqual(
    findUnknownFlags(["--yes", "--dry-run"], new Set(["--yes", "--dry-run"])),
    [],
  );
});

// --- parseTaskArgs throws on unknown flags -----------------------------------

test("parseTaskArgs throws unknown_flag for an unrecognized --flag", () => {
  assert.throws(
    () => parseTaskArgs(["task", "--bogus", "do", "something"], CWD),
    /unknown_flag: --bogus/,
  );
});

test("parseTaskArgs error hints at using -- for literal text", () => {
  assert.throws(
    () => parseTaskArgs(["task", "--nope", "hello"], CWD),
    /use -- to pass literal text/,
  );
});

test("parseTaskArgs treats --flags after -- as literal prompt text", () => {
  const parsed = parseTaskArgs(["task", "--", "fix", "--the", "--bug"], CWD);
  assert.equal(parsed.prompt, "fix --the --bug");
});

test("parseTaskArgs still accepts recognized flags", () => {
  const parsed = parseTaskArgs(
    ["task", "--plan-only", "--planner", "off", "ship", "it"],
    CWD,
  );
  assert.equal(parsed.mode, "plan-only");
  assert.equal(parsed.plannerPolicy, "off");
  assert.equal(parsed.prompt, "ship it");
});

// --- collecting parsers expose unknownFlags ----------------------------------

test("parseActionArgs collects unknown flags and keeps positionals separate", () => {
  const parsed = parseActionArgs(
    ["approve", "task-1", "--bogus", "--note", "ok", "--also-bad"],
    CWD,
  );
  assert.deepEqual(parsed.unknownFlags, ["--bogus", "--also-bad"]);
  assert.deepEqual(parsed.positional, ["task-1"]);
  assert.equal(parsed.note, "ok");
});

test("parseActionArgs reports no unknown flags when all are recognized", () => {
  const parsed = parseActionArgs(["cancel", "task-1", "--force"], CWD);
  assert.deepEqual(parsed.unknownFlags, []);
  assert.equal(parsed.force, true);
});

test("parseEditActionArgs collects unknown flags", () => {
  const parsed = parseEditActionArgs(
    ["edit-action", "task-1", "act-1", "--bogus", "--type", "host_command"],
    CWD,
  );
  assert.deepEqual(parsed.unknownFlags, ["--bogus"]);
  assert.deepEqual(parsed.positional, ["task-1", "act-1"]);
  assert.equal(parsed.patch.type, "host_command");
});

test("parseInspectArgs collects unknown flags", () => {
  const parsed = parseInspectArgs(
    ["inspect", "task-1", "--json", "--bogus"],
    CWD,
  );
  assert.deepEqual(parsed.unknownFlags, ["--bogus"]);
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.positional, ["task-1"]);
});

test("parseProjectArgs collects unknown flags after the action", () => {
  const parsed = parseProjectArgs(
    ["project", "create", "alpha", "--target", "main", "--bogus"],
    CWD,
  );
  assert.equal(parsed.action, "create");
  assert.deepEqual(parsed.unknownFlags, ["--bogus"]);
  assert.deepEqual(parsed.positional, ["alpha"]);
  assert.equal(parsed.target, "main");
});

// --- dispatch sites warn on stderr -------------------------------------------

test("status command warns about unknown flags on stderr", async () => {
  await withTempStore(async ({ dir, store }) => {
    const stderr = captureWriter();
    await runLocalMaestroCommand({
      args: ["status", "--bogus"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr,
      store,
    });
    assert.match(stderr.text(), /warning: unknown flag for 'status': --bogus/);
  });
});

test("task command rejects unknown flags instead of treating them as prompt", async () => {
  await withTempStore(async ({ dir, store }) => {
    await assert.rejects(
      () =>
        runLocalMaestroCommand({
          args: ["task", "--bogus", "do", "something"],
          cwd: dir,
          stdout: { write: () => {} },
          stderr: { write: () => {} },
          store,
        }),
      /unknown_flag: --bogus/,
    );
  });
});
