// Tests for src/run-manifest.mjs — buildRunManifest / manifestToTaskInputs /
// sanitizeRerunWorkflowName / readMaestroVersion. All pure/total (no disk).

import assert from "node:assert/strict";
import { test } from "node:test";

import { isValidWorkflowName } from "../src/task-store.mjs";
import {
  MANIFEST_VERSION,
  buildRunManifest,
  manifestToTaskInputs,
  readMaestroVersion,
  sanitizeRerunWorkflowName,
} from "../src/run-manifest.mjs";

const REP_TASK = {
  // identity / derived — must NOT leak into manifest.task
  id: "20260615-120000-do-the-thing",
  status: "running",
  steps: [{ role: "executor", status: "succeeded" }],
  branch: "feat/x",
  worktree_path: "/tmp/wt",
  run_dir: "/tmp/.maestro/runs/20260615-120000-do-the-thing",
  project_id: "proj",
  source_issue_id: "ISSUE-1",
  start_head: "abc123",
  planner_decision: "plan",
  planner_reason: "because",
  created_at: "2026-06-15T12:00:00.000Z",
  updated_at: "2026-06-15T12:00:00.000Z",
  active_step: "executor",
  // replayable input knobs
  prompt: "do the thing",
  mode: "task",
  workflow: "default",
  cwd: "/work",
  planner_policy: "auto",
  review_enabled: true,
  timeout_ms: 3_600_000,
  stream_tail_bytes: 65_536,
  context_retry_limit: 1,
  claude_command: "claude",
  codex_command: "codex",
  planner_model: "p-model",
  claude_effort: "high",
  executor_model: "e-model",
  executor_effort: "med",
  reviewer_model: "r-model",
  reviewer_effort: "low",
  worktree_mode: "current-cwd",
  write_paths: ["src/", "test/"],
};

const REP_WORKFLOW = { version: 2, roles: { executor: {} }, transitions: {} };

test("buildRunManifest task block contains EXACTLY the 19 input knobs, no identity fields", () => {
  const m = buildRunManifest({
    task: REP_TASK,
    workflow: REP_WORKFLOW,
    maestroVersion: "1.2.3",
    startHead: "abc123",
  });
  const expectedKeys = [
    "prompt", "mode", "workflow", "cwd", "planner_policy", "review_enabled",
    "timeout_ms", "stream_tail_bytes", "context_retry_limit", "claude_command",
    "codex_command", "planner_model", "claude_effort", "executor_model",
    "executor_effort", "reviewer_model", "reviewer_effort", "worktree_mode",
    "write_paths",
  ];
  assert.deepEqual(Object.keys(m.task).sort(), [...expectedKeys].sort());
  assert.equal(Object.keys(m.task).length, 19);
  // explicit exclusions
  for (const banned of ["id", "status", "steps", "branch", "worktree_path",
    "run_dir", "project_id", "source_issue_id", "start_head", "planner_decision",
    "planner_reason", "created_at", "updated_at", "active_step"]) {
    assert.ok(!(banned in m.task), `${banned} must be absent from manifest.task`);
  }
  // input values round-tripped
  assert.equal(m.task.prompt, "do the thing");
  assert.deepEqual(m.task.write_paths, ["src/", "test/"]);
});

