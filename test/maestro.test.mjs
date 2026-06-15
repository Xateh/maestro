import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { canonicalizeActionRequestsForTask, parseReviewerOutput, runLocalMaestroCommand } from "../bin/maestro.mjs";
import { SqliteTaskStore } from "../src/db/store.mjs";
import { buildCodexCommand } from "../src/adapters/codex.mjs";
import { buildCopilotCommand } from "../src/adapters/copilot.mjs";
import { buildClaudeCommand } from "../src/adapters/claude.mjs";
import { buildAntigravityCommand } from "../src/adapters/antigravity.mjs";
import { TerminalAgentRunner } from "../src/agent-runner.mjs";
import { buildStepPrompt, evaluatePlannerDecision, resolveAgentFlow } from "../src/router.mjs";
import {
  LocalTaskStore,
  DEFAULT_WORKFLOW,
  DEFAULT_WORKFLOW_NAME,
  WORKFLOW_NAME_RE,
  isValidWorkflowName,
} from "../src/task-store.mjs";
import { collectNewTaskForm, defaultCommandExists, filterTasksForView, formatPageHeader, formatProjectDetails, formatProjectList, formatSettingsList, formatTaskDetails, formatTaskDraft, formatTaskList, resolveTaskSelection, runMaestroTui } from "../src/tui.mjs";

import {
  LinearTrackerClient,
  normalizeLinearIssue,
} from "../src/linear-tracker.mjs";
import {
  WorkspaceManager,
  sanitizeWorkspaceKey,
} from "../src/workspace.mjs";
import {
  MaestroOrchestrator,
  computeRetryDelay,
  createRuntimeState,
  isIssueEligible,
  sortIssuesForDispatch,
} from "../src/orchestrator.mjs";
import { createMaestroHttpHandler } from "../src/http-server.mjs";
import { TaskGraphRunner } from "../src/task-graph-runner.mjs";
import { resolveServerConfig } from "../src/setup/server-config.mjs";
import {
  parseAgentHandoff,
  REVIEW_MAX_CONTINUATIONS,
} from "../src/markers.mjs";
import YAML from "yaml";

const TEST_HANDLE = process.env.USER ?? process.env.USERNAME ?? "xateh";

async function tempDir(prefix = "maestro-test-") {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function withTempDir(fn) {
  const dir = await tempDir();
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createFakeGitRunner({
  ignored = true,
  dirty = "",
  dirtyByCwd = {},
  branch = "main",
  head = "head-1",
  headByCwd = {},
  commitHead = "head-2",
  remoteUrl = "git@example.com:repo.git",
  branchExists = false,
  fail = {},
} = {}) {
  const calls = [];
  const mutableDirtyByCwd = { ...dirtyByCwd };
  const mutableHeadByCwd = { ...headByCwd };
  const worktrees = new Set();
  const run = async ({ args = [], cwd = "" } = {}) => {
    calls.push({ args, cwd });
    const key = args.join(" ");
    if (fail[key]) {
      const error = new Error(fail[key]);
      error.code = 1;
      error.stdout = "";
      error.stderr = fail[key];
      throw error;
    }
    if (args[0] === "check-ignore") {
      if (ignored) return { stdout: ".maestro/\n", stderr: "", code: 0 };
      const error = new Error("not ignored");
      error.code = 1;
      error.stdout = "";
      error.stderr = "";
      throw error;
    }
    if (args[0] === "status" && args.includes("--porcelain")) {
      return { stdout: mutableDirtyByCwd[cwd] ?? dirty, stderr: "", code: 0 };
    }
    if (args[0] === "branch" && args[1] === "--show-current") {
      return { stdout: `${branch}\n`, stderr: "", code: 0 };
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { stdout: `${cwd}\n`, stderr: "", code: 0 };
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      const value = Array.isArray(mutableHeadByCwd[cwd])
        ? mutableHeadByCwd[cwd].shift()
        : mutableHeadByCwd[cwd];
      return { stdout: `${value ?? head}\n`, stderr: "", code: 0 };
    }
    if (args[0] === "config" && args[1] === "--get" && args[2] === "remote.origin.url") {
      return { stdout: `${remoteUrl}\n`, stderr: "", code: 0 };
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      if (branchExists) {
        return { stdout: "branch-sha\n", stderr: "", code: 0 };
      }
      const error = new Error("unknown revision");
      error.code = 1;
      error.stdout = "";
      error.stderr = "";
      throw error;
    }
    if (args[0] === "worktree" && args[1] === "list") {
      return { stdout: [...worktrees].join("\n"), stderr: "", code: 0 };
    }
    if (args[0] === "worktree" && args[1] === "add") {
      worktrees.add(args.at(-2));
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      worktrees.delete(args.at(-1));
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "diff") {
      return { stdout: "diff --git a/file b/file\n", stderr: "", code: 0 };
    }
    if (args[0] === "commit") {
      mutableDirtyByCwd[cwd] = "";
      mutableHeadByCwd[cwd] = commitHead;
      return { stdout: "[main abc] commit\n", stderr: "", code: 0 };
    }
    if (["add", "merge", "checkout", "switch", "branch", "fetch", "pull", "push"].includes(args[0])) {
      return { stdout: args[0] === "commit" ? "[main abc] commit\n" : "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, run };
}

function statusHash(value = "") {
  return createHash("sha256").update(String(value)).digest("hex");
}

function issue(overrides = {}) {
  return {
    id: "issue-1",
    identifier: "OPS-1",
    title: "Fix operational drift",
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

test("workspace manager sanitizes identifiers, runs hooks, and enforces root containment", async () => {
  await withTempDir(async (dir) => {
    const manager = new WorkspaceManager({
      root: path.join(dir, "workspaces"),
      hooks: {
        afterCreate: "printf created > marker.txt",
        beforeRun: "printf before >> marker.txt",
        afterRun: "printf after >> marker.txt",
        beforeRemove: "printf remove > ../removed.txt",
        timeoutMs: 5_000,
      },
    });

    assert.equal(sanitizeWorkspaceKey("OPS/1: bad"), "OPS_1__bad");
    const workspace = await manager.createForIssue("OPS/1: bad");

    assert.equal(workspace.workspaceKey, "OPS_1__bad");
    assert.equal(workspace.createdNow, true);
    assert.equal(workspace.path, path.join(dir, "workspaces", "OPS_1__bad"));
    assert.equal(await readFile(path.join(workspace.path, "marker.txt"), "utf8"), "created");

    await manager.runBeforeRun(workspace.path);
    await manager.runAfterRun(workspace.path);
    assert.equal(await readFile(path.join(workspace.path, "marker.txt"), "utf8"), "createdbeforeafter");

    const reused = await manager.createForIssue("OPS/1: bad");
    assert.equal(reused.createdNow, false);

    await manager.removeForIssue("OPS/1: bad");
    assert.equal(await readFile(path.join(dir, "workspaces", "removed.txt"), "utf8"), "remove");

    const escaped = path.join(dir, "workspaces-other", "OPS-2");
    assert.equal(manager.isPathInsideRoot(escaped), false);
  });
});

test("Linear tracker uses project slug, paginates, normalizes labels and blocker relations", async () => {
  const calls = [];
  const pages = [
    {
      data: {
        issues: {
          nodes: [
            {
              id: "linear-1",
              identifier: "OPS-7",
              title: "Patch safety panel",
              description: "Do it",
              priority: 1,
              branchName: `${TEST_HANDLE}/ops-7`,
              url: "https://linear.app/acme/issue/OPS-7",
              state: { name: "Todo" },
              labels: { nodes: [{ name: "Safety" }] },
              inverseRelations: {
                nodes: [
                  {
                    type: "blocks",
                    relatedIssue: {
                      id: "linear-0",
                      identifier: "OPS-6",
                      state: { name: "In Progress" },
                    },
                  },
                ],
              },
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    },
    {
      data: {
        issues: {
          nodes: [
            {
              id: "linear-2",
              identifier: "OPS-8",
              title: "Add smoke check",
              priority: "not-number",
              state: { name: "In Progress" },
              labels: { nodes: [] },
              inverseRelations: { nodes: [] },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  ];

  const client = new LinearTrackerClient({
    endpoint: "https://linear.example/graphql",
    apiKey: "token",
    projectSlug: "twin-ops",
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      calls.push({ url, headers: options.headers, payload });
      return {
        ok: true,
        status: 200,
        json: async () => pages.shift(),
      };
    },
  });

  const candidates = await client.fetchCandidateIssues(["Todo", "In Progress"]);

  assert.equal(calls.length, 2);
  assert.match(calls[0].payload.query, /slugId/);
  assert.deepEqual(calls[0].payload.variables, {
    projectSlug: "twin-ops",
    stateNames: ["Todo", "In Progress"],
    first: 50,
    after: null,
  });
  assert.equal(calls[1].payload.variables.after, "cursor-1");
  assert.equal(calls[0].headers.Authorization, "token");
  assert.equal(candidates[0].identifier, "OPS-7");
  assert.deepEqual(candidates[0].labels, ["safety"]);
  assert.deepEqual(candidates[0].blocked_by, [
    { id: "linear-0", identifier: "OPS-6", state: "In Progress" },
  ]);
  assert.equal(candidates[1].priority, null);

  assert.deepEqual(await client.fetchIssuesByStates([]), []);
});

test("normalizeLinearIssue handles minimal state-refresh payloads", () => {
  assert.deepEqual(normalizeLinearIssue({
    id: "linear-9",
    identifier: "OPS-9",
    title: "State only",
    state: { name: "Human Review" },
  }), issue({
    id: "linear-9",
    identifier: "OPS-9",
    title: "State only",
    state: "Human Review",
    created_at: null,
    updated_at: null,
  }));
});

test("orchestrator helpers sort, gate blockers, and compute retry backoff", () => {
  const runtime = createRuntimeState({
    activeStates: ["todo", "in progress"],
    terminalStates: ["done", "canceled"],
    maxConcurrentAgents: 2,
    maxConcurrentAgentsByState: { todo: 1 },
  });
  runtime.running.set("issue-running", {
    issue: issue({ id: "issue-running", state: "In Progress" }),
  });

  assert.equal(isIssueEligible(issue({ id: "blocked", blocked_by: [{ id: "dep", state: "In Progress" }] }), runtime), false);
  assert.equal(isIssueEligible(issue({ id: "clear", blocked_by: [{ id: "dep", state: "Done" }] }), runtime), true);

  const sorted = sortIssuesForDispatch([
    issue({ identifier: "OPS-3", priority: null, created_at: "2026-01-01T00:00:00.000Z" }),
    issue({ identifier: "OPS-2", priority: 2, created_at: "2026-01-03T00:00:00.000Z" }),
    issue({ identifier: "OPS-1", priority: 1, created_at: "2026-01-04T00:00:00.000Z" }),
  ]);
  assert.deepEqual(sorted.map((item) => item.identifier), ["OPS-1", "OPS-2", "OPS-3"]);

  assert.equal(computeRetryDelay({ attempt: 1, maxRetryBackoffMs: 60_000 }), 10_000);
  assert.equal(computeRetryDelay({ attempt: 3, maxRetryBackoffMs: 30_000 }), 30_000);
  // Continuation delay uses continuationDelayMs (default 30_000) not 1_000 (R4 fix).
  assert.equal(computeRetryDelay({ continuation: true, attempt: 1, maxRetryBackoffMs: 30_000 }), 30_000);
  // Explicit continuationDelayMs is honored; floor is 1_000.
  assert.equal(computeRetryDelay({ continuation: true, continuationDelayMs: 5_000, maxRetryBackoffMs: 30_000 }), 5_000);
});

test("orchestrator dispatches eligible issues and schedules continuation retry after normal worker exit", async () => {
  const dispatched = [];
  const tracker = {
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => [],
    fetchCandidateIssues: async () => [
      issue({ id: "blocked", identifier: "OPS-1", blocked_by: [{ id: "dep", state: "Todo" }] }),
      issue({ id: "clear", identifier: "OPS-2", state: "In Progress", priority: 1 }),
    ],
  };
  const runner = {
    run: async ({ issue: selected }) => {
      dispatched.push(selected.identifier);
      return { status: "succeeded", runtimeSeconds: 0.2 };
    },
    cancel: () => {},
  };

  const orchestrator = new MaestroOrchestrator({
    config: {
      tracker: { activeStates: ["Todo", "In Progress"], terminalStates: ["Done"], kind: "linear" },
      polling: { intervalMs: 30_000 },
      agent: {
        maxConcurrentAgents: 2,
        maxConcurrentAgentsByState: {},
        maxRetryBackoffMs: 300_000,
        maxTurns: 1,
        stallTimeoutMs: 300_000,
      },
    },
    tracker,
    runner,
    workspaceManager: { removeForIssue: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    timers: { setTimeout: () => ({ fake: true }), clearTimeout: () => {} },
  });

  await orchestrator.tick();
  await Promise.resolve();

  assert.deepEqual(dispatched, ["OPS-2"]);
  const snapshot = orchestrator.snapshot();
  assert.equal(snapshot.counts.running, 0);
  assert.equal(snapshot.counts.retrying, 1);
  assert.equal(snapshot.retrying[0].issue_identifier, "OPS-2");
  assert.equal(snapshot.retrying[0].attempt, 1);
});

test("orchestrator reconcile cancels stalled run and reschedules with stall_timeout reason", async () => {
  const cancelled = [];
  const tracker = {
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => [],
    fetchCandidateIssues: async () => [],
  };
  const runner = {
    run: async () => ({ status: "succeeded" }),
    cancel: (id) => cancelled.push(id),
  };
  const orchestrator = new MaestroOrchestrator({
    config: {
      tracker: { activeStates: ["Todo"], terminalStates: ["Done"], kind: "linear" },
      polling: { intervalMs: 30_000 },
      agent: {
        maxConcurrentAgents: 1,
        maxConcurrentAgentsByState: {},
        maxRetryBackoffMs: 300_000,
        maxTurns: 1,
        stallTimeoutMs: 10,
      },
    },
    tracker,
    runner,
    workspaceManager: { removeForIssue: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    timers: { setTimeout: () => ({ fake: true }), clearTimeout: () => {} },
  });

  const stalled = issue({ id: "stall-1", identifier: "OPS-STALL" });
  orchestrator.runtime.running.set("stall-1", {
    issue: stalled,
    issue_identifier: "OPS-STALL",
    started_at: new Date().toISOString(),
    attempt: 0,
    last_event_at_ms: Date.now() - 1_000,
  });

  await orchestrator.reconcileRunningIssues();

  assert.deepEqual(cancelled, ["stall-1"]);
  assert.equal(orchestrator.runtime.running.size, 0);
  assert.equal(orchestrator.runtime.retrying.size, 1);
  assert.equal(orchestrator.runtime.retrying.get("stall-1").reason, "stall_timeout");
});

test("orchestrator retry timer can relaunch its own claimed issue", async () => {
  let scheduled = null;
  const runs = [];
  const tracker = {
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => [],
    fetchCandidateIssues: async () => [],
  };
  const runner = {
    run: async ({ issue: selected, attempt }) => {
      runs.push(`${selected.identifier}:${attempt}`);
      return { status: "succeeded" };
    },
    cancel: () => {},
  };
  const orchestrator = new MaestroOrchestrator({
    config: {
      tracker: { activeStates: ["Todo"], terminalStates: ["Done"], kind: "linear" },
      polling: { intervalMs: 30_000 },
      agent: {
        maxConcurrentAgents: 1,
        maxConcurrentAgentsByState: {},
        maxRetryBackoffMs: 300_000,
        maxTurns: 1,
        stallTimeoutMs: 300_000,
      },
    },
    tracker,
    runner,
    workspaceManager: { removeForIssue: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    timers: {
      setTimeout: (callback) => {
        scheduled = callback;
        return { fake: true };
      },
      clearTimeout: () => {},
    },
  });

  orchestrator.scheduleRetry(issue({ id: "retry-1", identifier: "OPS-RETRY" }), {
    attempt: 1,
    continuation: true,
    reason: "continuation_check",
  });
  scheduled();
  await Promise.resolve();

  assert.deepEqual(runs, ["OPS-RETRY:1"]);
  assert.equal(orchestrator.runtime.retrying.size, 1);
});

test("HTTP extension serves state, issue details, refresh trigger, and JSON errors", async () => {
  const orchestrator = {
    snapshot: () => ({
      generated_at: "2026-05-12T00:00:00.000Z",
      counts: { running: 1, retrying: 0 },
      running: [{ issue_identifier: "OPS-1" }],
      retrying: [],
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      rate_limits: null,
    }),
    issueDetails: (identifier) => (identifier === "OPS-1" ? { issue_identifier: "OPS-1", status: "running" } : null),
    refresh: async () => ({ queued: true, coalesced: false, operations: ["poll", "reconcile"] }),
  };
  const handler = createMaestroHttpHandler({ orchestrator });
  const invoke = async (method, url) => {
    let statusCode = null;
    let headers = null;
    let body = "";
    await handler(
      { method, url },
      {
        writeHead: (status, nextHeaders) => {
          statusCode = status;
          headers = nextHeaders;
        },
        end: (payload) => {
          body = payload ?? "";
        },
      },
    );
    return {
      status: statusCode,
      headers,
      text: body,
      json: () => JSON.parse(body),
    };
  };

  assert.equal((await invoke("GET", "/")).status, 200);

  const state = await invoke("GET", "/api/v1/state");
  assert.equal(state.status, 200);
  assert.equal(state.json().counts.running, 1);

  const detail = await invoke("GET", "/api/v1/OPS-1");
  assert.equal(detail.status, 200);
  assert.equal(detail.json().status, "running");

  const missing = await invoke("GET", "/api/v1/OPS-404");
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error.code, "issue_not_found");

  const refresh = await invoke("POST", "/api/v1/refresh");
  assert.equal(refresh.status, 202);
  assert.deepEqual(refresh.json().operations, ["poll", "reconcile"]);

  assert.equal((await invoke("GET", "/api/v1/refresh")).status, 405);
});

test("HTTP /state and /refresh reflect the unified TaskGraphRunner dispatch path", async () => {
  // Wire a real orchestrator onto a TaskGraphRunner with mocked store/tracker so
  // /refresh drives poll→dispatch→createTask→runTask and /state then mirrors it.
  const serverConfig = resolveServerConfig(
    {
      server: {
        workflow: "default",
        tracker: { kind: "linear", api_key: "tok", project_slug: "team" },
        workspace: { root: "/tmp/maestro-http-parity" },
        intake_template: "Issue {{ issue.identifier }}.",
      },
    },
    { env: { LINEAR_API_KEY: "tok" }, baseDir: "/tmp/maestro-http-parity" },
  );

  const tasks = [];
  let counter = 0;
  const taskStore = {
    async listTasks() {
      return tasks.map((task) => ({ ...task }));
    },
    async createTask(input) {
      counter += 1;
      const task = {
        id: `task-${counter}`,
        status: "queued",
        ...input,
        source_issue_id: input.source_issue_id ?? input.sourceIssueId ?? null,
      };
      tasks.push(task);
      return { ...task };
    },
  };

  const candidate = { id: "issue-77", identifier: "OPS-77", state: "Todo" };
  let dispatched = false;
  const tracker = {
    async fetchCandidateIssues() {
      // Only offer the candidate once so the second tick doesn't double-dispatch.
      if (dispatched) return [];
      return [candidate];
    },
    async fetchIssueStatesByIds() {
      return [];
    },
  };
  const workspaceManager = {
    async createForIssue(identifier) {
      return { path: `/tmp/ws/${identifier}` };
    },
    async removeForIssue() {},
  };

  let runCalls = 0;
  const runner = new TaskGraphRunner({
    taskStore,
    serverConfig,
    workspaceManager,
    runTask: async (taskId) => {
      runCalls += 1;
      dispatched = true;
      return { task: { id: taskId, status: "succeeded" } };
    },
  });

  const orchestrator = new MaestroOrchestrator({
    config: serverConfig,
    tracker,
    runner,
    workspaceManager,
  });

  const handler = createMaestroHttpHandler({ orchestrator });
  const invoke = async (method, url) => {
    let statusCode = null;
    let body = "";
    await handler(
      { method, url },
      {
        writeHead: (status) => {
          statusCode = status;
        },
        end: (payload) => {
          body = payload ?? "";
        },
      },
    );
    return { status: statusCode, json: () => JSON.parse(body) };
  };

  // Before refresh: nothing dispatched.
  assert.equal((await invoke("GET", "/api/v1/state")).json().counts.running, 0);

  const refresh = await invoke("POST", "/api/v1/refresh");
  assert.equal(refresh.status, 202);
  // Let the coalesced refresh tick + async dispatch settle.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(runCalls, 1, "unified path invoked runTask once");
  assert.equal(tasks.length, 1, "exactly one graph task created");
  assert.equal(tasks[0].source_issue_id, "issue-77");
  assert.equal(tasks[0].workflow, "default");
  assert.equal(tasks[0].mode, "task");

  // The completed run is reflected in the snapshot the /state route serves.
  const state = await invoke("GET", "/api/v1/state");
  assert.equal(state.status, 200);
  assert.equal(state.json().counts.completed, 1);

  await orchestrator.stop();
});

test("root package exposes Maestro scripts and dependencies", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(pkg.scripts.maestro, "node bin/maestro.mjs");
  assert.equal(pkg.scripts["test:maestro"], "node --test test/maestro.test.mjs");
  assert.match(pkg.scripts["test:enterprise"], /npm run test:maestro/);
  assert.ok(pkg.dependencies.yaml);
  assert.ok(pkg.dependencies.liquidjs);
});

test("root gitignore ignores Maestro runtime and worktree state", async () => {
  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^\.maestro\/$/m);
});

test("project create blocks until .maestro state is ignored", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const git = createFakeGitRunner({ ignored: false });

    await assert.rejects(
      () => runLocalMaestroCommand({
        args: ["project", "create", "alpha", "--state-dir", store.root, "--target", "main"],
        cwd: dir,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        store,
        gitRunner: git.run,
      }),
      /maestro_root_not_ignored/,
    );
  });
});

test("project create blocks dirty target branches", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".gitignore"), ".maestro/\n");
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const git = createFakeGitRunner({ dirty: " M scripts/maestro.mjs\n" });

    await assert.rejects(
      () => runLocalMaestroCommand({
        args: ["project", "create", "alpha", "--state-dir", store.root, "--target", "main"],
        cwd: dir,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        store,
        gitRunner: git.run,
      }),
      /dirty_target_branch/,
    );
  });
});

test("project create owns only .maestro worktrees and reports local secrets not copied", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".gitignore"), ".maestro/\n");
    await writeFile(path.join(dir, ".env"), "TOKEN=secret\n");
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const git = createFakeGitRunner();
    const output = [];

    const result = await runLocalMaestroCommand({
      args: ["project", "create", "alpha", "--state-dir", store.root, "--target", "main"],
      cwd: dir,
      stdout: { write: (text) => output.push(text) },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });

    const project = await store.readProject("alpha");
    assert.equal(result.project.id, "alpha");
    assert.equal(project.status, "open");
    assert.equal(project.integration_branch, "maestro/alpha/integration");
    assert.equal(project.integration_worktree, path.join(dir, ".maestro", "worktrees", "alpha", "integration"));
    assert.deepEqual(project.local_file_warnings, [{
      path: ".env",
      status: "not_copied",
      sensitive: true,
    }]);
    assert.ok(git.calls.some((call) => call.args.join(" ") === "worktree add -b maestro/alpha/integration "
      + `${project.integration_worktree} main`));
    assert.match(output.join(""), /local file .env not copied/);
  });
});

test("project task worktree creates a task branch with Maestro metadata env", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".gitignore"), ".maestro/\n");
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const git = createFakeGitRunner();
    await runLocalMaestroCommand({
      args: ["project", "create", "alpha", "--state-dir", store.root, "--target", "main"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });
    const calls = [];
    const runner = {
      runStep: async (step) => {
        calls.push(step);
        return {
          status: "succeeded",
          stdout: "executor ok",
          stderr: "",
          stdoutPath: path.join(step.logDir, "executor.stdout.log"),
          stderrPath: path.join(step.logDir, "executor.stderr.log"),
          command: step.provider,
          args: [step.role],
        };
      },
    };

    const result = await runLocalMaestroCommand({
      args: [
        "task",
        "--state-dir", store.root,
        "--project", "alpha",
        "--worktree-mode", "project-worktree",
        "--paths", "scripts/maestro.mjs",
        "--planner", "off",
        "--review", "off",
        "Patch Maestro worktrees",
      ],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: git.run,
    });

    const saved = await store.readTask(result.task.id);
    assert.equal(saved.project_id, "alpha");
    assert.equal(saved.worktree_mode, "project-worktree");
    assert.equal(saved.branch, "maestro/alpha/task/patch-maestro-worktrees");
    assert.equal(calls[0].cwd, path.join(dir, ".maestro", "worktrees", "alpha", "patch-maestro-worktrees"));
    assert.equal(calls[0].env.MAESTRO_PROJECT_ID, "alpha");
    assert.equal(calls[0].env.MAESTRO_TASK_ID, saved.id);
    assert.equal(calls[0].env.MAESTRO_BRANCH, saved.branch);
    assert.equal(calls[0].env.MAESTRO_WORKTREE, calls[0].cwd);
  });
});

test("overlapping project path leases queue write tasks", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".gitignore"), ".maestro/\n");
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const git = createFakeGitRunner();
    await runLocalMaestroCommand({
      args: ["project", "create", "alpha", "--state-dir", store.root, "--target", "main"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });
    await store.updateProject("alpha", {
      path_leases: {
        "scripts/maestro.mjs": { task_id: "other-task", mode: "write" },
      },
    });
    let ran = false;

    const result = await runLocalMaestroCommand({
      args: [
        "task",
        "--state-dir", store.root,
        "--project", "alpha",
        "--worktree-mode", "project-worktree",
        "--paths", "scripts/maestro.mjs",
        "--planner", "off",
        "--review", "off",
        "Competing patch",
      ],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { ran = true; } },
      gitRunner: git.run,
    });

    assert.equal(result.task.status, "waiting_user");
    assert.equal(result.task.blockers[0].code, "queued_path_conflict");
    assert.deepEqual(result.task.unblock_options.map((option) => option.type), ["retry", "cancel"]);
    assert.equal(ran, false);
  });
});

