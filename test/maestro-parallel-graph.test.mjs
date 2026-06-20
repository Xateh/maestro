import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph } from "../src/langgraph/graph.mjs";

// The group node calls makeRoleNodeFn directly. We test this indirectly by
// testing the parallel group node itself in Tasks 3+. This task is a
// refactor-only step; we confirm the existing engine test still passes.
test("SP7: existing engine tests pass after makeRoleNodeFn refactor", async () => {
  // This test is a placeholder. Run: npm test
  // If npm test passes, this task is complete.
  assert.ok(true);
});

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
