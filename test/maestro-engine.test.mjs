/**
 * Unit tests for the LangGraph engine modules:
 *   src/langgraph/graph.mjs   — buildGraph()
 *   src/langgraph/nodes.mjs   — makeRoleNode()
 *
 * These were previously untested. Each test uses a stub runner and a real
 * in-memory SqliteTaskStore (tmpdir) so no agent CLI binary is needed.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildGraph } from "../src/langgraph/graph.mjs";
import { makeRoleNode } from "../src/langgraph/nodes.mjs";
import { buildPromptFromHandoffs } from "../src/langgraph/prompt.mjs";
import { runLangGraphTask } from "../src/langgraph/engine.mjs";
import { SqliteTaskStore } from "../src/db/store.mjs";
import { getStageEvents } from "../src/stage-events.mjs";
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

// ── makeRoleNode: opt-in strict enforcement (U2) ─────────────────────────────────
// enforce_output_schema:true turns a soft validation failure into a hard halt
// (event "error" + a typed output_schema_violation blocker). Default (flag absent)
// stays soft: a non-conformant payload still routes "done".

test("makeRoleNode: enforce_output_schema halts with output_schema_violation on bad payload", async () => {
  const roleDef = {
    ...DEFAULT_WORKFLOW.roles.executor,
    output_schema: "implementation",
    enforce_output_schema: true,
  };
  const { dir, db, result, handoffs } = await runNodeWithSchema({
    roleDef,
    stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ summary: "missing arrays" })}`,
  });
  try {
    assert.equal(result.event, "error"); // routing HALTED
    const task = await db.getTask("20260614-000001-schema");
    assert.equal(task.status, "waiting_user");
    const blocker = (task.blockers ?? []).find((b) => b.code === "output_schema_violation");
    assert.ok(blocker, "expected an output_schema_violation blocker");
    assert.equal(blocker.role, "executor");
    assert.equal(blocker.schema, "implementation");
    assert.ok(Array.isArray(blocker.errors) && blocker.errors.length > 0);
    // a halted run records no handoff for this stage
    assert.equal(handoffs.length, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeRoleNode: enforce_output_schema passes through a conformant payload", async () => {
  const roleDef = {
    ...DEFAULT_WORKFLOW.roles.executor,
    output_schema: "implementation",
    enforce_output_schema: true,
  };
  const { dir, db, result } = await runNodeWithSchema({
    roleDef,
    stdout: `MAESTRO_HANDOFF: ${JSON.stringify(IMPL_OK)}`,
  });
  try {
    assert.equal(result.event, "done");
    assert.equal(result.priorHandoffs[0].schema_validation.ok, true);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeRoleNode: without enforce_output_schema a bad payload stays soft (done)", async () => {
  const roleDef = { ...DEFAULT_WORKFLOW.roles.executor, output_schema: "implementation" };
  const { dir, db, result } = await runNodeWithSchema({
    roleDef,
    stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ summary: "missing arrays" })}`,
  });
  try {
    assert.equal(result.event, "done"); // soft default — never halts
    assert.equal(result.priorHandoffs[0].schema_validation.ok, false);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeRoleNode: enforce_output_schema halts a non-LLM stub stage too", async () => {
  // Stubs auto-generate a payload from emptyPayloadForSchema; an inline schema
  // with a constraint the empty value can't meet (minLength) forces a violation,
  // proving strict enforcement is wired at the non-LLM node sites as well.
  const roleDef = {
    ...DEFAULT_WORKFLOW.roles.executor,
    kind: "stub",
    enforce_output_schema: true,
    output_schema: { type: "object", required: ["token"], properties: { token: { type: "string", minLength: 3 } } },
  };
  const { dir, db, result, handoffs } = await runNodeWithSchema({ roleDef, stdout: "" });
  try {
    assert.equal(result.event, "error");
    const task = await db.getTask("20260614-000001-schema");
    const blocker = (task.blockers ?? []).find((b) => b.code === "output_schema_violation");
    assert.ok(blocker, "expected an output_schema_violation blocker on the stub stage");
    assert.equal(handoffs.length, 0);
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

// A terminal role can route to $complete via a custom (agent-chosen) event, not
// just the engine-default "done" (e.g. the `triage` template: feature→$complete).
// The final-state interpreter must finalize such a run as succeeded — otherwise
// the task is stranded "running" after reaching the complete sink.
test("runLangGraphTask: custom event routing to $complete finalizes succeeded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-complete-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "classify it", cwd: dir, reviewEnabled: false });
    await writeFile(
      path.join(store.root, "workflow.json"),
      JSON.stringify({
        version: 2,
        initial: "triage",
        roles: { triage: { label: "Triage", provider: "codex", prompt_template: "triage", permission: "read" } },
        transitions: { triage: { feature: "$complete", clarify: "$ask_user", error: "$halt" } },
        modes: { task: { initial: "triage" } },
      }),
    );
    const runner = {
      runStep: async () => ({
        stdout: 'MAESTRO_HANDOFF: {"event":"feature","rationale":"net-new flag"}',
        stderr: "",
        stdoutPath: null,
        stderrPath: null,
      }),
    };
    const { task: finalTask } = await runLangGraphTask(task.id, {
      taskStore: store,
      maestroRoot: store.root,
      runner,
      stdout: silent,
      stderr: silent,
      availabilityProbe: () => true,
    });
    assert.equal(finalTask.status, "succeeded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Security (audit finding F1): a role `source` that escapes the project (absolute
// or "..") must be blocked BEFORE loadRole reads it — otherwise an imported/shared
// workflow could read an arbitrary file into the prompt + run-manifest. The
// engine MRC loop is the sole enforceable gate (validateWorkflow runs after
// composeRole strips `source` and is non-blocking).
test("runLangGraphTask: unsafe role.source path is blocked before load (path-escape guard)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-srcguard-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "x", cwd: dir, reviewEnabled: false });
    await writeFile(
      path.join(store.root, "workflow.json"),
      JSON.stringify({
        version: 2,
        initial: "worker",
        roles: {
          worker: {
            label: "W",
            provider: "codex",
            prompt_template: "worker",
            permission: "read",
            source: "../../../../../../etc/hostname", // escapes the project
          },
        },
        transitions: { worker: { done: "$complete", error: "$halt" } },
        modes: { task: { initial: "worker" } },
      }),
    );
    const runner = {
      runStep: async () => ({ stdout: 'MAESTRO_HANDOFF: {"summary":"x"}', stderr: "", stdoutPath: null, stderrPath: null }),
    };
    const { task: finalTask } = await runLangGraphTask(task.id, {
      taskStore: store,
      maestroRoot: store.root,
      runner,
      stdout: silent,
      stderr: silent,
      availabilityProbe: () => true,
    });
    assert.equal(finalTask.status, "waiting_user");
    assert.ok(
      (finalTask.blockers ?? []).some((b) => b.code === "bad_role_source"),
      "unsafe source must produce a bad_role_source blocker, not be read",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    // non-agent stages never reach the runner (stub / command / regression / scoring)
    for (const stub of ["static_analysis", "evaluation", "regression", "scoring"]) {
      assert.ok(!ranRoles.includes(stub), `non-agent stage ${stub} must not call the runner`);
    }

    const db = new SqliteTaskStore(path.join(store.root, "maestro.db"));
    try {
      const handoffs = await db.getHandoffs(task.id);
      const byRole = new Set(handoffs.map((h) => h.role));
      for (const role of Object.keys(template.roles)) {
        assert.ok(byRole.has(role), `missing handoff for ${role}`);
      }
      assert.equal(handoffs.length, 10, "exactly one handoff per stage");
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

test("SP6b: engine seam materialises one events row per step, no dupes on re-run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-events-seam-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const template = resolveWorkflowTemplate("full-audit-sweep");
    await store.writeWorkflow("full-audit-sweep", template);
    const task = await store.createTask({ prompt: "ship it", cwd: dir, workflow: "full-audit-sweep" });

    const stubRunner = {
      runStep: async ({ role }) => {
        const payload = AUDIT_AGENT_OUTPUTS[role] ?? {};
        return { stdout: `MAESTRO_HANDOFF: ${JSON.stringify(payload)}`, stderr: "", stdoutPath: null, stderrPath: null };
      },
    };

    const runOnce = () => runLangGraphTask(task.id, {
      taskStore: store,
      maestroRoot: store.root,
      runner: stubRunner,
      stdout: silent,
      stderr: silent,
      availabilityProbe: () => true,
    });

    await runOnce();

    const db = new SqliteTaskStore(path.join(store.root, "maestro.db"));
    try {
      const endTask = await db.getTask(task.id);
      const projected = getStageEvents(endTask);
      const materialised = await db.getStageEventsForTask(task.id);
      assert.ok(projected.length > 0, "expected at least one projected event");
      assert.equal(materialised.length, projected.length, "one row per projected step");
      assert.deepEqual(materialised.map((e) => e.stage), projected.map((e) => e.stage));
      assert.deepEqual(materialised.map((e) => e.status), projected.map((e) => e.status));

      // Re-run / resume re-materialises without duplicating.
      await runOnce();
      const after = await db.getStageEventsForTask(task.id);
      const reProjected = getStageEvents(await db.getTask(task.id));
      assert.equal(after.length, reProjected.length, "re-run must not duplicate rows");
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
import { regressionStore } from "../src/regression-corpus.mjs";

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

// ── SP4 kind:"regression" node branch ────────────────────────────────────────

function regressionRoleDef(overrides = {}) {
  return {
    label: "Regression",
    kind: "regression",
    provider: null,
    prompt_template: "regression",
    output_schema: "regression",
    fail_event: "regressions_found",
    ...overrides,
  };
}

// In-memory fake regressionStore. `cmd` maps a case-run string → result object.
function fakeStore({ cases = [], loadErrors = [], promoted = [], writeErrors = [], onPromote } = {}) {
  return {
    loadCorpus: async () => ({ cases, loadErrors }),
    promoteFailures: async (args) => (onPromote ? onPromote(args) : { promoted, writeErrors }),
    deriveCaseId: (f) => f.id,
  };
}

async function runRegressionNode(roleDef, { ops, db: dbArg, priorHandoffs = [], config = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-reg-"));
  const db = dbArg ?? new SqliteTaskStore(path.join(dir, "maestro.db"));
  const taskId = `20260614-reg-${Math.random().toString(36).slice(2, 8)}`;
  await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
  const node = makeRoleNode(roleDef, {
    db, runner: THROWING_RUNNER, providerDef: null, stateName: "regression", config, ops,
  });
  const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs, event: null, currentState: null });
  return { result, db, dir, taskId };
}

test("regression node: 2 cases (pass/fail) → 2 run, 1 new_failure, schema ok, runner untouched", async () => {
  const ops = {
    regressionStore: fakeStore({ cases: [
      { id: "a", command: { run: "good" } },
      { id: "b", command: { run: "bad" } },
    ] }),
    commandRunner: async ({ run }) => ({ exit_code: run === "good" ? 0 : 1, signal: null, stdout: "", stderr: "", timed_out: false }),
  };
  const { result, db, dir } = await runRegressionNode(regressionRoleDef(), { ops });
  try {
    const p = result.priorHandoffs[0].payload;
    assert.equal(p.regressions_run.length, 2);
    assert.equal(p.new_failures.length, 1);
    assert.equal(p.new_failures[0].id, "b");
    assert.equal(p.new_failures[0].exit_code, 1);
    assert.equal(p.new_failures[0].timed_out, false);
    assert.equal(p.new_failures[0].attempts, 1);
    assert.equal("output_tail" in p.new_failures[0], true);
    assert.equal("passed" in p.new_failures[0], false); // new_failures omit `passed`
    assert.equal(result.priorHandoffs[0].schema_validation.ok, true);
    assert.equal(result.priorHandoffs[0].provider, null);
    assert.equal(result.event, "regressions_found");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: DB row carries provider sentinel 'regression', engine handoff null", async () => {
  const ops = { regressionStore: fakeStore({ cases: [] }) };
  const { result, db, dir, taskId } = await runRegressionNode(regressionRoleDef(), { ops });
  try {
    assert.equal(result.priorHandoffs[0].provider, null);
    const handoffs = await db.getHandoffs(taskId);
    assert.equal(handoffs[0].provider, "regression");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: retry fail→fail→pass ⇒ passed, attempts 3, done/clean", async () => {
  let n = 0;
  const ops = {
    regressionStore: fakeStore({ cases: [{ id: "a", command: { run: "x" } }] }),
    commandRunner: async () => {
      n += 1;
      return { exit_code: n < 3 ? 1 : 0, signal: null, stdout: "", stderr: "", timed_out: false };
    },
  };
  const { result, db, dir } = await runRegressionNode(regressionRoleDef({ attempts: 3 }), { ops });
  try {
    const p = result.priorHandoffs[0].payload;
    assert.equal(p.regressions_run[0].passed, true);
    assert.equal(p.regressions_run[0].attempts, 3);
    assert.equal(p.new_failures.length, 0);
    assert.equal(result.event, "done");
    assert.equal(p.outcome, "clean");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: retry fail×3 ⇒ not passed, attempts 3, one new_failure, regressions_found", async () => {
  const ops = {
    regressionStore: fakeStore({ cases: [{ id: "a", command: { run: "x" } }] }),
    commandRunner: async () => ({ exit_code: 1, signal: null, stdout: "", stderr: "", timed_out: false }),
  };
  const { result, db, dir } = await runRegressionNode(regressionRoleDef({ attempts: 3 }), { ops });
  try {
    const p = result.priorHandoffs[0].payload;
    assert.equal(p.regressions_run[0].passed, false);
    assert.equal(p.regressions_run[0].attempts, 3);
    assert.equal(p.new_failures.length, 1);
    assert.equal(result.event, "regressions_found");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: first-try pass stops early (attempts 1, runner called once)", async () => {
  let calls = 0;
  const ops = {
    regressionStore: fakeStore({ cases: [{ id: "a", command: { run: "x" } }] }),
    commandRunner: async () => { calls += 1; return { exit_code: 0, signal: null, stdout: "", stderr: "", timed_out: false }; },
  };
  const { result, db, dir } = await runRegressionNode(regressionRoleDef({ attempts: 3 }), { ops });
  try {
    assert.equal(calls, 1);
    assert.equal(result.priorHandoffs[0].payload.regressions_run[0].attempts, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: attempts precedence — case > role > config", async () => {
  // case.attempts wins over role.attempts.
  let calls = 0;
  const ops1 = {
    regressionStore: fakeStore({ cases: [{ id: "a", attempts: 2, command: { run: "x" } }] }),
    commandRunner: async () => { calls += 1; return { exit_code: 1, signal: null, stdout: "", stderr: "", timed_out: false }; },
  };
  const r1 = await runRegressionNode(regressionRoleDef({ attempts: 5 }), { ops: ops1, config: { regression_attempts: 9 } });
  try {
    assert.equal(calls, 2);
    assert.equal(r1.result.priorHandoffs[0].payload.regressions_run[0].attempts, 2);
  } finally { r1.db.close(); await rm(r1.dir, { recursive: true, force: true }); }

  // no case/role value ⇒ config.regression_attempts used.
  calls = 0;
  const ops2 = {
    regressionStore: fakeStore({ cases: [{ id: "a", command: { run: "x" } }] }),
    commandRunner: async () => { calls += 1; return { exit_code: 1, signal: null, stdout: "", stderr: "", timed_out: false }; },
  };
  const r2 = await runRegressionNode(regressionRoleDef(), { ops: ops2, config: { regression_attempts: 2 } });
  try {
    assert.equal(calls, 2);
  } finally { r2.db.close(); await rm(r2.dir, { recursive: true, force: true }); }
});

test("regression node: empty corpus + no eval failures ⇒ all empty, clean, done", async () => {
  const ops = { regressionStore: fakeStore({ cases: [] }) };
  const { result, db, dir } = await runRegressionNode(regressionRoleDef(), { ops });
  try {
    const p = result.priorHandoffs[0].payload;
    assert.deepEqual(p.regressions_run, []);
    assert.deepEqual(p.new_failures, []);
    assert.deepEqual(p.promoted_tests, []);
    assert.deepEqual(p.corpus_load_errors, []);
    assert.equal(p.outcome, "clean");
    assert.equal(result.event, "done");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: one failing case ⇒ event regressions_found, outcome mirrors", async () => {
  const ops = {
    regressionStore: fakeStore({ cases: [{ id: "a", command: { run: "x" } }] }),
    commandRunner: async () => ({ exit_code: 1, signal: null, stdout: "", stderr: "", timed_out: false }),
  };
  const { result, db, dir } = await runRegressionNode(regressionRoleDef(), { ops });
  try {
    assert.equal(result.event, "regressions_found");
    assert.equal(result.priorHandoffs[0].payload.outcome, "regressions_found");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: fail_threshold 2 with one failure ⇒ done", async () => {
  const ops = {
    regressionStore: fakeStore({ cases: [{ id: "a", command: { run: "x" } }] }),
    commandRunner: async () => ({ exit_code: 1, signal: null, stdout: "", stderr: "", timed_out: false }),
  };
  const { result, db, dir } = await runRegressionNode(regressionRoleDef({ fail_threshold: 2 }), { ops });
  try {
    assert.equal(result.priorHandoffs[0].payload.new_failures.length, 1);
    assert.equal(result.event, "done");
    assert.equal(result.priorHandoffs[0].payload.outcome, "clean");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: custom fail_event honored", async () => {
  const ops = {
    regressionStore: fakeStore({ cases: [{ id: "a", command: { run: "x" } }] }),
    commandRunner: async () => ({ exit_code: 1, signal: null, stdout: "", stderr: "", timed_out: false }),
  };
  const { result, db, dir } = await runRegressionNode(regressionRoleDef({ fail_event: "oops" }), { ops });
  try {
    assert.equal(result.event, "oops");
    assert.equal(result.priorHandoffs[0].payload.outcome, "oops");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: auto-promotion + dedup against existing corpus", async () => {
  let promoteArgs = null;
  const ops = {
    regressionStore: fakeStore({
      cases: [{ id: "lint-existing", command: { run: "npm run lint" } }],
      onPromote: (args) => {
        promoteArgs = args;
        // store reports one new promoted entry (the second failure)
        return { promoted: [{ id: "test-new", source: "evaluation.failures", run: "npm test", category: "unit", path: "/tmp/test-new.json" }], writeErrors: [] };
      },
    }),
    commandRunner: async () => ({ exit_code: 0, signal: null, stdout: "", stderr: "", timed_out: false }),
  };
  const priorHandoffs = [{
    role: "evaluation",
    provider: null,
    payload: { failures: [
      { name: "lint", run: "npm run lint", category: "lint" },
      { name: "test", run: "npm test", category: "unit" },
    ] },
  }];
  const { result, db, dir } = await runRegressionNode(regressionRoleDef(), { ops, priorHandoffs });
  try {
    const p = result.priorHandoffs[0].payload;
    assert.equal(p.promoted_tests.length, 1);
    assert.equal(p.promoted_tests[0].id, "test-new");
    assert.equal(p.promoted_tests[0].source, "evaluation.failures");
    assert.ok(p.promoted_tests[0].path);
    // existingIds passed to the store includes the already-present corpus id
    assert.ok(promoteArgs.existingIds.has("lint-existing"));
    assert.equal(promoteArgs.failures.length, 2);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: no prior evaluation handoff ⇒ promoted_tests empty, corpus still runs", async () => {
  let promoteCalled = false;
  const ops = {
    regressionStore: {
      loadCorpus: async () => ({ cases: [{ id: "a", command: { run: "x" } }], loadErrors: [] }),
      promoteFailures: async () => { promoteCalled = true; return { promoted: [], writeErrors: [] }; },
    },
    commandRunner: async () => ({ exit_code: 0, signal: null, stdout: "", stderr: "", timed_out: false }),
  };
  const { result, db, dir } = await runRegressionNode(regressionRoleDef(), { ops });
  try {
    assert.deepEqual(result.priorHandoffs[0].payload.promoted_tests, []);
    assert.equal(result.priorHandoffs[0].payload.regressions_run.length, 1);
    assert.equal(promoteCalled, false);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: load errors don't halt; appear in corpus_load_errors", async () => {
  const ops = {
    regressionStore: fakeStore({
      cases: [{ id: "a", command: { run: "x" } }],
      loadErrors: [{ file: "broken.json", error: "bad" }],
    }),
    commandRunner: async () => ({ exit_code: 0, signal: null, stdout: "", stderr: "", timed_out: false }),
  };
  const { result, db, dir } = await runRegressionNode(regressionRoleDef(), { ops });
  try {
    const p = result.priorHandoffs[0].payload;
    assert.equal(p.corpus_load_errors.length, 1);
    assert.equal(p.regressions_run.length, 1);
    assert.equal(result.event, "done");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: absent regressionStore ⇒ done, empty arrays (no runner)", async () => {
  const { result, db, dir } = await runRegressionNode(regressionRoleDef(), { ops: {} });
  try {
    const p = result.priorHandoffs[0].payload;
    assert.deepEqual(p.regressions_run, []);
    assert.deepEqual(p.new_failures, []);
    assert.equal(result.event, "done");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: throwing commandRunner ⇒ synthetic 127 failure, never throws", async () => {
  const ops = {
    regressionStore: fakeStore({ cases: [{ id: "c", command: { run: "x" } }] }),
    commandRunner: async () => { throw new Error("rej"); },
  };
  const { result, db, dir } = await runRegressionNode(regressionRoleDef(), { ops });
  try {
    const p = result.priorHandoffs[0].payload;
    assert.equal(p.new_failures.length, 1);
    assert.equal(p.new_failures[0].exit_code, 127);
    assert.equal(result.event, "regressions_found");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: promote write failure tolerated (writeErrors swallowed)", async () => {
  const ops = {
    regressionStore: fakeStore({
      cases: [],
      onPromote: () => ({ promoted: [], writeErrors: [{ id: "x", error: "EACCES" }] }),
    }),
  };
  const priorHandoffs = [{ role: "evaluation", provider: null, payload: { failures: [{ name: "lint", run: "npm run lint" }] } }];
  const { result, db, dir } = await runRegressionNode(regressionRoleDef(), { ops, priorHandoffs });
  try {
    assert.deepEqual(result.priorHandoffs[0].payload.promoted_tests, []);
    assert.equal(result.event, "done"); // clean corpus ⇒ done despite write error
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression node: resume skip ⇒ neither store nor runner called", async () => {
  let touched = false;
  const node = makeRoleNode(regressionRoleDef(), {
    db: { getTask: () => { throw new Error("db should not be hit on resume skip"); } },
    runner: THROWING_RUNNER, providerDef: null, stateName: "regression",
    ops: {
      regressionStore: { loadCorpus: async () => { touched = true; return { cases: [], loadErrors: [] }; } },
      commandRunner: async () => { touched = true; return {}; },
    },
  });
  const result = await node({
    task: { id: "t-resume" },
    priorHandoffs: [{ role: "regression", provider: null, payload: {} }],
    event: null, currentState: null,
  });
  assert.equal(result.event, "done");
  assert.equal(touched, false);
});

// ── SP4 template conversion + e2e + back-compat ──────────────────────────────

test("full-audit-sweep template: regression is kind:regression with loop-back transition", () => {
  const template = resolveWorkflowTemplate("full-audit-sweep");
  assert.equal(template.roles.regression.kind, "regression");
  assert.equal(template.transitions.regression.regressions_found, "implementation");
  // SP5 repoints regression.done from human_approval to the new scoring stage.
  assert.equal(template.transitions.regression.done, "scoring");
});

test("full-audit-sweep: clean-corpus e2e → succeeded, regression handoff clean, runner untouched", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-reg-e2e-"));
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
      ops: { commandRunner, regressionStore },
    });
    assert.equal(finalTask.status, "succeeded");
    assert.ok(!ranRoles.includes("regression"), "regression must not call the agent runner");

    const db = new SqliteTaskStore(path.join(store.root, "maestro.db"));
    try {
      const handoffs = await db.getHandoffs(task.id);
      const regression = handoffs.find((h) => h.role === "regression");
      assert.ok(regression, "regression handoff present");
      assert.deepEqual(regression.payload.regressions_run, []);
      assert.deepEqual(regression.payload.new_failures, []);
      assert.equal(regression.payload.outcome, "clean");
      assert.equal(regression.provider, "regression");
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── SP5 kind:"scoring" node branch ───────────────────────────────────────────

function scoringRoleDef(overrides = {}) {
  return {
    label: "Scoring",
    kind: "scoring",
    provider: null,
    permission: "read",
    prompt_template: "scoring",
    output_schema: "scoring",
    ...overrides,
  };
}

// Full conforming upstream handoffs (priorHandoffs shape) → all scores 1.0.
function fullPriorHandoffs() {
  return [
    { role: "evaluation", provider: null, payload: { pass_rate: 1.0, failures: [], coverage: {} } },
    { role: "tests", provider: null, payload: { tests_created: ["a.test.js"], coverage_targets: [] } },
    { role: "review", provider: null, payload: { severity: "none", findings: [], recommendations: [] } },
    { role: "threat_model", provider: null, payload: { threats: [], mitigations: [] } },
    { role: "regression", provider: null, payload: { regressions_run: [], new_failures: [], promoted_tests: [] } },
  ];
}

async function runScoringNode(roleDef, { priorHandoffs = [], workflow = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-score-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  const taskId = `20260615-score-${Math.random().toString(36).slice(2, 8)}`;
  await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
  const node = makeRoleNode(roleDef, {
    db, runner: THROWING_RUNNER, providerDef: null, stateName: "scoring", workflow,
  });
  const result = await node({ task: { id: taskId, run_dir: null }, priorHandoffs, event: null, currentState: null });
  return { result, db, dir, taskId };
}

test("scoring node: full handoffs, no gates ⇒ six scores, passed, schema ok, sentinel scoring, runner untouched", async () => {
  const { result, db, dir, taskId } = await runScoringNode(scoringRoleDef(), {
    priorHandoffs: fullPriorHandoffs(),
  });
  try {
    const p = result.priorHandoffs[0].payload;
    assert.equal(p.correctness_score, 1.0);
    assert.equal(p.review_score, 1.0);
    assert.equal(p.security_score, 1.0);
    assert.equal(p.test_score, 1.0);
    assert.equal(p.regression_score, 1.0);
    assert.equal(p.overall_confidence, 1.0);
    assert.deepEqual(p.missing_evidence, []);
    assert.deepEqual(p.gates, {});
    assert.deepEqual(p.blocked_reasons, []);
    assert.equal(result.event, "passed");
    assert.equal(result.priorHandoffs[0].provider, null);
    assert.equal(result.priorHandoffs[0].schema_validation.ok, true);
    const handoffs = await db.getHandoffs(taskId);
    assert.equal(handoffs[0].provider, "scoring");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoring node: missing evidence ⇒ 0 + flagged + overall 0", async () => {
  const prior = fullPriorHandoffs().filter((h) => h.role !== "threat_model");
  const { result, db, dir } = await runScoringNode(scoringRoleDef(), { priorHandoffs: prior });
  try {
    const p = result.priorHandoffs[0].payload;
    assert.equal(p.security_score, 0.0);
    assert.ok(p.missing_evidence.includes("threat_model"));
    assert.equal(p.score_inputs.security_score.missing, true);
    assert.equal(p.overall_confidence, 0.0);
    assert.equal(result.event, "passed"); // no gates ⇒ informational
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoring node: blocking gate ⇒ blocked event + blocked_reasons + gate.passed false", async () => {
  const prior = fullPriorHandoffs().filter((h) => h.role !== "threat_model"); // overall 0
  const { result, db, dir } = await runScoringNode(scoringRoleDef(), {
    priorHandoffs: prior,
    workflow: { gates: { min_overall_confidence: 0.99 } },
  });
  try {
    const p = result.priorHandoffs[0].payload;
    assert.equal(result.event, "blocked");
    assert.equal(p.gates.min_overall_confidence.passed, false);
    assert.ok(p.blocked_reasons.length >= 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoring node: passing gate ⇒ passed event", async () => {
  const { result, db, dir } = await runScoringNode(scoringRoleDef(), {
    priorHandoffs: fullPriorHandoffs(),
    workflow: { gates: { min_overall_confidence: 0.5 } },
  });
  try {
    assert.equal(result.event, "passed");
    assert.equal(result.priorHandoffs[0].payload.gates.min_overall_confidence.passed, true);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoring node: custom pass_event/block_event honored", async () => {
  // passing custom
  const pass = await runScoringNode(scoringRoleDef({ pass_event: "ok", block_event: "stop" }), {
    priorHandoffs: fullPriorHandoffs(),
  });
  try {
    assert.equal(pass.result.event, "ok");
  } finally {
    pass.db.close();
    await rm(pass.dir, { recursive: true, force: true });
  }
  // blocking custom
  const block = await runScoringNode(scoringRoleDef({ pass_event: "ok", block_event: "stop" }), {
    priorHandoffs: fullPriorHandoffs(),
    workflow: { gates: { min_overall_confidence: 1.1 } },
  });
  try {
    assert.equal(block.result.event, "stop");
  } finally {
    block.db.close();
    await rm(block.dir, { recursive: true, force: true });
  }
});

test("scoring node: role-level gates override (no workflow gates)", async () => {
  const { result, db, dir } = await runScoringNode(
    scoringRoleDef({ gates: { min_overall_confidence: 1.1 } }),
    { priorHandoffs: fullPriorHandoffs(), workflow: {} },
  );
  try {
    assert.equal(result.event, "blocked");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoring node: last-write-wins for duplicate review handoffs", async () => {
  const prior = [
    ...fullPriorHandoffs(),
    { role: "review", provider: null, payload: { severity: "critical", findings: [], recommendations: [] } },
  ];
  const { result, db, dir } = await runScoringNode(scoringRoleDef(), { priorHandoffs: prior });
  try {
    // last review (critical → 0.0) wins over the earlier none (1.0)
    assert.equal(result.priorHandoffs[0].payload.review_score, 0.0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoring node: resume skip when scoring handoff already present ⇒ done, runner untouched", async () => {
  const node = makeRoleNode(scoringRoleDef(), {
    db: { getTask: async () => { throw new Error("getTask must not run on resume-skip"); } },
    runner: THROWING_RUNNER,
    providerDef: null,
    stateName: "scoring",
  });
  const result = await node({
    task: { id: "t", run_dir: null },
    priorHandoffs: [{ role: "scoring", provider: null, payload: {} }],
    event: null,
    currentState: null,
  });
  assert.equal(result.event, "done");
});

test("scoring node: empty priorHandoffs ⇒ all 0, passed (totality, no throw)", async () => {
  const { result, db, dir } = await runScoringNode(scoringRoleDef(), { priorHandoffs: [] });
  try {
    const p = result.priorHandoffs[0].payload;
    assert.equal(p.overall_confidence, 0.0);
    assert.equal(p.correctness_score, 0.0);
    assert.equal(result.event, "passed");
    assert.equal(p.missing_evidence.length, 5);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── SP5 template insertion + e2e ──────────────────────────────────────────────

test("full-audit-sweep template: scoring kind + repointed transitions", () => {
  const template = resolveWorkflowTemplate("full-audit-sweep");
  assert.equal(template.roles.scoring.kind, "scoring");
  assert.equal(template.transitions.regression.done, "scoring");
  assert.equal(template.transitions.scoring.passed, "human_approval");
  assert.equal(template.transitions.scoring.blocked, "$halt");
});

test("full-audit-sweep: no gates ⇒ scoring routes to human_approval, six scores in handoff", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-score-e2e-"));
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
      ops: { commandRunner, regressionStore },
    });
    assert.equal(finalTask.status, "succeeded");
    assert.ok(!ranRoles.includes("scoring"), "scoring must not call the agent runner");

    const db = new SqliteTaskStore(path.join(store.root, "maestro.db"));
    try {
      const handoffs = await db.getHandoffs(task.id);
      const scoring = handoffs.find((h) => h.role === "scoring");
      assert.ok(scoring, "scoring handoff present");
      assert.equal(scoring.provider, "scoring");
      assert.equal(typeof scoring.payload.overall_confidence, "number");
      assert.deepEqual(scoring.payload.gates, {});
      assert.ok(handoffs.find((h) => h.role === "human_approval"), "reached human_approval");
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("full-audit-sweep: blocking gate ⇒ scoring routes to $halt, no human_approval", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-score-block-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const template = resolveWorkflowTemplate("full-audit-sweep");
    template.gates = { min_overall_confidence: 0.99 }; // empty tests_created ⇒ test_score 0 ⇒ overall 0
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
      ops: { commandRunner, regressionStore },
    });
    // blocked → $halt: task does not complete via human_approval
    assert.notEqual(finalTask.status, "succeeded");

    const db = new SqliteTaskStore(path.join(store.root, "maestro.db"));
    try {
      const handoffs = await db.getHandoffs(task.id);
      const scoring = handoffs.find((h) => h.role === "scoring");
      assert.ok(scoring, "scoring handoff present");
      assert.ok(scoring.payload.blocked_reasons.length >= 1);
      assert.equal(scoring.payload.gates.min_overall_confidence.passed, false);
      assert.ok(!handoffs.find((h) => h.role === "human_approval"), "must NOT reach human_approval");
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("full-audit-sweep: regressions_found loops back to implementation, bounded by loop_limits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-reg-loop-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const template = resolveWorkflowTemplate("full-audit-sweep");
    await store.writeWorkflow("full-audit-sweep", template);
    const task = await store.createTask({ prompt: "loop it", cwd: dir, workflow: "full-audit-sweep" });

    // Seed one corpus case that always fails.
    const corpusDir = path.join(dir, ".maestro", "regression");
    await mkdir(corpusDir, { recursive: true });
    await writeFile(path.join(corpusDir, "always-fail.json"), JSON.stringify({
      id: "always-fail", command: { run: "false" },
    }));

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
      ops: { commandRunner, regressionStore },
    });
    // The regression→implementation loop is bounded by loop_limits → eventually
    // pauses for the user (does not run forever / does not crash).
    assert.ok(["waiting_user", "succeeded"].includes(finalTask.status), `unexpected status ${finalTask.status}`);

    const db = new SqliteTaskStore(path.join(store.root, "maestro.db"));
    try {
      const handoffs = await db.getHandoffs(task.id);
      const regression = handoffs.find((h) => h.role === "regression");
      assert.ok(regression, "regression handoff present");
      assert.ok(regression.payload.new_failures.length >= 1);
    } finally {
      db.close();
    }
    // Explicit loop-back: the regressions_found event routed back to
    // implementation, so it ran more than once (steps append per visit and are
    // not deduped, unlike handoffs) — proves routing, not merely inferred from
    // the paused status.
    const implRuns = (finalTask.steps ?? []).filter((s) => s.role === "implementation").length;
    assert.ok(implRuns >= 2, `expected implementation re-visited, got ${implRuns} run(s)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── SP6a capture seam: non-LLM started_at + agent model/tokens ───────────────

test("capture seam: command node records started_at ⇒ projected duration_ms > 0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-sp6a-cmd-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260615-sp6a-cmd";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    const node = makeRoleNode(commandRoleDef([{ name: "ok", run: "good" }]), {
      db, runner: THROWING_RUNNER, providerDef: null, stateName: "evaluation",
      ops: { commandRunner: async () => ({ exit_code: 0, signal: null, stdout: "", stderr: "", timed_out: false }) },
    });
    await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    const task = await db.getTask(taskId);
    const step = task.steps.find((s) => s.role === "evaluation");
    assert.ok(step, "evaluation step recorded");
    assert.ok(step.started_at, "started_at stamped on non-LLM branch");
    const { getStageEvents } = await import("../src/stage-events.mjs");
    const event = getStageEvents(task).find((e) => e.stage === "evaluation");
    assert.ok(event.duration_ms >= 0, "duration_ms projects (>=0)");
    assert.equal(event.model, "", "non-LLM model is empty");
    assert.equal(event.tokens, 0, "non-LLM tokens is 0");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture seam: scoring node records started_at", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-sp6a-score-"));
  const db = new SqliteTaskStore(path.join(dir, "maestro.db"));
  try {
    const taskId = "20260615-sp6a-score";
    await db.createTask({ id: taskId, status: "running", prompt: "x", cwd: dir, mode: "task", run_dir: null });
    const roleDef = { kind: "scoring", prompt_template: "scoring", output_schema: "scoring", gates: {} };
    const node = makeRoleNode(roleDef, { db, runner: THROWING_RUNNER, providerDef: null, stateName: "scoring" });
    await node({ task: { id: taskId, run_dir: null }, priorHandoffs: [], event: null, currentState: null });
    const task = await db.getTask(taskId);
    const step = task.steps.find((s) => s.role === "scoring");
    assert.ok(step.started_at, "started_at stamped on scoring branch");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture seam: agent-success step stores model + parsed tokens", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-sp6a-agent-"));
  let db;
  try {
    db = new SqliteTaskStore(path.join(dir, "maestro.db"));
    const taskId = "20260615-sp6a-agent";
    await db.createTask({ id: taskId, status: "running", prompt: "add logging", cwd: dir, mode: "task", run_dir: null, planner_policy: "on" });
    const handoffPayload = { plan_summary: "p", steps: ["s"], files_to_touch: ["f"] };
    const claudeUsage = JSON.stringify({ type: "result", usage: { input_tokens: 100, output_tokens: 25 } });
    const stubRunner = {
      runStep: async () => ({
        stdout: `MAESTRO_HANDOFF: ${JSON.stringify(handoffPayload)}\n${claudeUsage}`,
        stderr: "",
        stdoutPath: null,
        stderrPath: null,
      }),
    };
    // planner role default model is "" — set one so model is captured non-empty.
    const roleDef = { ...DEFAULT_WORKFLOW.roles.planner, model: "claude-opus" };
    const node = makeRoleNode(roleDef, { db, runner: stubRunner, providerDef: DEFAULT_CONFIG.providers.claude });
    await node({ task: { id: taskId }, priorHandoffs: [], event: null, currentState: null });
    const task = await db.getTask(taskId);
    const step = task.steps.find((s) => s.role === "planner" && s.status === "succeeded");
    assert.ok(step, "succeeded planner step recorded");
    assert.equal(step.model, "claude-opus", "runModel stored on step");
    assert.equal(step.tokens, 125, "parsed claude usage stored on step");
  } finally {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── SP6c: engine writes run-manifest.json at run start ───────────────────────

// Drive a full task run with a stub runner (review disabled → reviewer
// synthesizes "complete"), returning the store + run_dir for manifest asserts.
async function runForManifest({ store, dir, taskPatch = {} } = {}) {
  const task = await store.createTask({
    prompt: "snapshot me", cwd: dir, reviewEnabled: false, plannerPolicy: "off",
    plannerModel: "p", executorModel: "e", ...taskPatch,
  });
  const stubRunner = {
    runStep: async () => ({
      stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ summary: "done" })}`,
      stderr: "", stdoutPath: null, stderrPath: null,
    }),
    closeTab: async () => {},
  };
  const { task: finalTask } = await runLangGraphTask(task.id, {
    taskStore: store, maestroRoot: store.root, runner: stubRunner,
    stdout: { write: () => {} }, stderr: { write: () => {} },
    availabilityProbe: () => true,
  });
  return { task, finalTask };
}

test("runLangGraphTask: writes run-manifest.json with the resolved snapshot + seeded inputs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-manifest-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const { task } = await runForManifest({ store, dir });
    const runDir = store.runDir(task.id);
    const manifest = JSON.parse(await readFile(path.join(runDir, "run-manifest.json"), "utf8"));

    assert.equal(manifest.manifest_version, 1);
    assert.equal(manifest.source_task_id, task.id);
    assert.deepEqual(manifest.workflow_snapshot, DEFAULT_WORKFLOW);
    // allow-listed task block reflects seeded inputs
    assert.equal(manifest.task.prompt, "snapshot me");
    assert.equal(manifest.task.review_enabled, false);
    assert.equal(manifest.task.planner_policy, "off");
    assert.equal(manifest.task.executor_model, "e");
    // identity fields excluded
    assert.ok(!("id" in manifest.task));
    assert.ok(!("steps" in manifest.task));
    assert.ok(!("status" in manifest.task));
    // maestro_version present
    assert.match(manifest.maestro_version, /^\d/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runLangGraphTask: a forced manifest-write error is swallowed; the run still completes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-manifest-err-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "x", cwd: dir, reviewEnabled: false, plannerPolicy: "off" });
    // Make run-manifest.json a DIRECTORY so writeFile(run-manifest.json) fails
    // (run_dir itself stays a valid dir so the engine's mkdir succeeds).
    const runDir = store.runDir(task.id);
    await mkdir(path.join(runDir, "run-manifest.json"), { recursive: true });
    const stubRunner = {
      runStep: async () => ({ stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ summary: "ok" })}`, stderr: "", stdoutPath: null, stderrPath: null }),
      closeTab: async () => {},
    };
    const stderrLines = [];
    const { task: finalTask } = await runLangGraphTask(task.id, {
      taskStore: store, maestroRoot: store.root, runner: stubRunner,
      stdout: { write: () => {} }, stderr: { write: (t) => stderrLines.push(t) },
      availabilityProbe: () => true,
    });
    assert.equal(finalTask.status, "succeeded", "run completes despite manifest write failure");
    assert.ok(stderrLines.join("").includes("run-manifest write failed"), "failure logged to stderr");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runLangGraphTask: resume overwrites the manifest, leaving a single file (no error)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-manifest-resume-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const { task } = await runForManifest({ store, dir });
    const runDir = store.runDir(task.id);
    // Re-run the same task (resume): manifest write is idempotent.
    const stubRunner = {
      runStep: async () => ({ stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ summary: "again" })}`, stderr: "", stdoutPath: null, stderrPath: null }),
      closeTab: async () => {},
    };
    await runLangGraphTask(task.id, {
      taskStore: store, maestroRoot: store.root, runner: stubRunner,
      stdout: { write: () => {} }, stderr: { write: () => {} },
      availabilityProbe: () => true,
    });
    const manifest = JSON.parse(await readFile(path.join(runDir, "run-manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 1);
    assert.deepEqual(manifest.workflow_snapshot, DEFAULT_WORKFLOW);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