test("retry keeps a path-conflicted task waiting while another task owns the lease", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".gitignore"), ".maestro/\n");
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const git = createFakeGitRunner();
    await runLocalMaestroCommand({
      args: ["project", "create", "alpha", "--state-dir", store.root, "--target", "main"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });
    await store.updateProject("alpha", {
      path_leases: {
        "scripts/maestro.mjs": { task_id: "other-task", mode: "write" },
      },
    });
    const waiting = await runLocalMaestroCommand({
      args: [
        "task",
        "--state-dir", store.root,
        "--project", "alpha",
        "--worktree-mode", "project-worktree",
        "--paths", "scripts/maestro.mjs",
        "--planner", "off",
        "--review", "off",
        "Retry blocked path",
      ],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { throw new Error("should not run while leased"); } },
      gitRunner: git.run,
    });
    let ran = false;

    const result = await runLocalMaestroCommand({
      args: ["retry", "--state-dir", store.root, waiting.task.id, "--note", "try again"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { ran = true; } },
      gitRunner: git.run,
    });

    assert.equal(result.task.status, "waiting_user");
    assert.equal(result.task.blockers[0].code, "queued_path_conflict");
    assert.deepEqual(result.task.unblock_options.map((option) => option.type), ["retry", "cancel"]);
    assert.equal(ran, false);
  });
});

test("retry force-parallel rebuilds missing project setup and runs despite path conflict", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".gitignore"), ".maestro/\n");
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const git = createFakeGitRunner();
    await runLocalMaestroCommand({
      args: ["project", "create", "alpha", "--state-dir", store.root, "--target", "main"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });
    await store.updateProject("alpha", {
      path_leases: {
        "scripts/maestro.mjs": { task_id: "other-task", mode: "write" },
      },
    });
    const waiting = await runLocalMaestroCommand({
      args: [
        "task",
        "--state-dir", store.root,
        "--project", "alpha",
        "--worktree-mode", "project-worktree",
        "--paths", "scripts/maestro.mjs",
        "--planner", "off",
        "--review", "off",
        "Force retry path",
      ],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { throw new Error("should not run before retry"); } },
      gitRunner: git.run,
    });
    const seen = {};

    const result = await runLocalMaestroCommand({
      args: ["retry", "--state-dir", store.root, waiting.task.id, "--force-parallel", "--note", "force it"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => {
          const task = await store.readTask(waiting.task.id);
          const project = await store.readProject("alpha");
          seen.cwd = step.cwd;
          seen.branch = task.branch;
          seen.worktreePath = task.worktree_path;
          seen.lease = project.path_leases["scripts/maestro.mjs"]?.task_id;
          seen.record = (project.tasks ?? []).find((record) => record.id === task.id);
          return {
            status: "succeeded",
            stdout: "executor ok",
            stderr: "",
            stdoutPath: path.join(step.logDir, "executor.stdout.log"),
            stderrPath: path.join(step.logDir, "executor.stderr.log"),
            command: step.provider,
            args: [step.role],
          };
        },
      },
      gitRunner: git.run,
    });

    assert.equal(result.task.status, "succeeded");
    assert.equal(seen.branch, "maestro/alpha/task/force-retry-path");
    assert.equal(seen.worktreePath, path.join(dir, ".maestro", "worktrees", "alpha", "force-retry-path"));
    assert.equal(seen.cwd, seen.worktreePath);
    assert.equal(seen.lease, waiting.task.id);
    assert.equal(seen.record.branch, seen.branch);
  });
});

test("retry after a lease clears creates missing branch, project task record, and leases before running", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".gitignore"), ".maestro/\n");
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const git = createFakeGitRunner();
    await runLocalMaestroCommand({
      args: ["project", "create", "alpha", "--state-dir", store.root, "--target", "main"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });
    await store.updateProject("alpha", {
      path_leases: {
        "scripts/maestro.mjs": { task_id: "other-task", mode: "write" },
      },
    });
    const waiting = await runLocalMaestroCommand({
      args: [
        "task",
        "--state-dir", store.root,
        "--project", "alpha",
        "--worktree-mode", "project-worktree",
        "--paths", "scripts/maestro.mjs",
        "--planner", "off",
        "--review", "off",
        "Lease cleared path",
      ],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { throw new Error("should not run before retry"); } },
      gitRunner: git.run,
    });
    await store.updateProject("alpha", { path_leases: {} });
    const seen = {};

    const result = await runLocalMaestroCommand({
      args: ["retry", "--state-dir", store.root, waiting.task.id],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => {
          const task = await store.readTask(waiting.task.id);
          const project = await store.readProject("alpha");
          seen.cwd = step.cwd;
          seen.branch = task.branch;
          seen.record = (project.tasks ?? []).find((record) => record.id === task.id);
          seen.lease = project.path_leases["scripts/maestro.mjs"]?.task_id;
          return {
            status: "succeeded",
            stdout: "executor ok",
            stderr: "",
            stdoutPath: path.join(step.logDir, "executor.stdout.log"),
            stderrPath: path.join(step.logDir, "executor.stderr.log"),
            command: step.provider,
            args: [step.role],
          };
        },
      },
      gitRunner: git.run,
    });

    assert.equal(result.task.status, "succeeded");
    assert.equal(seen.branch, "maestro/alpha/task/lease-cleared-path");
    assert.equal(seen.cwd, path.join(dir, ".maestro", "worktrees", "alpha", "lease-cleared-path"));
    assert.equal(seen.record.id, waiting.task.id);
    assert.equal(seen.lease, waiting.task.id);
  });
});

test("agent HEAD movement marks project task for review and blocks automation", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".gitignore"), ".maestro/\n");
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const taskWorktree = path.join(dir, ".maestro", "worktrees", "alpha", "agent-commit");
    const git = createFakeGitRunner({
      headByCwd: {
        [dir]: "main-head",
        [taskWorktree]: ["agent-start", "agent-commit"],
      },
    });
    await runLocalMaestroCommand({
      args: ["project", "create", "alpha", "--state-dir", store.root, "--target", "main"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });

    const result = await runLocalMaestroCommand({
      args: [
        "task",
        "--state-dir", store.root,
        "--project", "alpha",
        "--worktree-mode", "project-worktree",
        "--planner", "off",
        "--review", "off",
        "Agent commit",
      ],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => ({
          status: "succeeded",
          stdout: "committed by agent",
          stderr: "",
          stdoutPath: path.join(step.logDir, "executor.stdout.log"),
          stderrPath: path.join(step.logDir, "executor.stderr.log"),
          command: step.provider,
          args: [step.role],
        }),
      },
      gitRunner: git.run,
    });

    const project = await store.readProject("alpha");
    assert.equal(result.task.status, "needs_review");
    assert.equal(project.blockers[0].code, "agent_head_moved");
  });
});

test("current-cwd git publish tasks request broker approval before agents run", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    let ran = false;
    const stderr = [];
    const git = createFakeGitRunner({ dirtyByCwd: { [dir]: " M package.json\n" } });

    const result = await runLocalMaestroCommand({
      args: [
        "task",
        "--state-dir", store.root,
        "--planner", "off",
        "--review", "off",
        "Commit current changes",
      ],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: (text) => stderr.push(text) },
      store,
      runner: { runStep: async () => { ran = true; } },
      gitRunner: git.run,
    });

    assert.equal(ran, false);
    assert.equal(result.task.status, "waiting_approval");
    assert.equal(result.task.action_requests[0].type, "git_commit");
    assert.equal(result.task.action_requests[0].status, "pending");
    assert.equal(result.task.action_requests[0].expected_branch, "main");
    assert.equal(result.task.action_requests[0].expected_head, "head-1");
    assert.equal(result.task.action_requests[0].expected_status_hash, statusHash(" M package.json\n"));
    assert.deepEqual(result.task.unblock_options.map((option) => option.type), ["approve_action", "edit_action", "manual_done", "cancel"]);
    assert.equal(stderr.join(""), "");
  });
});

test("unsupported git intent waits for user recovery instead of blocking", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });

    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "--review", "off", "Merge branch"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { throw new Error("should not run"); } },
      gitRunner: createFakeGitRunner().run,
    });

    assert.equal(result.task.status, "waiting_user");
    assert.equal(result.task.review.completion_state, "incomplete_needs_user");
    assert.equal(result.task.blockers[0].code, "git_publish_unsupported_in_agent_sandbox");
    assert.equal(result.task.unblock_options.some((option) => option.type === "retry"), true);
    assert.equal(result.task.unblock_options.some((option) => option.type === "instruct"), true);
    assert.equal(result.task.unblock_options.some((option) => option.type === "cancel"), true);
  });
});

test("commit then push requests only commit first and refreshes push snapshot after commit", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const git = createFakeGitRunner({ dirtyByCwd: { [dir]: " M package.json\n" }, commitHead: "head-after-commit" });
    let runCount = 0;
    const runner = {
      runStep: async () => {
        runCount += 1;
        throw new Error("agent should not run until commit and push are both approved");
      },
    };

    const waiting = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "--review", "off", "Commit then push current changes"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: git.run,
    });
    assert.equal(waiting.task.status, "waiting_approval");
    assert.deepEqual(waiting.task.action_requests.map((request) => request.type), ["git_commit"]);

    const afterCommit = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, waiting.task.id, waiting.task.action_requests[0].id],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: git.run,
    });

    assert.equal(afterCommit.task.status, "waiting_approval");
    assert.deepEqual(afterCommit.task.action_requests.map((request) => `${request.type}:${request.status}`), [
      "git_commit:succeeded",
      "git_push:pending",
    ]);
    assert.equal(afterCommit.task.action_requests[1].expected_head, "head-after-commit");
    assert.equal(afterCommit.task.action_requests[1].expected_status_hash, statusHash(""));
    assert.equal(runCount, 0);
    assert.equal(git.calls.filter((call) => call.args[0] === "commit").length, 1);
    assert.equal(git.calls.filter((call) => call.args[0] === "push").length, 0);
  });
});

test("approve-action note resumes the agent before automatic next git action", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const git = createFakeGitRunner({ dirtyByCwd: { [dir]: " M package.json\n" }, commitHead: "head-after-commit" });
    const prompts = [];
    const runner = {
      runStep: async (step) => {
        prompts.push(step.prompt);
        return {
          status: "succeeded",
          stdout: "executor honored note",
          stderr: "",
          stdoutPath: path.join(step.logDir, "executor.stdout.log"),
          stderrPath: path.join(step.logDir, "executor.stderr.log"),
          command: step.provider,
          args: [step.role],
        };
      },
    };

    const waiting = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "--review", "off", "Commit then push current changes"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: git.run,
    });

    const result = await runLocalMaestroCommand({
      args: [
        "approve-action",
        "--state-dir", store.root,
        waiting.task.id,
        waiting.task.action_requests[0].id,
        "--note", "Stop after commit; do not push.",
      ],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: git.run,
    });

    const saved = await store.readTask(waiting.task.id);
    assert.equal(result.task.status, "succeeded");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Stop after commit; do not push\./);
    assert.match(prompts[0], /Do not repeat the prior blocked action unchanged/);
    assert.deepEqual(saved.action_requests.map((request) => `${request.type}:${request.status}`), ["git_commit:succeeded"]);
    assert.equal(git.calls.filter((call) => call.args[0] === "push").length, 0);
  });
});

test("deny-action note resumes the agent with denied action context", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const git = createFakeGitRunner({ dirtyByCwd: { [dir]: " M package.json\n" } });
    const prompts = [];
    const runner = {
      runStep: async (step) => {
        prompts.push(step.prompt);
        return {
          status: "succeeded",
          stdout: "executor chose alternate path",
          stderr: "",
          stdoutPath: path.join(step.logDir, "executor.stdout.log"),
          stderrPath: path.join(step.logDir, "executor.stderr.log"),
          command: step.provider,
          args: [step.role],
        };
      },
    };

    const waiting = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "--review", "off", "Commit current changes"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: git.run,
    });

    const result = await runLocalMaestroCommand({
      args: [
        "deny-action",
        "--state-dir", store.root,
        waiting.task.id,
        waiting.task.action_requests[0].id,
        "--note", "Do not commit; explain what remains.",
      ],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: git.run,
    });

    assert.equal(result.task.status, "succeeded");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Action request denied/);
    assert.match(prompts[0], /Do not commit; explain what remains\./);
    assert.equal(git.calls.filter((call) => call.args[0] === "commit").length, 0);
  });
});

test("approving git action runs broker once and resumes task", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const git = createFakeGitRunner({ dirtyByCwd: { [dir]: " M package.json\n" } });
    let runCount = 0;
    const runner = {
      runStep: async (step) => {
        runCount += 1;
        return {
          status: "succeeded",
          stdout: "executor ok",
          stderr: "",
          stdoutPath: path.join(step.logDir, "executor.stdout.log"),
          stderrPath: path.join(step.logDir, "executor.stderr.log"),
          command: step.provider,
          args: [step.role],
        };
      },
    };

    const waiting = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "--review", "off", "Commit current changes"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: git.run,
    });
    const actionId = waiting.task.action_requests[0].id;

    const approved = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, waiting.task.id, actionId, "--note", "commit locally"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: git.run,
    });
    const duplicate = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, waiting.task.id, actionId, "--note", "duplicate"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: git.run,
    });

    const saved = await store.readTask(waiting.task.id);
    const commitCalls = git.calls.filter((call) => call.args[0] === "commit");
    assert.equal(approved.task.status, "succeeded");
    assert.equal(duplicate.task.status, "succeeded");
    assert.equal(commitCalls.length, 1);
    assert.equal(runCount, 1);
    assert.equal(saved.action_requests[0].status, "succeeded");
    assert.match(saved.action_requests[0].result.stdout, /commit/);
    assert.equal(saved.interactions.some((entry) => entry.type === "approval"), true);
  });
});

test("approve-action prints receipt when stale approval is not run", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const git = createFakeGitRunner({
      dirtyByCwd: { [dir]: " M package.json\n" },
      headByCwd: { [dir]: ["head-2"] },
    });
    const task = await store.createTask({ prompt: "Commit current changes", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_commit",
        status: "pending",
        cwd: dir,
        normalized_args: ["commit", "-m", "maestro: test"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(" M package.json\n"),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
      }],
      unblock_options: [{ id: "approve-act-1", type: "approve_action", label: "Approve commit", status: "open" }],
    });
    const output = [];

    const result = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1"],
      cwd: dir,
      stdout: { write: (text) => output.push(text) },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { throw new Error("should not run"); } },
      gitRunner: git.run,
    });

    assert.equal(result.receipt.executed, false);
    assert.equal(result.receipt.reason, "head_changed");
    assert.equal(result.receipt.status_before, "waiting_approval");
    assert.equal(result.receipt.status_after, "waiting_user");
    assert.match(output.join(""), /receipt approve-action: action act-1 not run: head_changed/);
    assert.equal(git.calls.some((call) => call.args[0] === "commit"), false);
  });
});

test("approve-action prints no-op receipt for already succeeded request", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "Commit current changes", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "succeeded",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_commit",
        status: "succeeded",
        cwd: dir,
        normalized_args: ["commit", "-m", "maestro: test"],
        continuation_generation: 0,
        result: { code: 0, stdout: "already committed", stderr: "" },
      }],
    });
    const output = [];

    const result = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1"],
      cwd: dir,
      stdout: { write: (text) => output.push(text) },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { throw new Error("should not run"); } },
      gitRunner: createFakeGitRunner().run,
    });

    assert.equal(result.receipt.executed, false);
    assert.equal(result.receipt.reason, "already_succeeded");
    assert.match(output.join(""), /receipt approve-action: action act-1 not run: already_succeeded/);
  });
});

test("state-changing CLI commands print feedback receipts", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    // host_command_allow required for the run-action on printf later in this test.
    await store.writeConfig({ host_command_allow: ["printf"] });
    const runner = {
      runStep: async (step) => ({
        status: "succeeded",
        stdout: `${step.role} ok`,
        stderr: "",
        stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
        stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
        command: step.provider,
        args: [step.role],
      }),
    };

    const editTask = await store.createTask({ prompt: "Edit action", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(editTask.id, {
      status: "waiting_user",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_push",
        status: "pending",
        cwd: dir,
        normalized_args: ["push", "origin", "main"],
      }],
    });
    const editOut = [];
    await runLocalMaestroCommand({
      args: ["edit-action", "--state-dir", store.root, editTask.id, "act-1", "--args-json", "[\"push\",\"origin\",\"feature\"]"],
      cwd: dir,
      stdout: { write: (text) => editOut.push(text) },
      stderr: { write: () => {} },
      store,
    });

    const runTask = await store.createTask({ prompt: "Run host action", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(runTask.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "host",
        type: "host_command",
        status: "pending",
        cwd: dir,
        command: "printf",
        args: ["ok"],
        env: {},
        continuation_generation: 0,
      }],
    });
    const runOut = [];
    await runLocalMaestroCommand({
      args: ["run-action", "--state-dir", store.root, runTask.id, "act-1", "--note", "run it"],
      cwd: dir,
      stdout: { write: (text) => runOut.push(text) },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: createFakeGitRunner().run,
      hostRunner: async () => ({ stdout: "ok", stderr: "", code: 0 }),
    });

    const denyTask = await store.createTask({ prompt: "Deny action", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(denyTask.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_push",
        status: "pending",
        cwd: dir,
        normalized_args: ["push", "origin", "main"],
      }],
    });
    const denyOut = [];
    await runLocalMaestroCommand({
      args: ["deny-action", "--state-dir", store.root, denyTask.id, "act-1", "--note", "do not push"],
      cwd: dir,
      stdout: { write: (text) => denyOut.push(text) },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: createFakeGitRunner().run,
    });

    const retryTask = await store.createTask({ prompt: "Retry task", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(retryTask.id, {
      status: "waiting_user",
      blockers: [{ code: "agent_timeout" }],
      unblock_options: [{ id: "retry-task", type: "retry", label: "Retry", status: "open" }],
    });
    const retryOut = [];
    await runLocalMaestroCommand({
      args: ["retry", "--state-dir", store.root, retryTask.id, "--note", "again"],
      cwd: dir,
      stdout: { write: (text) => retryOut.push(text) },
      stderr: { write: () => {} },
      store,
      runner,
      gitRunner: createFakeGitRunner().run,
    });

    const cancelTask = await store.createTask({ prompt: "Cancel task", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(cancelTask.id, {
      status: "waiting_user",
      unblock_options: [{ id: "cancel-task", type: "cancel", label: "Cancel", status: "open" }],
    });
    const cancelOut = [];
    await runLocalMaestroCommand({
      args: ["cancel", "--state-dir", store.root, cancelTask.id, "--note", "stop"],
      cwd: dir,
      stdout: { write: (text) => cancelOut.push(text) },
      stderr: { write: () => {} },
      store,
    });

    assert.match(editOut.join(""), /receipt edit-action: action act-1 edited/);
    assert.match(runOut.join(""), /receipt run-action: action act-1 executed/);
    assert.match(denyOut.join(""), /receipt deny-action: action act-1 denied/);
    assert.match(retryOut.join(""), /receipt retry: retry queued/);
    assert.match(cancelOut.join(""), /receipt cancel: task cancelled/);
  });
});

test("canonical action requests collapse identical ids and split conflicting same ids", () => {
  const task = {
    id: "task-actions",
    status: "waiting_user",
    action_requests: [{
      id: "act-1",
      provider: "git",
      type: "git_push",
      status: "pending",
      cwd: "/repo",
      normalized_args: ["push", "origin", "main"],
      stale_reason: "head_changed",
      result: { code: 1, stdout: "", stderr: "stale" },
    }],
    blockers: [{ code: "stale_action_request", action_id: "act-1", reason: "head_changed" }],
  };

  const collapsed = canonicalizeActionRequestsForTask(task, [{
    id: "act-1",
    provider: "git",
    type: "git_push",
    status: "pending",
    cwd: "/repo",
    normalized_args: ["push", "origin", "main"],
    expected_head: "head-2",
  }]);

  assert.equal(collapsed.action_requests.length, 1);
  assert.equal(collapsed.action_requests[0].id, "act-1");
  assert.equal(collapsed.action_requests[0].stale_reason, null);
  assert.equal(collapsed.action_requests[0].result, null);
  assert.equal(collapsed.blockers.length, 0);

  const split = canonicalizeActionRequestsForTask(collapsed, [{
    id: "act-1",
    provider: "git",
    type: "git_push",
    status: "pending",
    cwd: "/repo",
    normalized_args: ["push", "origin", "feature"],
  }]);

  assert.deepEqual(split.action_requests.map((request) => request.id), ["act-1", "act-1-2"]);
  assert.deepEqual(split.unblock_options.map((option) => option.id), [
    "approve-act-1",
    "edit-act-1",
    "approve-act-1-2",
    "edit-act-1-2",
    "manual-task-actions",
    "cancel-task-actions",
  ]);
});

test("stale git action approval stays actionable and run-action bypasses freshness", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const git = createFakeGitRunner({
      dirtyByCwd: { [dir]: " M package.json\n" },
      headByCwd: { [dir]: ["head-1", "head-2"] },
    });

    const waiting = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "--review", "off", "Commit current changes"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { throw new Error("should not run"); } },
      gitRunner: git.run,
    });

    const blocked = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, waiting.task.id, waiting.task.action_requests[0].id],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { throw new Error("should not run"); } },
      gitRunner: git.run,
    });

    assert.equal(blocked.task.status, "waiting_user");
    assert.equal(blocked.task.action_requests[0].status, "pending");
    assert.equal(git.calls.some((call) => call.args[0] === "commit"), false);
    assert.equal(blocked.task.blockers[0].code, "stale_action_request");
    assert.equal(blocked.task.action_requests[0].stale_reason, "head_changed");
    assert.equal(blocked.task.unblock_options.some((option) => option.type === "run_anyway"), true);

    const resumed = await runLocalMaestroCommand({
      args: ["run-action", "--state-dir", store.root, waiting.task.id, waiting.task.action_requests[0].id, "--note", "state changed; run anyway"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => ({
          status: "succeeded",
          stdout: "executor ok",
          stderr: "",
          stdoutPath: path.join(step.logDir, "executor.stdout.log"),
          stderrPath: path.join(step.logDir, "executor.stderr.log"),
          command: step.provider,
          args: [step.role],
        }),
      },
      gitRunner: git.run,
    });

    assert.equal(resumed.task.status, "succeeded");
    assert.equal(resumed.task.action_requests[0].status, "succeeded");
    assert.equal(git.calls.some((call) => call.args[0] === "commit"), true);
  });
});

