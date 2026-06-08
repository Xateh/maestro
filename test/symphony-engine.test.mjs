/**
 * Unit tests for the LangGraph engine modules:
 *   src/langgraph/graph.mjs   — buildGraph()
 *   src/langgraph/nodes.mjs   — makeRoleNode()
 *
 * These were previously untested. Each test uses a stub runner and a real
 * in-memory SqliteTaskStore (tmpdir) so no agent CLI binary is needed.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildGraph } from "../src/langgraph/graph.mjs";
import { makeRoleNode } from "../src/langgraph/nodes.mjs";
import { SqliteTaskStore } from "../src/db/store.mjs";
import { DEFAULT_WORKFLOW } from "../src/task-store.mjs";

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

test("makeRoleNode: emits question event when agent stdout contains SYMPHONY_QUESTION", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "symphony-engine-"));
  let db;
  try {
    db            = new SqliteTaskStore(path.join(dir, "symphony.db"));
    const taskId  = "20260608-000001-test-question";
    db.createTask({ id: taskId, status: "running", prompt: "do the thing", cwd: dir, mode: "task", run_dir: null });

    const stubRunner = {
      runStep: async () => ({
        stdout:     "thinking...\nSYMPHONY_QUESTION: which framework should I use?",
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

    const saved = db.getTask(taskId);
    assert.equal(saved.status, "waiting_user");
    assert.ok(saved.active_question?.question, "active_question should be set in DB");
    assert.match(String(saved.active_question.question), /framework/);

  } finally {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── makeRoleNode: waiting event (action request) ──────────────────────────────────

test("makeRoleNode: emits waiting event when agent stdout contains SYMPHONY_ACTION_REQUEST", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "symphony-engine-"));
  let db;
  try {
    db            = new SqliteTaskStore(path.join(dir, "symphony.db"));
    const taskId  = "20260608-000002-test-action";
    db.createTask({ id: taskId, status: "running", prompt: "build it", cwd: dir, mode: "task", run_dir: null });

    const actionReq = { provider: "host", command: "make", args: ["build"], cwd: dir };
    const stubRunner = {
      runStep: async () => ({
        stdout:     `running build\nSYMPHONY_ACTION_REQUEST: ${JSON.stringify(actionReq)}`,
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

    const saved = db.getTask(taskId);
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

test("makeRoleNode: returns done and records handoff when agent emits SYMPHONY_HANDOFF", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "symphony-engine-"));
  let db;
  try {
    db            = new SqliteTaskStore(path.join(dir, "symphony.db"));
    const taskId  = "20260608-000003-test-handoff";
    // planner_policy: "on" forces the planner to run (auto-mode would skip for a simple prompt)
    db.createTask({ id: taskId, status: "running", prompt: "add logging", cwd: dir, mode: "task", run_dir: null, planner_policy: "on" });

    const handoffPayload = { plan_summary: "add logging to the server", steps: ["edit server.js"], files_to_touch: ["server.js"] };
    const stubRunner = {
      runStep: async () => ({
        stdout:     `SYMPHONY_HANDOFF: ${JSON.stringify(handoffPayload)}`,
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

    const handoffs = db.getHandoffs(taskId);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].role, "planner");
    assert.deepEqual(handoffs[0].payload, handoffPayload);

  } finally {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
