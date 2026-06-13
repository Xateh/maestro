import { spawn } from "node:child_process";

import { executeApprovedAction } from "./action-execute.mjs";
import {
  actionableActionRequests,
  buildUnblockOptions,
  canApproveAction,
  taskHasBlocker,
} from "./action-requests.mjs";
import { settleActionGate, validateManualDoneObservation } from "./action-validate.mjs";
import { defaultHostRunner } from "./git-exec.mjs";
import { gitTypeForActionRequest, normalizeActionRequest } from "./git-intent.mjs";
import {
  acquirePathLeases,
  currentPathConflicts,
  ensureProjectTaskSetup,
  finalizeProjectTask,
  markProjectTaskStatus,
  releasePathLeases,
} from "./projects.mjs";
import { attachReceipt, feedbackReceipt, openNextActions, withReceipt } from "./receipts.mjs";
import { resumeQueuedTask } from "./tasks-run.mjs";
import { writeLine } from "./util.mjs";

export async function handleApproveAction({
  taskStore,
  taskId,
  actionId,
  note = "",
  cwd,
  stdout,
  stderr,
  runner,
  gitRunner,
  hostRunner = defaultHostRunner,
  allowExternalCwd = false,
  bypassFreshness = false,
  resumeMode = "foreground",
  spawnProcess = spawn,
}) {
  const execution = await executeApprovedAction({
    taskStore,
    taskId,
    actionId,
    note,
    cwd,
    gitRunner,
    hostRunner,
    stdout,
    stderr,
    allowExternalCwd,
    bypassFreshness,
  });
  if (execution.task.status === "queued") {
    const resumed = await resumeQueuedTask({
      task: execution.task,
      taskStore,
      taskId,
      cwd,
      stdout,
      stderr,
      runner,
      gitRunner,
      hostRunner,
      resumeMode,
      spawnProcess,
    });
    return attachReceipt(resumed, execution.receipt);
  }
  return execution;
}

export async function handleRunAction({
  taskStore,
  taskId,
  actionId,
  note = "",
  cwd,
  stdout,
  stderr,
  runner,
  gitRunner,
  hostRunner = defaultHostRunner,
  resumeMode = "foreground",
  spawnProcess = spawn,
}) {
  return handleApproveAction({
    taskStore,
    taskId,
    actionId,
    note,
    cwd,
    stdout,
    stderr,
    runner,
    gitRunner,
    hostRunner,
    allowExternalCwd: true,
    bypassFreshness: true,
    resumeMode,
    spawnProcess,
  });
}

export async function handleDenyAction({
  taskStore,
  taskId,
  actionId,
  note = "",
  cwd,
  stdout,
  stderr,
  runner,
  gitRunner,
  resumeMode = "foreground",
  spawnProcess = spawn,
}) {
  const task = await taskStore.readTask(taskId);
  const statusBefore = task.status ?? null;
  const request = (task.action_requests ?? []).find((item) => item.id === actionId);
  if (!request) throw new Error(`unknown_action_request: ${actionId}`);
  const requests = (task.action_requests ?? []).map((item) => (
    item.id === actionId
      ? { ...item, status: "denied", result: { code: null, stdout: "", stderr: note } }
      : item
  ));
  await taskStore.appendInteraction(taskId, {
    type: "approval",
    actor: "user",
    body: note,
    action_id: actionId,
    approved: false,
  });
  const continuationPrompt = [
    `Action request denied: ${request.type}`,
    `Action id: ${actionId}`,
    note ? `Denial note: ${note}` : null,
    "Do not repeat this host action unless the user explicitly approves it later.",
  ].filter(Boolean).join("\n");
  const updated = await taskStore.incrementContinuationGeneration(taskId, {
    status: "queued",
    active_step: null,
    active_approval: null,
    action_requests: requests,
    blockers: [],
    unblock_options: [],
    continuation_prompt: continuationPrompt,
  });
  await markProjectTaskStatus(taskStore, updated, "queued", { action_requests: requests });
  writeLine(stdout, `task ${taskId} action ${actionId} denied`);
  const result = await resumeQueuedTask({
    task: updated,
    taskStore,
    taskId,
    cwd,
    stdout,
    stderr,
    runner,
    gitRunner,
    resumeMode,
    spawnProcess,
  });
  return attachReceipt(result, feedbackReceipt({
    kind: "deny-action",
    message: `action ${actionId} denied`,
    executed: false,
    statusBefore,
    statusAfter: result.task?.status,
    actionId,
  }));
}