test("unsafe git action requests reject force, ref deletion, and shell injection without running git", async () => {
  await withTempDir(async (dir) => {
    const cases = [
      ["act-force", ["push", "--force", "origin", "main"]],
      ["act-delete", ["push", "origin", ":main"]],
      ["act-inject", ["push", "origin", "main;rm -rf /"]],
    ];
    for (const [actionId, normalizedArgs] of cases) {
      const store = new LocalTaskStore({ root: path.join(dir, `.maestro-${actionId}`) });
      const task = await store.createTask({ prompt: "Push force", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
      await store.updateTask(task.id, {
        status: "waiting_approval",
        action_requests: [{
          id: actionId,
          provider: "git",
          type: "git_push",
          status: "pending",
          cwd: dir,
          normalized_args: normalizedArgs,
          expected_branch: "main",
          expected_head: "head-1",
          expected_status_hash: statusHash(""),
          expected_remote_url: "git@example.com:repo.git",
          continuation_generation: 0,
        }],
        unblock_options: [{ id: `approve-${actionId}`, type: "approve_action", label: "Approve", status: "open" }],
      });
      const git = createFakeGitRunner();

      const result = await runLocalMaestroCommand({
        args: ["approve-action", "--state-dir", store.root, task.id, actionId],
        cwd: dir,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        store,
        gitRunner: git.run,
      });

      assert.equal(result.task.status, "waiting_user");
      assert.equal(result.task.review.completion_state, "incomplete_needs_user");
      assert.equal(result.task.action_requests[0].status, "pending");
      assert.equal(result.task.unblock_options.some((option) => option.type === "edit_action"), true);
      assert.equal(git.calls.some((call) => call.args[0] === "push"), false);
    }
  });
});

test("git push action validation rejects force flags, refspec mapping, wildcards, and extra args", async () => {
  await withTempDir(async (dir) => {
    const cases = [
      ["force-with-lease", ["push", "--force-with-lease", "origin", "main"]],
      ["plus-ref", ["push", "origin", "+main"]],
      ["mapped-refspec", ["push", "origin", "main:other"]],
      ["delete-ref", ["push", "origin", ":main"]],
      ["wildcard", ["push", "origin", "feature/*"]],
      ["extra-arg", ["push", "origin", "main", "--tags"]],
    ];
    for (const [caseId, normalizedArgs] of cases) {
      const store = new LocalTaskStore({ root: path.join(dir, `.maestro-push-${caseId}`) });
      const task = await store.createTask({ prompt: "Push branch", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
      await store.updateTask(task.id, {
        status: "waiting_approval",
        action_requests: [{
          id: `act-${caseId}`,
          provider: "git",
          type: "git_push",
          status: "pending",
          cwd: dir,
          normalized_args: normalizedArgs,
          expected_branch: "main",
          expected_head: "head-1",
          expected_status_hash: statusHash(""),
          expected_remote_url: "git@example.com:repo.git",
          continuation_generation: 0,
        }],
      });
      const git = createFakeGitRunner();

      const result = await runLocalMaestroCommand({
        args: ["approve-action", "--state-dir", store.root, task.id, `act-${caseId}`],
        cwd: dir,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        store,
        gitRunner: git.run,
      });

      assert.equal(result.task.status, "waiting_user");
      assert.equal(result.task.action_requests[0].status, "pending");
      assert.equal(result.task.unblock_options.some((option) => option.type === "edit_action"), true);
      assert.equal(git.calls.some((call) => call.args[0] === "push"), false);
    }
  });
});

test("broker auth and merge failures route to recovery states", async () => {
  await withTempDir(async (dir) => {
    const cases = [
      {
        id: "push",
        type: "git_push",
        args: ["push", "origin", "main"],
        fail: { "push origin main": "permission denied" },
        expectedStatus: "waiting_user",
        expectedBlocker: "needs_user",
      },
      {
        id: "merge",
        type: "git_merge",
        args: ["merge", "--no-ff", "feature/a"],
        fail: { "merge --no-ff feature/a": "CONFLICT content" },
        expectedStatus: "waiting_user",
        expectedBlocker: "merge_conflict",
      },
    ];
    for (const item of cases) {
      const store = new LocalTaskStore({ root: path.join(dir, `.maestro-${item.id}`) });
      const task = await store.createTask({ prompt: `Run ${item.id}`, cwd: dir, plannerPolicy: "off", reviewEnabled: false });
      await store.updateTask(task.id, {
        status: "waiting_approval",
        action_requests: [{
          id: `act-${item.id}`,
          provider: "git",
          type: item.type,
          status: "pending",
          cwd: dir,
          normalized_args: item.args,
          expected_branch: "main",
          expected_head: "head-1",
          expected_status_hash: statusHash(""),
          expected_remote_url: "git@example.com:repo.git",
          continuation_generation: 0,
        }],
      });
      const result = await runLocalMaestroCommand({
        args: ["approve-action", "--state-dir", store.root, task.id, `act-${item.id}`],
        cwd: dir,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        store,
        gitRunner: createFakeGitRunner({ fail: item.fail }).run,
      });

      assert.equal(result.task.status, item.expectedStatus);
      assert.equal(result.task.action_requests[0].status, "failed");
      assert.equal(result.task.blockers[0].code, item.expectedBlocker);
      assert.equal(result.task.unblock_options.some((option) => option.type === "retry"), true);
    }
  });
});

test("failed git action can be rerun or force marked done", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "Push branch", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_push",
        status: "failed",
        cwd: dir,
        normalized_args: ["push", "origin", "main"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(""),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
        result: { code: 1, stdout: "", stderr: "network failed" },
      }],
      unblock_options: [
        { id: "approve-act-1", type: "approve_action", label: "Approve", status: "open" },
        { id: "manual-task", type: "manual_done", label: "Manual", status: "open" },
      ],
    });
    const git = createFakeGitRunner();
    const rerun = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1", "--note", "network fixed"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => ({
          status: "succeeded",
          stdout: "executor ok",
          stderr: "",
          stdoutPath: path.join(step.logDir, "executor.stdout.log"),
          stderrPath: path.join(step.logDir, "executor.stderr.log"),
          command: step.provider,
          args: [step.role],
        }),
      },
      gitRunner: git.run,
    });
    assert.equal(rerun.task.status, "succeeded");
    assert.equal(rerun.task.action_requests[0].status, "succeeded");
    assert.equal(git.calls.some((call) => call.args.join(" ") === "push origin main"), true);

    const second = await store.createTask({ prompt: "Fetch branch", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(second.id, {
      status: "waiting_user",
      action_requests: [{
        id: "act-2",
        provider: "git",
        type: "git_fetch",
        status: "failed",
        cwd: dir,
        normalized_args: ["fetch", "origin"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(""),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
        result: { code: 1, stdout: "", stderr: "auth failed" },
      }],
    });
    const forced = await runLocalMaestroCommand({
      args: ["mark-done", "--state-dir", store.root, second.id, "act-2", "--force", "--note", "fetched manually"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => ({
          status: "succeeded",
          stdout: "executor ok",
          stderr: "",
          stdoutPath: path.join(step.logDir, "executor.stdout.log"),
          stderrPath: path.join(step.logDir, "executor.stderr.log"),
          command: step.provider,
          args: [step.role],
        }),
      },
      gitRunner: createFakeGitRunner().run,
    });
    assert.equal(forced.task.status, "succeeded");
    assert.equal(forced.task.action_requests[0].result.forced, true);
  });
});

test("MAESTRO_HANDOFF JSON is written to disk and used in reviewer prompt", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const prompts = [];
    const runner = {
      runStep: async (step) => {
        prompts.push(step.prompt);
        return {
          status: "succeeded",
          stdout: step.role === "executor"
            ? `MAESTRO_HANDOFF: ${JSON.stringify({ changed_files: ["scripts/maestro.mjs"], verification: ["npm run test:maestro"], residual_risks: [] })}\nraw log line\n`
            : `MAESTRO_REVIEW: ${JSON.stringify({ version: 1, completion_state: "complete", required_action: "none", risk_level: "low", confidence: "high", summary: "ok", evidence: [], blockers: [], required_user_input: null, approval_request: null, continuation: null })}\n`,
          stderr: "",
          stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
          stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
          command: step.provider,
          args: [step.role],
        };
      },
    };

    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "Structured handoff"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
    });

    const handoff = JSON.parse(await readFile(path.join(result.task.run_dir, "handoff.executor.json"), "utf8"));
    assert.deepEqual(handoff.payload.changed_files, ["scripts/maestro.mjs"]);
    assert.match(prompts.at(-1), /Structured handoff from executor/);
    assert.match(prompts.at(-1), /scripts\/maestro\.mjs/);
  });
});

test("MAESTRO_HANDOFF is parsed from Codex JSON agent messages", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const prompts = [];
    const payload = { changed_files: ["a.txt"], verification: [], residual_risks: ["push blocked"] };

    const result = await runLocalMaestroCommand({
      args: [
        "task",
        "--state-dir", store.root,
        "--planner", "off",
        "Patch docs",
      ],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => {
          prompts.push(step.prompt);
          return {
            status: "succeeded",
            stdout: step.role === "executor"
              ? `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `done\nMAESTRO_HANDOFF: ${JSON.stringify(payload)}` } })}\n`
              : `MAESTRO_REVIEW: ${JSON.stringify({ version: 1, completion_state: "complete", required_action: "none", risk_level: "low", confidence: "high", summary: "ok", evidence: [], blockers: [], required_user_input: null, approval_request: null, continuation: null })}\n`,
            stderr: "",
            stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
            stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
            command: step.provider,
            args: [step.role],
          };
        },
      },
      gitRunner: createFakeGitRunner().run,
    });

    assert.equal(result.task.status, "succeeded");
    const handoff = JSON.parse(await readFile(path.join(result.task.run_dir, "handoff.executor.json"), "utf8"));
    assert.deepEqual(handoff.payload, payload);
    assert.match(prompts.at(-1), /Structured handoff from executor/);
  });
});

test("reviewer complete marker controls final success and records review", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const verdict = {
      version: 1,
      completion_state: "complete",
      required_action: "none",
      risk_level: "low",
      confidence: "high",
      summary: "done",
      evidence: ["executor verification passed"],
      blockers: [],
      required_user_input: null,
      approval_request: null,
      continuation: null,
    };
    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "Patch docs"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => ({
          status: "succeeded",
          stdout: step.role === "reviewer" ? `MAESTRO_REVIEW: ${JSON.stringify(verdict)}\n` : "executor ok",
          stderr: "",
          stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
          stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
          command: step.provider,
          args: [step.role],
        }),
      },
    });

    assert.equal(result.task.status, "succeeded");
    assert.equal(result.task.review.status, "reviewed");
    assert.equal(result.task.review.completion_state, "complete");
    assert.equal(result.task.review.risk_level, "low");
  });
});

test("missing reviewer marker becomes waiting_user and uncertain", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });

    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "Patch docs"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => ({
          status: "succeeded",
          stdout: step.role === "reviewer" ? "looks fine but no marker" : "executor ok",
          stderr: "",
          stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
          stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
          command: step.provider,
          args: [step.role],
        }),
      },
    });

    assert.equal(result.task.status, "waiting_user");
    assert.equal(result.task.review.status, "invalid");
    assert.equal(result.task.review.completion_state, "uncertain");
    assert.equal(result.task.unblock_options.some((option) => option.type === "retry"), true);
    assert.equal(result.task.unblock_options.some((option) => option.type === "cancel"), true);
  });
});

test("reviewer can route task to user or approval waiting states", async () => {
  await withTempDir(async (dir) => {
    const cases = [
      {
        prompt: "Need user",
        verdict: {
          completion_state: "incomplete_needs_user",
          required_action: "ask_user",
          required_user_input: { question: "Which branch should be pushed?" },
        },
        expectedStatus: "waiting_user",
        activeKey: "active_question",
      },
      {
        prompt: "Need approval",
        verdict: {
          completion_state: "incomplete_needs_approval",
          required_action: "request_approval",
          approval_request: { action: "git push origin main", reason: "Network push requires approval." },
        },
        expectedStatus: "waiting_approval",
        activeKey: "active_approval",
      },
    ];

    for (const item of cases) {
      const store = new LocalTaskStore({
        root: path.join(dir, `.maestro-${item.expectedStatus}`),
        clock: () => new Date("2026-05-13T12:34:56.000Z"),
      });
      const verdict = {
        version: 1,
        required_action: item.verdict.required_action,
        completion_state: item.verdict.completion_state,
        risk_level: "medium",
        confidence: "high",
        summary: item.prompt,
        evidence: [],
        blockers: [],
        required_user_input: item.verdict.required_user_input ?? null,
        approval_request: item.verdict.approval_request ?? null,
        continuation: null,
      };
      const result = await runLocalMaestroCommand({
        args: ["task", "--state-dir", store.root, "--planner", "off", item.prompt],
        cwd: dir,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        store,
        runner: {
          runStep: async (step) => ({
            status: "succeeded",
            stdout: step.role === "reviewer" ? `MAESTRO_REVIEW: ${JSON.stringify(verdict)}\n` : "executor ok",
            stderr: "",
            stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
            stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
            command: step.provider,
            args: [step.role],
          }),
        },
      });

      assert.equal(result.task.status, item.expectedStatus);
      assert.ok(result.task[item.activeKey]);
    }
  });
});

test("reviewer marker can carry typed action requests and unblock options", () => {
  const review = parseReviewerOutput(`MAESTRO_REVIEW: ${JSON.stringify({
    version: 1,
    completion_state: "incomplete_needs_approval",
    required_action: "request_approval",
    risk_level: "medium",
    confidence: "high",
    summary: "needs local commit",
    evidence: [],
    blockers: [],
    required_user_input: null,
    approval_request: null,
    action_requests: [{
      provider: "git",
      type: "git_commit",
      cwd: "/repo",
      normalized_args: ["commit", "-m", "maestro: test"],
      expected_branch: "main",
      expected_head: "head-1",
      expected_status_hash: statusHash(" M package.json\n"),
    }],
    unblock_options: [{ type: "manual_done", label: "I committed manually" }],
    continuation: null,
  })}\n`);

  assert.equal(review.action_requests[0].type, "git_commit");
  assert.equal(review.unblock_options[0].type, "manual_done");
});

test("manual mark-done records audit note and resumes task", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "Publish after manual step", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_push",
        status: "pending",
        cwd: dir,
        normalized_args: ["push", "origin", "main"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(""),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
      }],
      unblock_options: [{ id: "manual-act-1", type: "manual_done", label: "I pushed manually", status: "open" }],
    });
    const prompts = [];

    const result = await runLocalMaestroCommand({
      args: ["mark-done", "--state-dir", store.root, task.id, "--note", "I pushed manually"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: createFakeGitRunner().run,
      runner: {
        runStep: async (step) => {
          prompts.push(step.prompt);
          return {
            status: "succeeded",
            stdout: "executor ok",
            stderr: "",
            stdoutPath: path.join(step.logDir, "executor.stdout.log"),
            stderrPath: path.join(step.logDir, "executor.stderr.log"),
            command: step.provider,
            args: [step.role],
          };
        },
      },
    });

    const saved = await store.readTask(task.id);
    assert.equal(result.task.status, "succeeded");
    assert.equal(saved.interactions[0].type, "manual_done");
    assert.match(prompts.at(-1), /I pushed manually/);
  });
});

test("manual mark-done fails for commit when HEAD has not changed", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "Commit current changes", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_commit",
        status: "pending",
        cwd: dir,
        normalized_args: ["commit", "-m", "maestro: test"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(" M package.json\n"),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
      }],
    });

    const result = await runLocalMaestroCommand({
      args: ["mark-done", "--state-dir", store.root, task.id, "act-1", "--note", "committed elsewhere"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { throw new Error("should not run"); } },
      gitRunner: createFakeGitRunner().run,
    });

    assert.equal(result.task.status, "waiting_user");
    assert.equal(result.task.action_requests[0].status, "pending");
    assert.equal(result.task.blockers[0].code, "manual_done_not_observed");
  });
});

test("manual mark-done succeeds for changed HEAD and appends the next git action", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "Commit then push current changes", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_commit",
        status: "pending",
        cwd: dir,
        normalized_args: ["commit", "-m", "maestro: test"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(" M package.json\n"),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
      }],
    });
    let ran = false;

    const result = await runLocalMaestroCommand({
      args: ["mark-done", "--state-dir", store.root, task.id, "act-1", "--note", "committed manually"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { ran = true; } },
      gitRunner: createFakeGitRunner({ head: "head-2", dirtyByCwd: { [dir]: "" } }).run,
    });

    assert.equal(result.task.status, "waiting_approval");
    assert.deepEqual(result.task.action_requests.map((request) => `${request.type}:${request.status}`), [
      "git_commit:succeeded",
      "git_push:pending",
    ]);
    assert.equal(result.task.action_requests[1].expected_head, "head-2");
    assert.equal(result.task.action_requests[0].result.stdout, "manual_verified_local_state");
    assert.equal(ran, false);
  });
});

test("manual mark-done without action id stays waiting when multiple actions are pending", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "Commit and push", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [
        {
          id: "act-1",
          provider: "git",
          type: "git_commit",
          status: "pending",
          cwd: dir,
          normalized_args: ["commit", "-m", "maestro: test"],
          expected_branch: "main",
          expected_head: "head-1",
          expected_status_hash: statusHash(" M package.json\n"),
          expected_remote_url: "git@example.com:repo.git",
          continuation_generation: 0,
        },
        {
          id: "act-2",
          provider: "git",
          type: "git_push",
          status: "pending",
          cwd: dir,
          normalized_args: ["push", "origin", "main"],
          expected_branch: "main",
          expected_head: "head-1",
          expected_status_hash: statusHash(" M package.json\n"),
          expected_remote_url: "git@example.com:repo.git",
          continuation_generation: 0,
        },
      ],
    });

    const result = await runLocalMaestroCommand({
      args: ["mark-done", "--state-dir", store.root, task.id, "--note", "one of them"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { throw new Error("should not run"); } },
      gitRunner: createFakeGitRunner().run,
    });

    assert.equal(result.task.status, "waiting_user");
    assert.equal(result.task.blockers[0].code, "manual_done_ambiguous");
    assert.deepEqual(result.task.action_requests.map((request) => request.status), ["pending", "pending"]);
  });
});

test("git action args normalize a harmless leading git token before execution", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "Push branch", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_push",
        status: "pending",
        cwd: dir,
        normalized_args: ["git", "push", "origin", "main"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(""),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
      }],
    });
    const git = createFakeGitRunner();

    const result = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1", "--note", "run push"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => ({
          status: "succeeded",
          stdout: "executor ok",
          stderr: "",
          stdoutPath: path.join(step.logDir, "executor.stdout.log"),
          stderrPath: path.join(step.logDir, "executor.stderr.log"),
          command: step.provider,
          args: [step.role],
        }),
      },
      gitRunner: git.run,
    });

    assert.equal(result.task.status, "succeeded");
    assert.deepEqual(result.task.action_requests[0].normalized_args, ["push", "origin", "main"]);
    assert.equal(git.calls.some((call) => call.args.join(" ") === "push origin main"), true);
  });
});

test("git action outside task cwd becomes recoverable external-cwd action instead of blocked", async () => {
  await withTempDir(async (dir) => {
    const taskCwd = path.join(dir, "task");
    const externalCwd = path.join(dir, "other");
    await mkdir(taskCwd, { recursive: true });
    await mkdir(externalCwd, { recursive: true });
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "Push external repo", cwd: taskCwd, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_push",
        status: "pending",
        cwd: externalCwd,
        normalized_args: ["push", "origin", "main"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(""),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
      }],
    });
    const git = createFakeGitRunner();

    const result = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });

    assert.equal(result.task.status, "waiting_user");
    assert.equal(result.task.action_requests[0].status, "pending");
    assert.equal(result.task.action_requests[0].type, "external_cwd_git");
    assert.equal(result.task.action_requests[0].git_type, "git_push");
    assert.equal(result.task.blockers[0].code, "action_cwd_outside_task");
    assert.deepEqual(
      result.task.unblock_options.map((option) => option.type).filter((type) => ["run_external", "edit_action", "cancel"].includes(type)),
      ["run_external", "edit_action", "cancel"],
    );
    assert.equal(git.calls.some((call) => call.args[0] === "push"), false);

    const resumed = await runLocalMaestroCommand({
      args: ["run-action", "--state-dir", store.root, task.id, "act-1", "--note", "I approve the external cwd"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
      runner: {
        runStep: async (step) => ({
          status: "succeeded",
          stdout: "executor ok",
          stderr: "",
          stdoutPath: path.join(step.logDir, "executor.stdout.log"),
          stderrPath: path.join(step.logDir, "executor.stderr.log"),
          command: step.provider,
          args: [step.role],
        }),
      },
    });

    assert.equal(resumed.task.status, "succeeded");
    assert.equal(resumed.task.action_requests[0].status, "succeeded");
    assert.equal(git.calls.some((call) => call.args.join(" ") === "push origin main"), true);
  });
});

test("host command action captures logs and resumes with compact output context", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    // host_command_allow must be set in config; default empty = feature off (S1 fix).
    await store.writeConfig({ host_command_allow: ["printf"] });
    const task = await store.createTask({ prompt: "Run host command", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "host",
        type: "host_command",
        status: "pending",
        cwd: dir,
        command: "printf",
        args: ["host-ok"],
        env: {},
        timeout_ms: 5_000,
        continuation_generation: 0,
      }],
    });
    const prompts = [];

    const result = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1", "--note", "safe host run"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => {
          prompts.push(step.prompt);
          return {
            status: "succeeded",
            stdout: "executor ok",
            stderr: "",
            stdoutPath: path.join(step.logDir, "executor.stdout.log"),
            stderrPath: path.join(step.logDir, "executor.stderr.log"),
            command: step.provider,
            args: [step.role],
          };
        },
      },
      gitRunner: createFakeGitRunner().run,
    });

    const request = result.task.action_requests[0];
    assert.equal(result.task.status, "succeeded");
    assert.equal(request.status, "succeeded");
    assert.equal(request.result.exit_code, 0);
    assert.equal(await readFile(request.result.stdout_path, "utf8"), "host-ok");
    assert.match(request.result.command_hash, /^[a-f0-9]{64}$/);
    assert.equal(typeof request.result.duration_ms, "number");
    assert.equal(request.result.user_note, "safe host run");
    assert.match(prompts[0], /Host action completed: host_command/);
    assert.match(prompts[0], /stdout log:/);
    assert.match(prompts[0], /host-ok/);
  });
});

test("edit-action rewrites malformed git args before approval", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "Push branch", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_push",
        status: "pending",
        cwd: dir,
        normalized_args: ["push", "--force", "origin", "main"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(""),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
      }],
    });
    const git = createFakeGitRunner();

    const waiting = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });
    assert.equal(waiting.task.status, "waiting_user");
    assert.equal(waiting.task.unblock_options.some((option) => option.type === "edit_action"), true);

    await runLocalMaestroCommand({
      args: ["edit-action", "--state-dir", store.root, task.id, "act-1", "--args-json", "[\"git\",\"push\",\"origin\",\"main\"]"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
    });
    const approved = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1", "--note", "edited"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => ({
          status: "succeeded",
          stdout: "executor ok",
          stderr: "",
          stdoutPath: path.join(step.logDir, "executor.stdout.log"),
          stderrPath: path.join(step.logDir, "executor.stderr.log"),
          command: step.provider,
          args: [step.role],
        }),
      },
      gitRunner: git.run,
    });

    assert.equal(approved.task.status, "succeeded");
    assert.deepEqual(approved.task.action_requests[0].normalized_args, ["push", "origin", "main"]);
    assert.equal(git.calls.some((call) => call.args.join(" ") === "push origin main"), true);
  });
});

test("host command failure stays recoverable with captured stderr log", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    // host_command_allow must be set in config; default empty = feature off (S1 fix).
    await store.writeConfig({ host_command_allow: ["sh"] });
    const task = await store.createTask({ prompt: "Run failing host command", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "host",
        type: "host_command",
        status: "pending",
        cwd: dir,
        command: "sh",
        args: ["-c", "printf host-bad >&2; exit 7"],
        env: {},
        timeout_ms: 5_000,
        continuation_generation: 0,
      }],
    });

    const result = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: createFakeGitRunner().run,
    });

    const request = result.task.action_requests[0];
    assert.equal(result.task.status, "waiting_user");
    assert.equal(request.status, "failed");
    assert.equal(request.result.exit_code, 7);
    assert.equal(await readFile(request.result.stderr_path, "utf8"), "host-bad");
    assert.equal(result.task.unblock_options.some((option) => option.type === "retry"), true);
    assert.equal(result.task.unblock_options.some((option) => option.type === "edit_action"), true);
    assert.equal(result.task.unblock_options.some((option) => option.type === "cancel"), true);
  });
});

test("failed host action can be approved again, edited in any flag order, and force marked done", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    // host_command_allow must be set in config; default empty = feature off (S1 fix).
    await store.writeConfig({ host_command_allow: ["sh", "printf"] });
    const task = await store.createTask({ prompt: "Run recoverable host command", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "host",
        type: "host_command",
        status: "pending",
        cwd: dir,
        command: "sh",
        args: ["-c", "printf bad >&2; exit 3"],
        env: {},
        timeout_ms: 5_000,
        continuation_generation: 0,
      }],
    });
    let prompts = [];

    const failed = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: createFakeGitRunner().run,
    });
    assert.equal(failed.task.action_requests[0].status, "failed");

    const rerun = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1", "--note", "try same command again"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      hostRunner: async () => ({ stdout: "rerun ok", stderr: "", code: 0 }),
      runner: {
        runStep: async (step) => {
          prompts.push(step.prompt);
          return {
            status: "succeeded",
            stdout: "executor ok",
            stderr: "",
            stdoutPath: path.join(step.logDir, "executor.stdout.log"),
            stderrPath: path.join(step.logDir, "executor.stderr.log"),
            command: step.provider,
            args: [step.role],
          };
        },
      },
      gitRunner: createFakeGitRunner().run,
    });
    assert.equal(rerun.task.status, "succeeded");
    assert.equal(rerun.task.action_requests[0].status, "succeeded");
    assert.match(prompts.at(-1), /rerun ok/);

    const second = await store.createTask({ prompt: "Manual host command", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(second.id, {
      status: "waiting_user",
      action_requests: [{
        id: "act-2",
        provider: "host",
        type: "host_command",
        status: "failed",
        cwd: dir,
        command: "badcmd",
        args: ["old"],
        env: {},
        timeout_ms: 5_000,
        continuation_generation: 0,
      }],
    });
    const edited = await runLocalMaestroCommand({
      args: [
        "edit-action",
        "--state-dir", store.root,
        second.id,
        "act-2",
        "--args-json", "[\"hello\"]",
        "--env-json", "{\"MODE\":\"test\"}",
        "--timeout-ms", "-1",
        "--cwd", ".",
        "--command", "printf",
      ],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
    });
    assert.equal(edited.task.action_requests[0].provider, "host");
    assert.deepEqual(edited.task.action_requests[0].args, ["hello"]);
    assert.deepEqual(edited.task.action_requests[0].env, { MODE: "test" });
    assert.equal(edited.task.action_requests[0].timeout_ms, -1);

    prompts = [];
    const forced = await runLocalMaestroCommand({
      args: ["mark-done", "--state-dir", store.root, second.id, "act-2", "--force", "--note", "completed outside Maestro"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => {
          prompts.push(step.prompt);
          return {
            status: "succeeded",
            stdout: "executor ok",
            stderr: "",
            stdoutPath: path.join(step.logDir, "executor.stdout.log"),
            stderrPath: path.join(step.logDir, "executor.stderr.log"),
            command: step.provider,
            args: [step.role],
          };
        },
      },
      gitRunner: createFakeGitRunner().run,
    });
    assert.equal(forced.task.status, "succeeded");
    assert.equal(forced.task.action_requests[0].status, "succeeded");
    assert.equal(forced.task.action_requests[0].result.forced, true);
    assert.match(prompts.at(-1), /User reports command completed manually/);
    assert.match(prompts.at(-1), /completed outside Maestro/);
  });
});

test("failed agent run becomes waiting_user with retry, instruct, and cancel options", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });

    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "--review", "off", "Run flaky task"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => {
          const error = new Error("tool timed out");
          error.code = "ETIMEDOUT";
          error.stdoutPath = path.join(step.logDir, "executor.stdout.log");
          error.stderrPath = path.join(step.logDir, "executor.stderr.log");
          throw error;
        },
      },
      gitRunner: createFakeGitRunner().run,
    });

    assert.equal(result.task.status, "waiting_user");
    assert.equal(result.task.blockers[0].code, "agent_timeout");
    assert.equal(result.task.steps[0].status, "failed");
    assert.equal(result.task.unblock_options.some((option) => option.type === "retry"), true);
    assert.equal(result.task.unblock_options.some((option) => option.type === "instruct"), true);
    assert.equal(result.task.unblock_options.some((option) => option.type === "cancel"), true);
  });
});

