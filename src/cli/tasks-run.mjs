import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandRunner } from "../command-runner.mjs";
import { regressionStore } from "../regression-corpus.mjs";
import { runLangGraphTask } from "../langgraph/engine.mjs";
import { evaluatePlannerDecision } from "../router.mjs";
import { buildRunSummary, formatRunSummary } from "../run-summary.mjs";
import { slugifyTaskTitle } from "../task-store.mjs";

import {
  buildNextGitActionRequestForTask,
  buildUnblockOptions,
  canonicalizeActionRequestsForTask,
  hasResolvedGitIntent,
} from "./action-requests.mjs";
import { blockUnsupportedGitAction } from "./action-validate.mjs";
import { runGit } from "./git-exec.mjs";
import { detectGitPublishIntent, gitPublishBlockerForTask } from "./git-intent.mjs";
import { normalizeProjectId, normalizeWritePaths } from "./parse-args.mjs";
import {
  acquirePathLeases,
  addProjectTaskRecord,
  assertBranchUnused,
  conflictingLeases,
  createProject,
  finalizeProjectTask,
  markProjectTaskStatus,
  recordProjectBlocker,
  releasePathLeases,
  taskAliasForProject,
} from "./projects.mjs";
import { REVIEW_MAX_CONTINUATIONS, nowIso, sanitizeReviewString, writeLine } from "./util.mjs";

// Detached children must re-enter through bin/maestro.mjs (not this module) so
// they pick up the warning suppressor and workspace resolution.
const BIN_ENTRY = fileURLToPath(new URL("../../bin/maestro.mjs", import.meta.url));

export async function createLocalTaskFromParsed({ parsed, taskStore, defaults, cwd, gitRunner, stdout = process.stdout }) {
  let projectId = parsed.projectId;
  let worktreeMode = parsed.worktreeMode ?? defaults.worktree_mode_default ?? "auto";
  const writePaths = normalizeWritePaths(parsed.writePaths ?? []);
  if (worktreeMode === "auto") {
    worktreeMode = projectId ? "project-worktree" : "current-cwd";
  }
  if (worktreeMode === "new-project" && !projectId) {
    projectId = normalizeProjectId(parsed.prompt);
    await createProject({ taskStore, id: projectId, target: null, cwd, stdout, gitRunner });
    worktreeMode = "project-worktree";
  }

  let taskCwd = path.resolve(cwd, parsed.taskCwd ?? defaults.cwd);
  let branch = null;
  let worktreePath = null;
  let pathConflict = null;
  let project = null;

  if (projectId) {
    project = await taskStore.readProject(projectId);
    if (writePaths.length > 0) {
      const conflicts = conflictingLeases(project, writePaths);
      if (conflicts.length > 0 && !parsed.forceParallel) {
        pathConflict = { conflicts };
      }
    }
    if (!pathConflict && worktreeMode === "project-worktree") {
      const alias = taskAliasForProject(project, parsed.prompt);
      branch = `maestro/${project.id}/task/${alias}`;
      await assertBranchUnused({ gitRunner, cwd, branch });
      worktreePath = path.join(project.worktree_root, project.id, alias);
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      await runGit(gitRunner, cwd, ["worktree", "add", "-b", branch, worktreePath, project.integration_branch]);
      taskCwd = worktreePath;
    }
  }

  const timeoutMs = parsed.timeoutMs ?? defaults.timeout_ms;
  const roleSkips = parsed.roleSkips ?? null;
  // Derive legacy plannerPolicy/reviewEnabled from roleSkips if provided; else fall back to config
  let plannerPolicy = parsed.plannerPolicy ?? defaults.planner_policy;
  let reviewEnabled = parsed.reviewEnabled ?? defaults.review_enabled;
  if (roleSkips) {
    const ps = roleSkips.planner;
    if (ps === "always") plannerPolicy = "off";
    else if (ps === "never") plannerPolicy = "on";
    else plannerPolicy = "auto";
    reviewEnabled = roleSkips.reviewer !== "always";
  }
  const plannerDecision = evaluatePlannerDecision({
    plannerPolicy,
    prompt: parsed.prompt,
    mode: parsed.mode,
  });
  const task = await taskStore.createTask({
    prompt: parsed.prompt,
    mode: parsed.mode,
    workflow: parsed.workflow ?? "default",
    cwd: taskCwd,
    plannerPolicy,
    plannerDecision: plannerDecision.decision,
    plannerReason: plannerDecision.reason,
    reviewEnabled,
    ...(roleSkips ? { role_skips: roleSkips } : {}),
    timeoutMs,
    streamTailBytes: defaults.stream_tail_bytes,
    contextRetryLimit: defaults.context_retry_limit,
    claudeCommand: defaults.claude_command,
    codexCommand: defaults.codex_command,
    plannerModel: defaults.planner_model,
    claudeEffort: defaults.claude_effort,
    executorModel: defaults.executor_model,
    executorEffort: defaults.executor_effort,
    reviewerModel: defaults.reviewer_model,
    reviewerEffort: defaults.reviewer_effort,
    projectId,
    worktreeMode,
    branch,
    worktreePath,
    writePaths,
    pathConflict,
  });

  if (projectId && pathConflict) {
    return taskStore.updateTask(task.id, {
      status: "waiting_user",
      blockers: [{
        code: "queued_path_conflict",
        conflicts: pathConflict.conflicts,
      }],
      unblock_options: buildUnblockOptions({ task, includeRetry: true }).filter((option) => ["retry", "cancel"].includes(option.type)),
    });
  }
  if (projectId) {
    await acquirePathLeases(taskStore, projectId, task.id, writePaths);
    project = await taskStore.readProject(projectId);
    await addProjectTaskRecord(taskStore, project, {
      id: task.id,
      alias: branch ? branch.split("/").at(-1) : slugifyTaskTitle(parsed.prompt),
      branch,
      worktree_path: worktreePath,
      write_paths: writePaths,
      status: "queued",
    });
  }
  return task;
}