export async function handleEditAction({
  taskStore,
  taskId,
  actionId,
  patch = {},
  note = "",
  stdout,
}) {
  let task = await taskStore.readTask(taskId);
  const statusBefore = task.status ?? null;
  const request = (task.action_requests ?? []).find((item) => item.id === actionId);
  if (!request) throw new Error(`unknown_action_request: ${actionId}`);
  const edited = normalizeActionRequest({
    ...request,
    ...patch,
    status: "pending",
    result: null,
    continuation_generation: task.continuation_generation ?? 0,
  });
  if (edited.provider === "git" && edited.type === "external_cwd_git" && !edited.git_type) {
    edited.git_type = request.git_type || gitTypeForActionRequest(request);
  }
  await taskStore.appendInteraction(taskId, {
    type: "edit_action",
    actor: "user",
    body: note,
    action_id: actionId,
  });
  const requests = (task.action_requests ?? []).map((item) => (
    item.id === actionId ? edited : item
  ));
  task = await taskStore.updateTask(taskId, {
    status: "waiting_user",
    active_step: null,
    active_approval: null,
    action_requests: requests,
    unblock_options: buildUnblockOptions({
      task: { ...task, action_requests: requests },
      actionRequests: requests.filter((item) => item.status === "pending"),
      includeRetry: true,
      includeManualDone: true,
    }),
  });
  await markProjectTaskStatus(taskStore, task, "waiting_user", { action_requests: requests });
  writeLine(stdout, `task ${taskId} action ${actionId} edited`);
  return withReceipt(task, feedbackReceipt({
    kind: "edit-action",
    message: `action ${actionId} edited`,
    executed: false,
    statusBefore,
    statusAfter: task.status,
    actionId,
    nextActions: openNextActions(task),
  }));
}

export async function handleRetryTask({
  taskStore,
  taskId,
  note = "",
  forceParallel = false,
  cwd,
  stdout,
  stderr,
  runner,
  gitRunner,
  resumeMode = "foreground",
  spawnProcess = spawn,
}) {
  let task = await taskStore.appendInteraction(taskId, {
    type: "retry",
    actor: "user",
    body: note,
    force_parallel: forceParallel,
  });
  const statusBefore = task.status ?? null;
  if (taskHasBlocker(task, "task_merge_conflict")) {
    const retrying = await taskStore.incrementContinuationGeneration(taskId, {
      status: "queued",
      active_question: null,
      active_approval: null,
      unblock_options: [],
      continuation_prompt: note ? `Retry project finalize:\n${note}` : "Retry project finalize.",
    });
    const finalized = await finalizeProjectTask({ taskStore, task: retrying, gitRunner, stdout });
    if (finalized.status === "waiting_user") {
      writeLine(stdout, `task ${task.id} finalize still waiting`);
      return withReceipt(finalized, feedbackReceipt({
        kind: "retry",
        message: "retry not queued: finalize still waiting",
        executed: false,
        statusBefore,
        statusAfter: finalized.status,
        reason: "finalize_still_waiting",
      }));
    }
    const updated = await taskStore.updateTask(taskId, {
      status: "succeeded",
      active_step: null,
      blockers: (finalized.blockers ?? []).filter((blocker) => blocker.code !== "task_merge_conflict"),
      unblock_options: [],
      continuation_prompt: null,
    });
    await markProjectTaskStatus(taskStore, updated, "succeeded");
    writeLine(stdout, `task ${task.id} finalize retry succeeded`);
    return withReceipt(updated, feedbackReceipt({
      kind: "retry",
      message: "retry finalized task",
      executed: true,
      statusBefore,
      statusAfter: updated.status,
    }));
  }
  const conflicts = await currentPathConflicts(taskStore, task);
  if (conflicts.length > 0 && !forceParallel) {
    task = await taskStore.updateTask(taskId, {
      status: "waiting_user",
      active_question: null,
      active_approval: null,
      path_conflict: { conflicts },
      blockers: [{ code: "queued_path_conflict", conflicts }],
      unblock_options: buildUnblockOptions({ task, includeRetry: true }).filter((option) => ["retry", "cancel"].includes(option.type)),
    });
    await markProjectTaskStatus(taskStore, task, "waiting_user", { blocker: task.blockers[0] });
    writeLine(stdout, `task ${task.id} waiting: path conflict`);
    return withReceipt(task, feedbackReceipt({
      kind: "retry",
      message: "retry not queued: queued_path_conflict",
      executed: false,
      statusBefore,
      statusAfter: task.status,
      reason: "queued_path_conflict",
    }));
  }

  if (task.project_id) {
    task = await ensureProjectTaskSetup({ taskStore, task, cwd, gitRunner });
    await acquirePathLeases(taskStore, task.project_id, task.id, task.write_paths ?? []);
  }

  task = await taskStore.incrementContinuationGeneration(taskId, {
    status: "queued",
    active_question: null,
    active_approval: null,
    path_conflict: null,
    blockers: (task.blockers ?? []).filter((blocker) => blocker.code !== "queued_path_conflict"),
    unblock_options: [],
    continuation_prompt: note ? `Retry note:\n${note}` : "Retry requested by user.",
  });
  await markProjectTaskStatus(taskStore, task, "queued");
  writeLine(stdout, `task ${task.id} retry queued`);
  const result = await resumeQueuedTask({
    task,
    taskStore,
    taskId,
    cwd,
    stdout,
    stderr,
    runner,
    gitRunner,
    resumeMode,
    spawnProcess,
  });
  return attachReceipt(result, feedbackReceipt({
    kind: "retry",
    message: forceParallel ? "force retry queued" : "retry queued",
    executed: false,
    statusBefore,
    statusAfter: result.task?.status,
  }));
}