test("agent timeout exposes extend-timeout and queues continuation", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });

    const waiting = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "--review", "off", "Run slow task"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async () => {
          const error = new Error("timed out after 1000ms");
          error.code = "ETIMEDOUT";
          throw error;
        },
      },
      gitRunner: createFakeGitRunner().run,
    });

    assert.equal(waiting.task.status, "waiting_user");
    assert.equal(waiting.task.blockers[0].code, "agent_timeout");
    assert.equal(waiting.task.unblock_options.some((option) => option.type === "extend_timeout"), true);

    const prompts = [];
    const result = await runLocalMaestroCommand({
      args: ["extend-timeout", "--state-dir", store.root, waiting.task.id, "--timeout-ms", "-1", "--note", "disable timeout and continue"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => {
          prompts.push(step.prompt);
          return {
            status: "succeeded",
            stdout: "executor ok",
            stderr: "",
            stdoutPath: path.join(step.logDir, "executor.stdout.log"),
            stderrPath: path.join(step.logDir, "executor.stderr.log"),
            command: step.provider,
            args: [step.role],
          };
        },
      },
      gitRunner: createFakeGitRunner().run,
    });

    assert.equal(result.task.status, "succeeded");
    assert.equal(result.task.timeout_ms, -1);
    assert.equal(result.task.interactions.at(-1).type, "extend_timeout");
    assert.match(prompts.at(-1), /Timeout extended to -1 ms/);
    assert.match(prompts.at(-1), /disable timeout and continue/);
  });
});

test("message command queues non-running task context and preserves running task state", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const queued = await store.createTask({ prompt: "Patch docs", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    const running = await store.createTask({ prompt: "Long task", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(running.id, { status: "running" });
    const prompts = [];

    const queuedResult = await runLocalMaestroCommand({
      args: ["message", "--state-dir", store.root, queued.id, "--note", "Use the v2 endpoint"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => {
          prompts.push(step.prompt);
          return {
            status: "succeeded",
            stdout: "executor ok",
            stderr: "",
            stdoutPath: path.join(step.logDir, "executor.stdout.log"),
            stderrPath: path.join(step.logDir, "executor.stderr.log"),
            command: step.provider,
            args: [step.role],
          };
        },
      },
      gitRunner: createFakeGitRunner().run,
    });
    const runningResult = await runLocalMaestroCommand({
      args: ["message", "--state-dir", store.root, running.id, "--note", "Pause before final review"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: { runStep: async () => { throw new Error("running task should not restart"); } },
      gitRunner: createFakeGitRunner().run,
    });

    assert.equal(queuedResult.task.status, "succeeded");
    assert.match(prompts.at(-1), /Use the v2 endpoint/);
    assert.equal(runningResult.task.status, "running");
    assert.equal(runningResult.task.interactions[0].body, "Pause before final review");
  });
});

test("approval command records decision and resumes through continuation", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    let reviewerCalls = 0;
    const prompts = [];
    const runner = {
      runStep: async (step) => {
        prompts.push(step.prompt);
        const review = reviewerCalls === 0
          ? {
              version: 1,
              completion_state: "incomplete_needs_approval",
              required_action: "request_approval",
              risk_level: "medium",
              confidence: "high",
              summary: "needs push approval",
              evidence: [],
              blockers: [],
              required_user_input: null,
              approval_request: { action: "git push origin main", reason: "Network push requires approval." },
              continuation: null,
            }
          : {
              version: 1,
              completion_state: "complete",
              required_action: "none",
              risk_level: "low",
              confidence: "high",
              summary: "approval handled",
              evidence: [],
              blockers: [],
              required_user_input: null,
              approval_request: null,
              continuation: null,
            };
        if (step.role === "reviewer") reviewerCalls += 1;
        return {
          status: "succeeded",
          stdout: step.role === "reviewer" ? `MAESTRO_REVIEW: ${JSON.stringify(review)}\n` : "executor ok",
          stderr: "",
          stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
          stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
          command: step.provider,
          args: [step.role],
        };
      },
    };

    const waiting = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "Publish after review"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
    });
    assert.equal(waiting.task.status, "waiting_approval");

    const approved = await runLocalMaestroCommand({
      args: ["approve", "--state-dir", store.root, waiting.task.id, "--note", "user handled remote push"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
    });

    const saved = await store.readTask(waiting.task.id);
    assert.equal(approved.task.status, "succeeded");
    assert.equal(saved.approval_decisions[0].approved, true);
    assert.match(prompts.at(-2), /Approval granted for: git push origin main/);
    assert.equal(reviewerCalls, 2);
  });
});

test("reviewer blocked, failed, and uncertain states stay recoverable", async () => {
  await withTempDir(async (dir) => {
    const cases = [
      ["blocked_external", "retry_after_environment_change", "waiting_user"],
      ["blocked_repo_state", "manual_fix", "waiting_user"],
      ["blocked_safety", "manual_fix", "waiting_user"],
      ["failed_agent", "mark_failed", "waiting_user"],
      ["uncertain", "manual_fix", "waiting_user"],
      ["complete", "manual_fix", "waiting_user"],
    ];

    for (const [completionState, requiredAction, expectedStatus] of cases) {
      const store = new LocalTaskStore({
        root: path.join(dir, `.maestro-${completionState}`),
        clock: () => new Date("2026-05-13T12:34:56.000Z"),
      });
      const review = {
        version: 1,
        completion_state: completionState,
        required_action: requiredAction,
        risk_level: "medium",
        confidence: "high",
        summary: completionState,
        evidence: [],
        blockers: [{ code: completionState }],
        required_user_input: null,
        approval_request: null,
        continuation: null,
      };

      const result = await runLocalMaestroCommand({
        args: ["task", "--state-dir", store.root, "--planner", "off", `Review ${completionState}`],
        cwd: dir,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        store,
        runner: {
          runStep: async (step) => ({
            status: "succeeded",
            stdout: step.role === "reviewer" ? `MAESTRO_REVIEW: ${JSON.stringify(review)}\n` : "executor ok",
            stderr: "",
            stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
            stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
            command: step.provider,
            args: [step.role],
          }),
        },
      });

      assert.equal(result.task.status, expectedStatus);
      if (expectedStatus === "waiting_user") {
        assert.equal(result.task.unblock_options.some((option) => option.type === "retry"), true);
        assert.equal(result.task.unblock_options.some((option) => option.type === "cancel"), true);
      }
      if (completionState === "complete") {
        assert.equal(result.task.review.status, "invalid");
      }
    }
  });
});

test("reviewer continueable outcome queues exactly one continuation", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const roles = [];
    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "Finish docs"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => {
          roles.push(step.role);
          const review = {
            version: 1,
            completion_state: "incomplete_continueable",
            required_action: "continue",
            risk_level: "medium",
            confidence: "high",
            summary: "needs another pass",
            evidence: ["missing verification"],
            blockers: [],
            required_user_input: null,
            approval_request: null,
            continuation: { prompt: "Run verification and update handoff.", reason: "No verification listed." },
          };
          return {
            status: "succeeded",
            stdout: step.role === "reviewer" ? `MAESTRO_REVIEW: ${JSON.stringify(review)}\n` : "executor ok",
            stderr: "",
            stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
            stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
            command: step.provider,
            args: [step.role],
          };
        },
      },
    });

    assert.deepEqual(roles, ["executor", "reviewer"]);
    assert.equal(result.task.status, "queued");
    assert.equal(result.task.review.continuation_attempts, 1);
    assert.match(result.task.continuation_prompt, /Run verification/);
  });
});

test("reviewer continuation exhaustion becomes waiting_user with recovery actions", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const task = await store.createTask({ prompt: "Finish docs", cwd: dir, plannerPolicy: "off", reviewEnabled: true });
    await store.updateTask(task.id, {
      status: "running",
      review: {
        status: "reviewed",
        completion_state: "incomplete_continueable",
        required_action: "continue",
        risk_level: "medium",
        confidence: "high",
        summary: "needs another pass",
        evidence: [],
        blockers: [],
        required_user_input: null,
        approval_request: null,
        continuation: { prompt: "Run verification.", reason: "No verification." },
        continuation_attempts: 1,
        max_continuations: 1,
      },
    });

    const result = await runLocalMaestroCommand({
      args: ["run-task", "--state-dir", store.root, task.id],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => ({
          status: "succeeded",
          stdout: step.role === "reviewer"
            ? `MAESTRO_REVIEW: ${JSON.stringify({
                version: 1,
                completion_state: "incomplete_continueable",
                required_action: "continue",
                risk_level: "medium",
                confidence: "high",
                summary: "still needs work",
                evidence: [],
                blockers: [],
                required_user_input: null,
                approval_request: null,
                continuation: { prompt: "Try again.", reason: "Still missing." },
                continuation_attempts: 1,
                max_continuations: 1,
              })}\n`
            : "executor ok",
          stderr: "",
          stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
          stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
          command: step.provider,
          args: [step.role],
        }),
      },
    });

    assert.equal(result.task.status, "waiting_user");
    assert.equal(result.task.blockers[0].code, "continuation_exhausted");
    assert.equal(result.task.unblock_options.some((option) => option.type === "retry"), true);
    assert.equal(result.task.unblock_options.some((option) => option.type === "instruct"), true);
    assert.equal(result.task.unblock_options.some((option) => option.type === "cancel"), true);
  });
});

test("project close merge conflicts create a merge-fix task", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".gitignore"), ".maestro/\n");
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const git = createFakeGitRunner({ fail: { "merge --squash maestro/alpha/integration": "merge conflict" } });
    await runLocalMaestroCommand({
      args: ["project", "create", "alpha", "--state-dir", store.root, "--target", "main"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });

    const result = await runLocalMaestroCommand({
      args: ["project", "close", "alpha", "--state-dir", store.root],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });

    const tasks = await store.listTasks();
    assert.equal(result.project.status, "close_blocked");
    assert.equal(tasks[0].mode, "merge-fix");
    assert.match(tasks[0].prompt, /Resolve Maestro merge conflict for project alpha/);
  });
});

test("project task merge conflict waits for user and retry finalizes only the merge", async () => {
  await withTempDir(async (dir) => {
    const taskWorktree = path.join(dir, ".maestro", "worktrees", "alpha", "conflict-task");
    const integrationWorktree = path.join(dir, ".maestro", "worktrees", "alpha", "integration");
    await mkdir(taskWorktree, { recursive: true });
    await mkdir(integrationWorktree, { recursive: true });
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    await store.createProject({
      id: "alpha",
      status: "open",
      target_branch: "main",
      target_head: "target-head",
      integration_branch: "maestro/alpha/integration",
      integration_worktree: integrationWorktree,
      worktree_root: path.join(dir, ".maestro", "worktrees"),
      tasks: [],
      path_leases: {},
      blockers: [],
      cleanup_blockers: [],
      ledger: [],
    });
    const task = await store.createTask({
      prompt: "Finish conflict task",
      cwd: taskWorktree,
      plannerPolicy: "off",
      reviewEnabled: false,
      projectId: "alpha",
      branch: "maestro/alpha/task/conflict-task",
      worktreePath: taskWorktree,
    });
    await store.updateProject("alpha", {
      tasks: [{
        id: task.id,
        alias: "conflict-task",
        branch: task.branch,
        worktree_path: taskWorktree,
        status: "queued",
      }],
    });
    const fail = {
      [`merge --no-ff ${task.branch} -m maestro: merge ${task.id}`]: "CONFLICT content",
    };
    const git = createFakeGitRunner({
      dirtyByCwd: { [taskWorktree]: " M file.txt\n" },
      fail,
    });
    let runnerCalls = 0;

    const blocked = await runLocalMaestroCommand({
      args: ["run-task", "--state-dir", store.root, task.id],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async (step) => {
          runnerCalls += 1;
          return {
            status: "succeeded",
            stdout: "executor ok",
            stderr: "",
            stdoutPath: path.join(step.logDir, "executor.stdout.log"),
            stderrPath: path.join(step.logDir, "executor.stderr.log"),
            command: step.provider,
            args: [step.role],
          };
        },
      },
      gitRunner: git.run,
    });

    assert.equal(blocked.task.status, "waiting_user");
    assert.equal(blocked.task.blockers[0].code, "task_merge_conflict");
    assert.equal(blocked.task.blockers[0].integration_worktree, integrationWorktree);
    assert.equal(blocked.task.unblock_options.some((option) => option.type === "retry"), true);
    assert.equal(blocked.task.unblock_options.some((option) => option.type === "manual_done"), true);
    assert.equal(git.calls.some((call) => call.args.join(" ") === "merge --abort"), true);

    delete fail[`merge --no-ff ${task.branch} -m maestro: merge ${task.id}`];
    const retried = await runLocalMaestroCommand({
      args: ["retry", "--state-dir", store.root, task.id, "--note", "conflict resolved"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: {
        runStep: async () => {
          throw new Error("retry should finalize project merge without rerunning agent");
        },
      },
      gitRunner: git.run,
    });

    assert.equal(retried.task.status, "succeeded");
    assert.equal(runnerCalls, 1);
    assert.equal(git.calls.filter((call) => call.args[0] === "merge" && call.args[1] === "--no-ff").length, 2);
  });
});

test("project cleanup preserves dirty worktrees and writes a patch path", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".gitignore"), ".maestro/\n");
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const taskWorktree = path.join(dir, ".maestro", "worktrees", "alpha", "dirty-task");
    const git = createFakeGitRunner({ dirtyByCwd: { [taskWorktree]: " M dirty.txt\n" } });
    await runLocalMaestroCommand({
      args: ["project", "create", "alpha", "--state-dir", store.root, "--target", "main"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });
    await mkdir(taskWorktree, { recursive: true });
    await store.updateProject("alpha", {
      status: "closed",
      tasks: [{
        id: "dirty-task",
        branch: "maestro/alpha/task/dirty-task",
        worktree_path: taskWorktree,
        status: "succeeded",
      }],
    });

    const result = await runLocalMaestroCommand({
      args: ["project", "cleanup", "alpha", "--state-dir", store.root],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });

    const project = await store.readProject("alpha");
    assert.equal(result.project.status, "cleanup_blocked");
    assert.match(project.cleanup_blockers[0].patch_path, /\.maestro\/patches\/dirty-task\.patch$/);
    assert.match(await readFile(project.cleanup_blockers[0].patch_path, "utf8"), /diff --git/);
  });
});

test("project cleanup removes clean project worktrees and local closed branches only", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".gitignore"), ".maestro/\n");
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const git = createFakeGitRunner();
    await runLocalMaestroCommand({
      args: ["project", "create", "alpha", "--state-dir", store.root, "--target", "main"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });
    const project = await store.readProject("alpha");
    const taskWorktree = path.join(dir, ".maestro", "worktrees", "alpha", "clean-task");
    await mkdir(taskWorktree, { recursive: true });
    await store.updateProject("alpha", {
      status: "closed",
      target_merge_commit: "target-merge",
      tasks: [{
        id: "clean-task",
        branch: "maestro/alpha/task/clean-task",
        worktree_path: taskWorktree,
        status: "succeeded",
      }],
    });

    const result = await runLocalMaestroCommand({
      args: ["project", "cleanup", "alpha", "--state-dir", store.root],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: git.run,
    });

    assert.equal(result.project.status, "closed");
    assert.deepEqual(result.project.cleanup_blockers, []);
    const callTexts = git.calls.map((call) => call.args.join(" "));
    assert.ok(callTexts.includes(`worktree remove ${taskWorktree}`));
    assert.ok(callTexts.includes(`branch -d maestro/alpha/task/clean-task`));
    assert.ok(callTexts.includes(`worktree remove ${project.integration_worktree}`));
    assert.ok(callTexts.includes("branch -D maestro/alpha/integration"));
    assert.equal(callTexts.some((text) => text.includes("origin/")), false);
  });
});

test("local task store persists queued tasks and step results", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });

    const task = await store.createTask({
      prompt: "Add production throughput drilldown",
      mode: "task",
    });
    await store.appendStep(task.id, {
      role: "planner",
      provider: "claude",
      status: "succeeded",
      stdout_path: "runs/x/planner.stdout.log",
    });

    const saved = await store.readTask(task.id);
    const listed = await store.listTasks();

    assert.match(task.id, /^20260513-123456-add-production-throughput-drilldown$/);
    assert.equal(saved.status, "queued");
    assert.equal(saved.steps[0].provider, "claude");
    assert.deepEqual(listed.map((item) => item.id), [task.id]);
  });
});

test("task list uses short display ids and a human timestamp column", () => {
  const rows = formatTaskList([
    {
      id: "20260514-013151-in-mobility-twin-need-a-way-to-retrigger-an-evaluation-of-the-simulation",
      created_at: "2026-05-14T01:31:51.996Z",
      status: "failed",
      mode: "task",
      planner_policy: "auto",
      planner_decision: "used",
      active_step: null,
      steps: [{ role: "planner", status: "failed" }],
    },
  ]);

  assert.match(rows, /#\s+Status\s+Created\s+Task\s+Activity/);
  assert.match(rows, /2026-05-14 01:31/);
  assert.match(rows, /in-mobility-twin-need-a-way-to-retrigger-an-evaluation/);
  assert.doesNotMatch(rows, /20260514-013151-in-mobility/);
  assert.doesNotMatch(rows, /planner auto\/used/);
});

test("task list can color status cells for terminal readability", () => {
  const rows = formatTaskList([
    {
      id: "task-running",
      created_at: "2026-05-14T01:31:51.996Z",
      status: "running",
      mode: "task",
      steps: [],
    },
  ], { color: true });

  assert.match(rows, /\u001b\[36m/);
  assert.match(rows, /running/);
});

test("TUI page headers are plain by default and colored when enabled", () => {
  assert.equal(formatPageHeader("Tasks"), "== Tasks ==");
  assert.equal(
    formatPageHeader("Tasks", { color: true, accent: "\u001b[35m" }),
    "\u001b[35m\u001b[1m== Tasks ==\u001b[0m",
  );
});

test("local task store creates unique ids for duplicate prompts in the same second", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });

    const first = await store.createTask({ prompt: "Duplicate task", mode: "task" });
    const second = await store.createTask({ prompt: "Duplicate task", mode: "task" });

    assert.equal(first.id, "20260513-123456-duplicate-task");
    assert.equal(second.id, "20260513-123456-duplicate-task-2");
    assert.equal((await store.listTasks()).length, 2);
  });
});

test("appendStep records step without owning final lifecycle status", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const task = await store.createTask({ prompt: "Preserve lifecycle", cwd: dir });
    await store.updateTask(task.id, { status: "waiting_approval" });

    const updated = await store.appendStep(task.id, {
      role: "reviewer",
      provider: "codex",
      status: "failed",
      error: "bad marker",
    });

    assert.equal(updated.status, "waiting_approval");
    assert.equal(updated.steps[0].status, "failed");
  });
});

test("question and approval decisions sync project task records", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    await store.createProject({
      id: "alpha",
      status: "open",
      tasks: [],
      path_leases: {},
      blockers: [],
      cleanup_blockers: [],
      ledger: [],
    });
    const task = await store.createTask({ prompt: "Sync project row", cwd: dir, projectId: "alpha" });
    await store.updateProject("alpha", {
      tasks: [{ id: task.id, alias: "sync", status: "waiting_approval" }],
    });

    await store.updateTask(task.id, {
      status: "waiting_approval",
      active_approval: { id: "a1", action: "deploy", reason: "needs gate" },
    });
    await store.decideApproval(task.id, { approved: false, note: "denied" });
    assert.equal((await store.readProject("alpha")).tasks[0].status, "queued");

    await store.updateTask(task.id, {
      status: "waiting_user",
      active_question: { id: "q1", question: "continue?" },
    });
    await store.answerQuestion(task.id, "yes");
    assert.equal((await store.readProject("alpha")).tasks[0].status, "queued");
  });
});

test("local task store reports unreadable task files without crashing task history", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    await writeFile(path.join(store.tasksDir, "bad-task.json"), "");

    const tasks = await store.listTasks();

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, "bad-task");
    assert.equal(tasks[0].status, "unreadable");
    assert.match(tasks[0].error, /invalid_task_json/);
    assert.match(formatTaskList(tasks), /unreadable\s+-\s+bad-task/);
  });
});

test("local router maps normal and plan-only tasks to provider roles", async () => {
  assert.deepEqual(resolveAgentFlow({
    mode: "task",
    prompt: "Design a TUI workflow",
  }), [
    { role: "planner", provider: "claude" },
    { role: "executor", provider: "codex" },
    { role: "reviewer", provider: "codex" },
  ]);
  assert.deepEqual(resolveAgentFlow({ mode: "plan-only" }), [
    { role: "planner", provider: "claude" },
  ]);

  const prompt = await buildStepPrompt({
    role: "executor",
    task: { prompt: "Fix API drift" },
    priorOutputs: [{ role: "planner", output: "Plan: patch api.py and test_api.py" }],
  });

  assert.match(prompt, /Codex owns execution/);
  assert.match(prompt, /Plan: patch api\.py and test_api\.py/);
  assert.match(prompt, /Fix API drift/);
});

test("step prompts compact large prior outputs before review", async () => {
  const largeOutput = "review evidence line\n".repeat(50_000);
  const prompt = await buildStepPrompt({
    role: "reviewer",
    task: { prompt: "Review the repository" },
    priorOutputs: [{
      role: "executor",
      output: largeOutput,
      stdoutPath: "/repo/.maestro/runs/task/executor.stdout.log",
    }],
  });

  assert.ok(Buffer.byteLength(prompt, "utf8") < 140_000);
  assert.match(prompt, /executor output compacted/);
  assert.match(prompt, /Original bytes:/);
  assert.match(prompt, /executor\.stdout\.log/);
  assert.doesNotMatch(prompt, new RegExp("review evidence line\\n".repeat(500)));
});

test("reviewer prompt requires structured review verdict", async () => {
  const prompt = await buildStepPrompt({
    role: "reviewer",
    task: { prompt: "Review task" },
    priorOutputs: [],
  });

  assert.match(prompt, /MAESTRO_REVIEW:/);
  assert.match(prompt, /completion_state/);
  assert.match(prompt, /incomplete_needs_approval/);
  assert.match(prompt, /Reviewer output is advisory/);
});

test("reviewer marker parser validates logs and rejects injection", () => {
  const marker = (patch = {}) => `MAESTRO_REVIEW: ${JSON.stringify({
    version: 1,
    completion_state: "complete",
    required_action: "none",
    risk_level: "low",
    confidence: "high",
    summary: "ok",
    evidence: [],
    blockers: [],
    required_user_input: null,
    approval_request: null,
    continuation: null,
    ...patch,
  })}`;

  assert.equal(parseReviewerOutput(`noise\n${marker({ summary: "plain" })}\n`).summary, "plain");
  assert.equal(parseReviewerOutput(`${marker({ summary: "first" })}\n${marker({ summary: "last" })}`).summary, "last");
  assert.equal(parseReviewerOutput(`${JSON.stringify({ type: "message", text: `done\n${marker({ summary: "json" })}` })}\n`).summary, "json");
  assert.equal(parseReviewerOutput(`${JSON.stringify({ type: "message", quote: marker({ summary: "quoted-json" }) })}\n`).status, "invalid");
  assert.equal(parseReviewerOutput("MAESTRO_REVIEW: {bad json").status, "invalid");
  assert.equal(parseReviewerOutput(marker({ completion_state: "bogus" })).completion_state, "uncertain");
  assert.equal(parseReviewerOutput(marker({ completion_state: "complete", required_action: "manual_fix" })).status, "invalid");
  assert.equal(parseReviewerOutput(`> ${marker({ summary: "quoted" })}`).status, "invalid");
  assert.equal(parseReviewerOutput(`\`\`\`\n${marker({ summary: "code" })}\n\`\`\``).status, "invalid");

  const oversized = parseReviewerOutput(marker({
    summary: "x".repeat(5_000),
    evidence: Array.from({ length: 20 }, (_, index) => `evidence-${index}`),
  }));
  assert.ok(Buffer.byteLength(oversized.summary, "utf8") <= 2_000);
  assert.equal(oversized.evidence.length, 10);
});

test("planner policy lets Codex auto-decide whether Claude planning is needed", () => {
  assert.deepEqual(evaluatePlannerDecision({
    plannerPolicy: "on",
    prompt: "Fix typo",
    mode: "task",
  }), {
    policy: "on",
    decision: "used",
    reason: "planner forced on",
  });

  assert.deepEqual(evaluatePlannerDecision({
    plannerPolicy: "off",
    prompt: "Design safer API flow",
    mode: "task",
  }), {
    policy: "off",
    decision: "skipped",
    reason: "planner forced off",
  });

  assert.equal(evaluatePlannerDecision({
    plannerPolicy: "auto",
    prompt: "Fix typo in README",
    mode: "task",
  }).decision, "skipped");

  const complex = evaluatePlannerDecision({
    plannerPolicy: "auto",
    prompt: "Design a TUI with settings, task history, and orchestration policy",
    mode: "task",
  });
  assert.equal(complex.decision, "used");
  assert.match(complex.reason, /matched/);

  assert.deepEqual(resolveAgentFlow({
    mode: "task",
    plannerPolicy: "off",
    reviewEnabled: false,
    prompt: "Patch one test",
  }), [
    { role: "executor", provider: "codex" },
  ]);
});

