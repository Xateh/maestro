import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveServerConfig } from "../src/setup/server-config.mjs";
import { LocalTaskStore } from "../src/task-store.mjs";
import { TaskGraphRunner } from "../src/task-graph-runner.mjs";

function makeServerConfig(overrides = {}) {
  return resolveServerConfig(
    {
      server: {
        workflow: "ops",
        tracker: { kind: "linear", api_key: "token", project_slug: "team" },
        workspace: { root: "/tmp/maestro-tgr-workspaces" },
        intake_template: "Issue {{ issue.identifier }} attempt {{ attempt }}.",
        ...overrides,
      },
    },
    { env: { LINEAR_API_KEY: "token" }, baseDir: "/tmp/maestro-tgr" },
  );
}

function makeTaskStore() {
  const tasks = [];
  let counter = 0;
  return {
    tasks,
    async listTasks() {
      return tasks.map((task) => ({ ...task }));
    },
    async readTask(id) {
      const found = tasks.find((task) => task.id === id);
      return found ? { ...found } : null;
    },
    async createTask(input) {
      counter += 1;
      const task = {
        id: `task-${counter}`,
        status: "queued",
        ...input,
        source_issue_id: input.source_issue_id ?? null,
      };
      tasks.push(task);
      return { ...task };
    },
  };
}

function makeWorkspaceManager() {
  return {
    created: [],
    async createForIssue(identifier) {
      this.created.push(identifier);
      return { path: `/tmp/ws/${identifier}` };
    },
  };
}

const issue = { id: "issue-1", identifier: "OPS-7", title: "Fix it", state: "Todo" };

test("run locates-or-creates exactly one task per issue id", async () => {
  const taskStore = makeTaskStore();
  let runCalls = 0;
  const runner = new TaskGraphRunner({
    taskStore,
    serverConfig: makeServerConfig(),
    workspaceManager: makeWorkspaceManager(),
    runTask: async (taskId) => {
      runCalls += 1;
      return { task: { id: taskId, status: "succeeded" } };
    },
  });

  await runner.run({ issue, attempt: 0, continuation: false });
  await runner.run({ issue, attempt: 1, continuation: true });

  assert.equal(taskStore.tasks.length, 1);
  assert.equal(runCalls, 2);
});

test("created task carries rendered prompt, workflow, mode, source_issue_id", async () => {
  const taskStore = makeTaskStore();
  const runner = new TaskGraphRunner({
    taskStore,
    serverConfig: makeServerConfig(),
    workspaceManager: makeWorkspaceManager(),
    runTask: async (taskId) => ({ task: { id: taskId, status: "succeeded" } }),
  });

  await runner.run({ issue, attempt: 3, continuation: false });

  const [task] = taskStore.tasks;
  assert.equal(task.prompt, "Issue OPS-7 attempt 3.");
  assert.equal(task.workflow, "ops");
  assert.equal(task.mode, "task");
  assert.equal(task.source_issue_id, "issue-1");
  assert.equal(task.cwd, "/tmp/ws/OPS-7");
});

test("runTask is invoked with the located task id", async () => {
  const taskStore = makeTaskStore();
  let seenId = null;
  const runner = new TaskGraphRunner({
    taskStore,
    serverConfig: makeServerConfig(),
    workspaceManager: makeWorkspaceManager(),
    runTask: async (taskId) => {
      seenId = taskId;
      return { task: { id: taskId, status: "succeeded" } };
    },
  });

  await runner.run({ issue, attempt: 0, continuation: false });
  assert.equal(seenId, taskStore.tasks[0].id);
});

test("graph status maps to runner status", async () => {
  const cases = [
    ["succeeded", "succeeded"],
    ["done", "succeeded"],
    ["waiting_user", "succeeded"],
    ["waiting_approval", "succeeded"],
  ];
  for (const [graphStatus, expected] of cases) {
    const taskStore = makeTaskStore();
    const runner = new TaskGraphRunner({
      taskStore,
      serverConfig: makeServerConfig(),
      workspaceManager: makeWorkspaceManager(),
      runTask: async (taskId) => ({ task: { id: taskId, status: graphStatus } }),
    });
    const result = await runner.run({ issue, attempt: 0, continuation: false });
    assert.equal(result.status, expected, `graph ${graphStatus} → ${expected}`);
  }
});

test("failed/engine_error graph status throws so the orchestrator retries", async () => {
  for (const graphStatus of ["failed", "engine_error"]) {
    const taskStore = makeTaskStore();
    const runner = new TaskGraphRunner({
      taskStore,
      serverConfig: makeServerConfig(),
      workspaceManager: makeWorkspaceManager(),
      runTask: async (taskId) => ({ task: { id: taskId, status: graphStatus } }),
    });
    await assert.rejects(() => runner.run({ issue, attempt: 0, continuation: false }));
  }
});

test("cancel clears bookkeeping without throwing", async () => {
  const taskStore = makeTaskStore();
  const runner = new TaskGraphRunner({
    taskStore,
    serverConfig: makeServerConfig(),
    workspaceManager: makeWorkspaceManager(),
    runTask: async (taskId) => ({ task: { id: taskId, status: "succeeded" } }),
  });
  await runner.run({ issue, attempt: 0, continuation: false });
  assert.doesNotThrow(() => runner.cancel("issue-1"));
});

test("onActivity is threaded and invoked safely", async () => {
  const taskStore = makeTaskStore();
  let activity = 0;
  const runner = new TaskGraphRunner({
    taskStore,
    serverConfig: makeServerConfig(),
    workspaceManager: makeWorkspaceManager(),
    runTask: async (taskId, { onActivity }) => {
      onActivity?.();
      return { task: { id: taskId, status: "succeeded" } };
    },
  });
  await runner.run({
    issue,
    attempt: 0,
    continuation: false,
    onActivity: () => {
      activity += 1;
    },
  });
  assert.equal(activity, 1);
  // No onActivity supplied → must not throw.
  await runner.run({ issue, attempt: 1, continuation: true });
});

test("idempotent against the REAL task store across re-polls (one task)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-tgr-real-"));
  try {
    const taskStore = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await taskStore.init();
    const runner = new TaskGraphRunner({
      taskStore,
      serverConfig: makeServerConfig({ workflow: "default" }),
      workspaceManager: makeWorkspaceManager(),
      runTask: async (taskId) => ({ task: { id: taskId, status: "succeeded" } }),
    });

    await runner.run({ issue, attempt: 0, continuation: false });
    // Second tick for the same issue: locate must find the persisted task and
    // skip re-creation, proving idempotency against the real store (not a stub).
    await runner.run({ issue, attempt: 1, continuation: true });

    const tasks = await taskStore.listTasks();
    const forIssue = tasks.filter((t) => t.source_issue_id === "issue-1");
    assert.equal(forIssue.length, 1, "exactly one task persisted for the issue");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