export async function handleExtendTimeout({
  taskStore,
  taskId,
  timeoutMs,
  note = "",
  cwd,
  stdout,
  stderr,
  runner,
  gitRunner,
  resumeMode = "foreground",
  spawnProcess = spawn,
}) {
  if (!Number.isInteger(timeoutMs) || (timeoutMs <= 0 && timeoutMs !== -1)) {
    throw new Error(`invalid_timeout_ms: ${timeoutMs}`);
  }
  const before = await taskStore.readTask(taskId);
  let task = await taskStore.appendInteraction(taskId, {
    type: "extend_timeout",
    actor: "user",
    body: note,
    timeout_ms: timeoutMs,
  });
  task = await taskStore.incrementContinuationGeneration(taskId, {
    status: "queued",
    timeout_ms: timeoutMs,
    active_step: null,
    active_question: null,
    active_approval: null,
    blockers: (task.blockers ?? []).filter((blocker) => blocker.code !== "agent_timeout"),
    unblock_options: [],
    continuation_prompt: [
      `Timeout extended to ${timeoutMs} ms.`,
      note ? `User note:\n${note}` : null,
    ].filter(Boolean).join("\n"),
  });
  await markProjectTaskStatus(taskStore, task, "queued");
  writeLine(stdout, `task ${task.id} timeout extended`);
  const result = await resumeQueuedTask({
    task,
    taskStore,
    taskId,
    cwd,
    stdout,
    stderr,
    runner,
    gitRunner,
    resumeMode,
    spawnProcess,
  });
  return attachReceipt(result, feedbackReceipt({
    kind: "extend-timeout",
    message: "timeout extended",
    executed: false,
    statusBefore: before.status,
    statusAfter: result.task?.status,
  }));
}