test("local CLI adapters build bounded commands for Claude, Codex, and disabled Copilot", () => {
  const claude = buildClaudeCommand({
    prompt: "Plan only",
    cwd: "/repo",
    role: "planner",
    commandName: "pclaude",
    effort: "xhigh",
  });
  assert.equal(claude.command, "pclaude");
  assert.deepEqual(claude.args.slice(0, 2), ["--output-format", "stream-json"]);
  assert.ok(claude.args.includes("--verbose"));
  assert.ok(claude.args.includes("--permission-mode"));
  assert.ok(claude.args.includes("plan"));
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--effort"), claude.args.indexOf("--effort") + 2), ["--effort", "xhigh"]);
  assert.equal(claude.args.includes("Plan only"), false);
  assert.equal(claude.stdin, "Plan only");

  const codex = buildCodexCommand({
    prompt: "Implement",
    cwd: "/repo",
    role: "executor",
    commandName: "mycodex",
    effort: "xhigh",
  });
  assert.equal(codex.command, "mycodex");
  assert.deepEqual(codex.args.slice(0, 8), ["exec", "--json", "-c", "approval_policy=\"never\"", "--sandbox", "workspace-write", "--cd", "/repo"]);
  assert.deepEqual(codex.args.slice(codex.args.indexOf("model_reasoning_effort=\"xhigh\"") - 1, codex.args.indexOf("model_reasoning_effort=\"xhigh\"") + 1), ["-c", "model_reasoning_effort=\"xhigh\""]);
  assert.equal(codex.args.includes("--ask-for-approval"), false);
  assert.equal(codex.args.includes("Implement"), false);
  assert.equal(codex.stdin, "Implement");

  const review = buildCodexCommand({
    prompt: "Review",
    cwd: "/repo",
    role: "reviewer",
  });
  assert.equal(review.args[review.args.indexOf("--sandbox") + 1], "read-only");

  const copilot = buildCopilotCommand({ prompt: "Do work", cwd: "/repo" });
  assert.equal(copilot.command, "copilot");
  assert.ok(copilot.args.includes("-p"));

  const antigravity = buildAntigravityCommand({
    prompt: "Solve this issue",
    cwd: "/repo",
    role: "executor",
    commandName: "antigravity-cli",
    model: "antigravity-pro",
    effort: "high",
    permission: "write",
  });
  assert.equal(antigravity.command, "antigravity-cli");
  assert.deepEqual(antigravity.args, [
    "-p",
    "Solve this issue",
    "--output-format",
    "json",
    "--role",
    "executor",
    "--model",
    "antigravity-pro",
    "--effort",
    "high",
    "--permission",
    "write",
  ]);
  assert.equal(antigravity.cwd, "/repo");
  assert.equal(antigravity.stdin, null);
});

test("Codex adapter sends long prompts over stdin to avoid argv limits", () => {
  const prompt = "review ".repeat(80_000);
  const codex = buildCodexCommand({
    prompt,
    cwd: "/repo",
    role: "reviewer",
  });

  assert.equal(codex.stdin, prompt);
  assert.equal(codex.args.includes(prompt), false);
  assert.equal(codex.args[codex.args.indexOf("--sandbox") + 1], "read-only");
});

test("Claude adapter sends prompts over stdin to avoid argv limits", () => {
  const prompt = "plan ".repeat(80_000);
  const claude = buildClaudeCommand({
    prompt,
    cwd: "/repo",
    role: "planner",
  });

  assert.equal(claude.stdin, prompt);
  assert.equal(claude.args.includes(prompt), false);
});

test("local task CLI creates a task, runs planner/executor/reviewer, and records logs", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const calls = [];
    const runner = {
      runStep: async (step) => {
        calls.push(step);
        let stdout;
        if (step.role === "reviewer") {
          stdout = `MAESTRO_REVIEW: ${JSON.stringify({ version: 1, completion_state: "complete", required_action: "none", risk_level: "low", confidence: "high", summary: "ok", evidence: [], blockers: [], required_user_input: null, approval_request: null, continuation: null })}\n`;
        } else if (step.role === "planner") {
          // Emit structured handoff so "planner output" flows into executor prompt
          stdout = `planner output\nMAESTRO_HANDOFF: ${JSON.stringify({ plan_summary: "planner output", steps: [], files_to_touch: [] })}\n`;
        } else {
          stdout = `${step.role} output`;
        }
        return {
          status: "succeeded",
          stdout,
          stderr: "",
          stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
          stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
          command: step.provider,
          args: [step.role],
        };
      },
    };
    const stdoutLines = [];
    let createdTaskId = null;

    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--cwd", dir, "Improve berth ETA tests"],
      cwd: dir,
      stdout: { write: (text) => stdoutLines.push(text) },
      stderr: { write: () => {} },
      store,
      runner,
      availabilityProbe: () => true, // stub runner; don't probe the host PATH
      onTaskCreated: (task) => {
        createdTaskId = task.id;
      },
    });

    const saved = await store.readTask(result.task.id);
    assert.equal(createdTaskId, "20260513-123456-improve-berth-eta-tests");
    assert.equal(result.task.status, "succeeded");
    assert.equal(saved.steps.length, 3);
    assert.deepEqual(calls.map((call) => `${call.role}:${call.provider}`), [
      "planner:claude",
      "executor:codex",
      "reviewer:codex",
    ]);
    assert.match(calls[1].prompt, /planner output/);
    assert.match(stdoutLines.join(""), /task 20260513-123456-improve-berth-eta-tests succeeded/);
    assert.match(stdoutLines.join(""), /run summary: 20260513-123456-improve-berth-eta-tests succeeded/);
  });
});

test("local task --plan-only fails on workflows without a plan-only mode", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    const { SOLO_WORKFLOW } = await import("../src/setup/workflow-templates.mjs");
    await writeFile(
      path.join(store.root, "workflow.json"),
      JSON.stringify(SOLO_WORKFLOW, null, 2),
    );
    await assert.rejects(
      runLocalMaestroCommand({
        args: ["task", "--plan-only", "--state-dir", store.root, "--cwd", dir, "do thing"],
        cwd: dir,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        store,
      }),
      /unknown_mode: plan-only \(defined modes: task\)/,
    );
  });
});

test("workflow use switches templates via the CLI and backs up the old file", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    const stdoutLines = [];
    await runLocalMaestroCommand({
      args: ["workflow", "use", "solo", "--state-dir", store.root],
      cwd: dir,
      stdout: { write: (text) => stdoutLines.push(text) },
      stderr: { write: () => {} },
      store,
    });
    const output = stdoutLines.join("");
    assert.match(output, /workflow\.json now uses template "solo": executor\(codex\)/);
    assert.match(output, /modes: task/);
    const workflow = JSON.parse(
      await readFile(path.join(store.root, "workflow.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(workflow.roles), ["executor"]);
  });
});

test("workflow use --as writes a named slot", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    await runLocalMaestroCommand({
      args: ["workflow", "use", "solo", "--as", "fast", "--state-dir", store.root],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
    });
    const wf = await store.readWorkflow("fast");
    assert.deepEqual(Object.keys(wf.roles), ["executor"]);
  });
});

test("readWorkflow: named .yaml normalizes to the JSON-equivalent shape", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    await mkdir(store.workflowsDir, { recursive: true });
    const wfObj = { version: 2, initial: "executor", roles: { executor: { provider: "codex" } }, transitions: { executor: { done: "$complete" } } };
    await writeFile(store.workflowYamlFilePath("foo"), YAML.stringify(wfObj));
    const fromYaml = await store.readWorkflow("foo");
    await writeFile(store.workflowFilePath("bar"), JSON.stringify(wfObj));
    const fromJson = await store.readWorkflow("bar");
    assert.deepEqual(fromYaml, fromJson);
  });
});

test("readWorkflow: named JSON wins over YAML with a precedence warning", async () => {
  await withTempDir(async (dir) => {
    const warnings = [];
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro"), onWarn: (m) => warnings.push(m) });
    await store.init();
    await mkdir(store.workflowsDir, { recursive: true });
    const jsonObj = { version: 2, initial: "executor", roles: { executor: { provider: "codex", model: "json" } }, transitions: { executor: { done: "$complete" } } };
    const yamlObj = { ...jsonObj, roles: { executor: { provider: "codex", model: "yaml" } } };
    await writeFile(store.workflowFilePath("foo"), JSON.stringify(jsonObj));
    await writeFile(store.workflowYamlFilePath("foo"), YAML.stringify(yamlObj));
    const wf = await store.readWorkflow("foo");
    assert.equal(wf.roles.executor.model, "json");
    assert.ok(warnings.some((m) => m.includes("workflow_format_precedence")));
  });
});

test("readWorkflow: default .maestro/workflow.yaml is used when no JSON exists", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    const wfObj = { version: 2, initial: "executor", roles: { executor: { provider: "codex", model: "fromyaml" } }, transitions: { executor: { done: "$complete" } } };
    await writeFile(store.workflowYamlPath, YAML.stringify(wfObj));
    const wf = await store.readWorkflow();
    assert.equal(wf.roles.executor.model, "fromyaml");
  });
});

test("workflow list prints name + source", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    await writeFile(store.workflowPath, JSON.stringify(DEFAULT_WORKFLOW));
    await store.applyWorkflowTemplate({ name: "solo", as: "fast" });
    const lines = [];
    await runLocalMaestroCommand({
      args: ["workflow", "list", "--state-dir", store.root],
      cwd: dir,
      stdout: { write: (text) => lines.push(text) },
      stderr: { write: () => {} },
      store,
    });
    const output = lines.join("");
    assert.match(output, /default \(legacy\)/);
    assert.match(output, /fast \(named\)/);
  });
});

test("task --workflow runs the named workflow and stamps it", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    await store.applyWorkflowTemplate({ name: "solo", as: "solo" });
    const roles = [];
    const runner = {
      runStep: async ({ role }) => {
        roles.push(role);
        return { stdout: `MAESTRO_HANDOFF: ${JSON.stringify({ summary: "done" })}`, stderr: "", stdoutPath: null, stderrPath: null };
      },
    };
    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--workflow", "solo", "--planner", "off", "--review", "off", "Do it"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
      availabilityProbe: () => true,
    });
    assert.equal(result.task.workflow, "solo");
    assert.deepEqual([...new Set(roles)], ["executor"]);
    const persisted = await store.readTask(result.task.id);
    assert.equal(persisted.workflow, "solo");
  });
});

test("task --workflow rejects an unknown workflow name", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    await assert.rejects(
      () => runLocalMaestroCommand({
        args: ["task", "--state-dir", store.root, "--workflow", "nope", "do", "it"],
        cwd: dir,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        store,
      }),
      /unknown_workflow: nope/,
    );
  });
});

test("local task CLI records agent failure as recoverable waiting_user state", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const runner = {
      runStep: async () => {
        throw new Error("agent_failed: codex exited with 2");
      },
    };

    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "--review", "off", "Fail task"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
    });

    assert.equal(result.task.id, "20260513-123456-fail-task");
    assert.equal(result.task.status, "waiting_user");
    assert.equal(result.task.blockers[0].code, "failed_agent");
    assert.equal(result.task.unblock_options.some((option) => option.type === "retry"), true);
  });
});

test("local task CLI passes configured Claude and Codex command names to runner", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    await store.writeConfig({
      cwd: dir,
      planner_policy: "on",
      review_enabled: true,
      timeout_ms: -1,
      claude_command: "pclaude",
      codex_command: "mycodex",
      planner_model: "opus",
      claude_effort: "high",
      executor_model: "gpt-5.5",
      executor_effort: "high",
      reviewer_model: "gpt-5.4",
      reviewer_effort: "low",
    });
    const options = [];
    const runner = {
      runStep: async (step) => {
        options.push(step.options);
        return {
          status: "succeeded",
          stdout: `${step.role} output`,
          stderr: "",
          stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
          stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
          command: step.provider,
          args: [step.role],
        };
      },
    };

    await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "Use custom commands"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
      availabilityProbe: () => true, // custom aliases (pclaude/mycodex) aren't on the host PATH
    });

    // LangGraph engine uses role-level fields (alias/effort/permission) from workflow.json
    // which writeConfig populates from legacy claude_command/codex_command/etc. keys.
    assert.deepEqual(options, [
      { alias: "pclaude", model: "opus", effort: "high", permission: "plan", streamTailBytes: 65536 },
      { alias: "mycodex", model: "gpt-5.5", effort: "high", permission: "write", streamTailBytes: 65536 },
      { alias: "mycodex", model: "gpt-5.4", effort: "low", permission: "read", streamTailBytes: 65536 },
    ]);
  });
});

test("local task CLI records planner decisions and supports planner/reviewer overrides", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const calls = [];
    const runner = {
      runStep: async (step) => {
        calls.push(step);
        return {
          status: "succeeded",
          stdout: `${step.role} output`,
          stderr: "",
          stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
          stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
          command: step.provider,
          args: [step.role],
        };
      },
    };

    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--cwd", dir, "--planner", "off", "--review", "off", "Patch one doc typo"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
    });

    const saved = await store.readTask(result.task.id);
    assert.deepEqual(calls.map((call) => `${call.role}:${call.provider}`), ["executor:codex"]);
    assert.equal(saved.planner_policy, "off");
    assert.equal(saved.planner_decision, "skipped");
    assert.equal(saved.review_enabled, false);
  });
});

// ── provider availability: block, skip, and switch recovery (Phase D) ────────────

function recordingRunner(calls) {
  return {
    runStep: async (step) => {
      calls.push(step);
      return {
        status: "succeeded",
        stdout: `${step.role} output`,
        stderr: "",
        stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
        stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
        command: step.provider,
        args: [step.role],
      };
    },
  };
}

async function runBlockedExecutorTask({ dir, store, runner }) {
  const result = await runLocalMaestroCommand({
    args: ["task", "--state-dir", store.root, "--cwd", dir, "--planner", "off", "--review", "off", "Do the thing"],
    cwd: dir,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    store,
    runner,
    availabilityProbe: () => false, // no provider CLI resolves
  });
  return result.task.id;
}

test("missing provider blocks the role with switch/skip unblock options", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const calls = [];
    const taskId = await runBlockedExecutorTask({ dir, store, runner: recordingRunner(calls) });

    const saved = await store.readTask(taskId);
    assert.equal(saved.status, "waiting_user");
    assert.equal(saved.blockers[0].code, "provider_missing");
    assert.match(saved.blockers[0].message, /not installed/i);
    const types = (saved.unblock_options ?? []).map((o) => o.type);
    assert.ok(types.includes("switch_provider"), "offers switch_provider");
    assert.ok(types.includes("skip_role"), "offers skip_role");
    assert.equal(calls.length, 0, "agent never ran");
  });
});

test("skip-role recovers a task whose provider is unavailable", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const calls = [];
    const taskId = await runBlockedExecutorTask({ dir, store, runner: recordingRunner(calls) });

    await runLocalMaestroCommand({
      args: ["skip-role", "--state-dir", store.root, taskId],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: recordingRunner(calls),
      availabilityProbe: () => false,
    });

    const after = await store.readTask(taskId);
    assert.equal(after.status, "succeeded");
    assert.equal(after.role_skips?.executor, "always");
    assert.equal(calls.length, 0, "skipped role never ran");
  });
});

test("switch-provider recovers by running the role on an available provider", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const calls = [];
    const taskId = await runBlockedExecutorTask({ dir, store, runner: recordingRunner(calls) });

    await runLocalMaestroCommand({
      args: ["switch-provider", "--state-dir", store.root, taskId, "claude"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner: recordingRunner(calls),
      availabilityProbe: (alias) => alias === "claude",
    });

    const after = await store.readTask(taskId);
    assert.equal(after.status, "succeeded");
    assert.deepEqual(after.role_overrides?.executor, { provider: "claude" });
    assert.deepEqual(calls.map((c) => `${c.role}:${c.provider}`), ["executor:claude"]);
  });
});

test("local task CLI marks task waiting when an agent asks a Maestro question", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const runner = {
      runStep: async (step) => ({
        status: "succeeded",
        stdout: `${JSON.stringify({
          type: "assistant",
          message: "Need input\nMAESTRO_QUESTION: Which port should I use?",
        })}\n`,
        stderr: "",
        stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
        stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
        command: step.provider,
        args: [step.role],
      }),
    };

    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "--review", "off", "Ask user"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
    });

    const saved = await store.readTask(result.task.id);
    assert.equal(saved.status, "waiting_user");
    assert.deepEqual(saved.active_question, {
      id: "q1",
      role: "executor",
      provider: "codex",
      question: "Which port should I use?",
    });
    assert.equal(saved.steps.at(-1).status, "waiting");
  });
});

test("local task CLI auto-compacts and retries context-window failures", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const prompts = [];
    let reviewerAttempts = 0;
    const runner = {
      runStep: async (step) => {
        prompts.push(step.prompt);
        if (step.role === "reviewer") {
          reviewerAttempts += 1;
          if (reviewerAttempts > 1) {
            return {
              status: "succeeded",
              stdout: `review passed\nMAESTRO_REVIEW: ${JSON.stringify({ version: 1, completion_state: "complete", required_action: "none", risk_level: "low", confidence: "high", summary: "ok", evidence: [], blockers: [], required_user_input: null, approval_request: null, continuation: null })}\n`,
              stderr: "",
              stdoutPath: path.join(step.logDir, "reviewer.stdout.log"),
              stderrPath: path.join(step.logDir, "reviewer.stderr.log"),
              command: step.provider,
              args: [step.role],
            };
          }
          const error = new Error("agent_failed: codex:reviewer exited with 1");
          error.stdout = `${JSON.stringify({
            type: "error",
            message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
          })}\n`;
          error.stderr = "Reading prompt from stdin...\n";
          error.stdoutPath = path.join(step.logDir, "reviewer.stdout.log");
          error.stderrPath = path.join(step.logDir, "reviewer.stderr.log");
          throw error;
        }
        return {
          status: "succeeded",
          stdout: "executor evidence\n".repeat(60_000),
          stderr: "",
          stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
          stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
          command: step.provider,
          args: [step.role],
        };
      },
    };

    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "Large review task"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
    });

    const saved = await store.readTask(result.task.id);
    assert.equal(saved.status, "succeeded");
    assert.equal(saved.active_question, null);
    assert.equal(reviewerAttempts, 2);
    assert.deepEqual(saved.steps.map((step) => step.status), ["succeeded", "retried", "succeeded"]);
    assert.equal(saved.steps[1].recovery, "auto_compact_retry");
    assert.match(prompts.at(-1), /Auto-retry note/);
    assert.ok(Buffer.byteLength(prompts.at(-1), "utf8") < 70_000);
  });
});

test("local run-task command executes an existing queued task without duplicating it", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const task = await store.createTask({
      prompt: "Existing task",
      mode: "task",
      cwd: dir,
      plannerPolicy: "off",
      plannerDecision: "skipped",
      plannerReason: "planner forced off",
      reviewEnabled: false,
      timeoutMs: -1,
      claudeCommand: "pclaude",
      codexCommand: "mycodex",
    });
    const calls = [];
    const runner = {
      runStep: async (step) => {
        calls.push(step);
        return {
          status: "succeeded",
          stdout: "executor output",
          stderr: "",
          stdoutPath: path.join(step.logDir, "executor.stdout.log"),
          stderrPath: path.join(step.logDir, "executor.stderr.log"),
          command: step.provider,
          args: [step.role],
        };
      },
    };

    const result = await runLocalMaestroCommand({
      args: ["run-task", "--state-dir", store.root, task.id],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
    });

    const tasks = await store.listTasks();
    assert.equal(result.task.id, task.id);
    assert.equal(result.task.status, "succeeded");
    assert.equal(tasks.length, 1);
    assert.deepEqual(calls.map((call) => `${call.role}:${call.provider}`), ["executor:codex"]);
  });
});

test("status exposes stale running tasks with retry and cancel options", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.writeConfig({ stale_after_ms: 1 });
    const task = await store.createTask({ prompt: "Long running", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "running",
      updated_at: "2020-01-01T00:00:00.000Z",
      active_step: { role: "executor", provider: "codex", status: "running" },
    });

    const result = await runLocalMaestroCommand({
      args: ["status", "--state-dir", store.root],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
    });

    assert.equal(result.tasks[0].status, "waiting_user");
    assert.equal(result.tasks[0].blockers[0].code, "stale_running_task");
    assert.deepEqual(result.tasks[0].unblock_options.map((option) => option.type), ["retry", "cancel"]);
  });
});

test("empty status commands print explicit empty messages", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const taskOutput = [];
    const projectOutput = [];

    const status = await runLocalMaestroCommand({
      args: ["status", "--state-dir", store.root],
      cwd: dir,
      stdout: { write: (text) => taskOutput.push(text) },
      stderr: { write: () => {} },
      store,
    });
    const projectStatus = await runLocalMaestroCommand({
      args: ["project", "status", "--state-dir", store.root],
      cwd: dir,
      stdout: { write: (text) => projectOutput.push(text) },
      stderr: { write: () => {} },
      store,
    });

    assert.deepEqual(status.tasks, []);
    assert.deepEqual(projectStatus.projects, []);
    assert.equal(taskOutput.join(""), "No Maestro tasks\n");
    assert.equal(projectOutput.join(""), "No Maestro projects\n");
  });
});

test("local task CLI records the active agent step while it is running", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const taskId = "20260513-123456-track-active-step";
    const runner = {
      runStep: async (step) => {
        const during = await store.readTask(taskId);
        assert.equal(during.status, "running");
        assert.deepEqual(during.active_step, {
          role: step.role,
          provider: step.provider,
          status: "running",
        });
        return {
          status: "succeeded",
          stdout: `${step.role} output`,
          stderr: "",
          stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
          stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
          command: step.provider,
          args: [step.role],
        };
      },
    };

    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--planner", "off", "--review", "off", "Track active step"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
    });

    const saved = await store.readTask(result.task.id);
    assert.equal(saved.status, "succeeded");
    assert.equal(saved.active_step, null);
  });
});

test("local task CLI accepts -1 timeout to disable agent timeout", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const runner = {
      runStep: async (step) => ({
        status: "succeeded",
        stdout: `${step.role} output`,
        stderr: "",
        stdoutPath: path.join(step.logDir, `${step.role}.stdout.log`),
        stderrPath: path.join(step.logDir, `${step.role}.stderr.log`),
        command: step.provider,
        args: [step.role],
      }),
    };

    const result = await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "--cwd", dir, "--timeout-ms", "-1", "--planner", "off", "--review", "off", "Patch docs"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      runner,
    });

    const saved = await store.readTask(result.task.id);
    assert.equal(saved.timeout_ms, -1);
  });
});

test("terminal agent runner writes command stdin and records only stdin size", async () => {
  await withTempDir(async (dir) => {
    let stdinText = "";
    const runner = new TerminalAgentRunner({
      spawnProcess: () => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        child.stdin.on("data", (chunk) => {
          stdinText += chunk.toString("utf8");
        });
        queueMicrotask(() => {
          child.emit("exit", 0, null);
        });
        return child;
      },
    });

    await runner.runStep({
      provider: "codex",
      role: "executor",
      prompt: "large prompt",
      cwd: dir,
      logDir: dir,
    });

    const command = JSON.parse(await readFile(path.join(dir, "executor.command.json"), "utf8"));
    assert.equal(stdinText, "large prompt");
    assert.equal(command.stdin_bytes, "large prompt".length);
    assert.equal(command.args.includes("large prompt"), false);
  });
});

test("terminal agent runner runs configured bash aliases through an interactive shell", async () => {
  await withTempDir(async (dir) => {
    let stdinText = "";
    const spawned = [];
    const runner = new TerminalAgentRunner({
      spawnProcess: (command, args, options) => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        child.stdin.on("data", (chunk) => {
          stdinText += chunk.toString("utf8");
        });
        spawned.push({ command, args, options });
        queueMicrotask(() => {
          child.stdout.write("alias output");
          child.emit("exit", 0, null);
        });
        return child;
      },
    });

    await runner.runStep({
      provider: "codex",
      role: "executor",
      prompt: "alias prompt",
      cwd: dir,
      logDir: dir,
      options: { codexCommand: "__maestro_alias_codex__" },
    });

    const command = JSON.parse(await readFile(path.join(dir, "executor.command.json"), "utf8"));
    assert.equal(spawned[0].command, "bash");
    assert.equal(spawned[0].args[0], "-ic");
    assert.match(spawned[0].args[1], /^__maestro_alias_codex__ /);
    assert.match(spawned[0].args[1], /'approval_policy="never"'/);
    assert.equal(command.command, "bash");
    assert.equal(command.configured_command, "__maestro_alias_codex__");
    assert.equal(command.invocation, "bash-interactive");
    assert.equal(stdinText, "alias prompt");
  });
});

test("terminal agent runner disables timeout when timeoutMs is -1", async () => {
  const runner = new TerminalAgentRunner({
    timeoutMs: -1,
    spawnProcess: () => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
    }),
    timers: {
      setTimeout: () => {
        throw new Error("setTimeout should not be called when timeout is disabled");
      },
      clearTimeout: () => {},
    },
  });

  assert.equal(runner.isTimeoutEnabled(), false);
});

test("terminal agent runner writes stdout and stderr logs when an agent exits nonzero", async () => {
  await withTempDir(async (dir) => {
    const runner = new TerminalAgentRunner({
      spawnProcess: () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        queueMicrotask(() => {
          child.stdout.write("partial stdout");
          child.stderr.write("bad flag");
          child.emit("exit", 2, null);
        });
        return child;
      },
    });

    await assert.rejects(
      () => runner.runStep({
        provider: "codex",
        role: "executor",
        prompt: "Do work",
        cwd: dir,
        logDir: dir,
      }),
      /agent_failed/,
    );

    assert.equal(await readFile(path.join(dir, "executor.stdout.log"), "utf8"), "partial stdout");
    assert.equal(await readFile(path.join(dir, "executor.stderr.log"), "utf8"), "bad flag");
  });
});

test("terminal agent runner keeps full logs on disk and returns bounded tails", async () => {
  await withTempDir(async (dir) => {
    const runner = new TerminalAgentRunner({
      spawnProcess: () => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        queueMicrotask(() => {
          child.stdout.write("head\n");
          child.stdout.write("x".repeat(100_000));
          child.stdout.write("\ntail");
          child.emit("exit", 0, null);
        });
        return child;
      },
    });

    const result = await runner.runStep({
      provider: "codex",
      role: "executor",
      prompt: "Do work",
      cwd: dir,
      logDir: dir,
      options: { streamTailBytes: 4096 },
    });

    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 4096);
    assert.match(result.stdout, /tail$/);
    const fullLog = await readFile(path.join(dir, "executor.stdout.log"), "utf8");
    assert.equal(Buffer.byteLength(fullLog, "utf8"), "head\n".length + 100_000 + "\ntail".length);
  });
});