export async function recoverStaleRunningTasks(taskStore) {
  const config = await taskStore.readConfig();
  const staleAfterMs = Number.isInteger(config.stale_after_ms) ? config.stale_after_ms : 300_000;
  const now = Date.now();
  const tasks = await taskStore.listTasks();
  const recovered = [];
  for (const task of tasks) {
    if (task.status !== "running") {
      recovered.push(task);
      continue;
    }
    const updatedAt = Date.parse(task.updated_at ?? task.created_at ?? "");
    if (!Number.isFinite(updatedAt) || now - updatedAt < staleAfterMs) {
      recovered.push(task);
      continue;
    }
    const updated = await taskStore.updateTask(task.id, {
      status: "waiting_user",
      active_step: null,
      blockers: [
        { code: "stale_running_task", stale_after_ms: staleAfterMs, last_updated_at: task.updated_at ?? null },
        ...(task.blockers ?? []),
      ],
      unblock_options: buildUnblockOptions({ task, includeRetry: true }).filter((option) => ["retry", "cancel"].includes(option.type)),
    });
    await markProjectTaskStatus(taskStore, updated, "waiting_user");
    recovered.push(updated);
  }
  return recovered;
}

// Shared graph-engine invocation used by CLI, MCP (spawn), and the dispatch
// server (via TaskGraphRunner) so every entry point builds the ops bundle and
// calls runLangGraphTask identically.
export async function runTaskGraph({ taskStore, taskId, stdout, stderr, runner = null, gitRunner, availabilityProbe = null }) {
  return runLangGraphTask(taskId, {
    taskStore,
    maestroRoot: taskStore.root,
    runner,
    stdout,
    stderr,
    gitRunner,
    availabilityProbe,
    ops: {
      buildUnblockOptions,
      canonicalizeActionRequestsForTask,
      releasePathLeases: (t) => releasePathLeases(taskStore, t),
      markProjectTaskStatus: (t, s, p) => markProjectTaskStatus(taskStore, t, s, p),
      recordProjectBlocker: (pid, b) => recordProjectBlocker(taskStore, pid, b),
      finalizeProjectTask: (t) => finalizeProjectTask({ taskStore, task: t, gitRunner, stdout }),
      gitRunner,
      commandRunner,
      regressionStore,
    },
  });
}