test("buildRunManifest embeds snapshot + git + version + identity envelope", () => {
  const m = buildRunManifest({
    task: REP_TASK, workflow: REP_WORKFLOW, maestroVersion: "1.2.3", startHead: "abc123",
  });
  assert.equal(m.manifest_version, MANIFEST_VERSION);
  assert.equal(m.manifest_version, 1);
  assert.equal(m.maestro_version, "1.2.3");
  assert.deepEqual(m.workflow_snapshot, REP_WORKFLOW);
  assert.deepEqual(m.git, { start_head: "abc123" });
  assert.equal(m.source_task_id, REP_TASK.id);
  assert.equal(m.run_dir, REP_TASK.run_dir);
  assert.match(m.created_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("buildRunManifest is total — partial/empty task never throws", () => {
  assert.doesNotThrow(() => buildRunManifest({}));
  const m = buildRunManifest({});
  assert.equal(m.task.prompt, null);
  assert.deepEqual(m.task.write_paths, []);
  assert.equal(m.workflow_snapshot, null);
  assert.deepEqual(m.git, { start_head: null });
  assert.equal(m.source_task_id, null);
  assert.equal(m.maestro_version, null);
});

test("manifestToTaskInputs maps snake→camel, omits workflow + identity", () => {
  const m = buildRunManifest({ task: REP_TASK, workflow: REP_WORKFLOW, maestroVersion: "1.2.3", startHead: null });
  const inputs = manifestToTaskInputs(m);
  // workflow NOT set — the rerun caller pins the name
  assert.ok(!("workflow" in inputs), "manifestToTaskInputs must not set workflow");
  // camelCase keys present
  assert.equal(inputs.prompt, "do the thing");
  assert.equal(inputs.plannerPolicy, "auto");
  assert.equal(inputs.reviewEnabled, true);
  assert.equal(inputs.timeoutMs, 3_600_000);
  assert.equal(inputs.streamTailBytes, 65_536);
  assert.equal(inputs.contextRetryLimit, 1);
  assert.equal(inputs.claudeCommand, "claude");
  assert.equal(inputs.codexCommand, "codex");
  assert.equal(inputs.plannerModel, "p-model");
  assert.equal(inputs.executorModel, "e-model");
  assert.equal(inputs.reviewerModel, "r-model");
  assert.equal(inputs.worktreeMode, "current-cwd");
  assert.deepEqual(inputs.writePaths, ["src/", "test/"]);
  // no identity leak
  for (const banned of ["id", "status", "steps", "branch", "run_dir", "startHead", "start_head"]) {
    assert.ok(!(banned in inputs), `${banned} must not be in inputs`);
  }
});

test("manifestToTaskInputs tolerates a partial/absent manifest", () => {
  assert.deepEqual(manifestToTaskInputs(undefined), {});
  assert.deepEqual(manifestToTaskInputs({}), {});
  assert.deepEqual(manifestToTaskInputs({ task: { prompt: "x" } }), { prompt: "x" });
});

test("sanitizeRerunWorkflowName: >64-char id ⇒ valid name ≤64", () => {
  const longId = "20260615-235959-a-very-long-slug-that-keeps-going-and-going-and-going-well-past-the-limit";
  const name = sanitizeRerunWorkflowName(longId);
  assert.ok(isValidWorkflowName(name), `expected valid workflow name, got ${name}`);
  assert.ok(name.length <= 64);
  assert.ok(name.startsWith("rerun-"));
});

test("sanitizeRerunWorkflowName: short id ⇒ rerun-<id>; junk ⇒ fallback", () => {
  assert.equal(sanitizeRerunWorkflowName("abc123"), "rerun-abc123");
  // uppercase + odd chars normalized
  assert.equal(sanitizeRerunWorkflowName("ABC_de.f"), "rerun-abc_de-f");
  // an id that sanitizes to nothing valid still yields a valid fallback
  const fb = sanitizeRerunWorkflowName("");
  assert.ok(isValidWorkflowName(fb));
});

test("readMaestroVersion reads the real package.json (not the 0.0.0 fallback)", () => {
  const v = readMaestroVersion();
  assert.equal(typeof v, "string");
  assert.match(v, /^\d/);
});

test("SP7: buildRunManifest includes resolved_parallel_groups when workflow has them", () => {
  const workflow = {
    initial: "planner",
    roles: { planner: {}, reviewerA: {}, reviewerB: {} },
    transitions: { planner: { done: "reviewerA" }, reviewerA: { done: "$complete" }, reviewerB: { done: "$complete" } },
    parallel_groups: [["reviewerA", "reviewerB"]],
  };
  const manifest = buildRunManifest({
    task: { id: "t1", prompt: "p", workflow: "default", steps: [] },
    workflow,
    maestroVersion: "0.4.0",
    startHead: null,
  });
  assert.deepEqual(manifest.resolved_parallel_groups, [["reviewerA", "reviewerB"]]);
});

test("SP7: buildRunManifest has no resolved_parallel_groups when workflow has none", () => {
  const workflow = {
    initial: "planner",
    roles: { planner: {} },
    transitions: { planner: { done: "$complete" } },
  };
  const manifest = buildRunManifest({
    task: { id: "t2", prompt: "p", workflow: "default", steps: [] },
    workflow,
    maestroVersion: "0.4.0",
    startHead: null,
  });
  assert.ok(!("resolved_parallel_groups" in manifest), "field must not exist when no groups");
});
