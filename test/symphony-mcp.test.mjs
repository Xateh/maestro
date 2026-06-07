import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Import handlers without starting the MCP server (guarded by isMain in server.mjs).
import {
  isValidId,
  assertInsideDir,
  redactConfig,
  VALID_MODES,
  createTask,
  showTask,
  showRun,
} from "../src/mcp/server.mjs";

import { safeRunnerEnv } from "../src/agent-runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const parent = "/tmp/symphony/tasks";
  assert.doesNotThrow(() => assertInsideDir(parent, "/tmp/symphony/tasks/task-1.json"));
  assert.doesNotThrow(() => assertInsideDir(parent, "/tmp/symphony/tasks/sub/file"));
});

test("assertInsideDir: throws path_traversal on escape", () => {
  const parent = "/tmp/symphony/tasks";
  assert.throws(
    () => assertInsideDir(parent, "/tmp/symphony/tasks/../runs/secret"),
    /path_traversal/,
  );
  assert.throws(
    () => assertInsideDir(parent, "/etc/passwd"),
    /path_traversal/,
  );
  assert.throws(
    () => assertInsideDir(parent, "/tmp/symphony/tasks-evil/x"),
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

test("safeRunnerEnv: passes through only SYMPHONY_-prefixed vars", () => {
  const env = {
    LINEAR_API_KEY: "lin-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    HOME: "/root",
    PATH: "/usr/bin",
    SYMPHONY_TASK_ID: "task-123",
    SYMPHONY_ROLE: "executor",
  };
  const out = safeRunnerEnv(env);
  assert.deepEqual(Object.keys(out).sort(), ["SYMPHONY_ROLE", "SYMPHONY_TASK_ID"]);
  assert.equal(out.SYMPHONY_TASK_ID, "task-123");
  assert.equal(out.SYMPHONY_ROLE, "executor");
});

test("safeRunnerEnv: excludes null and undefined values", () => {
  const env = { SYMPHONY_TASK_ID: "abc", SYMPHONY_NULL: null, SYMPHONY_UNDEF: undefined };
  const out = safeRunnerEnv(env);
  assert.ok("SYMPHONY_TASK_ID" in out);
  assert.ok(!("SYMPHONY_NULL" in out));
  assert.ok(!("SYMPHONY_UNDEF" in out));
});

test("safeRunnerEnv: returns empty object when no SYMPHONY_ vars", () => {
  const env = { HOME: "/home/user", PATH: "/usr/bin", LINEAR_API_KEY: "secret" };
  assert.deepEqual(safeRunnerEnv(env), {});
});

test("safeRunnerEnv: coerces values to string", () => {
  const env = { SYMPHONY_COUNT: 42 };
  const out = safeRunnerEnv(env);
  assert.equal(out.SYMPHONY_COUNT, "42");
  assert.equal(typeof out.SYMPHONY_COUNT, "string");
});