test("TUI command availability check accepts bash aliases from bashrc", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".bashrc"), "alias __maestro_alias_claude__='true'\n");

    assert.equal(await defaultCommandExists("__maestro_alias_claude__", {
      cwd: dir,
      env: {
        ...process.env,
        HOME: dir,
      },
    }), true);
  });
});

test("local task store persists Maestro defaults for TUI and CLI reuse", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });

    const defaults = await store.readConfig();
    assert.equal(defaults.cwd, dir);
    assert.equal(defaults.planner_policy, "auto");
    assert.equal(defaults.review_enabled, true);
    assert.equal(defaults.timeout_ms, 3600000);
    assert.equal(defaults.worktree_root, ".maestro/worktrees");
    assert.equal(defaults.stream_tail_bytes, 65536);
    assert.equal(defaults.context_retry_limit, 1);
    // legacy shim keys
    assert.equal(defaults.claude_command, "claude");
    assert.equal(defaults.codex_command, "codex");
    assert.equal(defaults.planner_model, "");
    assert.equal(defaults.claude_effort, "");
    assert.equal(defaults.executor_model, "");
    assert.equal(defaults.executor_effort, "");
    assert.equal(defaults.reviewer_model, "");
    assert.equal(defaults.reviewer_effort, "");
    // v2 schema fields present
    assert.equal(defaults.version, 2);
    assert.ok(defaults.providers && typeof defaults.providers === "object");
    assert.equal(defaults.default_role, "executor");

    await store.writeConfig({
      cwd: "/repo/subdir",
      planner_policy: "off",
      review_enabled: false,
      timeout_ms: 120000,
      claude_command: "pclaude",
      codex_command: "mycodex",
      planner_model: "opus",
      claude_effort: "xhigh",
      executor_model: "gpt-5.5",
      executor_effort: "high",
      reviewer_model: "gpt-5.4",
      reviewer_effort: "low",
    });

    const updated = await store.readConfig();
    assert.equal(updated.cwd, "/repo/subdir");
    assert.equal(updated.planner_policy, "off");
    assert.equal(updated.review_enabled, false);
    assert.equal(updated.timeout_ms, 120000);
    assert.equal(updated.claude_command, "pclaude");
    assert.equal(updated.codex_command, "mycodex");
    assert.equal(updated.planner_model, "opus");
    assert.equal(updated.claude_effort, "xhigh");
    assert.equal(updated.executor_model, "gpt-5.5");
    assert.equal(updated.executor_effort, "high");
    assert.equal(updated.reviewer_model, "gpt-5.4");
    assert.equal(updated.reviewer_effort, "low");
  });
});

test("native TUI helpers collect task settings and format task history", async () => {
  const answers = [
    "Build TUI",
    "5",
    "-1",
    "s",
  ];
  const form = await collectNewTaskForm({
    ask: async () => answers.shift(),
    defaults: {
      cwd: "/repo",
      mode: "task",
      timeout_ms: 3600000,
    },
  });

  assert.deepEqual(form, {
    prompt: "Build TUI",
    cwd: "/repo",
    mode: "task",
    workflow: "default",
    timeout_ms: -1,
  });

  // SP0a: the workflow picker (field 4) sets form.workflow; Enter keeps default.
  const pickAnswers = ["Build TUI", "4", "solo", "s"];
  const picked = await collectNewTaskForm({
    ask: async () => pickAnswers.shift(),
    defaults: { cwd: "/repo", mode: "task", timeout_ms: -1 },
  });
  assert.equal(picked.workflow, "solo");

  const keepAnswers = ["Build TUI", "s"];
  const kept = await collectNewTaskForm({
    ask: async () => keepAnswers.shift(),
    defaults: { cwd: "/repo", mode: "task", timeout_ms: -1 },
  });
  assert.equal(kept.workflow, "default");

  const rows = formatTaskList([
    {
      id: "task-1",
      status: "succeeded",
      mode: "task",
      planner_policy: "auto",
      planner_decision: "used",
      steps: [{ role: "planner", status: "succeeded" }, { role: "executor", status: "failed" }],
    },
    {
      id: "task-2",
      status: "running",
      mode: "task",
      planner_policy: "off",
      planner_decision: "skipped",
      active_step: { role: "executor", provider: "codex", status: "running" },
      steps: [],
    },
  ]);
  assert.match(rows, /task-1/);
  assert.match(rows, /1\s+succeeded/);
  assert.match(rows, /executor failed/);
  assert.match(rows, /task-2/);
  assert.match(rows, /2\s+running/);
  assert.match(rows, /executor running/);
});

test("task detail view defaults to a clean summary instead of raw JSON", () => {
  const detail = formatTaskDetails({
    id: "20260514-013151-in-mobility-twin-need-a-way-to-retrigger-an-evaluation-of-the-simulation",
    prompt: "Need simulation editor",
    created_at: "2026-05-14T01:31:51.996Z",
    status: "failed",
    mode: "task",
    cwd: "/repo",
    planner_policy: "auto",
    planner_decision: "used",
    planner_reason: "matched tests",
    review_enabled: true,
    active_step: null,
    active_question: null,
    steps: [
      {
        role: "planner",
        provider: "claude",
        status: "failed",
        error: "spawn pclaude ENOENT",
        stdout_path: "/repo/.maestro/runs/task/planner.stdout.log",
        stderr_path: "/repo/.maestro/runs/task/planner.stderr.log",
      },
    ],
  }, { alias: 5 });

  assert.match(detail, /Task 5: in-mobility-twin-need-a-way-to-retrigger-an-evaluation-of-the-simulation/);
  assert.match(detail, /Created: 2026-05-14 01:31/);
  assert.match(detail, /Full id: 20260514-013151-in-mobility/);
  assert.match(detail, /Flow: planner used, review on/);
  assert.match(detail, /planner \(claude\): failed/);
  assert.match(detail, /Use `json 5` for full JSON/);
  assert.doesNotMatch(detail, /"id":/);
});

test("task detail view shows unblock options, pending actions, and broker results", () => {
  const detail = formatTaskDetails({
    id: "20260514-013151-publish-docs",
    prompt: "Publish docs",
    created_at: "2026-05-14T01:31:51.996Z",
    status: "waiting_approval",
    mode: "task",
    cwd: "/repo",
    planner_policy: "off",
    planner_decision: "skipped",
    review_enabled: false,
    unblock_options: [
      { id: "approve-act-1", type: "approve_action", label: "Approve commit", status: "open" },
      { id: "manual-act-1", type: "manual_done", label: "I did it manually", status: "open" },
      { id: "retry-task", type: "retry", label: "Retry", status: "open" },
      { id: "cancel-task", type: "cancel", label: "Cancel", status: "open" },
    ],
    action_requests: [
      {
        id: "act-1",
        provider: "git",
        type: "git_commit",
        status: "pending",
        cwd: "/repo",
        normalized_args: ["commit", "-m", "maestro: publish"],
      },
      {
        id: "act-2",
        provider: "git",
        type: "git_push",
        status: "failed",
        cwd: "/repo",
        normalized_args: ["push", "origin", "main"],
        result: { code: 1, stderr: "permission denied" },
      },
    ],
    interactions: [
      { id: "i1", type: "message", actor: "user", body: "Push after review", created_at: "2026-05-14T01:32:00.000Z" },
    ],
    steps: [],
  }, { alias: 2 });

  assert.match(detail, /Unblock options:/);
  assert.match(detail, /approve-act-1 approve_action: Approve commit/);
  assert.match(detail, /Action requests:/);
  assert.match(detail, /act-1 git_commit pending/);
  assert.match(detail, /Available actions:/);
  assert.match(detail, /\(a\)pprove act-1/);
  assert.match(detail, /\(d\)eny act-1/);
  assert.match(detail, /\(m\)ark-done \[act-1\]/);
  assert.match(detail, /\(r\)etry/);
  assert.match(detail, /\(f\)orce retry/);
  assert.match(detail, /\(c\)ancel/);
  assert.match(detail, /git commit -m maestro: publish/);
  assert.match(detail, /act-2 git_push failed/);
  assert.match(detail, /stderr: permission denied/);
  assert.match(detail, /Messages:/);
  assert.match(detail, /Push after review/);
});

test("inspect renders human sections by default and JSON with --json", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "Inspect task", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_user",
      blockers: [{ code: "agent_timeout", error: "timed out" }],
      unblock_options: [
        { id: "retry-task", type: "retry", label: "Retry", status: "open" },
        { id: "cancel-task", type: "cancel", label: "Cancel", status: "open" },
      ],
      steps: [{ role: "executor", provider: "codex", status: "failed", stderr_path: path.join(dir, "stderr.log") }],
    });
    const human = [];
    await runLocalMaestroCommand({
      args: ["inspect", "--state-dir", store.root, task.id, "--no-color"],
      cwd: dir,
      stdout: { write: (text) => human.push(text) },
      stderr: { write: () => {} },
      store,
    });
    const humanText = human.join("");
    assert.match(humanText, /Summary\n/);
    assert.match(humanText, /\n\nCurrent Blockers\n/);
    assert.match(humanText, /\n\nAvailable Actions\n/);
    assert.match(humanText, /\n\nSteps\n/);
    assert.doesNotMatch(humanText, /^\{/);

    const json = [];
    await runLocalMaestroCommand({
      args: ["inspect", "--state-dir", store.root, task.id, "--json"],
      cwd: dir,
      stdout: { write: (text) => json.push(text) },
      stderr: { write: () => {} },
      store,
    });
    assert.equal(JSON.parse(json.join("")).id, task.id);
  });
});

test("task detail color covers sections labels action ids blockers and paths", () => {
  const detail = formatTaskDetails({
    id: "20260514-120000-color-task",
    status: "waiting_user",
    mode: "task",
    prompt: "Color detail",
    cwd: "/repo",
    blockers: [{ code: "stale_action_request", reason: "head_changed" }],
    action_requests: [{
      id: "act-1",
      provider: "git",
      type: "git_push",
      status: "pending",
      cwd: "/repo",
      normalized_args: ["push", "origin", "main"],
      result: {
        stdout_path: "/repo/.maestro/runs/task/actions/act-1.stdout.log",
      },
    }],
    unblock_options: [{ id: "approve-act-1", type: "approve_action", label: "Approve push", status: "open" }],
    steps: [{ role: "executor", provider: "codex", status: "failed", stderr_path: "/repo/.maestro/runs/task/executor.stderr.log" }],
  }, { color: true, sections: true });

  assert.match(detail, /\u001b\[1mSummary\u001b\[0m/);
  assert.match(detail, /\u001b\[2mStatus:\u001b\[0m/);
  assert.match(detail, /\u001b\[33mact-1\u001b\[0m/);
  assert.match(detail, /\u001b\[31mstale_action_request\u001b\[0m/);
  assert.match(detail, /\u001b\[36m\/repo\/\.maestro\/runs\/task\/actions\/act-1\.stdout\.log\u001b\[0m/);

  const plain = formatTaskDetails({
    id: "task-plain",
    status: "waiting_user",
    prompt: "Plain",
    cwd: "/repo",
  }, { color: false, sections: true });
  assert.doesNotMatch(plain, /\u001b\[/);
});

test("task list filters by view and sorts newest tasks first", () => {
  const tasks = [
    { id: "20260514-100000-succeeded-task", status: "succeeded", mode: "task", steps: [] },
    { id: "20260514-100200-running-task", status: "running", mode: "task", steps: [] },
    { id: "20260514-100100-waiting-task", status: "waiting", mode: "task", steps: [] },
    { id: "20260514-100300-failed-task", status: "failed", mode: "task", steps: [] },
    { id: "20260514-100400-newer-failed-task", status: "failed", mode: "task", steps: [] },
  ];

  assert.deepEqual(filterTasksForView(tasks, "active").map((task) => task.id), [
    "20260514-100200-running-task",
    "20260514-100100-waiting-task",
  ]);
  assert.deepEqual(filterTasksForView(tasks, "all").map((task) => task.id), [
    "20260514-100400-newer-failed-task",
    "20260514-100300-failed-task",
    "20260514-100200-running-task",
    "20260514-100100-waiting-task",
    "20260514-100000-succeeded-task",
  ]);
  assert.deepEqual(filterTasksForView(tasks, "failed").map((task) => task.id), [
    "20260514-100400-newer-failed-task",
    "20260514-100300-failed-task",
  ]);
});

test("task list filters group new lifecycle statuses", () => {
  const tasks = [
    { id: "20260513-120000-queued", status: "queued" },
    { id: "20260513-120100-user", status: "waiting_user" },
    { id: "20260513-120200-approval", status: "waiting_approval" },
    { id: "20260513-120300-blocked", status: "blocked" },
    { id: "20260513-120400-incomplete", status: "incomplete" },
    { id: "20260513-120500-partial", status: "partial_success" },
    { id: "20260513-120600-done", status: "succeeded" },
  ];

  assert.deepEqual(filterTasksForView(tasks, "needs-human").map((task) => task.status), ["waiting_approval", "waiting_user"]);
  assert.deepEqual(filterTasksForView(tasks, "blocked").map((task) => task.status), ["blocked"]);
  assert.deepEqual(filterTasksForView(tasks, "incomplete").map((task) => task.status), ["partial_success", "incomplete"]);
  assert.deepEqual(filterTasksForView(tasks, "done").map((task) => task.status), ["succeeded"]);
  assert.deepEqual(filterTasksForView(tasks, "active").map((task) => task.status), ["waiting_approval", "waiting_user", "queued"]);
});

test("project list and detail views show lifecycle blockers", () => {
  const project = {
    id: "alpha",
    status: "close_blocked",
    target_branch: "main",
    integration_branch: "maestro/alpha/integration",
    tasks: [{ id: "task-1", status: "needs_review" }],
    path_leases: {
      "scripts/maestro.mjs": { task_id: "task-1", mode: "write" },
    },
    blockers: [{ code: "agent_head_moved" }],
    cleanup_blockers: [{ code: "dirty_worktree", task_id: "task-1" }],
  };

  const list = formatProjectList([project]);
  assert.match(list, /#\s+Status\s+Target\s+Project\s+Blockers/);
  assert.match(list, /close_blocked/);
  assert.match(list, /alpha/);
  assert.match(list, /2 blockers/);

  const detail = formatProjectDetails(project, { alias: 1 });
  assert.match(detail, /Integration: maestro\/alpha\/integration/);
  assert.match(detail, /Leases:/);
  assert.match(detail, /scripts\/maestro\.mjs -> task-1/);
  assert.match(detail, /agent_head_moved/);
});

test("task selection accepts numeric aliases and unique id prefixes", () => {
  const tasks = [
    { id: "20260513-120000-first-task" },
    { id: "20260513-120001-second-task" },
  ];

  assert.deepEqual(resolveTaskSelection("1", tasks), {
    action: "select",
    id: "20260513-120000-first-task",
  });
  assert.deepEqual(resolveTaskSelection("#2", tasks), {
    action: "select",
    id: "20260513-120001-second-task",
  });
  assert.deepEqual(resolveTaskSelection("20260513-120001", tasks), {
    action: "select",
    id: "20260513-120001-second-task",
  });
  assert.deepEqual(resolveTaskSelection("20260513", tasks), {
    action: "invalid",
    error: "ambiguous",
  });
  assert.deepEqual(resolveTaskSelection("q", tasks), { action: "back" });
});

test("new task flow asks for the task prompt before showing settings", async () => {
  const answers = [
    "Initial prompt",
    "s",
  ];
  const writes = [];
  const prompts = [];

  const form = await collectNewTaskForm({
    ask: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    },
    output: { write: (text) => writes.push(text) },
    defaults: {
      cwd: "/repo",
      mode: "task",
      timeout_ms: -1,
    },
  });

  assert.equal(prompts[0], "Task prompt: ");
  assert.equal(writes[0].includes("Task draft"), true);
  assert.match(writes[0], /^(\n)?== New Task ==\nTask draft/);
  assert.match(writes[0], /1\. Prompt: Initial prompt/);
  assert.equal(form.prompt, "Initial prompt");
});

test("task draft shows static fields and per-role skips", () => {
  const draft = formatTaskDraft({
    prompt: "Design TUI orchestration",
    cwd: "/repo",
    mode: "task",
    timeout_ms: -1,
    role_skips: { planner: "auto", executor: "never", reviewer: "always" },
  });

  assert.match(draft, /^== New Task ==\nTask draft/);
  assert.match(draft, /1\. Prompt: Design TUI orchestration/);
  assert.match(draft, /planner skip: auto/);
  assert.match(draft, /reviewer skip: always/);
  assert.match(draft, /s\. Submit task/);

  const noSkips = formatTaskDraft({
    prompt: "Fix typo",
    cwd: "/repo",
    mode: "task",
    timeout_ms: -1,
  });

  assert.match(noSkips, /^== New Task ==\nTask draft/);
  assert.match(noSkips, /s\. Submit task/);
  assert.doesNotMatch(noSkips, /skip:/);
});

test("TUI new task asks prompt first then uses a draft picker", async () => {
  const writes = [];
  const prompts = [];
  const submitted = [];
  const answers = [
    "1",
    "Fix label overflow",
    "5",
    "-1",
    "s",
    "q",
  ];
  const store = {
    readConfig: async () => ({
      cwd: "/repo",
      timeout_ms: 3600000,
    }),
    readWorkflow: async () => structuredClone(DEFAULT_WORKFLOW),
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store,
    runTask: async (form) => {
      submitted.push(form);
      return { task: { id: "task-123" } };
    },
    ask: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    },
  });

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].prompt, "Fix label overflow");
  assert.equal(submitted[0].cwd, "/repo");
  assert.equal(submitted[0].mode, "task");
  assert.equal(submitted[0].timeout_ms, -1);
  assert.match(writes.join(""), /Task draft/);
  assert.match(writes.join(""), /s\. Submit task/);
  assert.match(writes.join(""), /Task id: task-123/);
  assert.equal((writes.join("").match(/Task id: task-123/g) ?? []).length, 1);
  assert.ok((writes.join("").match(/1\. New task/g) ?? []).length >= 2);
  assert.equal(prompts.includes("Working directory [/repo]: "), false);
  assert.equal(prompts.includes("Mode task|plan-only [task]: "), false);
  assert.equal(prompts[1], "Task prompt: ");
});

test("TUI new task defaults to the directory used to launch Maestro", async () => {
  const submitted = [];
  const answers = [
    "1",
    "Use caller cwd",
    "s",
    "q",
  ];
  const store = {
    readConfig: async () => ({
      cwd: "/repo/saved-default",
      timeout_ms: 3600000,
    }),
    readWorkflow: async () => structuredClone(DEFAULT_WORKFLOW),
  };

  await runMaestroTui({
    cwd: "/repo/caller",
    stdout: { write: () => {} },
    store,
    runTask: async (form) => {
      submitted.push(form);
      return { task: { id: "task-123" } };
    },
    ask: async () => answers.shift(),
  });

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].cwd, "/repo/caller");
});

test("TUI starts submitted tasks in the background and returns to the main menu", async () => {
  const writes = [];
  const answers = [
    "1",
    "Background task",
    "s",
    "2",
    "q",
    "q",
  ];
  const store = {
    readConfig: async () => ({
      cwd: "/repo",
      timeout_ms: -1,
    }),
    readWorkflow: async () => structuredClone(DEFAULT_WORKFLOW),
    listTasks: async () => [
      {
        id: "task-bg",
        status: "running",
        mode: "task",
        planner_policy: "off",
        planner_decision: "skipped",
        active_step: { role: "executor", provider: "codex", status: "running" },
        steps: [],
      },
    ],
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store,
    runTask: async (_form, callbacks = {}) => {
      callbacks.onTaskCreated({ id: "task-bg" });
      return new Promise(() => {});
    },
    ask: async () => answers.shift(),
  });

  const output = writes.join("");
  assert.match(output, /Task id: task-bg/);
  assert.match(output, /Task started in background/);
  assert.match(output, /task-bg/);
  assert.match(output, /running/);
  assert.ok((output.match(/1\. New task/g) ?? []).length >= 3);
});

test("TUI task form supports per-role skip override", async () => {
  const submitted = [];
  const answers = [
    "1",
    "Design workflow",
    "6",      // field 6 = planner skip (after 5 static fields)
    "always",
    "s",
    "q",
  ];
  const store = {
    readConfig: async () => ({
      cwd: "/repo",
      timeout_ms: -1,
    }),
    readWorkflow: async () => structuredClone(DEFAULT_WORKFLOW),
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: () => {} },
    store,
    runTask: async (form) => {
      submitted.push(form);
      return { task: { id: "task-skip-test", status: "succeeded" } };
    },
    ask: async () => answers.shift(),
  });

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].role_skips?.planner, "always");
  assert.equal(submitted[0].role_skips?.executor, "never");
  assert.equal(submitted[0].role_skips?.reviewer, "auto");
});

test("TUI reports each submitted task id only once when callback and result agree", async () => {
  const writes = [];
  const answers = [
    "1",
    "Quick task",
    "s",
    "q",
  ];
  const store = {
    readConfig: async () => ({ cwd: "/repo", timeout_ms: -1 }),
    readWorkflow: async () => structuredClone(DEFAULT_WORKFLOW),
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store,
    runTask: async (_form, callbacks = {}) => {
      callbacks.onTaskCreated({ id: "task-once" });
      return { task: { id: "task-once", status: "succeeded" } };
    },
    ask: async () => answers.shift(),
  });
  await Promise.resolve();

  assert.equal((writes.join("").match(/Task id: task-once/g) ?? []).length, 1);
  assert.match(writes.join(""), /Task task-once finished: succeeded/);
});

test("local TUI launches tasks in a detached runner so quit does not await agents", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const stdin = new PassThrough();
    const spawned = [];
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    stdin.end("1\nDetached task\n4\noff\n5\noff\ns\nq\n");

    await runLocalMaestroCommand({
      args: ["tui", "--state-dir", store.root],
      cwd: dir,
      stdin,
      stdout: { write: (text) => writes.push(text) },
      stderr: { write: () => {} },
      store,
      spawnProcess: (command, args, options) => {
        const child = new EventEmitter();
        child.unref = () => {
          child.unrefCalled = true;
        };
        spawned.push({ command, args, options, child });
        return child;
      },
    });

    const task = await store.readTask("20260513-123456-detached-task");
    assert.equal(task.status, "queued");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].options.stdio, "ignore");
    assert.equal(spawned[0].child.unrefCalled, true);
    assert.deepEqual(spawned[0].args.slice(-3), ["--state-dir", store.root, task.id]);
    assert.match(writes.join(""), /Task id: 20260513-123456-detached-task/);
    assert.match(writes.join(""), /Task started in background/);
    assert.doesNotMatch(writes.join(""), /finished: queued/);
  });
});

test("TUI settings list displays current values", () => {
  const text = formatSettingsList({
    cwd: "/repo",
    timeout_ms: -1,
  });

  assert.match(text, /^== Settings ==\n/);
  assert.match(text, /1\. Default cwd: \/repo/);
  assert.match(text, /2\. Default timeout ms: -1/);
  assert.match(text, /b\. Back/);
  assert.doesNotMatch(text, /planner/i);
  assert.doesNotMatch(text, /review/i);
});

test("TUI tasks page returns to main menu immediately when no tasks exist", async () => {
  const writes = [];
  const prompts = [];
  const answers = ["2", "q"];
  const store = {
    listTasks: async () => [],
    readTask: async (id) => {
      throw new Error(`readTask should not be called for empty task list: ${id}`);
    },
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store,
    runTask: async () => {},
    ask: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    },
  });

  assert.match(writes.join(""), /No Maestro tasks yet/);
  assert.deepEqual(prompts, ["> ", "> "]);
});

test("TUI renders colored page headers on TTY output", async () => {
  const writes = [];
  const answers = ["q"];
  const originalNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    await runMaestroTui({
      cwd: "/repo",
      stdout: { isTTY: true, write: (text) => writes.push(text) },
      store: {},
      runTask: async () => {},
      ask: async () => answers.shift(),
    });
  } finally {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  }

  assert.match(writes.join(""), /\u001b\[36m\u001b\[1m== Maestro ==\u001b\[0m/);
});

test("TUI tasks page treats q at inspect prompt as back to menu", async () => {
  const writes = [];
  const prompts = [];
  const answers = ["2", "q", "q"];
  const store = {
    listTasks: async () => [{ id: "task-1", status: "running", mode: "task", steps: [] }],
    readTask: async (id) => {
      throw new Error(`readTask should not be called for q/back: ${id}`);
    },
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store,
    runTask: async () => {},
    ask: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    },
  });

  assert.match(writes.join(""), /task-1/);
  assert.deepEqual(prompts, ["> ", "Inspect alias/id, json <alias/id>, filter active|needs-human|blocked|incomplete|failed|done|all, or blank: ", "> "]);
});

test("TUI tasks page resolves numeric aliases when inspecting tasks", async () => {
  const writes = [];
  const answers = ["2", "all", "1", "q", "q"];
  const seen = [];
  const store = {
    listTasks: async () => [
      { id: "task-1", status: "succeeded", mode: "task", steps: [] },
      { id: "task-2", status: "failed", mode: "task", steps: [] },
    ],
    readTask: async (id) => {
      seen.push(id);
      return { id, status: "failed" };
    },
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store,
    runTask: async () => {},
    ask: async () => answers.shift(),
  });

  assert.deepEqual(seen, ["task-2"]);
  assert.match(writes.join(""), /1\s+failed\s+-\s+task-2/);
  assert.match(writes.join(""), /2\s+succeeded\s+-\s+task-1/);
  assert.match(writes.join(""), /Task 1: task-2/);
  assert.match(writes.join(""), /Full id: task-2/);
  assert.doesNotMatch(writes.join(""), /"id": "task-2"/);
});

