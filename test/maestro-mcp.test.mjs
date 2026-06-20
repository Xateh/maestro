import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Import handlers without starting the MCP server (guarded by isMain in server.mjs).
import {
  isValidId,
  assertInsideDir,
  redactConfig,
  VALID_MODES,
  WORKFLOW_NAME_RE,
  buildTaskArgv,
  resolveValidModes,
  createTask,
  listTasks,
  showTask,
  showRun,
  validateWorkflowTool,
  readWorkflow,
  listWorkflowResources,
  readWorkflowResource,
  resetValidateAttemptGuards,
  validateAttemptGuardBegin,
  validateAttemptGuardSettle,
  _resetMaestroPathsForTest,
} from "../src/mcp/server.mjs";

import { safeRunnerEnv } from "../src/agent-runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function validWorkflow() {
  return {
    version: 2,
    initial: "executor",
    roles: { executor: { provider: "codex" } },
    transitions: { executor: { done: "$complete", error: "$halt" } },
    modes: { task: { initial: "executor" } },
  };
}

function structurallyBadWorkflow() {
  return {
    version: 2,
    initial: "executor",
    roles: [],
    transitions: { executor: { done: "$complete" } },
  };
}

async function withTempMaestroRoot({ workflow = validWorkflow(), config = {} } = {}, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-mcp-"));
  const stateDir = path.join(root, ".maestro");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, "workflow.json"), `${JSON.stringify(workflow, null, 2)}\n`);
  await fs.writeFile(path.join(stateDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const previousRoot = process.env.MAESTRO_ROOT;
  process.env.MAESTRO_ROOT = root;
  _resetMaestroPathsForTest();
  try {
    return await fn({ root, stateDir });
  } finally {
    if (previousRoot === undefined) delete process.env.MAESTRO_ROOT;
    else process.env.MAESTRO_ROOT = previousRoot;
    _resetMaestroPathsForTest();
    resetValidateAttemptGuards();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ── isValidId ─────────────────────────────────────────────────────────────────

test("isValidId: accepts well-formed task ids", () => {
  assert.equal(isValidId("20260513-133611-some-task"), true);
  assert.equal(isValidId("abc123"), true);
  assert.equal(isValidId("a.b-c_d"), true);
});

test("isValidId: rejects path traversal sequences", () => {
  assert.equal(isValidId("../etc/passwd"), false);
  assert.equal(isValidId("../../root"), false);
  assert.equal(isValidId(".hidden"), false);
});

test("isValidId: rejects slashes and empty strings", () => {
  assert.equal(isValidId("a/b"), false);
  assert.equal(isValidId(""), false);
  assert.equal(isValidId("/absolute"), false);
});

test("isValidId: rejects non-strings", () => {
  assert.equal(isValidId(null), false);
  assert.equal(isValidId(undefined), false);
  assert.equal(isValidId(42), false);
});

// ── assertInsideDir ───────────────────────────────────────────────────────────

test("assertInsideDir: allows paths strictly inside parent", () => {
  const parent = "/tmp/maestro/tasks";
  assert.doesNotThrow(() => assertInsideDir(parent, "/tmp/maestro/tasks/task-1.json"));
  assert.doesNotThrow(() => assertInsideDir(parent, "/tmp/maestro/tasks/sub/file"));
});

test("assertInsideDir: throws path_traversal on escape", () => {
  const parent = "/tmp/maestro/tasks";
  assert.throws(
    () => assertInsideDir(parent, "/tmp/maestro/tasks/../runs/secret"),
    /path_traversal/,
  );
  assert.throws(
    () => assertInsideDir(parent, "/etc/passwd"),
    /path_traversal/,
  );
  assert.throws(
    () => assertInsideDir(parent, "/tmp/maestro/tasks-evil/x"),
    /path_traversal/,
  );
});

// ── redactConfig ──────────────────────────────────────────────────────────────

test("redactConfig: redacts api_key leaves", () => {
  const cfg = { tracker: { api_key: "sk-live-secret" }, name: "test" };
  const out = redactConfig(cfg);
  assert.equal(out.tracker.api_key, "[redacted]");
  assert.equal(out.name, "test");
});

test("redactConfig: redacts _key, _token, _secret, password suffixes", () => {
  const cfg = {
    linear_api_key: "lin-key",
    auth_token: "tok-abc",
    db_secret: "my-secret",
    password: "hunter2",
    regular_field: "keep-me",
  };
  const out = redactConfig(cfg);
  assert.equal(out.linear_api_key, "[redacted]");
  assert.equal(out.auth_token, "[redacted]");
  assert.equal(out.db_secret, "[redacted]");
  assert.equal(out.password, "[redacted]");
  assert.equal(out.regular_field, "keep-me");
});

test("redactConfig: handles nested objects", () => {
  const cfg = { providers: { linear: { api_key: "lin-123", name: "linear" } } };
  const out = redactConfig(cfg);
  assert.equal(out.providers.linear.api_key, "[redacted]");
  assert.equal(out.providers.linear.name, "linear");
});

test("redactConfig: does not mutate original", () => {
  const cfg = { api_key: "secret" };
  redactConfig(cfg);
  assert.equal(cfg.api_key, "secret");
});

test("redactConfig: handles null/undefined gracefully", () => {
  assert.equal(redactConfig(null), null);
  assert.equal(redactConfig(undefined), undefined);
});

// ── VALID_MODES ───────────────────────────────────────────────────────────────

test("VALID_MODES: contains exactly task and plan-only", () => {
  assert.ok(VALID_MODES.has("task"));
  assert.ok(VALID_MODES.has("plan-only"));
  assert.equal(VALID_MODES.size, 2);
});

// ── createTask: mode validation ───────────────────────────────────────────────

test("createTask: rejects missing prompt", async () => {
  await assert.rejects(() => createTask({}), /prompt required/);
});

test("createTask: rejects invalid mode strings", async () => {
  await assert.rejects(() => createTask({ prompt: "x", mode: "--state-dir" }), /invalid_mode/);
  await assert.rejects(() => createTask({ prompt: "x", mode: "exec" }), /invalid_mode/);
  await assert.rejects(() => createTask({ prompt: "x", mode: "" }), /invalid_mode/);
  await assert.rejects(() => createTask({ prompt: "x", mode: "task; rm -rf /" }), /invalid_mode/);
});

test("createTask: rejects an invalid workflow name shape", async () => {
  await assert.rejects(() => createTask({ prompt: "x", workflow: "Bad name" }), /invalid_workflow/);
  await assert.rejects(() => createTask({ prompt: "x", workflow: "_x" }), /invalid_workflow/);
});

test("buildTaskArgv: includes --workflow and ends options with --", () => {
  const argv = buildTaskArgv("/bin/maestro.mjs", { mode: "task", workflow: "solo", prompt: "do it" });
  assert.deepEqual(argv, ["/bin/maestro.mjs", "task", "--mode", "task", "--workflow", "solo", "--", "do it"]);
  assert.ok(WORKFLOW_NAME_RE.test("solo"));
});

test("resolveValidModes: always includes base modes", async () => {
  const modes = await resolveValidModes();
  for (const mode of VALID_MODES) assert.ok(modes.has(mode));
});

// ── maestro_validate_workflow ─────────────────────────────────────────────────

test("validateWorkflowTool: returns {ok, errors, warnings} shape", async () => {
  const result = await validateWorkflowTool();
  assert.equal(typeof result.ok, "boolean");
  assert.ok(Array.isArray(result.errors));
  assert.ok(Array.isArray(result.warnings));
});

test("validateWorkflowTool: validates an inline workflow without reading disk workflow bytes", async () => {
  await withTempMaestroRoot({ workflow: structurallyBadWorkflow() }, async () => {
    resetValidateAttemptGuards();
    const result = await validateWorkflowTool({ workflow: validWorkflow() }, { sessionId: "inline-ok", nowMs: 0 });
    assert.deepEqual(result, { ok: true, errors: [], warnings: [] });
  });
});

test("validateWorkflowTool: structural pre-check fires on disk and inline with same verdict", async () => {
  const bad = structurallyBadWorkflow();
  await withTempMaestroRoot({ workflow: bad }, async () => {
    resetValidateAttemptGuards();
    const disk = await validateWorkflowTool({}, { sessionId: "disk-structural", nowMs: 0 });
    const inline = await validateWorkflowTool({ workflow: bad }, { sessionId: "inline-structural", nowMs: 0 });
    assert.deepEqual(disk, inline);
    assert.equal(disk.ok, false);
    assert.ok(disk.errors.length > 0);
    assert.ok(disk.errors.every((error) => error.code === "bad_workflow_schema"));
  });
});

test("validateWorkflowTool: inline non-object workflow returns bad_workflow_schema", async () => {
  await withTempMaestroRoot({ workflow: validWorkflow() }, async () => {
    const result = await validateWorkflowTool({ workflow: null }, { sessionId: "inline-null", nowMs: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "bad_workflow_schema");
  });
});

test("validateWorkflowTool: inline validate never mutates disk state", async () => {
  await withTempMaestroRoot({ workflow: validWorkflow() }, async ({ stateDir }) => {
    const workflowPath = path.join(stateDir, "workflow.json");
    const before = await fs.readFile(workflowPath, "utf8");
    const result = await validateWorkflowTool({ workflow: structurallyBadWorkflow() }, { sessionId: "no-mutate", nowMs: 0 });
    const after = await fs.readFile(workflowPath, "utf8");
    assert.equal(result.ok, false);
    assert.equal(before, after);
  });
});

test("validate attempt guard is unit-testable: trip, success reset, cooldown reset, fresh session", () => {
  const attempts = new Map();
  const opts = { maxAttempts: 2, cooldownMs: 100 };

  let gate = validateAttemptGuardBegin(attempts, { ...opts, sessionId: "s1", nowMs: 0 });
  assert.equal(gate.allowed, true);
  validateAttemptGuardSettle(attempts, { sessionKey: gate.sessionKey, ok: false, nowMs: 0 });

  gate = validateAttemptGuardBegin(attempts, { ...opts, sessionId: "s1", nowMs: 10 });
  assert.equal(gate.allowed, true);
  validateAttemptGuardSettle(attempts, { sessionKey: gate.sessionKey, ok: false, nowMs: 10 });

  gate = validateAttemptGuardBegin(attempts, { ...opts, sessionId: "s1", nowMs: 20 });
  assert.equal(gate.allowed, false);
  assert.equal(gate.verdict.errors[0].code, "validate_attempts_exhausted");
  assert.equal(gate.verdict.errors[0].retry_after_ms, 90);

  gate = validateAttemptGuardBegin(attempts, { ...opts, sessionId: "fresh", nowMs: 20 });
  assert.equal(gate.allowed, true);

  gate = validateAttemptGuardBegin(attempts, { ...opts, sessionId: "s1", nowMs: 111 });
  assert.equal(gate.allowed, true, "cooldown should reset and allow validation");

  gate = validateAttemptGuardBegin(attempts, { ...opts, sessionId: "reset", nowMs: 0 });
  validateAttemptGuardSettle(attempts, { sessionKey: gate.sessionKey, ok: false, nowMs: 0 });
  gate = validateAttemptGuardBegin(attempts, { ...opts, sessionId: "reset", nowMs: 1 });
  validateAttemptGuardSettle(attempts, { sessionKey: gate.sessionKey, ok: true, nowMs: 1 });
  gate = validateAttemptGuardBegin(attempts, { ...opts, sessionId: "reset", nowMs: 2 });
  assert.equal(gate.allowed, true);
  validateAttemptGuardSettle(attempts, { sessionKey: gate.sessionKey, ok: false, nowMs: 2 });
  gate = validateAttemptGuardBegin(attempts, { ...opts, sessionId: "reset", nowMs: 3 });
  assert.equal(gate.allowed, true, "success should have reset prior failure count");
});

test("validateWorkflowTool: attempt guard trips and recovers through the tool path", async () => {
  const config = { server: { mcp: { max_validate_attempts: 2, validate_cooldown_ms: 100 } } };
  await withTempMaestroRoot({ workflow: validWorkflow(), config }, async () => {
    resetValidateAttemptGuards();
    const first = await validateWorkflowTool({ workflow: structurallyBadWorkflow() }, { sessionId: "tool-s1", nowMs: 0 });
    const second = await validateWorkflowTool({ workflow: structurallyBadWorkflow() }, { sessionId: "tool-s1", nowMs: 10 });
    const blocked = await validateWorkflowTool({ workflow: structurallyBadWorkflow() }, { sessionId: "tool-s1", nowMs: 20 });
    assert.equal(first.errors[0].code, "bad_workflow_schema");
    assert.equal(second.errors[0].code, "bad_workflow_schema");
    assert.equal(blocked.errors[0].code, "validate_attempts_exhausted");
    assert.equal(blocked.errors[0].retry_after_ms, 90);

    const fresh = await validateWorkflowTool({ workflow: structurallyBadWorkflow() }, { sessionId: "tool-fresh", nowMs: 20 });
    assert.equal(fresh.errors[0].code, "bad_workflow_schema");

    const afterCooldown = await validateWorkflowTool({ workflow: structurallyBadWorkflow() }, { sessionId: "tool-s1", nowMs: 111 });
    assert.equal(afterCooldown.errors[0].code, "bad_workflow_schema");

    const failThenSuccess = await validateWorkflowTool({ workflow: structurallyBadWorkflow() }, { sessionId: "tool-reset", nowMs: 0 });
    const success = await validateWorkflowTool({ workflow: validWorkflow() }, { sessionId: "tool-reset", nowMs: 1 });
    const failAfterReset = await validateWorkflowTool({ workflow: structurallyBadWorkflow() }, { sessionId: "tool-reset", nowMs: 2 });
    assert.equal(failThenSuccess.errors[0].code, "bad_workflow_schema");
    assert.equal(success.ok, true);
    assert.equal(failAfterReset.errors[0].code, "bad_workflow_schema");
  });
});

test("validateWorkflowTool: disk mode is exempt from attempt counter", async () => {
  const config = { server: { mcp: { max_validate_attempts: 1, validate_cooldown_ms: 1000 } } };
  await withTempMaestroRoot({ workflow: structurallyBadWorkflow(), config }, async () => {
    resetValidateAttemptGuards();
    const diskOne = await validateWorkflowTool({}, { sessionId: "disk-exempt", nowMs: 0 });
    const diskTwo = await validateWorkflowTool({}, { sessionId: "disk-exempt", nowMs: 1 });
    const inlineOne = await validateWorkflowTool({ workflow: structurallyBadWorkflow() }, { sessionId: "disk-exempt", nowMs: 2 });
    const inlineTwo = await validateWorkflowTool({ workflow: structurallyBadWorkflow() }, { sessionId: "disk-exempt", nowMs: 3 });
    assert.equal(diskOne.errors[0].code, "bad_workflow_schema");
    assert.equal(diskTwo.errors[0].code, "bad_workflow_schema");
    assert.equal(inlineOne.errors[0].code, "bad_workflow_schema");
    assert.equal(inlineTwo.errors[0].code, "validate_attempts_exhausted");
  });
});

test("workflow schema resource lists and reads the published schema bytes", async () => {
  const resources = listWorkflowResources();
  assert.deepEqual(resources.resources.map((resource) => resource.uri), ["maestro://schema/workflow.json"]);
  const result = await readWorkflowResource({ uri: "maestro://schema/workflow.json" });
  const expected = await fs.readFile(path.join(repoRoot, "schema", "workflow.schema.json"), "utf8");
  assert.equal(result.contents[0].uri, "maestro://schema/workflow.json");
  assert.equal(result.contents[0].mimeType, "application/schema+json");
  assert.equal(result.contents[0].text, expected);
});

test("readWorkflow: returns only workflow_json (no dropped front-matter field)", async () => {
  const result = await readWorkflow();
  assert.ok(Object.hasOwn(result, "workflow_json"));
  assert.equal(Object.hasOwn(result, "workflow_md"), false);
});

// ── showTask / showRun: id validation ─────────────────────────────────────────

test("showTask: rejects missing id", async () => {
  await assert.rejects(() => showTask({}), /id required/);
});

test("showTask: rejects invalid ids (path traversal, slashes)", async () => {
  await assert.rejects(() => showTask({ id: "../../../etc" }), /invalid_id/);
  await assert.rejects(() => showTask({ id: ".hidden" }), /invalid_id/);
  await assert.rejects(() => showTask({ id: "a/b" }), /invalid_id/);
});

test("showRun: rejects missing id", async () => {
  await assert.rejects(() => showRun({}), /id required/);
});

test("showRun: rejects invalid ids", async () => {
  await assert.rejects(() => showRun({ id: "../runs" }), /invalid_id/);
  await assert.rejects(() => showRun({ id: "/abs/path" }), /invalid_id/);
});

// ── safeRunnerEnv (F8) ───────────────────────────────────────────────────────

test("safeRunnerEnv: passes through only MAESTRO_-prefixed vars", () => {
  const env = {
    LINEAR_API_KEY: "lin-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    HOME: "/root",
    PATH: "/usr/bin",
    MAESTRO_TASK_ID: "task-123",
    MAESTRO_ROLE: "executor",
  };
  const out = safeRunnerEnv(env);
  assert.deepEqual(Object.keys(out).sort(), ["MAESTRO_ROLE", "MAESTRO_TASK_ID"]);
  assert.equal(out.MAESTRO_TASK_ID, "task-123");
  assert.equal(out.MAESTRO_ROLE, "executor");
});

test("safeRunnerEnv: excludes null and undefined values", () => {
  const env = { MAESTRO_TASK_ID: "abc", MAESTRO_NULL: null, MAESTRO_UNDEF: undefined };
  const out = safeRunnerEnv(env);
  assert.ok("MAESTRO_TASK_ID" in out);
  assert.ok(!("MAESTRO_NULL" in out));
  assert.ok(!("MAESTRO_UNDEF" in out));
});

test("safeRunnerEnv: returns empty object when no MAESTRO_ vars", () => {
  const env = { HOME: "/home/user", PATH: "/usr/bin", LINEAR_API_KEY: "secret" };
  assert.deepEqual(safeRunnerEnv(env), {});
});

test("safeRunnerEnv: coerces values to string", () => {
  const env = { MAESTRO_COUNT: 42 };
  const out = safeRunnerEnv(env);
  assert.equal(out.MAESTRO_COUNT, "42");
  assert.equal(typeof out.MAESTRO_COUNT, "string");
});

// ── input validation hardening ──────────────────────────────────────────────

test("isValidId rejects over-long ids (length cap)", () => {
  assert.equal(isValidId("a".repeat(128)), true);
  assert.equal(isValidId("a".repeat(129)), false);
});

test("createTask rejects missing, non-string, and oversized prompts before any side effects", async () => {
  await assert.rejects(() => createTask({ prompt: "" }), /prompt required/);
  await assert.rejects(() => createTask({ prompt: 123 }), /prompt required/);
  await assert.rejects(() => createTask({}), /prompt required/);
  await assert.rejects(() => createTask({ prompt: "x".repeat(100_001) }), /prompt_too_large/);
});

test("listTasks rejects a malformed status filter", async () => {
  await assert.rejects(() => listTasks({ status: 123 }), /invalid_status/);
  await assert.rejects(() => listTasks({ status: "x".repeat(65) }), /invalid_status/);
});
