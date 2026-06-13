import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveDispatchConfig } from "../src/dispatch/config.mjs";
import { DispatchRunner } from "../src/dispatch/runner.mjs";
import { startMaestro } from "../src/cli/runtime.mjs";
import { LocalTaskStore } from "../src/task-store.mjs";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

// Engine runner stub: every step emits a completion handoff so the task reaches
// a terminal "succeeded" status without any agent CLI (mirrors the engine tests).
const engineRunner = {
  runStep: async () => ({
    stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ summary: "done" })}`,
    stderr: "",
    stdoutPath: null,
    stderrPath: null,
  }),
};

const issue = (over = {}) => ({
  id: "i-1",
  identifier: "OPS-1",
  title: "Add logging",
  description: "Add structured logging to the worker.",
  state: "Todo",
  url: "https://linear.app/x/OPS-1",
  blocked_by: [],
  ...over,
});

// A .maestro/ initialized for dispatch: review/planner off so the stub engine
// runner drives a single executor step straight to terminal.
async function initDispatchStore(dir) {
  const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
  await store.init();
  await writeFile(
    path.join(store.root, "config.json"),
    JSON.stringify({
      version: 2,
      review_enabled: false,
      planner_policy: "off",
      dispatch: { enabled: true, tracker: { project_slug: "ops", done_state: "Done" } },
    }),
  );
  return store;
}

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-dispatch-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitForTerminalTask(store, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tasks = await store.listTasks();
    const done = tasks.find((t) => ["succeeded", "failed", "waiting_user", "waiting_approval"].includes(t.status));
    if (done) return done;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

test("DispatchRunner runs a Linear issue through the workflow.json engine and transitions it", async () => {
  await withTempDir(async (dir) => {
    const store = await initDispatchStore(dir);
    const config = await store.readConfig();
    const dispatch = resolveDispatchConfig(config, { env: { LINEAR_API_KEY: "x" } });

    const transitions = [];
    const tracker = {
      transitionIssue: async (id, state) => {
        transitions.push([id, state]);
        return true;
      },
    };
    const runner = new DispatchRunner({ taskStore: store, tracker, dispatch, cwd: dir, runner: engineRunner, logger: silent });

    const result = await runner.run({ issue: issue() });

    assert.equal(result.status, "succeeded");
    const tasks = await store.listTasks();
    assert.equal(tasks.length, 1, "exactly one task created for the issue");
    assert.equal(tasks[0].status, "succeeded");
    assert.match(tasks[0].prompt, /Add logging/);
    assert.match(tasks[0].prompt, /OPS-1/);
    // done_state set → the issue is moved to "Done"
    assert.deepEqual(transitions, [["i-1", "Done"]]);

    // A second run reuses the same task (dispatch once per issue).
    await runner.run({ issue: issue() });
    assert.equal((await store.listTasks()).length, 1);
  });
});

test("startMaestro dispatches a polled issue end-to-end (no WORKFLOW.md)", async () => {
  await withTempDir(async (dir) => {
    const store = await initDispatchStore(dir);
    const transitions = [];
    let fetches = 0;
    const tracker = {
      fetchCandidateIssues: async () => (fetches++ === 0 ? [issue()] : []),
      fetchIssueStatesByIds: async () => [],
      transitionIssue: async (id, state) => {
        transitions.push([id, state]);
        return true;
      },
    };

    const service = await startMaestro({
      stateDir: store.root,
      port: null,
      env: { LINEAR_API_KEY: "x" },
      logger: silent,
      tracker,
      engineRunner,
    });
    try {
      const done = await waitForTerminalTask(store);
      assert.ok(done, "a task was created and reached a terminal status");
      assert.equal(done.status, "succeeded");
      assert.deepEqual(transitions, [["i-1", "Done"]]);

      const snapshot = service.orchestrator.snapshot();
      assert.equal(snapshot.completed.length, 1);
      assert.equal(snapshot.completed[0].issue_identifier, "OPS-1");
      assert.equal(snapshot.completed[0].task_id, done.id);
    } finally {
      await service.stop();
    }
  });
});

test("startMaestro fails fast with an actionable error when the tracker is unconfigured", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init(); // default config → dispatch.enabled false, no project_slug
    await assert.rejects(
      () => startMaestro({ stateDir: store.root, port: null, env: {}, logger: silent }),
      /missing_tracker_api_key/,
    );
  });
});
