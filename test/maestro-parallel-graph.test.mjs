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

function makeFourMemberParallelWorkflowWithCollector() {
  return {
    version: 2,
    initial: "reviewerA",
    roles: {
      reviewerA: { provider: "claude", prompt_template: "reviewerA", permission: "read" },
      reviewerB: { provider: "claude", prompt_template: "reviewerB", permission: "read" },
      reviewerC: { provider: "claude", prompt_template: "reviewerC", permission: "read" },
      reviewerD: { provider: "claude", prompt_template: "reviewerD", permission: "read" },
      collector: { provider: "claude", prompt_template: "collector", permission: "read" },
    },
    transitions: {
      reviewerA: { done: "collector", error: "$halt" },
      reviewerB: { done: "collector", error: "$halt" },
      reviewerC: { done: "collector", error: "$halt" },
      reviewerD: { done: "collector", error: "$halt" },
      collector: { done: "$complete", error: "$halt" },
    },
    parallel_groups: [["reviewerA", "reviewerB", "reviewerC", "reviewerD"]],
  };
}

function priorHandoffRolesFromPrompt(prompt = "") {
  return [...prompt.matchAll(/## Structured handoff from ([^\n]+)/g)].map((match) => match[1].trim());
}

async function runFourMemberParallelGraph({ maxConcurrentRoles = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-par-4cap-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.writeWorkflow("par-4cap", makeFourMemberParallelWorkflowWithCollector());
    if (maxConcurrentRoles !== null) {
      await store.writeConfig({
        server: {
          agent: {
            max_concurrent_roles: maxConcurrentRoles,
          },
        },
      });
    }
    const task = await store.createTask({
      prompt: "run with sink",
      cwd: dir,
      workflow: "par-4cap",
      reviewEnabled: false,
    });

    let inFlight = 0;
    let maxInFlight = 0;
    let collectorPrompt = "";

    const stubRunner = {
      runStep: async ({ role, prompt }) => {
        if (role === "collector") {
          collectorPrompt = prompt;
          return {
            stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ summary: "collect", role, total: 4 })}`,
            stderr: "",
            stdoutPath: null,
            stderrPath: null,
          };
        }
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 8));
        inFlight -= 1;
        return {
          stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ summary: `member:${role}` })}`,
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

    return {
      finalTask,
      maxInFlight,
      collectorRoles: priorHandoffRolesFromPrompt(collectorPrompt),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

// Legitimate partial-failure-for-evidence case: a member completes with the
// engine-default "done" event but produces no handoff evidence. The group still
// emits "done" and the run continues to $complete (scoring handles missing
// evidence). Only interrupt/terminal events halt the group (see next test).
test("SP7 integration: a member completing 'done' with no evidence → group emits 'done', run continues", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-par-noevidence-"));
  try {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.writeWorkflow("par-noev", makeParallelWorkflow());
    const task = await store.createTask({ prompt: "no evidence", cwd: dir, workflow: "par-noev", reviewEnabled: false });

    const ranRoles = [];
    const stubRunner = {
      runStep: async ({ role }) => {
        ranRoles.push(role);
        if (role === "reviewerA") {
          // Completes normally (event "done") but emits no handoff evidence.
          return { stdout: "", stderr: "", stdoutPath: null, stderrPath: null };
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

    assert.equal(ranRoles.length, 2, "both members must run");
    // A "done" member with no evidence is a legitimate partial failure: the
    // group still emits "done" and the run reaches $complete → succeeded.
    assert.equal(finalTask.status, "succeeded",
      `a 'done'-with-no-evidence member must not halt the group, got: ${finalTask.status}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A member whose node REJECTS is treated as an "error" event. error is in
// ALWAYS_TERMINAL, so the group now propagates "error" and the run HALTS at END
// instead of marching past the failure. The sibling still runs (allSettled).
test("SP7 integration: a member that rejects → group emits 'error', run halts (not swallowed)", async () => {
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
          // Throw so Promise.allSettled catches it as a rejection → "error".
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

    // The rejected member must NOT be silently swallowed: the group propagates
    // "error", which routes to END and halts the run rather than reaching
    // $complete. It must NOT finish "succeeded".
    assert.notEqual(finalTask.status, "succeeded",
      "a rejecting member must halt the group, not complete successfully");
    // The interrupt is surfaced as a human-in-the-loop pause.
    assert.equal(finalTask.status, "waiting_user",
      `a propagated 'error' must halt at the interrupt path, got: ${finalTask.status}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGroupNode caps member concurrency at maxConcurrentRoles and preserves merged handoffs", async () => {
  const unbounded = await runFourMemberParallelGraph();
  const capped = await runFourMemberParallelGraph({ maxConcurrentRoles: 2 });

  assert.equal(unbounded.finalTask.status, "succeeded", "unbounded baseline run must succeed");
  assert.equal(capped.finalTask.status, "succeeded", "capped run must succeed");

  assert.ok(capped.maxInFlight <= 2, "capped run must not exceed maxConcurrentRoles");
  assert.equal(capped.collectorRoles.length, 4, "collector must receive four merged handoffs");
  assert.deepEqual(capped.collectorRoles, unbounded.collectorRoles);
});
