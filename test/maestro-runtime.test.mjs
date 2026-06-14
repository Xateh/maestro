import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { startMaestro } from "../src/cli/runtime.mjs";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

async function makeStateDir(serverBlock) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-runtime-"));
  const stateDir = path.join(dir, ".maestro");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "config.json"),
    JSON.stringify({ version: 2, server: serverBlock }, null, 2),
  );
  return { dir, stateDir };
}

const validServer = {
  workflow: "default",
  tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "team" },
  workspace: { root: "/tmp/maestro-runtime-ws" },
  polling: { interval_ms: 60_000 },
  intake_template: "Issue {{ issue.identifier }}.",
};

function makeTracker(candidates = []) {
  return {
    calls: { fetchCandidates: 0, fetchStates: 0 },
    async fetchCandidateIssues() {
      this.calls.fetchCandidates += 1;
      return candidates;
    },
    async fetchIssueStatesByIds() {
      this.calls.fetchStates += 1;
      return [];
    },
  };
}

function makeWorkspaceManager() {
  return {
    async createForIssue(identifier) {
      return { path: `/tmp/ws/${identifier}`, workspaceKey: identifier, createdNow: true };
    },
    async removeForIssue() {},
  };
}

async function settle() {
  // Let the immediate orchestrator tick + async dispatch resolve.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

test("startMaestro builds the dispatch path and resolves serverConfig", async () => {
  const { stateDir } = await makeStateDir(validServer);
  const tracker = makeTracker();
  let stop;
  try {
    const service = await startMaestro({
      stateDir,
      env: { LINEAR_API_KEY: "secret-token" },
      logger: silentLogger,
      deps: {
        tracker,
        workspaceManager: makeWorkspaceManager(),
        runTask: async (taskId) => ({ task: { id: taskId, status: "succeeded" } }),
      },
    });
    stop = service.stop;
    assert.equal(service.serverConfig.tracker.apiKey, "secret-token");
    assert.equal(service.serverConfig.workflow, "default");
    assert.equal(service.httpServer, null, "no port → no http server");
    assert.ok(service.orchestrator);
    assert.ok(service.runner);
  } finally {
    if (stop) await stop();
  }
});

test("immediate tick polls the tracker and dispatches candidates through runTask", async () => {
  const { stateDir } = await makeStateDir(validServer);
  const issue = { id: "issue-1", identifier: "ENG-1", state: "Todo" };
  const tracker = makeTracker([issue]);
  let createdTaskId = null;
  let runCalls = 0;
  let stop;
  try {
    const service = await startMaestro({
      stateDir,
      env: { LINEAR_API_KEY: "secret-token" },
      logger: silentLogger,
      deps: {
        tracker,
        workspaceManager: makeWorkspaceManager(),
        runTask: async (taskId) => {
          runCalls += 1;
          createdTaskId = taskId;
          return { task: { id: taskId, status: "succeeded" } };
        },
      },
    });
    stop = service.stop;
    await settle();
    assert.ok(tracker.calls.fetchCandidates >= 1, "tracker polled");
    assert.equal(runCalls, 1, "runTask invoked once for the candidate");
    const tasks = await service.taskStore.listTasks();
    const dispatched = tasks.find((t) => t.source_issue_id === "issue-1");
    assert.ok(dispatched, "graph task created for the issue");
    assert.equal(dispatched.id, createdTaskId);
    assert.equal(dispatched.workflow, "default");
    assert.equal(dispatched.mode, "task");
    assert.equal(dispatched.prompt, "Issue ENG-1.");
  } finally {
    if (stop) await stop();
  }
});

test("invalid server config (missing tracker api key) rejects", async () => {
  const { stateDir } = await makeStateDir({
    ...validServer,
    tracker: { kind: "linear", api_key: null, project_slug: "team" },
  });
  await assert.rejects(
    () => startMaestro({
      stateDir,
      env: {},
      logger: silentLogger,
      deps: { tracker: makeTracker(), workspaceManager: makeWorkspaceManager(), runTask: async () => ({ task: {} }) },
    }),
    /missing_tracker_api_key/,
  );
});
