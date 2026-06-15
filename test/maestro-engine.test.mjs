/**
 * Unit tests for the LangGraph engine modules:
 *   src/langgraph/graph.mjs   — buildGraph()
 *   src/langgraph/nodes.mjs   — makeRoleNode()
 *
 * These were previously untested. Each test uses a stub runner and a real
 * in-memory SqliteTaskStore (tmpdir) so no agent CLI binary is needed.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildGraph } from "../src/langgraph/graph.mjs";
import { makeRoleNode } from "../src/langgraph/nodes.mjs";
import { buildPromptFromHandoffs } from "../src/langgraph/prompt.mjs";
import { runLangGraphTask } from "../src/langgraph/engine.mjs";
import { SqliteTaskStore } from "../src/db/store.mjs";
import { DEFAULT_WORKFLOW, LocalTaskStore } from "../src/task-store.mjs";
import { emptyPayloadForSchema, getSchema } from "../src/schemas/index.mjs";
import { resolveWorkflowTemplate } from "../src/setup/workflow-templates.mjs";

const DEFAULT_CONFIG = {
  default_role: "executor",
  context_retry_limit: 1,
  providers: {
    claude: { adapter: "built-in:claude", label: "Claude" },
    codex:  { adapter: "built-in:codex",  label: "Codex"  },
  },
};

// ── buildGraph ──────────────────────────────────────────────────────────────────

test("buildGraph: compiles DEFAULT_WORKFLOW without throwing", () => {
  const stubDb     = { getTask: () => null };
  const stubRunner = { runStep: async () => ({ stdout: "", stderr: "" }) };
  assert.doesNotThrow(
    () => buildGraph(DEFAULT_WORKFLOW, DEFAULT_CONFIG, { db: stubDb, runner: stubRunner }),
  );
});

test("buildGraph: compiled graph exposes invoke method (is a runnable StateGraph)", () => {
  const stubDb     = { getTask: () => null };
  const stubRunner = { runStep: async () => ({}) };
  const graph = buildGraph(DEFAULT_WORKFLOW, DEFAULT_CONFIG, { db: stubDb, runner: stubRunner });
  assert.ok(typeof graph.invoke === "function" || typeof graph.stream === "function",
    "compiled graph should have invoke or stream");
});

// ── makeRoleNode: resume skip ────────────────────────────────────────────────────

test("makeRoleNode: returns done immediately when role already in priorHandoffs", async () => {
  // roleKey = roleDef.prompt_template = "planner"
  const roleDef    = DEFAULT_WORKFLOW.roles.planner;
  const stubDb     = { getTask: () => { throw new Error("db should not be called on resume skip"); } };
  const stubRunner = { runStep: async () => { throw new Error("runner should not be called on resume skip"); } };

  const node   = makeRoleNode(roleDef, { db: stubDb, runner: stubRunner, providerDef: null });
  const result = await node({
    task:          { id: "t-skip" },
    priorHandoffs: [{ role: "planner", provider: "claude", payload: {} }],
    event:         null,
    currentState:  null,
  });

  assert.equal(result.event,        "done");
  assert.equal(result.currentState, "planner");
});

// ── makeRoleNode: question event ─────────────────────────────────────────────────

test("makeRoleNode: emits question event when agent stdout contains MAESTRO_QUESTION", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-engine-"));
  let db;
  try {
    db            = new SqliteTaskStore(path.join(dir, "maestro.db"));
    const taskId  = "20260608-000001-test-question";
    await db.createTask({ id: taskId, status: "running", prompt: "do the thing", cwd: dir, mode: "task", run_dir: null });

    const stubRunner = {
      runStep: async () => ({
        stdout:     "thinking...\nMAESTRO_QUESTION: which framework should I use?",
        stderr:     "",
        stdoutPath: null,
        stderrPath: null,
      }),
    };

    const node   = makeRoleNode(DEFAULT_WORKFLOW.roles.executor, {
      db,
      runner:      stubRunner,
      providerDef: DEFAULT_CONFIG.providers.codex,
    });
    const result = await node({ task: { id: taskId }, priorHandoffs: [], event: null, currentState: null });

    assert.equal(result.event,        "question");
    assert.equal(result.currentState, "executor");

    const saved = await db.getTask(taskId);
    assert.equal(saved.status, "waiting_user");
    assert.ok(saved.active_question?.question, "active_question should be set in DB");
    assert.match(String(saved.active_question.question), /framework/);

  } finally {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── makeRoleNode: waiting event (action request) ──────────────────────────────────

test("makeRoleNode: emits waiting event when agent stdout contains MAESTRO_ACTION_REQUEST", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-engine-"));
  let db;
  try {
    db            = new SqliteTaskStore(path.join(dir, "maestro.db"));
    const taskId  = "20260608-000002-test-action";
    await db.createTask({ id: taskId, status: "running", prompt: "build it", cwd: dir, mode: "task", run_dir: null });

    const actionReq = { provider: "host", command: "make", args: ["build"], cwd: dir };
    const stubRunner = {
      runStep: async () => ({
        stdout:     `running build\nMAESTRO_ACTION_REQUEST: ${JSON.stringify(actionReq)}`,
        stderr:     "",
        stdoutPath: null,
        stderrPath: null,
      }),
    };

    const node   = makeRoleNode(DEFAULT_WORKFLOW.roles.executor, {
      db,
      runner:      stubRunner,
      providerDef: DEFAULT_CONFIG.providers.codex,
    });
    const result = await node({ task: { id: taskId }, priorHandoffs: [], event: null, currentState: null });

    assert.equal(result.event,        "waiting");
    assert.equal(result.currentState, "executor");

    const saved = await db.getTask(taskId);
    assert.equal(saved.status, "waiting_approval");
    assert.ok(Array.isArray(saved.action_requests) && saved.action_requests.length > 0,
      "action_requests should be recorded in DB");
    assert.equal(saved.action_requests[0].command, "make");

  } finally {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── makeRoleNode: happy path (handoff emitted) ───────────────────────────────────

test("makeRoleNode: returns done and records handoff when agent emits MAESTRO_HANDOFF", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-engine-"));
  let db;
  try {
    db            = new SqliteTaskStore(path.join(dir, "maestro.db"));
    const taskId  = "20260608-000003-test-handoff";
    // planner_policy: "on" forces the planner to run (auto-mode would skip for a simple prompt)
    await db.createTask({ id: taskId, status: "running", prompt: "add logging", cwd: dir, mode: "task", run_dir: null, planner_policy: "on" });

    const handoffPayload = { plan_summary: "add logging to the server", steps: ["edit server.js"], files_to_touch: ["server.js"] };
    const stubRunner = {
      runStep: async () => ({
        stdout:     `MAESTRO_HANDOFF: ${JSON.stringify(handoffPayload)}`,
        stderr:     "",
        stdoutPath: null,
        stderrPath: null,
      }),
    };

    const node   = makeRoleNode(DEFAULT_WORKFLOW.roles.planner, {
      db,
      runner:      stubRunner,
      providerDef: DEFAULT_CONFIG.providers.claude,
    });
    const result = await node({ task: { id: taskId }, priorHandoffs: [], event: null, currentState: null });

    assert.equal(result.event,        "done");
    assert.equal(result.currentState, "planner");
    assert.ok(Array.isArray(result.priorHandoffs) && result.priorHandoffs.length > 0,
      "priorHandoffs should be populated after handoff");
    assert.equal(result.priorHandoffs[0].role, "planner");

    const handoffs = await db.getHandoffs(taskId);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].role, "planner");
    assert.deepEqual(handoffs[0].payload, handoffPayload);

  } finally {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── makeRoleNode: soft schema validation (SP1) ───────────────────────────────────

const IMPL_OK = {
  summary: "did the thing",
  files_changed: ["a.js"],
  assumptions: [],
  risks: [],
};

async function runNodeWithSchema({ roleDef, stdout, runDir = null }) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-schema-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  const taskId = "20260614-000001-schema";
  await db.createTask({
    id: taskId,
    status: "running",
    prompt: "do work",
    cwd: dir,
    mode: "task",
    run_dir: runDir,
    planner_policy: "on",
  });
  const stubRunner = {
    runStep: async () => ({ stdout, stderr: "", stdoutPath: null, stderrPath: null }),
  };
  const node = makeRoleNode(roleDef, {
    db,
    runner: stubRunner,
    providerDef: DEFAULT_CONFIG.providers.codex,
  });
  const result = await node({ task: { id: taskId, run_dir: runDir }, priorHandoffs: [], event: null, currentState: null });
  const handoffs = await db.getHandoffs(taskId);
  return { dir, db, result, handoffs };
}

test("makeRoleNode: conformant payload records schema_validation.ok === true", async () => {
  const roleDef = { ...DEFAULT_WORKFLOW.roles.executor, output_schema: "implementation" };
  const { dir, db, result } = await runNodeWithSchema({
    roleDef,
    stdout: `MAESTRO_HANDOFF: ${JSON.stringify(IMPL_OK)}`,
  });
  try {
    assert.equal(result.event, "done");
    assert.equal(result.priorHandoffs[0].schema_validation.ok, true);
    assert.equal(result.priorHandoffs[0].schema_validation.schema, "implementation");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeRoleNode: non-conformant payload records ok:false but routing unchanged", async () => {
  const roleDef = { ...DEFAULT_WORKFLOW.roles.executor, output_schema: "implementation" };
  const { dir, db, result, handoffs } = await runNodeWithSchema({
    roleDef,
    stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ summary: "missing arrays" })}`,
  });
  try {
    assert.equal(result.event, "done"); // routing NOT blocked
    const sv = result.priorHandoffs[0].schema_validation;
    assert.equal(sv.ok, false);
    assert.ok(sv.errors.length > 0);
    // DB carries schema_validation too.
    assert.equal(handoffs[0].schema_validation.ok, false);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeRoleNode: schema_validation written to handoff.<role>.json on disk", async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), "maestro-schema-run-"));
  const roleDef = { ...DEFAULT_WORKFLOW.roles.executor, output_schema: "implementation" };
  const { dir, db } = await runNodeWithSchema({
    roleDef,
    stdout: `MAESTRO_HANDOFF: ${JSON.stringify(IMPL_OK)}`,
    runDir,
  });
  try {
    const onDisk = JSON.parse(await readFile(path.join(runDir, "handoff.executor.json"), "utf8"));
    assert.equal(onDisk.schema_validation.ok, true);
    assert.equal(onDisk.schema_validation.schema, "implementation");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

test("makeRoleNode: no MAESTRO_HANDOFF emitted → schema_validation omitted", async () => {
  const roleDef = { ...DEFAULT_WORKFLOW.roles.executor, output_schema: "implementation" };
  const { dir, db, result, handoffs } = await runNodeWithSchema({
    roleDef,
    stdout: "just some text, no marker",
  });
  try {
    assert.equal(result.event, "done");
    assert.equal(result.priorHandoffs[0].schema_validation, undefined);
    assert.equal(handoffs[0].schema_validation, undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeRoleNode: role with no schema → schema_validation omitted", async () => {
  const roleDef = { ...DEFAULT_WORKFLOW.roles.executor }; // no output_schema
  const { dir, db, result } = await runNodeWithSchema({
    roleDef,
    stdout: `MAESTRO_HANDOFF: ${JSON.stringify(IMPL_OK)}`,
  });
  try {
    assert.equal(result.priorHandoffs[0].schema_validation, undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeRoleNode: inline output_schema validated via validateInline", async () => {
  const roleDef = {
    ...DEFAULT_WORKFLOW.roles.executor,
    output_schema: { type: "object", required: ["x"], properties: { x: { type: "number" } } },
  };
  const { dir, db, result } = await runNodeWithSchema({
    roleDef,
    stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ x: "not a number" })}`,
  });
  try {
    const sv = result.priorHandoffs[0].schema_validation;
    assert.equal(sv.schema, "inline");
    assert.equal(sv.ok, false);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── makeRoleNode: kind:"stub" pass-through (SP2) ─────────────────────────────────

const THROWING_RUNNER = {
  runStep: async () => { throw new Error("runner must never be called for a stub role"); },
};

test("makeRoleNode: stub role emits schema-conforming payload", async () => {
  const roleDef = { kind: "stub", prompt_template: "static_analysis", output_schema: "static_analysis", permission: "read" };
  const { dir, db, result, handoffs } = await runNodeWithSchema({
    roleDef,
  });
  try {
    assert.equal(result.event, "done");
    assert.deepEqual(result.priorHandoffs[0].payload, emptyPayloadForSchema(getSchema("static_analysis")));
    assert.equal(result.priorHandoffs[0].schema_validation.ok, true);
    assert.equal(result.priorHandoffs[0].provider, null, "engine-visible handoff has no provider");
    assert.equal(handoffs[0].provider, "stub", "DB row uses the stub sentinel (provider column is NOT NULL)");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeRoleNode: stub role does not invoke the runner (runStep throws)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-stub-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260614-000001-stub";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    const roleDef = { kind: "stub", prompt_template: "static_analysis", output_schema: "static_analysis", permission: "read" };
    const node = makeRoleNode(roleDef, { db, runner: THROWING_RUNNER, providerDef: null });
    const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "done");
    assert.equal(result.currentState, "static_analysis");
    assert.deepEqual(result.visits, { static_analysis: 1 });
    assert.deepEqual(result.priorHandoffs[0].payload, emptyPayloadForSchema(getSchema("static_analysis")));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeRoleNode: stub role with no output_schema → payload {} and schema_validation omitted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-stub-noschema-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260614-000002-stub";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    const roleDef = { kind: "stub", prompt_template: "noop", permission: "read" };
    const node = makeRoleNode(roleDef, { db, runner: THROWING_RUNNER, providerDef: null });
    const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "done");
    assert.deepEqual(result.priorHandoffs[0].payload, {});
    assert.equal(result.priorHandoffs[0].schema_validation, undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeRoleNode: stub already in priorHandoffs resume-skips, runner not called", async () => {
  const roleDef = { kind: "stub", prompt_template: "static_analysis", output_schema: "static_analysis", permission: "read" };
  const node = makeRoleNode(roleDef, {
    db: { getTask: () => { throw new Error("db should not be called on resume skip"); } },
    runner: THROWING_RUNNER,
    providerDef: null,
  });
  const result = await node({
    task: { id: "t" },
    priorHandoffs: [{ role: "static_analysis", payload: {} }],
    event: null,
    currentState: null,
  });
  assert.equal(result.event, "done");
  assert.equal(result.currentState, "static_analysis");
});

// ── buildPromptFromHandoffs: schema-aware generic prompt (SP2) ────────────────────

test("buildPromptFromHandoffs: generic role with outputSchema renders skeleton + enum note", () => {
  const prompt = buildPromptFromHandoffs({
    role: "review",
    task: { prompt: "x" },
    outputSchema: getSchema("review"),
  });
  assert.ok(prompt.includes("severity"));
  assert.ok(prompt.includes("findings"));
  assert.ok(prompt.includes("recommendations"));
  assert.ok(prompt.includes("severity ∈ {none,low,medium,high,critical}"));
});

test("buildPromptFromHandoffs: generic role with no outputSchema keeps the legacy example", () => {
  const prompt = buildPromptFromHandoffs({ role: "review", task: { prompt: "x" } });
  assert.ok(prompt.includes('{"summary":"","details":{}}'));
  assert.ok(!prompt.includes("severity"));
});

// ── runLangGraphTask: herdr tab close policy ─────────────────────────────────────

const silent = { write: () => {} };

// Drives a full task run over a tmp LocalTaskStore with a stub runner whose
// closeTab calls are recorded. review_enabled=false makes the reviewer node
// synthesize a "complete" review so the run ends succeeded without a real agent.
async function runTaskWithPolicy({ policy = null, emitQuestion = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-engine-tab-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "add logging", cwd: dir, reviewEnabled: false });
    if (policy) {
      await writeFile(
        path.join(store.root, "config.json"),
        JSON.stringify({ version: 2, herdr: { close_tab_on: policy } }),
      );
    }

    const closedTabs = [];
    const stubRunner = {
      runStep: async () => ({
        stdout: emitQuestion
          ? "MAESTRO_QUESTION: which logger?"
          : `MAESTRO_HANDOFF: ${JSON.stringify({ summary: "done" })}`,
        stderr: "",
        stdoutPath: null,
        stderrPath: null,
      }),
      closeTab: async (taskId) => { closedTabs.push(taskId); },
    };

    const { task: finalTask } = await runLangGraphTask(task.id, {
      taskStore: store,
      maestroRoot: store.root,
      runner: stubRunner,
      stdout: silent,
      stderr: silent,
      availabilityProbe: () => true, // stub runner; don't probe the host PATH
    });
    return { finalTask, closedTabs, taskId: task.id };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("runLangGraphTask: closes herdr tab on success under default policy", async () => {
  const { finalTask, closedTabs, taskId } = await runTaskWithPolicy();
  assert.equal(finalTask.status, "succeeded");
  assert.deepEqual(closedTabs, [taskId], "closeTab called exactly once for the task");
});

test("runLangGraphTask: close_tab_on=terminal closes on success, keeps waiting_user tabs", async () => {
  const success = await runTaskWithPolicy({ policy: "terminal" });
  assert.equal(success.finalTask.status, "succeeded");
  assert.deepEqual(success.closedTabs, [success.taskId]);

  const waiting = await runTaskWithPolicy({ policy: "terminal", emitQuestion: true });
  assert.equal(waiting.finalTask.status, "waiting_user");
  assert.deepEqual(waiting.closedTabs, []);
});

test("runLangGraphTask: close_tab_on=never leaves the tab open on success", async () => {
  const { finalTask, closedTabs } = await runTaskWithPolicy({ policy: "never" });
  assert.equal(finalTask.status, "succeeded");
  assert.deepEqual(closedTabs, [], "closeTab not called under never policy");
});

test("runLangGraphTask: waiting_user leaves the tab open as a trail", async () => {
  const { finalTask, closedTabs } = await runTaskWithPolicy({ emitQuestion: true });
  assert.equal(finalTask.status, "waiting_user");
  assert.deepEqual(closedTabs, [], "tab kept so the user can read the conversation");
});

// ── makeRoleNode: provider availability / fallback ───────────────────────────────

const HANDOFF_OUT = { stdout: 'MAESTRO_HANDOFF: {"summary":"ok"}', stderr: "", stdoutPath: null, stderrPath: null };

async function withRoleNode(taskPatch, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-avail-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260614-000001-avail";
    await db.createTask({ id: taskId, status: "running", prompt: "do it", cwd: dir, mode: "task", run_dir: null, ...taskPatch });
    return await fn({ db, taskId, dir });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("makeRoleNode: substitutes an available fallback once confirmed", async () => {
  await withRoleNode({ auto_fallback_confirmed: true }, async ({ db, taskId }) => {
    const role = { provider: "codex", fallback: ["claude"], prompt_template: "executor", permission: "write" };
    const seen = [];
    const runner = { runStep: async ({ provider }) => { seen.push(provider); return HANDOFF_OUT; } };
    const node = makeRoleNode(role, {
      db, runner, providerDef: DEFAULT_CONFIG.providers.codex, config: DEFAULT_CONFIG,
      availabilityProbe: (alias) => alias === "claude", // codex missing
    });
    const result = await node({ task: { id: taskId }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "done");
    assert.deepEqual(seen, ["claude"], "ran on the fallback provider");
    assert.equal(result.priorHandoffs[0].provider, "claude");
    const saved = await db.getTask(taskId);
    assert.ok(saved.steps.some((s) => s.status === "substituted"), "records a substituted step");
  });
});

test("makeRoleNode: first substitution pauses for confirmation", async () => {
  await withRoleNode({}, async ({ db, taskId }) => {
    const role = { provider: "codex", fallback: ["claude"], prompt_template: "executor", permission: "write" };
    const runner = { runStep: async () => { throw new Error("should not run before approval"); } };
    const node = makeRoleNode(role, {
      db, runner, providerDef: DEFAULT_CONFIG.providers.codex, config: DEFAULT_CONFIG,
      availabilityProbe: (alias) => alias === "claude",
    });
    const result = await node({ task: { id: taskId }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "error");
    const saved = await db.getTask(taskId);
    assert.equal(saved.status, "waiting_user");
    assert.equal(saved.blockers[0].code, "provider_substitution_pending");
    assert.equal(saved.pending_substitution.to, "claude");
  });
});

test("makeRoleNode: blocks with provider_missing when nothing resolves", async () => {
  await withRoleNode({}, async ({ db, taskId }) => {
    const role = { provider: "codex", prompt_template: "executor", permission: "write" };
    const runner = { runStep: async () => { throw new Error("should not run"); } };
    const node = makeRoleNode(role, {
      db, runner, providerDef: DEFAULT_CONFIG.providers.codex, config: DEFAULT_CONFIG,
      availabilityProbe: () => false,
    });
    const result = await node({ task: { id: taskId }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "error");
    const saved = await db.getTask(taskId);
    assert.equal(saved.status, "waiting_user");
    assert.equal(saved.blockers[0].code, "provider_missing");
    assert.match(saved.blockers[0].message, /not installed/i);
  });
});

test("makeRoleNode: usage-limit failure hops to an available fallback", async () => {
  await withRoleNode({ auto_fallback_confirmed: true }, async ({ db, taskId }) => {
    const role = { provider: "codex", fallback: ["claude"], prompt_template: "executor", permission: "write" };
    const seen = [];
    const runner = {
      runStep: async ({ provider }) => {
        seen.push(provider);
        if (provider === "codex") { const e = new Error("429 rate limit"); e.stderr = "rate limit exceeded"; throw e; }
        return HANDOFF_OUT;
      },
    };
    const node = makeRoleNode(role, {
      db, runner, providerDef: DEFAULT_CONFIG.providers.codex, config: DEFAULT_CONFIG,
      availabilityProbe: () => true, // both installed; codex just rate-limited
    });
    const result = await node({ task: { id: taskId }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "done");
    assert.deepEqual(seen, ["codex", "claude"], "retried on the fallback after the limit");
    assert.equal(result.priorHandoffs[0].provider, "claude");
    const saved = await db.getTask(taskId);
    assert.ok(saved.steps.some((s) => s.recovery === "usage_limit_fallback"), "records the usage-limit hop");
  });
});

// ── loop support: custom events, visit counting, loop limits ──────────────────

const LOOP_WORKFLOW = {
  version: 1,
  initial: "worker",
  roles: {
    worker:  { label: "Worker",  provider: "codex", prompt_template: "worker",  permission: "write" },
    checker: { label: "Checker", provider: "codex", prompt_template: "checker", permission: "read" },
  },
  transitions: {
    worker:  { done: "checker", question: "$ask_user", error: "$halt" },
    checker: { done: "$complete", revise: "worker", question: "$ask_user", error: "$halt" },
  },
  modes: { task: { initial: "worker" } },
};

function makeLoopRunner({ checkerOutputs, workerOutput = 'MAESTRO_HANDOFF: {"summary":"did work"}' }) {
  const calls = { worker: 0, checker: 0 };
  return {
    calls,
    runStep: async ({ role }) => {
      calls[role] += 1;
      const stdout = role === "checker"
        ? checkerOutputs[Math.min(calls.checker - 1, checkerOutputs.length - 1)]
        : workerOutput;
      return { stdout, stderr: "", stdoutPath: null, stderrPath: null };
    },
  };
}

async function runLoopGraph({ workflow = LOOP_WORKFLOW, runner, resumeCompletedRoles = null }) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-loop-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260611-000001-loop-test";
    await db.createTask({ id: taskId, status: "running", prompt: "loop it", cwd: dir, mode: "task", run_dir: null });
    const graph = buildGraph(workflow, DEFAULT_CONFIG, { db, runner, resumeCompletedRoles, availabilityProbe: () => true });
    const finalState = await graph.invoke(
      { task: await db.getTask(taskId), priorHandoffs: [], currentState: null, event: null },
      { configurable: { thread_id: taskId }, recursionLimit: 50 },
    );
    return { finalState, finalTask: await db.getTask(taskId) };
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("loop: checker 'revise' event routes back to worker, then completes", async () => {
  const runner = makeLoopRunner({
    checkerOutputs: [
      'MAESTRO_HANDOFF: {"event":"revise","summary":"needs another pass"}',
      'MAESTRO_HANDOFF: {"summary":"all good"}',
    ],
  });
  const { finalState } = await runLoopGraph({ runner });
  assert.equal(runner.calls.worker, 2, "worker re-runs after revise");
  assert.equal(runner.calls.checker, 2);
  assert.equal(finalState.event, "done");
  assert.deepEqual(finalState.visits, { worker: 2, checker: 2 });
  // fresh handoff supersedes the stale one for revisited roles
  const workerHandoffs = finalState.priorHandoffs.filter((h) => h.role === "worker");
  assert.equal(workerHandoffs.length, 1);
});

test("loop: reserved events in handoff payloads are ignored", async () => {
  const runner = makeLoopRunner({
    checkerOutputs: ['MAESTRO_HANDOFF: {"summary":"fine"}'],
    workerOutput: 'MAESTRO_HANDOFF: {"event":"error","summary":"sneaky"}',
  });
  const { finalState } = await runLoopGraph({ runner });
  assert.equal(runner.calls.checker, 1, "worker's reserved event did not halt the flow");
  assert.equal(finalState.event, "done");
});

test("loop: undeclared events fall back to done", async () => {
  const runner = makeLoopRunner({
    checkerOutputs: ['MAESTRO_HANDOFF: {"event":"undeclared_event","summary":"fine"}'],
  });
  const { finalState } = await runLoopGraph({ runner });
  assert.equal(finalState.event, "done");
  assert.equal(runner.calls.worker, 1, "undeclared event must not loop");
});

test("loop: max_visits exceeded pauses task with loop_limit_exceeded question", async () => {
  const workflow = structuredClone(LOOP_WORKFLOW);
  workflow.roles.worker.max_visits = 2;
  const runner = makeLoopRunner({
    checkerOutputs: ['MAESTRO_HANDOFF: {"event":"revise","summary":"again"}'],
  });
  const { finalState, finalTask } = await runLoopGraph({ workflow, runner });
  assert.equal(runner.calls.worker, 2, "worker capped at max_visits");
  assert.equal(finalState.event, "question");
  assert.equal(finalTask.status, "waiting_user");
  assert.match(String(finalTask.active_question?.question), /Loop limit reached/);
  assert.ok(finalTask.blockers?.some((b) => b.code === "loop_limit_exceeded"));
});

test("loop: loop_limits.on_exceeded=halt emits error instead of question", async () => {
  const workflow = structuredClone(LOOP_WORKFLOW);
  workflow.loop_limits = { default_max_visits: 1, on_exceeded: "halt" };
  const runner = makeLoopRunner({
    checkerOutputs: ['MAESTRO_HANDOFF: {"event":"revise","summary":"again"}'],
  });
  const { finalState, finalTask } = await runLoopGraph({ workflow, runner });
  assert.equal(finalState.event, "error");
  assert.equal(finalTask.status, "waiting_user");
  assert.ok(finalTask.blockers?.some((b) => b.code === "loop_limit_exceeded"));
});

test("loop: resume-skip regression — completed roles skip on first arrival only", async () => {
  const runner = makeLoopRunner({
    checkerOutputs: ['MAESTRO_HANDOFF: {"summary":"ok"}'],
  });
  const { finalState } = await runLoopGraph({
    runner,
    resumeCompletedRoles: new Set(["worker"]),
  });
  assert.equal(runner.calls.worker, 0, "previously-completed worker skipped on resume");
  assert.equal(runner.calls.checker, 1);
  assert.equal(finalState.event, "done");
});

test("standalone mode entry: imported role runs alone, default pipeline untouched", async () => {
  const workflow = structuredClone(DEFAULT_WORKFLOW);
  workflow.roles.system_evaluator = {
    label: "system-evaluator",
    provider: "claude",
    permission: "read",
    prompt_template: "system_evaluator",
    skip: "never",
    instructions: "Evaluate rigorously. Never modify the system.",
  };
  workflow.transitions.system_evaluator = { done: "$complete", question: "$ask_user", error: "$halt" };
  workflow.modes.system_evaluator = { initial: "system_evaluator", terminal_after: ["system_evaluator"] };

  const dir = await mkdtemp(path.join(tmpdir(), "maestro-standalone-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260612-000002-standalone";
    await db.createTask({ id: taskId, status: "running", prompt: "evaluate", cwd: dir, mode: "system_evaluator", run_dir: null });
    const calls = [];
    const runner = {
      runStep: async ({ role, prompt }) => {
        calls.push({ role, prompt });
        return { stdout: 'MAESTRO_HANDOFF: {"summary":"ok"}', stderr: "", stdoutPath: null, stderrPath: null };
      },
    };
    // graph must compile even though planner/executor/reviewer are not on this run's path
    const graph = buildGraph(workflow, DEFAULT_CONFIG, { db, runner, entry: "system_evaluator", availabilityProbe: () => true });
    const final = await graph.invoke(
      { task: await db.getTask(taskId), priorHandoffs: [], currentState: null, event: null },
      { configurable: { thread_id: taskId }, recursionLimit: 50 },
    );
    assert.equal(final.event, "done");
    assert.deepEqual(calls.map((c) => c.role), ["system_evaluator"]);
    assert.ok(calls[0].prompt.includes("Additional role instructions"), "inline instructions reach the prompt");
    assert.ok(calls[0].prompt.includes("MAESTRO_HANDOFF"), "custom role gets the marker protocol");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop recovery: answering the loop-limit question re-runs the capped cycle", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-loop-resume-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const workflow = structuredClone(LOOP_WORKFLOW);
    workflow.roles.worker.max_visits = 1;
    await store.writeWorkflow(workflow);
    const task = await store.createTask({ prompt: "loop it", cwd: dir, mode: "task" });

    const calls = [];
    let checkerCalls = 0;
    const stubRunner = {
      runStep: async ({ role }) => {
        calls.push(role);
        if (role === "checker") {
          checkerCalls += 1;
          return {
            stdout: checkerCalls === 1
              ? 'MAESTRO_HANDOFF: {"event":"revise","summary":"again"}'
              : 'MAESTRO_HANDOFF: {"summary":"ok"}',
            stderr: "", stdoutPath: null, stderrPath: null,
          };
        }
        return { stdout: 'MAESTRO_HANDOFF: {"summary":"worked"}', stderr: "", stdoutPath: null, stderrPath: null };
      },
    };

    // run 1: worker → checker(revise) → worker capped → ask_user question
    const run1 = await runLangGraphTask(task.id, {
      taskStore: store, maestroRoot: store.root, runner: stubRunner, stdout: silent, stderr: silent,
    });
    assert.equal(run1.task.status, "waiting_user");
    assert.match(String(run1.task.active_question?.question ?? ""), /Loop limit reached/);
    const callsAfterRun1 = calls.length;

    // user answers the loop-limit question
    await store.answerQuestion(task.id, "yes, one more round please");

    // run 2: the capped cycle re-runs with a fresh budget and completes
    const run2 = await runLangGraphTask(task.id, {
      taskStore: store, maestroRoot: store.root, runner: stubRunner, stdout: silent, stderr: silent,
    });
    const run2Calls = calls.slice(callsAfterRun1);
    assert.ok(run2Calls.includes("worker"), "capped role must re-run after the answer");
    assert.ok(run2Calls.includes("checker"), "the rest of the cycle re-runs too");
    assert.equal(run2.task.status, "succeeded");
    assert.ok(!(run2.task.blockers ?? []).some((b) => b.code === "loop_limit_exceeded"), "blocker cleared");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── resolveAgentRunner: herdr → terminal auto-fallback ──────────────────────────

test("resolveAgentRunner: falls back to terminal with a notice when herdr is missing", async () => {
  const { resolveAgentRunner } = await import("../src/langgraph/engine.mjs");
  const { TerminalAgentRunner } = await import("../src/agent-runner.mjs");
  let notice = "";
  const runner = await resolveAgentRunner(1_000, {
    env: {},
    stderr: { write: (text) => { notice += text; } },
    commandExists: async () => false,
  });
  assert.ok(runner instanceof TerminalAgentRunner);
  assert.match(notice, /herdr not found — using terminal backend/);
});

test("resolveAgentRunner: uses herdr when the binary exists", async () => {
  const { resolveAgentRunner } = await import("../src/langgraph/engine.mjs");
  const { HerdrAgentRunner } = await import("../src/herdr-agent-runner.mjs");
  let notice = "";
  const runner = await resolveAgentRunner(1_000, {
    env: {},
    stderr: { write: (text) => { notice += text; } },
    commandExists: async () => true,
  });
  assert.ok(runner instanceof HerdrAgentRunner);
  assert.equal(notice, "");
});

test("resolveAgentRunner: MAESTRO_BACKEND=terminal short-circuits without probing", async () => {
  const { resolveAgentRunner } = await import("../src/langgraph/engine.mjs");
  const { TerminalAgentRunner } = await import("../src/agent-runner.mjs");
  const runner = await resolveAgentRunner(1_000, {
    env: { MAESTRO_BACKEND: "terminal" },
    stderr: { write: () => { throw new Error("no notice expected"); } },
    commandExists: async () => { throw new Error("must not probe"); },
  });
  assert.ok(runner instanceof TerminalAgentRunner);
});

test("resolveAgentRunner: honors HERDR_BIN for the probe", async () => {
  const { resolveAgentRunner } = await import("../src/langgraph/engine.mjs");
  const probed = [];
  await resolveAgentRunner(1_000, {
    env: { HERDR_BIN: "/opt/custom/herdr" },
    stderr: { write: () => {} },
    commandExists: async (name) => { probed.push(name); return true; },
  });
  assert.deepEqual(probed, ["/opt/custom/herdr"]);
});

// ── started_at + run summary ─────────────────────────────────────────────────────

test("steps record started_at alongside completed_at", async () => {
  const { finalTask } = await runTaskWithPolicy();
  assert.ok(finalTask.steps.length > 0);
  for (const step of finalTask.steps) {
    assert.equal(typeof step.started_at, "string", `step ${step.role} missing started_at`);
    assert.ok(
      Date.parse(step.started_at) <= Date.parse(step.completed_at),
      `step ${step.role} started after it completed`,
    );
  }
});

test("buildRunSummary computes durations and tolerates missing logs", async () => {
  const { buildRunSummary } = await import("../src/run-summary.mjs");
  const summary = await buildRunSummary({
    id: "t-1",
    status: "succeeded",
    run_dir: "/tmp/run",
    steps: [
      {
        role: "executor",
        provider: "codex",
        status: "succeeded",
        started_at: "2026-06-12T00:00:00.000Z",
        completed_at: "2026-06-12T00:00:12.000Z",
        stdout_path: "/tmp/run/executor.stdout.log",
      },
      { role: "reviewer", provider: "codex", status: "waiting" },
    ],
  }, { stat: async () => ({ size: 2_048 }) });
  assert.equal(summary.task_id, "t-1");
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows[0].duration_ms, 12_000);
  assert.equal(summary.rows[0].stdout_bytes, 2_048);
  assert.equal(summary.rows[1].duration_ms, null);
  assert.equal(summary.rows[1].stdout_bytes, null);
});

test("formatRunSummary renders the role table and run dir", async () => {
  const { buildRunSummary, formatRunSummary } = await import("../src/run-summary.mjs");
  const summary = await buildRunSummary({
    id: "t-2",
    status: "succeeded",
    run_dir: "/tmp/run",
    steps: [{
      role: "executor",
      provider: "codex",
      status: "succeeded",
      started_at: "2026-06-12T00:00:00.000Z",
      completed_at: "2026-06-12T00:00:12.000Z",
      stdout_path: "/x",
    }],
  }, { stat: async () => ({ size: 2_048 }) });
  const text = formatRunSummary(summary);
  assert.match(text, /run summary: t-2 succeeded/);
  assert.match(text, /executor/);
  assert.match(text, /12s/);
  assert.match(text, /2\.0KB/);
  assert.match(text, /run dir: \/tmp\/run/);
});

test("formatDurationMs and formatBytes edge cases", async () => {
  const { formatDurationMs, formatBytes } = await import("../src/run-summary.mjs");
  assert.equal(formatDurationMs(null), "-");
  assert.equal(formatDurationMs(500), "<1s");
  assert.equal(formatDurationMs(12_000), "12s");
  assert.equal(formatDurationMs(182_000), "3m02s");
  assert.equal(formatDurationMs(3_840_000), "1h04m");
  assert.equal(formatBytes(null), "-");
  assert.equal(formatBytes(812), "812B");
  assert.equal(formatBytes(18_432), "18.0KB");
  assert.equal(formatBytes(2_097_152), "2.0MB");
});

// ── runLangGraphTask: per-task workflow selection (SP0a) ─────────────────────

test("runLangGraphTask runs the task's named workflow (solo = executor only)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-wf-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.applyWorkflowTemplate({ name: "solo", as: "solo" });
    const task = await store.createTask({ prompt: "do it", cwd: dir, workflow: "solo" });

    const roles = [];
    const stubRunner = {
      runStep: async ({ role }) => {
        roles.push(role);
        return {
          stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ summary: "done" })}`,
          stderr: "",
          stdoutPath: null,
          stderrPath: null,
        };
      },
    };

    const { task: finalTask } = await runLangGraphTask(task.id, {
      taskStore: store,
      maestroRoot: store.root,
      runner: stubRunner,
      stdout: silent,
      stderr: silent,
      availabilityProbe: () => true,
    });
    assert.equal(finalTask.status, "succeeded");
    assert.deepEqual([...new Set(roles)], ["executor"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runLangGraphTask surfaces unknown_workflow as waiting_user", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-wf-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "do it", cwd: dir, workflow: "nope" });

    let ran = false;
    const stubRunner = { runStep: async () => { ran = true; return { stdout: "", stderr: "", stdoutPath: null, stderrPath: null }; } };

    const { task: finalTask } = await runLangGraphTask(task.id, {
      taskStore: store,
      maestroRoot: store.root,
      runner: stubRunner,
      stdout: silent,
      stderr: silent,
      availabilityProbe: () => true,
    });
    assert.equal(finalTask.status, "waiting_user");
    assert.equal(finalTask.blockers[0].code, "unknown_workflow");
    assert.equal(finalTask.blockers[0].workflow, "nope");
    assert.equal(ran, false, "graph must not build for an unknown workflow");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── full-audit-sweep: e2e spine + loop-back routing (SP2) ────────────────────

// Schema-conforming MAESTRO_HANDOFF per agent role; stubs are skipped by the
// runner (kind:"stub"). Used by the e2e test below.
const AUDIT_AGENT_OUTPUTS = {
  implementation: { summary: "did it", files_changed: ["a.js"], assumptions: [], risks: [] },
  review: { severity: "none", findings: [], recommendations: [] },
  threat_model: { threats: [], mitigations: [] },
  edge_cases: { edge_cases: [] },
  tests: { tests_created: [], coverage_targets: [] },
  human_approval: {},
};

test("full-audit-sweep: e2e runs the spine to human_approval, one handoff per stage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-audit-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const template = resolveWorkflowTemplate("full-audit-sweep");
    await store.writeWorkflow("full-audit-sweep", template);
    const task = await store.createTask({ prompt: "ship it", cwd: dir, workflow: "full-audit-sweep" });

    const ranRoles = [];
    const stubRunner = {
      runStep: async ({ role }) => {
        ranRoles.push(role);
        const payload = AUDIT_AGENT_OUTPUTS[role] ?? {};
        return { stdout: `MAESTRO_HANDOFF: ${JSON.stringify(payload)}`, stderr: "", stdoutPath: null, stderrPath: null };
      },
    };

    const { task: finalTask } = await runLangGraphTask(task.id, {
      taskStore: store,
      maestroRoot: store.root,
      runner: stubRunner,
      stdout: silent,
      stderr: silent,
      availabilityProbe: () => true,
    });

    assert.equal(finalTask.status, "succeeded");
    // stubs never reach the runner
    for (const stub of ["static_analysis", "evaluation", "regression"]) {
      assert.ok(!ranRoles.includes(stub), `stub ${stub} must not call the runner`);
    }

    const db = new SqliteTaskStore(path.join(store.root, "maestro.db"));
    try {
      const handoffs = await db.getHandoffs(task.id);
      const byRole = new Set(handoffs.map((h) => h.role));
      for (const role of Object.keys(template.roles)) {
        assert.ok(byRole.has(role), `missing handoff for ${role}`);
      }
      assert.equal(handoffs.length, 9, "exactly one handoff per stage");
      for (const h of handoffs) {
        if (h.schema_validation) assert.equal(h.schema_validation.ok, true, `${h.role} not conforming`);
      }
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("full-audit-sweep: review changes_requested routes back to implementation", () => {
  const template = resolveWorkflowTemplate("full-audit-sweep");
  assert.equal(template.transitions.review.changes_requested, "implementation");
  assert.equal(template.transitions.threat_model.changes_requested, "implementation");
  assert.equal(template.transitions.edge_cases.changes_requested, "implementation");
});

test("full-audit-sweep: review node emits changes_requested when handoff requests it", async () => {
  const template = resolveWorkflowTemplate("full-audit-sweep");
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-audit-review-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260614-000003-review";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    const stubRunner = {
      runStep: async () => ({
        stdout: 'MAESTRO_HANDOFF: {"severity":"high","findings":["x"],"recommendations":[],"event":"changes_requested"}',
        stderr: "", stdoutPath: null, stderrPath: null,
      }),
    };
    const node = makeRoleNode(template.roles.review, {
      db,
      runner: stubRunner,
      providerDef: DEFAULT_CONFIG.providers.claude,
      workflow: template,
      stateName: "review",
      availabilityProbe: () => true,
      config: DEFAULT_CONFIG,
    });
    const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "changes_requested");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("full-audit-sweep: persistent changes_requested pauses after the visit cap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-audit-loop-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const template = resolveWorkflowTemplate("full-audit-sweep");
    await store.writeWorkflow("full-audit-sweep", template);
    const task = await store.createTask({ prompt: "loop it", cwd: dir, workflow: "full-audit-sweep" });

    const stubRunner = {
      runStep: async ({ role }) => {
        if (role === "review") {
          return {
            stdout: 'MAESTRO_HANDOFF: {"severity":"high","findings":["x"],"recommendations":[],"event":"changes_requested"}',
            stderr: "", stdoutPath: null, stderrPath: null,
          };
        }
        const payload = AUDIT_AGENT_OUTPUTS[role] ?? {};
        return { stdout: `MAESTRO_HANDOFF: ${JSON.stringify(payload)}`, stderr: "", stdoutPath: null, stderrPath: null };
      },
    };

    const { task: finalTask } = await runLangGraphTask(task.id, {
      taskStore: store,
      maestroRoot: store.root,
      runner: stubRunner,
      stdout: silent,
      stderr: silent,
      availabilityProbe: () => true,
    });
    assert.equal(finalTask.status, "waiting_user");
    assert.ok((finalTask.blockers ?? []).some((b) => b.code === "loop_limit_exceeded"));
    assert.ok(finalTask.active_question);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("full-audit-sweep: malformed verifier output records ok:false but advances", async () => {
  const template = resolveWorkflowTemplate("full-audit-sweep");
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-audit-bad-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260614-000004-bad-review";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    const stubRunner = {
      runStep: async () => ({
        stdout: 'MAESTRO_HANDOFF: {"severity":"none","recommendations":[]}', // missing findings
        stderr: "", stdoutPath: null, stderrPath: null,
      }),
    };
    const node = makeRoleNode(template.roles.review, {
      db,
      runner: stubRunner,
      providerDef: DEFAULT_CONFIG.providers.claude,
      workflow: template,
      stateName: "review",
      availabilityProbe: () => true,
      config: DEFAULT_CONFIG,
    });
    const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "done", "soft validation must not gate routing");
    assert.equal(result.priorHandoffs[0].schema_validation.ok, false);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── SP3 commandRunner (default impl) — hermetic coreutils ────────────────────

import { commandRunner } from "../src/command-runner.mjs";

test("commandRunner: echo → exit 0 with stdout", async () => {
  const r = await commandRunner({ run: "echo hi", cwd: process.cwd(), timeoutMs: 5000 });
  assert.equal(r.exit_code, 0);
  assert.equal(r.timed_out, false);
  assert.match(r.stdout, /hi/);
});

test("commandRunner: false → exit 1", async () => {
  const r = await commandRunner({ run: "false", cwd: process.cwd(), timeoutMs: 5000 });
  assert.equal(r.exit_code, 1);
  assert.equal(r.timed_out, false);
});

test("commandRunner: sleep beyond timeout → timed_out, exit null, SIGTERM", async () => {
  const r = await commandRunner({ run: "sleep 5", cwd: process.cwd(), timeoutMs: 50 });
  assert.equal(r.timed_out, true);
  assert.equal(r.exit_code, null);
  assert.equal(r.signal, "SIGTERM");
});

test("commandRunner: missing binary resolves (no throw) with spawn_error", async () => {
  // sh runs but the inner binary is missing → non-zero exit (not a spawn_error
  // of sh itself). Force a spawn error by injecting a throwing spawnProcess.
  const r = await commandRunner({
    run: "echo hi",
    cwd: process.cwd(),
    timeoutMs: 5000,
    spawnProcess: () => { throw new Error("spawn ENOENT"); },
  });
  assert.equal(r.exit_code, 127);
  assert.equal(r.spawn_error, true);
});

test("commandRunner: child 'error' event resolves with spawn_error 127", async () => {
  const { EventEmitter } = await import("node:events");
  const fakeChild = new EventEmitter();
  fakeChild.kill = () => {};
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  const p = commandRunner({
    run: "x", cwd: process.cwd(), timeoutMs: 5000,
    spawnProcess: () => fakeChild,
  });
  fakeChild.emit("error", new Error("boom"));
  const r = await p;
  assert.equal(r.exit_code, 127);
  assert.equal(r.spawn_error, true);
});

test("commandRunner: bounded tail keeps last maxTailBytes", async () => {
  const r = await commandRunner({ run: "printf 'abcdefghij'", cwd: process.cwd(), timeoutMs: 5000, maxTailBytes: 4 });
  assert.equal(Buffer.from(r.stdout, "utf8").length <= 4, true);
  assert.equal(r.stdout, "ghij");
});

// ── SP3 kind:"command" node branch ───────────────────────────────────────────

function commandRoleDef(commands) {
  return {
    label: "Evaluation",
    kind: "command",
    provider: null,
    prompt_template: "evaluation",
    output_schema: "evaluation",
    commands,
  };
}

test("command node: two commands (exit0/exit1) → done, pass_rate 0.5, one failure, schema ok, runner never called", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-cmd-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260614-cmd-0001";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    const calls = [];
    const fakeRunner = async ({ run }) => {
      calls.push(run);
      return { exit_code: run === "good" ? 0 : 1, signal: null, stdout: "", stderr: "", timed_out: false };
    };
    const node = makeRoleNode(commandRoleDef([{ name: "ok", run: "good" }, { name: "bad", run: "boom" }]), {
      db, runner: THROWING_RUNNER, providerDef: null, stateName: "evaluation",
      ops: { commandRunner: fakeRunner },
    });
    const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "done");
    assert.equal(result.priorHandoffs[0].provider, null);
    assert.equal(result.priorHandoffs[0].payload.pass_rate, 0.5);
    assert.equal(result.priorHandoffs[0].payload.failures.length, 1);
    assert.deepEqual(result.priorHandoffs[0].payload.coverage, {});
    assert.equal(result.priorHandoffs[0].schema_validation.ok, true);
    assert.deepEqual(calls, ["good", "boom"]);
    // DB sentinel is "command", engine-visible handoff is null
    const handoffs = await db.getHandoffs(taskId);
    assert.equal(handoffs[0].provider, "command");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("command node: empty commands → runner never called, pass_rate 1", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-cmd-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260614-cmd-0002";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    let called = false;
    const node = makeRoleNode(commandRoleDef([]), {
      db, runner: THROWING_RUNNER, providerDef: null, stateName: "evaluation",
      ops: { commandRunner: async () => { called = true; return {}; } },
    });
    const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(called, false);
    assert.equal(result.event, "done");
    assert.equal(result.priorHandoffs[0].payload.pass_rate, 1);
    assert.deepEqual(result.priorHandoffs[0].payload.failures, []);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("command node: spawn-error result → one failure, done", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-cmd-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260614-cmd-0003";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    const node = makeRoleNode(commandRoleDef([{ name: "missing", run: "nope" }]), {
      db, runner: THROWING_RUNNER, providerDef: null, stateName: "evaluation",
      ops: { commandRunner: async () => ({ exit_code: 127, signal: null, stdout: "", stderr: "boom", timed_out: false, spawn_error: true }) },
    });
    const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "done");
    assert.equal(result.priorHandoffs[0].payload.pass_rate, 0);
    assert.equal(result.priorHandoffs[0].payload.failures.length, 1);
    assert.equal(result.priorHandoffs[0].payload.failures[0].exit_code, 127);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("command node: timeout result → failure timed_out:true, done", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-cmd-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260614-cmd-0004";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    const node = makeRoleNode(commandRoleDef([{ name: "slow", run: "sleep" }]), {
      db, runner: THROWING_RUNNER, providerDef: null, stateName: "evaluation",
      ops: { commandRunner: async () => ({ exit_code: null, signal: "SIGTERM", stdout: "", stderr: "", timed_out: true }) },
    });
    const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "done");
    assert.equal(result.priorHandoffs[0].payload.failures.length, 1);
    assert.equal(result.priorHandoffs[0].payload.failures[0].timed_out, true);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("command node: rejecting commandRunner is caught → failure, done (never throws)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-cmd-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260614-cmd-0005";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    const node = makeRoleNode(commandRoleDef([{ name: "c", run: "x" }]), {
      db, runner: THROWING_RUNNER, providerDef: null, stateName: "evaluation",
      ops: { commandRunner: async () => { throw new Error("rejected"); } },
    });
    const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "done");
    assert.equal(result.priorHandoffs[0].payload.failures.length, 1);
    assert.equal(result.priorHandoffs[0].payload.failures[0].exit_code, 127);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("command node: absent commandRunner → synthetic spawn-error, done", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-cmd-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260614-cmd-0006";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    const node = makeRoleNode(commandRoleDef([{ name: "c", run: "x" }]), {
      db, runner: THROWING_RUNNER, providerDef: null, stateName: "evaluation",
      ops: {},
    });
    const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.event, "done");
    assert.equal(result.priorHandoffs[0].payload.failures.length, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("command node: allow_failure failing command excluded from pass_rate + failures", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-cmd-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260614-cmd-0007";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    const node = makeRoleNode(commandRoleDef([
      { name: "ok", run: "good" },
      { name: "flaky", run: "bad", allow_failure: true },
    ]), {
      db, runner: THROWING_RUNNER, providerDef: null, stateName: "evaluation",
      ops: { commandRunner: async ({ run }) => ({ exit_code: run === "good" ? 0 : 1, signal: null, stdout: "", stderr: "", timed_out: false }) },
    });
    const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    assert.equal(result.priorHandoffs[0].payload.pass_rate, 1);
    assert.deepEqual(result.priorHandoffs[0].payload.failures, []);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("command node: resume skip → commandRunner never called", async () => {
  let called = false;
  const node = makeRoleNode(commandRoleDef([{ name: "c", run: "x" }]), {
    db: { getTask: () => { throw new Error("db should not be hit on resume skip"); } },
    runner: THROWING_RUNNER, providerDef: null, stateName: "evaluation",
    ops: { commandRunner: async () => { called = true; return {}; } },
  });
  const result = await node({
    task: { id: "t-resume" },
    priorHandoffs: [{ role: "evaluation", provider: null, payload: {} }],
    event: null, currentState: null,
  });
  assert.equal(result.event, "done");
  assert.equal(called, false);
});

// ── SP3 template conversion + real-command e2e + back-compat ─────────────────

test("full-audit-sweep template: evaluation is kind:command with commands:[]", () => {
  const template = resolveWorkflowTemplate("full-audit-sweep");
  assert.equal(template.roles.evaluation.kind, "command");
  assert.deepEqual(template.roles.evaluation.commands, []);
});

test("full-audit-sweep: real-command evaluation e2e → succeeded, pass_rate 0.5, bad in failures", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-cmd-e2e-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const template = resolveWorkflowTemplate("full-audit-sweep");
    template.roles.evaluation.commands = [{ name: "ok", run: "true" }, { name: "bad", run: "false" }];
    await store.writeWorkflow("full-audit-sweep", template);
    const task = await store.createTask({ prompt: "ship it", cwd: dir, workflow: "full-audit-sweep" });

    const stubRunner = {
      runStep: async ({ role }) => {
        const payload = AUDIT_AGENT_OUTPUTS[role] ?? {};
        return { stdout: `MAESTRO_HANDOFF: ${JSON.stringify(payload)}`, stderr: "", stdoutPath: null, stderrPath: null };
      },
    };
    const { task: finalTask } = await runLangGraphTask(task.id, {
      taskStore: store,
      maestroRoot: store.root,
      runner: stubRunner,
      stdout: silent,
      stderr: silent,
      availabilityProbe: () => true,
      ops: { commandRunner },
    });
    assert.equal(finalTask.status, "succeeded");

    const db = new SqliteTaskStore(path.join(store.root, "maestro.db"));
    try {
      const handoffs = await db.getHandoffs(task.id);
      const evaluation = handoffs.find((h) => h.role === "evaluation");
      assert.equal(evaluation.payload.pass_rate, 0.5);
      assert.ok(evaluation.payload.failures.some((f) => f.name === "bad"));
      assert.deepEqual(evaluation.payload.coverage, {});
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("back-compat: DEFAULT_WORKFLOW roles declare no kind (kind absent ⇒ agent)", () => {
  for (const role of Object.values(DEFAULT_WORKFLOW.roles)) {
    assert.equal(role.kind, undefined);
  }
});