export async function runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner, availabilityProbe = null }) {
  let currentTask = await taskStore.readTask(taskId);
  const continuationPrompt = currentTask.continuation_prompt
    ? sanitizeReviewString(currentTask.continuation_prompt)
    : "";
  if (!continuationPrompt && currentTask.status === "waiting_approval" && (currentTask.action_requests ?? []).some((request) => request.status === "pending")) {
    writeLine(stdout, `task ${currentTask.id} waiting for action approval`);
    return { task: currentTask };
  }
  if (currentTask.status === "queued_path_conflict" || currentTask.path_conflict) {
    currentTask = await taskStore.updateTask(currentTask.id, {
      status: "waiting_user",
      active_step: null,
      unblock_options: buildUnblockOptions({ task: currentTask, includeRetry: true }).filter((option) => ["retry", "cancel"].includes(option.type)),
      blockers: currentTask.blockers?.length
        ? currentTask.blockers
        : [{ code: "queued_path_conflict", conflicts: currentTask.path_conflict?.conflicts ?? [] }],
    });
    writeLine(stdout, `task ${currentTask.id} waiting: path conflict`);
    return { task: currentTask };
  }
  const gitPublishBlocker = gitPublishBlockerForTask(currentTask);
  const gitIntent = detectGitPublishIntent(currentTask.prompt);
  if (!continuationPrompt && gitPublishBlocker && !hasResolvedGitIntent(currentTask, gitIntent)) {
    await releasePathLeases(taskStore, currentTask);
    if (currentTask.project_id) {
      await markProjectTaskStatus(taskStore, currentTask, "waiting_approval", { blocker: gitPublishBlocker });
      await recordProjectBlocker(taskStore, currentTask.project_id, {
        ...gitPublishBlocker,
        task_id: currentTask.id,
      });
    }
    const taskCwd = path.resolve(cwd, currentTask.cwd ?? ".");
    const actionRequest = await buildNextGitActionRequestForTask({ task: currentTask, taskCwd, gitRunner });
    if (!actionRequest) {
      currentTask = await blockUnsupportedGitAction({ taskStore, task: currentTask, blocker: gitPublishBlocker, stderr });
      return { task: currentTask };
    }
    currentTask = await taskStore.updateTask(taskId, {
      status: "waiting_approval",
      active_step: null,
      blockers: [gitPublishBlocker],
      action_requests: [
        ...(currentTask.action_requests ?? []),
        actionRequest,
      ],
      unblock_options: buildUnblockOptions({ task: currentTask, actionRequests: [actionRequest] }),
      review: {
        status: "system",
        completion_state: "incomplete_needs_approval",
        required_action: "request_approval",
        risk_level: "high",
        confidence: "high",
        summary: "Git host action requires explicit Maestro approval.",
        evidence: [],
        blockers: [gitPublishBlocker],
        continuation_attempts: 0,
        max_continuations: REVIEW_MAX_CONTINUATIONS,
        action_requests: [actionRequest],
        unblock_options: buildUnblockOptions({ task: currentTask, actionRequests: [actionRequest] }),
        decided_at: nowIso(),
      },
    });
    writeLine(stdout, `task ${taskId} waiting for git action approval (${gitPublishBlocker.operations.join(", ")})`);
    return { task: currentTask };
  }
  currentTask = await taskStore.updateTask(taskId, { status: "running" });
  const result = await runTaskGraph({
    taskStore,
    taskId,
    stdout,
    stderr,
    runner,
    gitRunner,
    availabilityProbe,
  });
  if ((result.task?.steps ?? []).length > 0) {
    writeLine(stdout, formatRunSummary(await buildRunSummary(result.task), { color: stdout.isTTY === true }));
  }
  return result;
}

export async function startDetachedLocalTask({
  form,
  cwd,
  taskStore,
  spawnProcess,
  onTaskCreated,
  gitRunner,
}) {
  const defaults = await taskStore.readConfig();
  const task = await createLocalTaskFromParsed({
    parsed: {
      mode: form.mode,
      workflow: form.workflow ?? "default",
      prompt: form.prompt,
      taskCwd: form.cwd,
      timeoutMs: form.timeout_ms,
      roleSkips: form.role_skips ?? null,
      projectId: form.project_id,
      worktreeMode: form.worktree_mode,
      writePaths: form.write_paths,
    },
    taskStore,
    defaults,
    cwd,
    gitRunner,
  });
  if (onTaskCreated) {
    onTaskCreated(task);
  }
  startDetachedExistingTask({
    task,
    cwd,
    taskStore,
    spawnProcess,
  });
  return { task, detached: true };
}

export function startDetachedExistingTask({
  task,
  cwd,
  taskStore,
  spawnProcess,
}) {
  const child = spawnProcess(process.execPath, [
    BIN_ENTRY,
    "run-task",
    "--state-dir",
    taskStore.root,
    task.id,
  ], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  if (child && typeof child.unref === "function") {
    child.unref();
  }
  return { task, detached: true };
}

export function resumeQueuedTask({
  task,
  taskStore,
  taskId = task?.id,
  cwd,
  stdout,
  stderr,
  runner,
  gitRunner,
  availabilityProbe = null,
  resumeMode = "foreground",
  spawnProcess = spawn,
}) {
  if (task?.status !== "queued") return { task };
  if (resumeMode === "detached") {
    return startDetachedExistingTask({
      task,
      cwd,
      taskStore,
      spawnProcess,
    });
  }
  return runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner, availabilityProbe });
}
