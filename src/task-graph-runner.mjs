// TaskGraphRunner — adapts the tracker→issue dispatch loop onto the LangGraph
// task engine. It implements the orchestrator runner contract:
//   run({ issue, attempt, continuation, onActivity }) -> { status, metrics? }
//   cancel(issueId)
//
// For each tracker issue the runner locates-or-creates a single graph task
// (idempotent via the `source_issue_id` field), runs it through the shared
// `runTask` (runTaskGraph) bundle, and maps the graph task status back onto the
// orchestrator's runner statuses:
//   succeeded / done             -> succeeded
//   waiting_user / waiting_approval -> succeeded + continuation (orchestrator re-polls)
//   failed / engine_error        -> throw (so the orchestrator retries with backoff)
//
// `cancel` is bookkeeping-only (decision SP0b#3): an in-flight graph run is left
// to finish; real mid-run engine cancellation is deferred to SP6.

import { nullLogger } from "./logger.mjs";
import { renderPrompt } from "./setup/server-config.mjs";

const SUCCEEDED_STATUSES = new Set(["succeeded", "done"]);
const CONTINUATION_STATUSES = new Set(["waiting_user", "waiting_approval"]);
const FAILED_STATUSES = new Set(["failed", "engine_error"]);

export class TaskGraphRunner {
  constructor({
    taskStore,
    serverConfig,
    workspaceManager,
    runTask,
    gitRunner = null,
    availabilityProbe = null,
    logger = nullLogger(),
    stdout = process.stdout,
    stderr = process.stderr,
  }) {
    if (typeof runTask !== "function") {
      throw new Error("TaskGraphRunner requires a runTask function");
    }
    this.taskStore = taskStore;
    this.serverConfig = serverConfig;
    this.workspaceManager = workspaceManager;
    this.runTask = runTask;
    this.gitRunner = gitRunner;
    this.availabilityProbe = availabilityProbe;
    this.logger = logger;
    this.stdout = stdout;
    this.stderr = stderr;
    // issueId -> taskId; bookkeeping only (decision SP0b#3).
    this.byIssue = new Map();
  }

  async locateTask(issueId) {
    const tasks = await this.taskStore.listTasks();
    return tasks.find((task) => task.source_issue_id === issueId) ?? null;
  }

  // `continuation` is part of the orchestrator runner contract (re-poll vs first
  // dispatch) but the graph engine resumes from persisted task state regardless,
  // so the locate-or-create + runTask path is identical either way.
  async run({ issue, attempt = 0, continuation: _continuation = false, onActivity } = {}) {
    let task = await this.locateTask(issue.id);
    if (!task) {
      const workspace = await this.workspaceManager.createForIssue(issue.identifier);
      const prompt = await renderPrompt(this.serverConfig.intakeTemplate, { issue, attempt });
      task = await this.taskStore.createTask({
        workflow: this.serverConfig.workflow,
        mode: "task",
        prompt,
        // LocalTaskStore.createTask reads the camelCase `sourceIssueId` param and
        // persists it as the flat `source_issue_id` field. Pass both so the
        // located task round-trips through either the real store or a test stub.
        sourceIssueId: issue.id,
        source_issue_id: issue.id,
        cwd: workspace.path,
      });
    }
    this.byIssue.set(issue.id, task.id);

    const result = await this.runTask(task.id, {
      taskStore: this.taskStore,
      cwd: task.cwd,
      stdout: this.stdout,
      stderr: this.stderr,
      gitRunner: this.gitRunner,
      availabilityProbe: this.availabilityProbe,
      onActivity,
    });

    const status = result?.task?.status ?? "engine_error";
    if (FAILED_STATUSES.has(status)) {
      const error = new Error(`graph_task_${status}`);
      error.code = status;
      throw error;
    }

    const metrics = result?.task?.metrics ?? undefined;
    if (CONTINUATION_STATUSES.has(status)) {
      return { status: "succeeded", continuation: true, metrics };
    }
    if (SUCCEEDED_STATUSES.has(status)) {
      return { status: "succeeded", metrics };
    }
    // Unknown status: treat conservatively as a failure so the orchestrator retries.
    const error = new Error(`graph_task_unknown_status_${status}`);
    error.code = "engine_error";
    throw error;
  }

  cancel(issueId) {
    // Bookkeeping-only: forget the issue→task mapping. An in-flight graph run is
    // left to finish; the orchestrator clears its own running/completed maps.
    this.byIssue.delete(issueId);
  }
}
