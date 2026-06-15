import assert from "node:assert/strict";
import { test } from "node:test";

import { LinearTrackerClient } from "../src/linear-tracker.mjs";
import { MaestroOrchestrator } from "../src/orchestrator.mjs";

function issue(overrides = {}) {
  return {
    id: "issue-1",
    identifier: "OPS-1",
    title: "Fix operational drift",
    description: null,
    priority: null,
    state: "In Progress",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function orchestratorConfig(trackerOverrides = {}) {
  return {
    tracker: {
      kind: "linear",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done"],
      doneState: null,
      blockedState: null,
      ...trackerOverrides,
    },
    polling: { intervalMs: 30_000 },
    agent: {
      maxConcurrentAgents: 2,
      maxConcurrentAgentsByState: {},
      maxRetryBackoffMs: 300_000,
      maxTurns: 1,
      stallTimeoutMs: 300_000,
    },
  };
}

function buildOrchestrator({ trackerConfig, runStatus, transitionIssue }) {
  const calls = [];
  const tracker = {
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => [],
    fetchCandidateIssues: async () => [],
    transitionIssue: transitionIssue ?? (async (id, state) => {
      calls.push({ id, state });
      return true;
    }),
  };
  const runner = {
    run: async () => ({ status: runStatus }),
    cancel: () => {},
  };
  const orchestrator = new MaestroOrchestrator({
    config: orchestratorConfig(trackerConfig),
    tracker,
    runner,
    workspaceManager: { removeForIssue: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    timers: { setTimeout: () => ({ fake: true }), clearTimeout: () => {} },
  });
  return { orchestrator, calls };
}

test("transitionIssue resolves a state name to id then issues the mutation", async () => {
  const seen = [];
  const client = new LinearTrackerClient({ apiKey: "tok", projectSlug: "team" });
  client.graphql = async (query, variables) => {
    seen.push({ query, variables });
    if (query.includes("workflowStates")) {
      return { data: { workflowStates: { nodes: [{ id: "state-done", name: "Done" }] } } };
    }
    return {
      data: {
        issueUpdate: { success: true, issue: { id: "issue-1", identifier: "OPS-1", state: { name: "Done" } } },
      },
    };
  };

  const result = await client.transitionIssue("issue-1", "Done");

  assert.equal(result, true);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].variables, { name: "Done" });
  assert.deepEqual(seen[1].variables, { id: "issue-1", stateId: "state-done" });
});

test("transitionIssue throws linear_state_not_found when the state name does not resolve", async () => {
  const client = new LinearTrackerClient({ apiKey: "tok", projectSlug: "team" });
  client.graphql = async () => ({ data: { workflowStates: { nodes: [] } } });

  await assert.rejects(
    () => client.transitionIssue("issue-1", "Nope"),
    (error) => error.code === "linear_state_not_found",
  );
});

test("transitionIssue throws linear_mutation_error when success is not true", async () => {
  const client = new LinearTrackerClient({ apiKey: "tok", projectSlug: "team" });
  client.graphql = async (query) => {
    if (query.includes("workflowStates")) {
      return { data: { workflowStates: { nodes: [{ id: "state-done", name: "Done" }] } } };
    }
    return { data: { issueUpdate: { success: false } } };
  };

  await assert.rejects(
    () => client.transitionIssue("issue-1", "Done"),
    (error) => error.code === "linear_mutation_error",
  );
});

test("transitionIssue is a no-op (returns false) for missing issueId or stateName", async () => {
  let called = false;
  const client = new LinearTrackerClient({ apiKey: "tok", projectSlug: "team" });
  client.graphql = async () => {
    called = true;
    return {};
  };

  assert.equal(await client.transitionIssue(null, "Done"), false);
  assert.equal(await client.transitionIssue("issue-1", null), false);
  assert.equal(called, false);
});

test("orchestrator transitions to doneState after a succeeded run", async () => {
  const { orchestrator, calls } = buildOrchestrator({
    trackerConfig: { doneState: "Done" },
    runStatus: "succeeded",
  });

  await orchestrator.runIssue(issue(), 0, false);

  assert.deepEqual(calls, [{ id: "issue-1", state: "Done" }]);
});

test("orchestrator transitions to blockedState after a waiting_user run", async () => {
  const { orchestrator, calls } = buildOrchestrator({
    trackerConfig: { blockedState: "Blocked" },
    runStatus: "waiting_user",
  });

  await orchestrator.runIssue(issue(), 0, false);

  assert.deepEqual(calls, [{ id: "issue-1", state: "Blocked" }]);
});

test("orchestrator does not transition when the relevant state is null", async () => {
  const { orchestrator, calls } = buildOrchestrator({
    trackerConfig: { doneState: null, blockedState: null },
    runStatus: "succeeded",
  });

  await orchestrator.runIssue(issue(), 0, false);

  assert.deepEqual(calls, []);
});

test("orchestrator write-back failure does not propagate (dispatch still completes)", async () => {
  const { orchestrator } = buildOrchestrator({
    trackerConfig: { doneState: "Done" },
    runStatus: "succeeded",
    transitionIssue: async () => {
      throw new Error("linear blew up");
    },
  });

  await assert.doesNotReject(() => orchestrator.runIssue(issue(), 0, false));
  assert.equal(orchestrator.lastError, null);
  assert.equal(orchestrator.runtime.completed.size, 1);
});