export async function handleMarkDone({
  taskStore,
  taskId,
  actionId = null,
  note = "",
  force = false,
  cwd,
  stdout,
  stderr,
  runner,
  gitRunner,
  resumeMode = "foreground",
  spawnProcess = spawn,
}) {
  let task = await taskStore.readTask(taskId);
  const actionable = actionableActionRequests(task);
  if (force && !actionId && taskHasBlocker(task, "task_merge_conflict")) {
    task = await taskStore.appendInteraction(taskId, {
      type: "manual_done",
      actor: "user",
      body: note,
      observed: false,
      forced: true,
      reason: "task_merge_conflict",
    });
    const updated = await taskStore.updateTask(taskId, {
      status: "succeeded",
      active_question: null,
      active_approval: null,
      blockers: (task.blockers ?? []).filter((blocker) => blocker.code !== "task_merge_conflict"),
      unblock_options: [],
      continuation_prompt: null,
    });
    await releasePathLeases(taskStore, updated);
    await markProjectTaskStatus(taskStore, updated, "succeeded");
    writeLine(stdout, `task ${taskId} force-marked done`);
    return { task: updated };
  }
  let selectedActionId = actionId;
  if (!selectedActionId && actionable.length === 1) {
    selectedActionId = actionable[0].id;
  }
  if (!selectedActionId && actionable.length > 1) {
    task = await taskStore.appendInteraction(taskId, {
      type: "manual_done",
      actor: "user",
      body: note,
    });
    const updated = await taskStore.updateTask(taskId, {
      status: "waiting_user",
      blockers: [{ code: "manual_done_ambiguous", pending_action_ids: actionable.map((request) => request.id) }],
      unblock_options: buildUnblockOptions({ task, actionRequests: actionable, includeRetry: true, includeManualDone: true }),
    });
    await markProjectTaskStatus(taskStore, updated, "waiting_user", { action_requests: updated.action_requests });
    writeLine(stdout, `task ${taskId} manual action ambiguous`);
    return { task: updated };
  }
  if (!selectedActionId) throw new Error("missing_action_id");
  const request = (task.action_requests ?? []).find((item) => item.id === selectedActionId);
  if (!request) throw new Error(`unknown_action_request: ${selectedActionId}`);
  if (!canApproveAction(request)) {
    return { task };
  }

  const validationReason = force ? null : await validateManualDoneObservation({ gitRunner, task, request });
  if (validationReason) {
    task = await taskStore.appendInteraction(taskId, {
      type: "manual_done",
      actor: "user",
      body: note,
      action_id: selectedActionId,
      observed: false,
      reason: validationReason,
    });
    const updated = await taskStore.updateTask(taskId, {
      status: "waiting_user",
      blockers: [{ code: "manual_done_not_observed", action_id: selectedActionId, reason: validationReason }],
      unblock_options: buildUnblockOptions({ task, actionRequests: actionable, includeRetry: true, includeManualDone: true }),
    });
    await markProjectTaskStatus(taskStore, updated, "waiting_user", { action_requests: updated.action_requests });
    writeLine(stdout, `task ${taskId} manual action not observed: ${validationReason}`);
    return { task: updated };
  }

  task = await taskStore.appendInteraction(taskId, {
    type: "manual_done",
    actor: "user",
    body: note,
    action_id: selectedActionId,
    observed: !force,
    forced: force,
  });
  const requests = (task.action_requests ?? []).map((item) => (
    item.id === selectedActionId
      ? {
          ...item,
          status: "succeeded",
          result: {
            code: 0,
            stdout: force ? "manual_forced_by_user" : "manual_verified_local_state",
            stderr: note,
            observed: !force,
            forced: force,
          },
        }
      : item
  ));
  task = await taskStore.updateTask(taskId, {
    active_question: null,
    active_approval: null,
    action_requests: requests,
  });
  writeLine(stdout, `task ${task.id} manual action recorded`);
  const settled = await settleActionGate({
    taskStore,
    taskId,
    cwd,
    stdout,
    stderr,
    gitRunner,
    continuationPrompt: force
      ? [
          "User reports command completed manually.",
          note ? `User note:\n${note}` : null,
        ].filter(Boolean).join("\n")
      : (note ? `Manual action completed:\n${note}` : "Manual action completed."),
  });
  if (settled.status === "queued") {
    return resumeQueuedTask({
      task: settled,
      taskStore,
      taskId,
      cwd,
      stdout,
      stderr,
      runner,
      gitRunner,
      resumeMode,
      spawnProcess,
    });
  }
  return { task: settled };
}

export async function handleCancelTask({ taskStore, taskId, note = "", stdout }) {
  const before = await taskStore.readTask(taskId);
  await taskStore.appendInteraction(taskId, {
    type: "cancel",
    actor: "user",
    body: note,
  });
  const task = await taskStore.updateTask(taskId, {
    status: "cancelled",
    active_step: null,
    active_question: null,
    active_approval: null,
    unblock_options: [],
  });
  await releasePathLeases(taskStore, task);
  await markProjectTaskStatus(taskStore, task, "cancelled");
  writeLine(stdout, `task ${task.id} cancelled`);
  return withReceipt(task, feedbackReceipt({
    kind: "cancel",
    message: "task cancelled",
    executed: false,
    statusBefore: before.status,
    statusAfter: task.status,
  }));
}
