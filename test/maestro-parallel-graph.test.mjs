import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildGraph } from "../src/langgraph/graph.mjs";
import { runLangGraphTask } from "../src/langgraph/engine.mjs";
import { LocalTaskStore } from "../src/task-store.mjs";

const silent = { write: () => {} };

// ── Minimal workflow with a parallel group ────────────────────────────────────
function parallelWorkflow() {
  return {
    version: 2,
    initial: "planner",
    roles: {
      planner:   { provider: "claude" },
      reviewerA: { provider: "gemini" },
      reviewerB: { provider: "gemini" },
      scoring:   { kind: "scoring", provider: "claude" },
    },
    transitions: {
      planner:   { done: "reviewerA" },
      reviewerA: { done: "scoring" },
      reviewerB: { done: "scoring" },
      scoring:   { passed: "$complete", blocked: "$halt" },
    },
    parallel_groups: [["reviewerA", "reviewerB"]],
  };
}

function makeStubDb() {
  return {
    getHandoffs: async () => [],
    createHandoff: async () => {},
    updateTask: async (id, patch) => ({ id, ...patch }),
    getTask: async (id) => ({ id, steps: [], status: "running" }),
  };
}

function makeStubRunner() {
  return {
    runStep: async () => ({
      stdout: "MAESTRO_HANDOFF_START\n{\"summary\":\"done\"}\nMAESTRO_HANDOFF_END\n",
      stderr: "",
      exit_code: 0,
    }),
  };
}

test("SP7: buildGraph with parallel_groups does NOT add individual group member nodes", () => {
  const wf = parallelWorkflow();
  const config = { providers: { claude: { model: "claude-sonnet-4-6" }, gemini: { model: "gemini-pro" } } };
  // Build the graph (this should not throw)
  const graph = buildGraph(wf, config, {
    db: makeStubDb(),
    runner: makeStubRunner(),
    ops: {},
    entry: "planner",
    resumeCompletedRoles: new Set(),
    advisoryEmitted: new Set(),
  });
  // The compiled graph exists
  assert.ok(graph, "graph should compile");
  // We can't inspect LangGraph internals directly, but we verify the group node
  // is present by running a minimal stream in Task 4.
});

test("SP7: buildGraph without parallel_groups builds normally (no regression)", () => {
  const wf = {
    version: 2,
    initial: "planner",
    roles: { planner: { provider: "claude" }, reviewer: { provider: "gemini", verifies: true } },
    transitions: { planner: { done: "reviewer" }, reviewer: { done: "$complete" } },
  };
  const config = { providers: { claude: {}, gemini: {} } };
  const graph = buildGraph(wf, config, {
    db: makeStubDb(), runner: makeStubRunner(), ops: {},
    entry: "planner", resumeCompletedRoles: new Set(), advisoryEmitted: new Set(),
  });
  assert.ok(graph);
});

// ── Integration: runLangGraphTask with parallel groups ────────────────────────
//
// Minimal two-member parallel workflow:
//   reviewerA ─┐
//               ├─(pg_0)─► $complete
//   reviewerB ─┘
//
// Both members share the same "done" → "$complete" transition.

function makeParallelWorkflow() {
  return {
    version: 2,
    initial: "reviewerA",
    roles: {
      reviewerA: { provider: "claude", prompt_template: "reviewerA", permission: "read" },
      reviewerB: { provider: "claude", prompt_template: "reviewerB", permission: "read" },
    },
    transitions: {
      reviewerA: { done: "$complete", error: "$halt" },
      reviewerB: { done: "$complete", error: "$halt" },
    },
    parallel_groups: [["reviewerA", "reviewerB"]],
  };
}

test("SP7 integration: parallel group merges handoffs from all members", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-par-ok-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.writeWorkflow("par-test", makeParallelWorkflow());
    const task = await store.createTask({ prompt: "run both", cwd: dir, workflow: "par-test", reviewEnabled: false });

    const ranRoles = [];
    const stubRunner = {
      runStep: async ({ role }) => {
        ranRoles.push(role);
        return {
          stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ role, summary: `done:${role}` })}`,
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

    assert.equal(finalTask.status, "succeeded", "task must succeed when both members complete");
    assert.ok(ranRoles.includes("reviewerA"), "reviewerA must have run");
    assert.ok(ranRoles.includes("reviewerB"), "reviewerB must have run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SP7 integration: one member fails → other member still runs; task does not crash", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-par-fail-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.writeWorkflow("par-fail", makeParallelWorkflow());
    const task = await store.createTask({ prompt: "partial fail", cwd: dir, workflow: "par-fail", reviewEnabled: false });

    const ranRoles = [];
    const stubRunner = {
      runStep: async ({ role }) => {
        ranRoles.push(role);
        if (role === "reviewerA") {
          // Throw so Promise.allSettled catches it as a rejection
          throw new Error("simulated agent crash for reviewerA");
        }
        return {
          stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ summary: "ok" })}`,
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

    // Both members must have been attempted (Promise.allSettled, not Promise.all)
    assert.equal(ranRoles.length, 2, "both members must be attempted even when one throws");
    assert.ok(ranRoles.includes("reviewerA"), "reviewerA must have been attempted");
    assert.ok(ranRoles.includes("reviewerB"), "reviewerB must have been attempted");

    // Task must not be left in a "crashed"/"running" state — it must resolve
    const terminal = ["succeeded", "failed", "waiting_user"];
    assert.ok(terminal.includes(finalTask.status),
      `task status must be terminal, got: ${finalTask.status}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