test("TUI tasks page shows full JSON only when requested", async () => {
  const writes = [];
  const answers = ["2", "all", "json 1", "q", "q"];
  const store = {
    listTasks: async () => [
      { id: "task-1", status: "failed", mode: "task", steps: [] },
    ],
    readTask: async (id) => ({ id, status: "failed", prompt: "Inspect JSON", steps: [] }),
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store,
    runTask: async () => {},
    ask: async () => answers.shift(),
  });

  assert.match(writes.join(""), /"id": "task-1"/);
  assert.match(writes.join(""), /"prompt": "Inspect JSON"/);
});

test("TUI tasks page defaults to active tasks and can switch to all tasks", async () => {
  const writes = [];
  const answers = ["2", "all", "q", "q"];
  const store = {
    listTasks: async () => [
      { id: "done-task", status: "succeeded", mode: "task", steps: [] },
      { id: "waiting-task", status: "waiting", mode: "task", steps: [] },
    ],
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store,
    runTask: async () => {},
    ask: async () => answers.shift(),
  });

  const output = writes.join("");
  assert.match(output, /Tasks \(active, newest first\)/);
  assert.match(output, /Tasks \(all, newest first\)/);
  assert.ok(output.indexOf("Tasks (active, newest first)") < output.indexOf("waiting-task"));
  assert.ok(output.indexOf("done-task") > output.indexOf("Tasks (all, newest first)"));
});

test("TUI tasks page can filter by failed tasks", async () => {
  const writes = [];
  const answers = ["2", "failed", "q", "q"];
  const store = {
    listTasks: async () => [
      { id: "20260514-100000-done-task", status: "succeeded", mode: "task", steps: [] },
      { id: "20260514-100100-fail-task", status: "failed", mode: "task", steps: [] },
      { id: "20260514-100200-run-task", status: "running", mode: "task", steps: [] },
    ],
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store,
    runTask: async () => {},
    ask: async () => answers.shift(),
  });

  const output = writes.join("");
  const failedSection = output.slice(output.indexOf("Tasks (failed, newest first)"));
  assert.match(output, /Tasks \(failed, newest first\)/);
  assert.match(failedSection, /fail-task/);
  assert.doesNotMatch(failedSection, /done-task/);
  assert.doesNotMatch(failedSection, /run-task/);
});

test("TUI projects page lists and inspects project state", async () => {
  const writes = [];
  const answers = ["4", "1", "q", "q"];
  const project = {
    id: "alpha",
    status: "open",
    target_branch: "main",
    integration_branch: "maestro/alpha/integration",
    integration_worktree: "/repo/.maestro/worktrees/alpha/integration",
    tasks: [],
    blockers: [],
    cleanup_blockers: [],
    path_leases: {},
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text), isTTY: false },
    stdin: { isTTY: true },
    ask: async () => answers.shift(),
    store: {
      listProjects: async () => [project],
      readProject: async () => project,
    },
    runTask: async () => {},
  });

  const output = writes.join("");
  assert.match(output, /== Projects ==/);
  assert.match(output, /alpha/);
  assert.match(output, /Integration: maestro\/alpha\/integration/);
});

test("TUI answers waiting task questions by alias and resumes the task", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const resumed = [];
    const answers = ["2", "1", "Use port 5173", "q", "q"];
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const task = await store.createTask({
      prompt: "Need answer",
      mode: "task",
      cwd: dir,
    });
    await store.updateTask(task.id, {
      status: "waiting",
      active_question: {
        id: "q1",
        role: "executor",
        provider: "codex",
        question: "Which port should I use?",
      },
    });

    await runMaestroTui({
      cwd: dir,
      stdout: { write: (text) => writes.push(text) },
      store,
      runTask: async () => {},
      resumeTask: async (selected) => {
        resumed.push(selected.id);
        return { task: selected, detached: true };
      },
      ask: async () => answers.shift(),
    });

    const saved = await store.readTask(task.id);
    assert.deepEqual(resumed, [task.id]);
    assert.equal(saved.status, "queued");
    assert.equal(saved.active_question, null);
    assert.equal(saved.question_answers[0].answer, "Use port 5173");
    assert.match(writes.join(""), /Which port should I use\?/);
    assert.match(writes.join(""), /Receipt: answer saved; task queued/);
    assert.match(writes.join(""), /Task resumed in background/);
  });
});

test("TUI denied legacy active approval renders receipt and refreshed status", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const resumed = [];
    const answers = ["2", "1", "n", "q", "q"];
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const task = await store.createTask({ prompt: "Needs approval", mode: "task", cwd: dir });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      active_approval: {
        id: "ap-1",
        action: "Run deployment",
        reason: "Needs user permission",
      },
    });

    await runMaestroTui({
      cwd: dir,
      stdout: { write: (text) => writes.push(text) },
      store,
      runTask: async () => {},
      resumeTask: async (selected) => {
        resumed.push(selected.id);
        return { task: selected, detached: true };
      },
      ask: async () => answers.shift(),
    });

    const saved = await store.readTask(task.id);
    assert.deepEqual(resumed, [task.id]);
    assert.equal(saved.status, "queued");
    assert.equal(saved.approval_decisions[0].approved, false);
    assert.match(writes.join(""), /Receipt: approval denied; task queued/);
    assert.match(writes.join(""), /Task resumed in background/);
    assert.match(writes.join(""), /Status: queued/);
  });
});

test("TUI typed unblock controls call action callbacks", async () => {
  const cases = [
    { command: "a act-1", callback: "approveAction", expected: { actionId: "act-1" } },
    { command: "x act-1", callback: "runAction", expected: { actionId: "act-1" } },
    { command: "d act-1", callback: "denyAction", expected: { actionId: "act-1" } },
    { command: "m act-1", callback: "markDone", expected: { actionId: "act-1" } },
    { command: "mf act-1", callback: "markDone", expected: { actionId: "act-1", force: true } },
    { command: "r", callback: "retryTask", expected: { forceParallel: false } },
    { command: "f", callback: "retryTask", expected: { forceParallel: true } },
    { command: "i", callback: "messageTask", expected: {} },
    { command: "t", callback: "extendTimeout", expected: { timeoutMs: 9000 } },
    { command: "c", callback: "cancelTask", expected: {} },
  ];

  for (const item of cases) {
    const calls = [];
    const task = {
      id: `task-${item.callback}-${item.command.replace(/\W+/g, "-")}`,
      status: "waiting_approval",
      mode: "task",
      prompt: "Needs action",
      cwd: "/repo",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_push",
        status: "pending",
        cwd: "/repo",
        normalized_args: ["push", "origin", "main"],
      }],
      unblock_options: [
        { id: "approve-act-1", type: "approve_action", label: "Approve", status: "open" },
        { id: "manual-task", type: "manual_done", label: "Manual", status: "open" },
        { id: "retry-task", type: "retry", label: "Retry", status: "open" },
        { id: "timeout-task", type: "extend_timeout", label: "Extend timeout", status: "open" },
        { id: "cancel-task", type: "cancel", label: "Cancel", status: "open" },
      ],
      steps: [],
    };
    const callbacks = {
      approveAction: async (selected, actionId, note) => calls.push({ callback: "approveAction", taskId: selected.id, actionId, note }),
      runAction: async (selected, actionId, note) => calls.push({ callback: "runAction", taskId: selected.id, actionId, note }),
      denyAction: async (selected, actionId, note) => calls.push({ callback: "denyAction", taskId: selected.id, actionId, note }),
      markDone: async (selected, actionId, note, options = {}) => calls.push({ callback: "markDone", taskId: selected.id, actionId, note, force: options.force === true }),
      retryTask: async (selected, note, options) => calls.push({ callback: "retryTask", taskId: selected.id, note, forceParallel: options.forceParallel }),
      messageTask: async (selected, note) => calls.push({ callback: "messageTask", taskId: selected.id, note }),
      extendTimeout: async (selected, timeoutMs, note) => calls.push({ callback: "extendTimeout", taskId: selected.id, timeoutMs, note }),
      cancelTask: async (selected, note) => calls.push({ callback: "cancelTask", taskId: selected.id, note }),
    };
    const answers = item.command === "t"
      ? ["2", "1", item.command, "9000", "typed note", "q", "q", "q"]
      : ["2", "1", item.command, "typed note", "q", "q", "q"];

    await runMaestroTui({
      cwd: "/repo",
      stdout: { write: () => {} },
      store: {
        listTasks: async () => [task],
        readTask: async () => task,
      },
      runTask: async () => {},
      ...callbacks,
      ask: async () => answers.shift(),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].callback, item.callback);
    assert.equal(calls[0].taskId, task.id);
    assert.equal(calls[0].note, "typed note");
    for (const [key, value] of Object.entries(item.expected)) {
      assert.equal(calls[0][key], value);
    }
  }
});

test("TUI host edit updates command, args, env, timeout, and cwd", async () => {
  const calls = [];
  const task = {
    id: "task-host-edit",
    status: "waiting_user",
    mode: "task",
    prompt: "Edit host command",
    cwd: "/repo",
    action_requests: [{
      id: "act-1",
      provider: "host",
      type: "host_command",
      status: "failed",
      cwd: "/repo",
      command: "oldcmd",
      args: ["old"],
      env: {},
      timeout_ms: 1000,
    }],
    unblock_options: [
      { id: "edit-act-1", type: "edit_action", label: "Edit", status: "open" },
      { id: "cancel-task", type: "cancel", label: "Cancel", status: "open" },
    ],
    steps: [],
  };
  const editedTask = {
    ...task,
    action_requests: [{
      ...task.action_requests[0],
      status: "pending",
      command: "printf",
      args: ["ok"],
      env: { MODE: "test" },
      timeout_ms: -1,
      cwd: "/tmp",
    }],
  };
  const answers = [
    "2",
    "1",
    "e act-1",
    "fix host command",
    "printf",
    "[\"ok\"]",
    "{\"MODE\":\"test\"}",
    "-1",
    "/tmp",
    "q",
    "q",
    "q",
  ];
  let currentTask = task;

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: () => {} },
    store: {
      listTasks: async () => [currentTask],
      readTask: async () => currentTask,
    },
    runTask: async () => {},
    editAction: async (selected, actionId, patch, note) => {
      calls.push({ selected, actionId, patch, note });
      currentTask = editedTask;
      return { task: editedTask };
    },
    ask: async () => answers.shift(),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].actionId, "act-1");
  assert.equal(calls[0].note, "fix host command");
  assert.equal(calls[0].patch.provider, "host");
  assert.equal(calls[0].patch.type, "host_command");
  assert.equal(calls[0].patch.command, "printf");
  assert.deepEqual(calls[0].patch.args, ["ok"]);
  assert.deepEqual(calls[0].patch.env, { MODE: "test" });
  assert.equal(calls[0].patch.timeout_ms, -1);
  assert.equal(calls[0].patch.cwd, "/tmp");
});

test("TUI edit-action invalid JSON stays on task detail page", async () => {
  const writes = [];
  const task = {
    id: "task-host-edit-bad-json",
    status: "waiting_user",
    mode: "task",
    prompt: "Edit host command",
    cwd: "/repo",
    action_requests: [{
      id: "act-1",
      provider: "host",
      type: "host_command",
      status: "failed",
      cwd: "/repo",
      command: "oldcmd",
      args: ["old"],
      env: {},
      timeout_ms: 1000,
    }],
    unblock_options: [
      { id: "edit-act-1", type: "edit_action", label: "Edit", status: "open" },
      { id: "cancel-task", type: "cancel", label: "Cancel", status: "open" },
    ],
    steps: [],
  };
  const answers = [
    "2",
    "1",
    "e act-1",
    "try bad json",
    "printf",
    "[bad",
    "q",
    "q",
    "q",
  ];

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store: {
      listTasks: async () => [task],
      readTask: async () => task,
    },
    runTask: async () => {},
    editAction: async () => {
      throw new Error("editAction should not be called for invalid JSON");
    },
    ask: async () => answers.shift(),
  });

  const output = writes.join("");
  assert.match(output, /Invalid JSON/);
  assert.match(output, /Task 1: task-host-edit-bad-json/);
  assert.doesNotMatch(output, /Could not inspect task/);
});

test("TUI task action prompt explains mnemonic aliases", async () => {
  const writes = [];
  const answers = ["2", "1", "", "q", "q"];
  const task = {
    id: "task-needs-action",
    status: "waiting_approval",
    mode: "task",
    prompt: "Needs action",
    cwd: "/repo",
    action_requests: [{
      id: "act-1",
      provider: "git",
      type: "git_push",
      status: "pending",
      cwd: "/repo",
      normalized_args: ["push", "origin", "main"],
    }],
    unblock_options: [
      { id: "approve-act-1", type: "approve_action", label: "Approve", status: "open" },
      { id: "manual-task", type: "manual_done", label: "Manual", status: "open" },
      { id: "retry-task", type: "retry", label: "Retry", status: "open" },
      { id: "cancel-task", type: "cancel", label: "Cancel", status: "open" },
    ],
    steps: [],
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store: {
      listTasks: async () => [task],
      readTask: async () => task,
    },
    runTask: async () => {},
    ask: async (prompt) => {
      writes.push(prompt);
      return answers.shift();
    },
  });

  const output = writes.join("");
  assert.match(output, /Available actions:/);
  assert.match(output, /\(a\)pprove act-1/);
  assert.match(output, /\(x\) run anyway act-1/);
  assert.match(output, /\(e\)dit act-1/);
  assert.match(output, /Action \(a\)pprove <action-id>, \(x\) run anyway <action-id>, \(d\)eny <action-id>, \(e\)dit <action-id>, \(i\)nstruct, \(m\)ark-done \[action-id\], \(mf\)orce mark-done \[action-id\], \(t\)imeout, \(r\)etry, \(f\)orce retry, \(c\)ancel, or blank:/);
});

test("task detail view shows recent approval, denial, retry, and manual notes", () => {
  const detail = formatTaskDetails({
    id: "task-notes",
    status: "waiting_user",
    prompt: "Inspect notes",
    cwd: "/repo",
    interactions: [
      { type: "approval", actor: "user", action_id: "act-1", approved: true, body: "commit locally" },
      { type: "approval", actor: "user", action_id: "act-2", approved: false, body: "do not push" },
      { type: "retry", actor: "user", body: "try after env fix", force_parallel: true },
      { type: "manual_done", actor: "user", action_id: "act-3", body: "pushed manually" },
    ],
    steps: [],
  });

  assert.match(detail, /Recent notes:/);
  assert.match(detail, /approval approved act-1: commit locally/);
  assert.match(detail, /approval denied act-2: do not push/);
  assert.match(detail, /retry force: try after env fix/);
  assert.match(detail, /manual_done act-3: pushed manually/);
});

test("TUI deny-action note detaches continuation and refreshes task detail", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const spawned = [];
    let runnerCalls = 0;
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const task = await store.createTask({ prompt: "Commit current changes", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_commit",
        status: "pending",
        cwd: dir,
        normalized_args: ["commit", "-m", "maestro: test"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(" M package.json\n"),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
      }],
      unblock_options: [{ id: "approve-act-1", type: "approve_action", label: "Approve commit", status: "open" }],
    });
    const stdin = new PassThrough();
    stdin.end("2\n1\nd act-1\nDo not commit; explain only.\n\nq\nq\n");

    const result = await Promise.race([
      runLocalMaestroCommand({
        args: ["tui", "--state-dir", store.root],
        cwd: dir,
        stdin,
        stdout: { write: (text) => writes.push(text) },
        stderr: { write: () => {} },
        store,
        runner: {
          runStep: async () => {
            runnerCalls += 1;
            return new Promise(() => {});
          },
        },
        spawnProcess: (command, args, options) => {
          const child = new EventEmitter();
          child.unref = () => {
            child.unrefCalled = true;
          };
          spawned.push({ command, args, options, child });
          return child;
        },
        gitRunner: createFakeGitRunner({ dirtyByCwd: { [dir]: " M package.json\n" } }).run,
      }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);

    const saved = await store.readTask(task.id);
    const output = writes.join("");
    assert.notEqual(result, "timeout");
    assert.equal(runnerCalls, 0);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].child.unrefCalled, true);
    assert.deepEqual(spawned[0].args.slice(-3), ["--state-dir", store.root, task.id]);
    assert.equal(saved.status, "queued");
    assert.equal(saved.action_requests[0].status, "denied");
    assert.match(saved.continuation_prompt, /Do not commit; explain only\./);
    assert.match(output, /Denied act-1\./);
    assert.match(output, /Task resumed in background\./);
    assert.match(output, /Recent notes:/);
    assert.match(output, /approval denied act-1: Do not commit; explain only\./);
    assert.match(output, /Status: queued/);
  });
});

test("TUI approve-action note commits once, detaches continuation, and does not append push approval", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const spawned = [];
    let runnerCalls = 0;
    const git = createFakeGitRunner({
      dirtyByCwd: { [dir]: " M package.json\n" },
      commitHead: "head-after-commit",
    });
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const task = await store.createTask({ prompt: "Commit then push current changes", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_commit",
        status: "pending",
        cwd: dir,
        normalized_args: ["commit", "-m", "maestro: test"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(" M package.json\n"),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
      }],
      unblock_options: [{ id: "approve-act-1", type: "approve_action", label: "Approve commit", status: "open" }],
    });
    const stdin = new PassThrough();
    stdin.end("2\n1\na act-1\nCommit locally; do not push.\n\nq\nq\n");

    const result = await Promise.race([
      runLocalMaestroCommand({
        args: ["tui", "--state-dir", store.root],
        cwd: dir,
        stdin,
        stdout: { write: (text) => writes.push(text) },
        stderr: { write: () => {} },
        store,
        runner: {
          runStep: async () => {
            runnerCalls += 1;
            return new Promise(() => {});
          },
        },
        spawnProcess: (command, args, options) => {
          const child = new EventEmitter();
          child.unref = () => {
            child.unrefCalled = true;
          };
          spawned.push({ command, args, options, child });
          return child;
        },
        gitRunner: git.run,
      }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);

    const saved = await store.readTask(task.id);
    assert.notEqual(result, "timeout");
    assert.equal(runnerCalls, 0);
    assert.equal(spawned.length, 1);
    assert.equal(git.calls.filter((call) => call.args[0] === "commit").length, 1);
    assert.equal(git.calls.filter((call) => call.args[0] === "push").length, 0);
    assert.deepEqual(saved.action_requests.map((request) => `${request.type}:${request.status}`), ["git_commit:succeeded"]);
    assert.equal(saved.status, "queued");
    assert.match(saved.continuation_prompt, /Commit locally; do not push\./);
    assert.match(writes.join(""), /Approved act-1\./);
    assert.match(writes.join(""), /Task resumed in background\./);
    assert.doesNotMatch(writes.join(""), /git_push pending/);
  });
});

test("TUI stale approve-action renders not-run receipt and refreshed blockers", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const spawned = [];
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const task = await store.createTask({ prompt: "Commit current changes", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_commit",
        status: "pending",
        cwd: dir,
        normalized_args: ["commit", "-m", "maestro: test"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(" M package.json\n"),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
      }],
      unblock_options: [{ id: "approve-act-1", type: "approve_action", label: "Approve commit", status: "open" }],
    });
    const stdin = new PassThrough();
    stdin.end("2\n1\na act-1\n\nq\nq\n");

    const result = await Promise.race([
      runLocalMaestroCommand({
        args: ["tui", "--state-dir", store.root],
        cwd: dir,
        stdin,
        stdout: { write: (text) => writes.push(text) },
        stderr: { write: () => {} },
        store,
        runner: { runStep: async () => { throw new Error("should not run"); } },
        spawnProcess: (command, args, options) => {
          const child = new EventEmitter();
          child.unref = () => {};
          spawned.push({ command, args, options, child });
          return child;
        },
        gitRunner: createFakeGitRunner({
          dirtyByCwd: { [dir]: " M package.json\n" },
          headByCwd: { [dir]: ["head-2"] },
        }).run,
      }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);

    const saved = await store.readTask(task.id);
    const output = writes.join("");
    assert.notEqual(result, "timeout");
    assert.equal(spawned.length, 0);
    assert.equal(saved.status, "waiting_user");
    assert.equal(saved.blockers[0].code, "stale_action_request");
    assert.match(output, /Receipt: action act-1 not run: head_changed/);
    assert.match(output, /Current Blockers/);
    assert.match(output, /stale_action_request/);
    assert.match(output, /Status: waiting_user/);
    assert.doesNotMatch(output, /Approved act-1/);
  });
});

test("TUI retry and force-retry detach continuation and refresh task detail", async () => {
  for (const item of [
    { command: "r", note: "try again", force: false, expected: /Retry queued\./ },
    { command: "f", note: "force it", force: true, expected: /Force retry queued\./ },
  ]) {
    await withTempDir(async (dir) => {
      const writes = [];
      const spawned = [];
      let runnerCalls = 0;
      const store = new LocalTaskStore({
        root: path.join(dir, ".maestro"),
        clock: () => new Date("2026-05-13T12:34:56.000Z"),
      });
      const task = await store.createTask({ prompt: `Retry ${item.command}`, cwd: dir, plannerPolicy: "off", reviewEnabled: false });
      await store.updateTask(task.id, {
        status: "waiting_user",
        blockers: [{ code: "stale_running_task" }],
        unblock_options: [
          { id: "retry-task", type: "retry", label: "Retry", status: "open" },
          { id: "cancel-task", type: "cancel", label: "Cancel", status: "open" },
        ],
      });
      const stdin = new PassThrough();
      stdin.end(`2\n1\n${item.command}\n${item.note}\n\nq\nq\n`);

      const result = await Promise.race([
        runLocalMaestroCommand({
          args: ["tui", "--state-dir", store.root],
          cwd: dir,
          stdin,
          stdout: { write: (text) => writes.push(text) },
          stderr: { write: () => {} },
          store,
          runner: {
            runStep: async () => {
              runnerCalls += 1;
              return new Promise(() => {});
            },
          },
          spawnProcess: (command, args, options) => {
            const child = new EventEmitter();
            child.unref = () => {
              child.unrefCalled = true;
            };
            spawned.push({ command, args, options, child });
            return child;
          },
          gitRunner: createFakeGitRunner().run,
        }),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
      ]);

      const saved = await store.readTask(task.id);
      assert.notEqual(result, "timeout");
      assert.equal(runnerCalls, 0);
      assert.equal(spawned.length, 1);
      assert.equal(saved.status, "queued");
      assert.equal(saved.interactions.at(-1).type, "retry");
      assert.equal(saved.interactions.at(-1).force_parallel, item.force);
      assert.match(writes.join(""), item.expected);
      assert.match(writes.join(""), /Task resumed in background\./);
      assert.match(writes.join(""), /Recent notes:/);
      assert.match(writes.join(""), item.force ? /retry force: force it/ : /retry: try again/);
      assert.match(writes.join(""), /Status: queued/);
    });
  }
});

test("TUI mark-done detaches continuation after manual validation succeeds", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const spawned = [];
    let runnerCalls = 0;
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    const task = await store.createTask({ prompt: "Publish after manual push", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "git",
        type: "git_push",
        status: "pending",
        cwd: dir,
        normalized_args: ["push", "origin", "main"],
        expected_branch: "main",
        expected_head: "head-1",
        expected_status_hash: statusHash(""),
        expected_remote_url: "git@example.com:repo.git",
        continuation_generation: 0,
      }],
      unblock_options: [{ id: "manual-act-1", type: "manual_done", label: "I pushed manually", status: "open" }],
    });
    const stdin = new PassThrough();
    stdin.end("2\n1\nm act-1\nPushed manually.\n\nq\nq\n");

    const result = await Promise.race([
      runLocalMaestroCommand({
        args: ["tui", "--state-dir", store.root],
        cwd: dir,
        stdin,
        stdout: { write: (text) => writes.push(text) },
        stderr: { write: () => {} },
        store,
        runner: {
          runStep: async () => {
            runnerCalls += 1;
            return new Promise(() => {});
          },
        },
        spawnProcess: (command, args, options) => {
          const child = new EventEmitter();
          child.unref = () => {
            child.unrefCalled = true;
          };
          spawned.push({ command, args, options, child });
          return child;
        },
        gitRunner: createFakeGitRunner().run,
      }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);

    const saved = await store.readTask(task.id);
    assert.notEqual(result, "timeout");
    assert.equal(runnerCalls, 0);
    assert.equal(spawned.length, 1);
    assert.equal(saved.status, "queued");
    assert.equal(saved.action_requests[0].status, "succeeded");
    assert.match(saved.continuation_prompt, /Pushed manually\./);
    assert.match(writes.join(""), /Manual completion checked\./);
    assert.match(writes.join(""), /Task resumed in background\./);
    assert.match(writes.join(""), /manual_done act-1: Pushed manually\./);
  });
});

test("TUI tasks page reports missing task aliases without crashing", async () => {
  const writes = [];
  const answers = ["2", "9", "q", "q"];
  const store = {
    listTasks: async () => [{ id: "task-1", status: "running", mode: "task", steps: [] }],
    readTask: async () => {
      throw new Error("readTask should not be called for invalid alias");
    },
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store,
    runTask: async () => {},
    ask: async () => answers.shift(),
  });

  assert.match(writes.join(""), /Could not find task alias\/id 9/);
});

test("TUI invalid main menu choices do not quit the application", async () => {
  const writes = [];
  const answers = ["wat", "q"];

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store: {},
    runTask: async () => {},
    ask: async () => answers.shift(),
  });

  const output = writes.join("");
  assert.match(output, /Unknown menu choice/);
  assert.ok((output.match(/1\. New task/g) ?? []).length >= 2);
});

