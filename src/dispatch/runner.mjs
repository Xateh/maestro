// DispatchRunner — the server-mode bridge that runs each Linear issue through
// the SAME workflow.json LangGraph engine the CLI/TUI use. It implements the
// interface MaestroOrchestrator expects (`run({ issue })`, `cancel(issueId)`):
// per issue it creates a Maestro task seeded from the issue and runs it via the
// exact `maestro task` path (createLocalTaskFromParsed → runCreatedLocalTask),
// then optionally writes the issue's terminal state back to Linear.

import { nullLogger } from "../logger.mjs";
import { renderPrompt } from "../workflow.mjs";

import { defaultGitRunner } from "../cli/git-exec.mjs";
import { createLocalTaskFromParsed, runCreatedLocalTask } from "../cli/tasks-run.mjs";
import { normalizeProjectId } from "../cli/parse-args.mjs";

// A stdout sink that pings onActivity on every write (keeps the orchestrator's
// liveness timestamp fresh) and discards output. Mirrors enough of a stream for
// runCreatedLocalTask (write + isTTY).
function activitySink(onActivity) {
  return {
    isTTY: false,
    write() {
      onActivity?.();
      return true;
    },
  };
}

export class DispatchRunner {
  constructor({
    taskStore,
    tracker,
    dispatch,
    cwd = process.cwd(),
    gitRunner = defaultGitRunner,
    logger = nullLogger(),
    runner = null, // optional engine runner injection (tests)
  }) {
    this.taskStore = taskStore;
    this.tracker = tracker;
    this.dispatch = dispatch;
    this.cwd = cwd;
    this.gitRunner = gitRunner;
    this.logger = logger;
    this.runner = runner;
    this.issueTasks = new Map(); // issueId -> taskId (dispatch once per issue)
    this.cancelled = new Set();
  }

  async buildPrompt(issue) {
    if (this.dispatch.promptTemplate) {
      return renderPrompt(this.dispatch.promptTemplate, { issue });
    }
    const body = [issue.title, issue.description].filter(Boolean).join("\n\n");
    const ref = `(Linear issue ${issue.identifier}${issue.url ? ` — ${issue.url}` : ""})`;
    return body ? `${body}\n\n${ref}` : ref;
  }

  // Throws on infra failure (task creation / git) → orchestrator backoff retry.
  // Returns { status } for task-level outcomes (succeeded/failed/waiting_*) →
  // orchestrator records it and leaves the issue claimed (no busy-retry).
  async run({ issue, onActivity = null }) {
    let taskId = this.issueTasks.get(issue.id);
    if (!taskId) {
      const defaults = await this.taskStore.readConfig();
      const worktreeMode = this.dispatch.worktreeMode ?? "current-cwd";
      const projectId = worktreeMode === "new-project"
        ? normalizeProjectId(issue.identifier)
        : null;
      const task = await createLocalTaskFromParsed({
        parsed: {
          prompt: await this.buildPrompt(issue),
          mode: "task",
          worktreeMode,
          projectId,
        },
        taskStore: this.taskStore,
        defaults,
        cwd: this.cwd,
        gitRunner: this.gitRunner,
        stdout: activitySink(onActivity),
      });
      taskId = task.id;
      this.issueTasks.set(issue.id, taskId);
      this.logger.info("dispatch_task_created", { issue_identifier: issue.identifier, task_id: taskId });
    }

    const sink = activitySink(onActivity);
    const result = await runCreatedLocalTask({
      taskStore: this.taskStore,
      taskId,
      cwd: this.cwd,
      stdout: sink,
      stderr: sink,
      runner: this.runner,
      gitRunner: this.gitRunner,
    });
    const status = result.task?.status ?? "succeeded";
    await this.applyTransition(issue, status);
    return { status, task_id: taskId };
  }

  async applyTransition(issue, status) {
    const tracker = this.dispatch.tracker;
    let target = null;
    if (status === "succeeded" && tracker.doneState) {
      target = tracker.doneState;
    } else if ((status === "waiting_user" || status === "waiting_approval") && tracker.blockedState) {
      target = tracker.blockedState;
    }
    if (!target) return;
    try {
      await this.tracker.transitionIssue(issue.id, target);
      this.logger.info("dispatch_issue_transitioned", { issue_identifier: issue.identifier, state: target });
    } catch (error) {
      this.logger.warn("dispatch_transition_failed", {
        issue_identifier: issue.identifier,
        state: target,
        error: error.message,
      });
    }
  }

  // Foreground task runs can't be killed mid-flight; record intent so we stop
  // tracking the issue. The task itself is bounded by its per-step timeout_ms.
  cancel(issueId) {
    this.cancelled.add(issueId);
    this.issueTasks.delete(issueId);
    return true;
  }
}