test("TUI task submission failure stays in the TUI instead of crashing", async () => {
  const writes = [];
  const answers = [
    "1",
    "Fix label overflow",
    "s",
    "q",
  ];
  const store = {
    readConfig: async () => ({ cwd: "/repo", timeout_ms: -1 }),
    readWorkflow: async () => structuredClone(DEFAULT_WORKFLOW),
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store,
    runTask: async () => {
      const error = new Error("agent_failed: codex exited with 2");
      error.taskId = "task-fail";
      throw error;
    },
    ask: async () => answers.shift(),
  });

  assert.match(writes.join(""), /Task id: task-fail/);
  assert.match(writes.join(""), /Task task-fail failed: agent_failed: codex exited with 2/);
  assert.ok((writes.join("").match(/1\. New task/g) ?? []).length >= 2);
});

test("TUI reports background task failures after returning to the menu", async () => {
  const writes = [];
  const answers = [
    "1",
    "Fail in background",
    "s",
    "q",
  ];
  const store = {
    readConfig: async () => ({ cwd: "/repo", timeout_ms: -1 }),
    readWorkflow: async () => structuredClone(DEFAULT_WORKFLOW),
  };

  await runMaestroTui({
    cwd: "/repo",
    stdout: { write: (text) => writes.push(text) },
    store,
    runTask: async (_form, callbacks = {}) => {
      callbacks.onTaskCreated({ id: "task-fail-bg" });
      await Promise.resolve();
      const error = new Error("agent_failed: codex exited with 2");
      error.taskId = "task-fail-bg";
      throw error;
    },
    ask: async () => answers.shift(),
  });
  await Promise.resolve();

  assert.match(writes.join(""), /Task id: task-fail-bg/);
  assert.match(writes.join(""), /Task task-fail-bg failed: agent_failed: codex exited with 2/);
});

test("TUI settings picker updates cwd and timeout", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const answers = [
      "3",       // Settings
      "1",       // Default cwd
      "/newdir",
      "2",       // Default timeout ms
      "7200000",
      "b",       // Back
      "q",
    ];
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });

    await runMaestroTui({
      cwd: dir,
      stdout: { write: (text) => writes.push(text) },
      store,
      runTask: async () => {},
      ask: async () => answers.shift(),
    });

    const config = await store.readConfig();
    assert.equal(config.cwd, "/newdir");
    assert.equal(config.timeout_ms, 7200000);
    assert.match(writes.join(""), /== Settings ==\n1\. Default cwd/);
    assert.match(writes.join(""), /Setting saved/);
  });
});

test("TUI settings menu shows roles and providers entries", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const answers = [
      "3",   // Settings
      "b",   // Back
      "q",
    ];
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });

    await runMaestroTui({
      cwd: dir,
      stdout: { write: (text) => writes.push(text) },
      store,
      runTask: async () => {},
      ask: async () => answers.shift(),
    });

    const output = writes.join("");
    assert.match(output, /== Settings ==/);
    assert.match(output, /Default cwd/);
    assert.match(output, /Roles & workflow/);
    assert.match(output, /Providers/);
    assert.doesNotMatch(output, /Default Claude plan/);
    assert.doesNotMatch(output, /Default Codex review/);
  });
});

test("TUI settings picker handles piped input for basic settings", async () => {
  await withTempDir(async (dir) => {
    const stdin = new PassThrough();
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    // Navigate: Settings (3) → cwd (1) → /newdir → timeout (2) → 1800000 → back (b) → quit (q)
    stdin.end("3\n1\n/newdir\n2\n1800000\nb\nq\n");

    await runMaestroTui({
      cwd: dir,
      stdin,
      stdout: { write: () => {} },
      store,
      runTask: async () => {},
    });

    const config = await store.readConfig();
    assert.equal(config.cwd, "/newdir");
    assert.equal(config.timeout_ms, 1800000);
  });
});

test("local task CLI uses custom codex command from TUI settings", async (t) => {
  // Force the spawn backend: CI runners have no herdr binary, and this test
  // exercises command building, not the herdr integration.
  const prevBackend = process.env.MAESTRO_BACKEND;
  process.env.MAESTRO_BACKEND = "terminal";
  t.after(() => {
    if (prevBackend === undefined) delete process.env.MAESTRO_BACKEND;
    else process.env.MAESTRO_BACKEND = prevBackend;
  });
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({
      root: path.join(dir, ".maestro"),
      clock: () => new Date("2026-05-13T12:34:56.000Z"),
    });
    await store.writeConfig({
      cwd: dir,
      planner_policy: "off",
      review_enabled: false,
      timeout_ms: -1,
      claude_command: "pclaude",
      codex_command: "true",
      executor_model: "gpt-5.5",
    });

    await runLocalMaestroCommand({
      args: ["task", "--state-dir", store.root, "Smoke custom codex command"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
    });

    const command = JSON.parse(await readFile(path.join(
      store.runDir("20260513-123456-smoke-custom-codex-command"),
      "executor.command.json",
    ), "utf8"));
    assert.equal(command.command, "true");
    assert.deepEqual(command.args.slice(command.args.indexOf("--model"), command.args.indexOf("--model") + 2), ["--model", "gpt-5.5"]);
  });
});

test("Maestro CLI agent README documents usage and safety defaults", async () => {
  const text = await readFile(new URL("../docs/maestro-cli-agents.md", import.meta.url), "utf8");
  const review = await readFile(new URL("../docs/maestro-tui-review.md", import.meta.url), "utf8");

  assert.match(text, /npm run maestro -- task/);
  assert.match(text, /Claude plans/);
  assert.match(text, /Codex executes/);
  assert.match(text, /\.maestro\/runs/);
  assert.match(text, /Copilot is disabled/);
  assert.match(text, /npm run maestro -- tui/);
  assert.match(text, /Submit task/);
  assert.match(text, /resolved\s+agent-flow preview/);
  assert.match(text, /colored header/);
  assert.match(text, /NO_COLOR/);
  assert.match(text, /detached background runner/);
  assert.match(text, /human-readable created\s+timestamps/);
  assert.match(text, /timestamp prefix/);
  assert.match(text, /sorted newest first/);
  assert.match(text, /`active`, `needs-human`, `blocked`, `incomplete`, `failed`, `done`, or `all`/);
  assert.match(text, /MAESTRO_REVIEW/);
  assert.match(text, /json 1/);
  assert.match(text, /MAESTRO_QUESTION/);
  assert.match(text, /active question/);
  assert.match(text, /question answers/);
  assert.match(text, /retry <task-id> --force-parallel/);
  assert.match(text, /mark-done <task-id> \[action-id\]/);
  assert.match(text, /run-action <task-id> <action-id>/);
  assert.match(text, /edit-action <task-id> <action-id>/);
  assert.match(text, /manual_done_ambiguous/);
  assert.match(text, /manual_verified_local_state/);
  assert.match(text, /Commit-then-push/);
  assert.match(text, /brokered sequentially/);
  assert.match(text, /host_command/);
  assert.match(text, /external_cwd_git/);
  assert.match(text, /stdout\/stderr log paths/);
  assert.match(text, /git_push:\s+\["push", remote, branchOrHEAD\]/);
  assert.match(text, /refspec mapping/);
  assert.match(text, /\(a\)pprove <action-id>/);
  assert.match(text, /\(x\) run outside sandbox <action-id>/);
  assert.match(text, /\(e\)dit <action-id>/);
  assert.match(text, /\(i\)nstruct/);
  assert.match(text, /\(f\)orce retry/);
  assert.match(text, /missing task branch\/worktree/);
  assert.match(text, /defaults to active\s+tasks/);
  assert.match(text, /Skip Claude planner/);
  assert.match(text, /bash functions, or bash\s+aliases/);
  assert.match(text, /interactive bash fallback/);
  assert.match(text, /numeric aliases/);
  assert.match(text, /unique id prefix/);
  assert.match(text, /Claude plan: auto/);
  assert.match(text, /-1 disables timeout/);
  assert.match(text, /stderr.log/);
  assert.match(text, /claude_command/);
  assert.match(text, /codex_command/);
  assert.match(text, /planner_model/);
  assert.match(text, /claude_effort/);
  assert.match(text, /executor_model/);
  assert.match(text, /executor_effort/);
  assert.match(text, /reviewer_model/);
  assert.match(text, /reviewer_effort/);
  assert.match(text, /sonnet/);
  assert.match(text, /xhigh/);
  assert.match(text, /gpt-5.3-codex/);
  assert.match(review, /Responsiveness/);
  assert.match(review, /Page Orientation/);
  assert.match(review, /TUI page headers/);
  assert.match(review, /detached `run-task` child process/);
  assert.match(review, /Task Identity Reliability/);
  assert.match(review, /compact table/);
  assert.match(review, /sorts newest tasks first/);
  assert.match(review, /needs-human`, `blocked`, `incomplete`, `failed`, `done/);
  assert.match(review, /Reviewer Outcome Control/);
  assert.match(review, /Raw JSON remains available/);
  assert.match(review, /Planner Availability/);
  assert.match(review, /User Question Flow/);
  assert.match(review, /Task List Defaults/);
  assert.match(review, /Large Prompt Reliability/);
});

// ── Regression tests for evaluation-plan fixes ────────────────────────────────

test("R1: malformed MAESTRO_HANDOFF line returns null instead of throwing", () => {
  // Previously _handoffFromText did a bare JSON.parse → throws on bad JSON.
  assert.equal(parseAgentHandoff("MAESTRO_HANDOFF:{bad json"), null);
  assert.equal(parseAgentHandoff("MAESTRO_HANDOFF:"), null);
  assert.equal(parseAgentHandoff("MAESTRO_HANDOFF:not-json-at-all!!"), null);
  // Well-formed handoff still parses correctly.
  assert.deepEqual(parseAgentHandoff('MAESTRO_HANDOFF:{"ok":true}'), { ok: true });
  assert.deepEqual(parseAgentHandoff("no marker here"), null);
});

test("SF4: REVIEW_MAX_CONTINUATIONS is exported from markers.mjs and equals 1", () => {
  // Previously duplicated in markers.mjs, engine.mjs, nodes.mjs — now single source.
  assert.equal(REVIEW_MAX_CONTINUATIONS, 1);
});

test("S1: host_command is rejected when config has no host_command_allow", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    // No writeConfig call → host_command_allow defaults to []
    const task = await store.createTask({ prompt: "Run host command", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "host",
        type: "host_command",
        status: "pending",
        cwd: dir,
        command: "printf",
        args: ["should-not-run"],
        env: {},
        continuation_generation: 0,
      }],
    });

    const result = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: createFakeGitRunner().run,
    });

    // Should be blocked with host_command_not_allowed, NOT succeeded
    const request = result.task.action_requests[0];
    assert.equal(request.status, "pending");
    assert.notEqual(result.task.status, "succeeded");
  });
});

test("S1: host_command with non-allowlisted binary is rejected even with an allowlist", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.writeConfig({ host_command_allow: ["echo"] }); // only echo, not printf
    const task = await store.createTask({ prompt: "Run host command", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.updateTask(task.id, {
      status: "waiting_approval",
      action_requests: [{
        id: "act-1",
        provider: "host",
        type: "host_command",
        status: "pending",
        cwd: dir,
        command: "printf",       // not in allowlist
        args: ["blocked"],
        env: {},
        continuation_generation: 0,
      }],
    });

    const result = await runLocalMaestroCommand({
      args: ["approve-action", "--state-dir", store.root, task.id, "act-1"],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
      gitRunner: createFakeGitRunner().run,
    });

    const request = result.task.action_requests[0];
    assert.equal(request.status, "pending"); // not run
  });
});

test("S2: canonicalizeActionRequestsForTask strips LD_PRELOAD, PATH, and GIT_SSH_COMMAND from env", () => {
  // sanitizeEnvObject is called during action-request canonicalization (agent output → store).
  // Dangerous env keys must be stripped before the request is stored or executed.
  const task = { id: "t1", cwd: "/tmp", continuation_generation: 0, action_requests: [] };
  const incoming = [{
    provider: "host",
    type: "host_command",
    status: "pending",
    cwd: "/tmp",
    command: "printf",
    args: ["ok"],
    env: {
      SAFE_VAR: "allowed",
      LD_PRELOAD: "/evil.so",
      PATH: "/evil/bin",
      GIT_SSH_COMMAND: "evil-ssh",
      NODE_OPTIONS: "--require evil",
      BASH_ENV: "/evil/rc",
      DYLD_INSERT_LIBRARIES: "/evil.dylib",
    },
  }];

  const { action_requests } = canonicalizeActionRequestsForTask(task, incoming);
  assert.equal(action_requests.length, 1);
  const storedEnv = action_requests[0].env;

  // Dangerous keys must be stripped
  assert.equal("LD_PRELOAD" in storedEnv, false, "LD_PRELOAD should be stripped");
  assert.equal("PATH" in storedEnv, false, "PATH should be stripped");
  assert.equal("GIT_SSH_COMMAND" in storedEnv, false, "GIT_SSH_COMMAND should be stripped");
  assert.equal("NODE_OPTIONS" in storedEnv, false, "NODE_OPTIONS should be stripped");
  assert.equal("BASH_ENV" in storedEnv, false, "BASH_ENV should be stripped");
  assert.equal("DYLD_INSERT_LIBRARIES" in storedEnv, false, "DYLD_INSERT_LIBRARIES should be stripped");
  // Safe key should pass through
  assert.equal(storedEnv.SAFE_VAR, "allowed");
});

test("CLI: unknown subcommand rejects with cli_usage and scoped help", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-cli-usage-"));
  try {
    await assert.rejects(
      runLocalMaestroCommand({ args: ["project", "creat", "--state-dir", dir], cwd: dir }),
      (error) => {
        assert.equal(error.code, "cli_usage");
        assert.match(error.cliHelp, /Did you mean: create\?/);
        assert.match(error.cliHelp, /Usage: maestro project <subcommand>/);
        return true;
      },
    );
    await assert.rejects(
      runLocalMaestroCommand({ args: ["setup", "--state-dir", dir], cwd: dir }),
      (error) => error.code === "cli_usage" && /missing subcommand/.test(error.cliHelp),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── multi-workflow store (SP0a) ───────────────────────────────────────────────

test("isValidWorkflowName accepts and rejects per the spec regex", () => {
  for (const ok of ["default", "solo", "a", "a_b-c", "a".repeat(64)]) {
    assert.equal(isValidWorkflowName(ok), true, `expected ${ok} valid`);
  }
  for (const bad of ["Default", "_x", "-x", "", "a".repeat(65), "a/b", "a.b"]) {
    assert.equal(isValidWorkflowName(bad), false, `expected ${JSON.stringify(bad)} invalid`);
  }
  assert.ok(WORKFLOW_NAME_RE.test("default"));
  assert.equal(DEFAULT_WORKFLOW_NAME, "default");
});

test("readWorkflow returns a clone of DEFAULT_WORKFLOW when no files exist", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const wf = await store.readWorkflow();
    assert.deepEqual(wf, DEFAULT_WORKFLOW);
    assert.notEqual(wf, DEFAULT_WORKFLOW);
  });
});

test("readWorkflow resolves the legacy workflow.json as default", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    await writeFile(store.workflowPath, JSON.stringify({ ...DEFAULT_WORKFLOW, initial: "executor" }));
    assert.equal((await store.readWorkflow()).initial, "executor");
    assert.equal((await store.readWorkflow("default")).initial, "executor");
  });
});

test("readWorkflow resolves workflows/default.json", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    await mkdir(store.workflowsDir, { recursive: true });
    await writeFile(store.workflowFilePath("default"), JSON.stringify({ ...DEFAULT_WORKFLOW, initial: "reviewer" }));
    assert.equal((await store.readWorkflow("default")).initial, "reviewer");
  });
});

test("readWorkflow precedence: workflows/default.json wins and warns", async () => {
  await withTempDir(async (dir) => {
    const warnings = [];
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro"), onWarn: (m) => warnings.push(m) });
    await store.init();
    await writeFile(store.workflowPath, JSON.stringify({ ...DEFAULT_WORKFLOW, initial: "legacy_wins" }));
    await mkdir(store.workflowsDir, { recursive: true });
    await writeFile(store.workflowFilePath("default"), JSON.stringify({ ...DEFAULT_WORKFLOW, initial: "named_wins" }));
    assert.equal((await store.readWorkflow("default")).initial, "named_wins");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /workflow_precedence/);
  });
});

test("onWarn fires only when both default sources exist", async () => {
  await withTempDir(async (dir) => {
    const warnings = [];
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro"), onWarn: (m) => warnings.push(m) });
    await store.init();
    await writeFile(store.workflowPath, JSON.stringify(DEFAULT_WORKFLOW));
    await store.readWorkflow("default");
    assert.equal(warnings.length, 0);
  });
});

test("readWorkflow reads named workflows; missing non-default returns null", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    await mkdir(store.workflowsDir, { recursive: true });
    await writeFile(store.workflowFilePath("solo"), JSON.stringify({ ...DEFAULT_WORKFLOW, initial: "executor" }));
    assert.equal((await store.readWorkflow("solo")).initial, "executor");
    assert.equal(await store.readWorkflow("missing"), null);
  });
});

test("readWorkflow throws on a bad name", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await assert.rejects(() => store.readWorkflow("Bad"), /invalid_workflow_name/);
  });
});

test("writeWorkflow named write round-trips deep-equal", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const written = await store.writeWorkflow("solo", { initial: "executor" });
    const readBack = await store.readWorkflow("solo");
    assert.deepEqual(readBack, written);
    assert.equal(readBack.initial, "executor");
  });
});

test("writeWorkflow legacy single-arg still updates the default slot", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.writeWorkflow({ initial: "executor" });
    assert.equal((await store.readWorkflow()).initial, "executor");
    // Default stays on the legacy path (no forced migration).
    assert.ok((await readFile(store.workflowPath, "utf8")).length > 0);
  });
});

test("writeWorkflow rejects a bad name", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await assert.rejects(() => store.writeWorkflow("Bad", {}), /invalid_workflow_name/);
  });
});

test("listWorkflows: empty store has nothing", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    assert.deepEqual(await store.listWorkflows(), []);
  });
});

test("listWorkflows: mixed named + legacy default", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    await writeFile(store.workflowPath, JSON.stringify(DEFAULT_WORKFLOW));
    await store.writeWorkflow("solo", { initial: "executor" });
    const list = await store.listWorkflows();
    assert.deepEqual(list.map((w) => w.name), ["default", "solo"]);
    assert.equal(list.find((w) => w.name === "default").source, "legacy");
    assert.equal(list.find((w) => w.name === "solo").source, "named");
  });
});

test("listWorkflows: skips non-json and invalid-stem files", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    await mkdir(store.workflowsDir, { recursive: true });
    await store.writeWorkflow("solo", { initial: "executor" });
    await writeFile(path.join(store.workflowsDir, "README.md"), "not a workflow");
    await writeFile(path.join(store.workflowsDir, "Bad Name.json"), "{}");
    const list = await store.listWorkflows();
    assert.deepEqual(list.map((w) => w.name), ["solo"]);
  });
});

test("listWorkflows: both default sources dedupe to a single named default", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.init();
    await writeFile(store.workflowPath, JSON.stringify(DEFAULT_WORKFLOW));
    await mkdir(store.workflowsDir, { recursive: true });
    await writeFile(store.workflowFilePath("default"), JSON.stringify(DEFAULT_WORKFLOW));
    const list = await store.listWorkflows();
    const defaults = list.filter((w) => w.name === "default");
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].source, "named");
  });
});

test("store.applyWorkflowTemplate writes a named slot from a template", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const result = await store.applyWorkflowTemplate({ name: "solo", as: "fast" });
    assert.equal(result.as, "fast");
    const wf = await store.readWorkflow("fast");
    assert.deepEqual(Object.keys(wf.roles), ["executor"]);
  });
});

test("store.applyWorkflowTemplate rejects unknown template + bad target name", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await assert.rejects(() => store.applyWorkflowTemplate({ name: "nope" }), /unknown_workflow_template/);
    await assert.rejects(() => store.applyWorkflowTemplate({ name: "solo", as: "Bad" }), /invalid_workflow_name/);
  });
});

test("createTask records workflow field with default + validation", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "x" });
    assert.equal(task.workflow, "default");
    const readBack = await store.readTask(task.id);
    assert.equal(readBack.workflow, "default");
    const solo = await store.createTask({ prompt: "y", workflow: "solo" });
    assert.equal(solo.workflow, "solo");
    await assert.rejects(() => store.createTask({ prompt: "z", workflow: "Bad" }), /invalid_workflow_name/);
  });
});

// ── SP6a: `maestro events <id> [--json]` ─────────────────────────────────────

test("events command lists one projected stage_event per step", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "do work", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.appendStep(task.id, {
      role: "planner", provider: "claude", model: "claude-opus", tokens: 120,
      status: "succeeded", started_at: "2026-06-15T00:00:00.000Z",
      stdout_path: "/runs/planner.out", handoff_path: "/runs/planner.json",
    });
    await store.appendStep(task.id, {
      role: "scoring", provider: "scoring", status: "succeeded",
      started_at: "2026-06-15T00:00:01.000Z",
    });
    const output = [];
    const result = await runLocalMaestroCommand({
      args: ["events", "--state-dir", store.root, task.id],
      cwd: dir,
      stdout: { write: (text) => output.push(text) },
      stderr: { write: () => {} },
      store,
    });
    assert.equal(result.events.length, 2);
    assert.deepEqual(result.events.map((e) => e.stage), ["planner", "scoring"]);
    const text = output.join("");
    assert.match(text, /planner/);
    assert.match(text, /claude-opus/);
    assert.match(text, /scoring/);
  });
});

test("events --json emits a valid stage_event array", async () => {
  await withTempDir(async (dir) => {
    const { validatePayload } = await import("../src/schemas/index.mjs");
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "do work", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.appendStep(task.id, {
      role: "executor", provider: "codex", model: "gpt", tokens: 50,
      status: "succeeded", started_at: "2026-06-15T00:00:00.000Z",
    });
    const output = [];
    await runLocalMaestroCommand({
      args: ["events", "--state-dir", store.root, task.id, "--json"],
      cwd: dir,
      stdout: { write: (text) => output.push(text) },
      stderr: { write: () => {} },
      store,
    });
    const events = JSON.parse(output.join(""));
    assert.ok(Array.isArray(events));
    assert.equal(events.length, 1);
    for (const event of events) {
      assert.ok(validatePayload("stage_event", event).ok, JSON.stringify(event));
    }
    assert.equal(events[0].model, "gpt");
    assert.equal(events[0].tokens, 50);
  });
});

// ── SP6b: `maestro artifacts` + `maestro events --all` ───────────────────────

test("artifacts lists a run's files and reads one with --tail / --json", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "do work", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    const runDir = store.runDir(task.id);
    await mkdir(runDir, { recursive: true });
    const stdoutContent = `${"y".repeat(50)}STDOUT-TAIL`;
    await writeFile(path.join(runDir, "implementation.stdout.log"), stdoutContent);
    await writeFile(path.join(runDir, "handoff.implementation.json"), JSON.stringify({ ok: true }));

    // list
    const listOut = [];
    const listResult = await runLocalMaestroCommand({
      args: ["artifacts", "--state-dir", store.root, task.id],
      cwd: dir,
      stdout: { write: (t) => listOut.push(t) },
      stderr: { write: () => {} },
      store,
    });
    assert.equal(listResult.entries.length, 2);
    assert.match(listOut.join(""), /implementation\.stdout\.log/);

    // read with --tail (bounded)
    const tailOut = [];
    await runLocalMaestroCommand({
      args: ["artifacts", "--state-dir", store.root, task.id, "implementation.stdout", "--tail"],
      cwd: dir,
      stdout: { write: (t) => tailOut.push(t) },
      stderr: { write: () => {} },
      store,
    });
    assert.match(tailOut.join(""), /STDOUT-TAIL/);

    // --json metadata is valid
    const jsonOut = [];
    await runLocalMaestroCommand({
      args: ["artifacts", "--state-dir", store.root, task.id, "implementation.handoff", "--json"],
      cwd: dir,
      stdout: { write: (t) => jsonOut.push(t) },
      stderr: { write: () => {} },
      store,
    });
    const entry = JSON.parse(jsonOut.join(""));
    assert.equal(entry.kind, "handoff");
    assert.equal(entry.role, "implementation");

    // bad selector → clean error, never a traversal
    await assert.rejects(
      () => runLocalMaestroCommand({
        args: ["artifacts", "--state-dir", store.root, task.id, "../escape"],
        cwd: dir,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        store,
      }),
      /unknown_artifact/,
    );
  });
});

test("events --all queries the materialised table with filters; events <id> stays the live projection", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    const task = await store.createTask({ prompt: "do work", cwd: dir, plannerPolicy: "off", reviewEnabled: false });
    await store.appendStep(task.id, {
      role: "executor", provider: "codex", model: "gpt", status: "succeeded",
      started_at: "2026-06-15T00:00:00.000Z",
    });

    // Seed the events table directly (the engine seam does this in production).
    const db = new SqliteTaskStore(path.join(store.root, "maestro.db"));
    try {
      await db.replaceStageEvents(task.id, [
        { workflow_id: "default", stage: "scoring", model: "m", tokens: 1, duration_ms: 1, status: "succeeded", artifacts: [] },
        { workflow_id: "default", stage: "review", model: "m", tokens: 1, duration_ms: 1, status: "failed", artifacts: [] },
      ]);
    } finally {
      db.close();
    }

    const allOut = [];
    const allResult = await runLocalMaestroCommand({
      args: ["events", "--state-dir", store.root, "--all", "--stage", "scoring", "--json"],
      cwd: dir,
      stdout: { write: (t) => allOut.push(t) },
      stderr: { write: () => {} },
      store,
    });
    assert.equal(allResult.events.length, 1);
    assert.equal(allResult.events[0].stage, "scoring");
    const parsed = JSON.parse(allOut.join(""));
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed[0].task_id, task.id);

    // events <id> is still the live projection over the task's steps.
    const liveResult = await runLocalMaestroCommand({
      args: ["events", "--state-dir", store.root, task.id],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      store,
    });
    assert.equal(liveResult.events.length, 1);
    assert.equal(liveResult.events[0].stage, "executor");
  });
});
