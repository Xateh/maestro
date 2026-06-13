import fs from "node:fs/promises";
import path from "node:path";

import { buildUnblockOptions, canApproveAction } from "./action-requests.mjs";
import {
  markStaleActionRequest,
  settleActionGate,
  unsafeGitActionReason,
  validateActionFreshness,
} from "./action-validate.mjs";
import { hashText, runGit } from "./git-exec.mjs";
import {
  gitTypeForActionRequest,
  normalizeActionRequest,
  normalizeGitActionArgs,
} from "./git-intent.mjs";
import { markProjectTaskStatus } from "./projects.mjs";
import { actionResultLogPaths, feedbackReceipt, withReceipt } from "./receipts.mjs";
import { REVIEW_MAX_CONTINUATIONS, exitCodeFromError, nowIso, writeLine } from "./util.mjs";

function classifyBrokerFailure(error, request) {
  const text = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
  if (/conflict|CONFLICT/i.test(text) || gitTypeForActionRequest(request) === "git_merge") return "merge_conflict";
  if (/auth|permission denied|protected branch|network|could not resolve|eai_again|403|401/i.test(text)) return "needs_user";
  return "failed";
}

function actionCommandHash(request) {
  return hashText(JSON.stringify({
    provider: request.provider,
    type: request.type,
    git_type: request.git_type ?? null,
    cwd: request.cwd ?? "",
    command: request.command ?? "",
    args: request.provider === "host" ? (request.args ?? []) : (request.normalized_args ?? []),
    env: request.provider === "host" ? (request.env ?? {}) : {},
    timeout_ms: request.timeout_ms ?? null,
  }));
}

function renderActionCommand(request) {
  if (request.provider === "host") {
    return [request.command, ...(request.args ?? [])].filter(Boolean).join(" ");
  }
  return `git ${normalizeGitActionArgs(request.normalized_args ?? []).join(" ")}`;
}

async function writeActionLogs({ task, actionId, stdoutText = "", stderrText = "" }) {
  const stdoutPath = path.join(task.run_dir, `${actionId}.stdout.log`);
  const stderrPath = path.join(task.run_dir, `${actionId}.stderr.log`);
  await fs.mkdir(task.run_dir, { recursive: true });
  await Promise.all([
    fs.writeFile(stdoutPath, String(stdoutText ?? "")),
    fs.writeFile(stderrPath, String(stderrText ?? "")),
  ]);
  return { stdoutPath, stderrPath };
}

function compactLogSnippet(value = "", maxLength = 600) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function buildActionResult({ task, request, note, startedAt, output, stdoutPath, stderrPath }) {
  const stdoutText = String(output?.stdout ?? "");
  const stderrText = String(output?.stderr ?? "");
  const exitCode = Number.isInteger(output?.code) ? output.code : 0;
  return {
    code: exitCode,
    exit_code: exitCode,
    stdout: stdoutText,
    stderr: stderrText,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    duration_ms: Math.max(0, Date.now() - startedAt),
    cwd: request.cwd,
    command: renderActionCommand(request),
    command_hash: actionCommandHash(request),
    user_note: String(note ?? ""),
    task_id: task.id,
  };
}

function buildActionContinuationPrompt({ request, note, result }) {
  return [
    `Host action completed: ${request.type}`,
    request.type === "external_cwd_git" && request.git_type ? `Git action: ${request.git_type}` : null,
    `Command: ${result.command}`,
    `cwd: ${result.cwd}`,
    `exit code: ${result.exit_code}`,
    `stdout log: ${result.stdout_path}`,
    `stderr log: ${result.stderr_path}`,
    note ? `User note: ${note}` : null,
    result.stdout ? `stdout summary:\n${compactLogSnippet(result.stdout)}` : null,
    result.stderr ? `stderr summary:\n${compactLogSnippet(result.stderr)}` : null,
  ].filter(Boolean).join("\n");
}

async function runActionRequest({ request, gitRunner, hostRunner }) {
  if (request.provider === "host") {
    return hostRunner({
      command: request.command,
      args: request.args ?? [],
      cwd: request.cwd,
      env: request.env ?? {},
      timeoutMs: request.timeout_ms,
    });
  }
  return runGit(gitRunner, request.cwd, normalizeGitActionArgs(request.normalized_args ?? []));
}

async function recoverUnsafeActionRequest({ taskStore, task, actionId, request, reason, stdout }) {
  const pendingRequest = reason === "action_cwd_outside_task" && request.provider === "git"
    ? {
        ...request,
        type: "external_cwd_git",
        git_type: gitTypeForActionRequest(request),
        external_cwd: true,
        status: "pending",
        normalized_args: normalizeGitActionArgs(request.normalized_args ?? []),
        result: null,
      }
    : {
        ...request,
        status: "pending",
        normalized_args: request.provider === "git" ? normalizeGitActionArgs(request.normalized_args ?? []) : request.normalized_args,
        result: null,
      };
  const requests = (task.action_requests ?? []).map((item) => (
    item.id === actionId ? pendingRequest : item
  ));
  const nextTask = { ...task, action_requests: requests };
  const updated = await taskStore.updateTask(task.id, {
    status: "waiting_user",
    active_step: null,
    action_requests: requests,
    blockers: [
      { code: reason, action_id: actionId },
      ...(task.blockers ?? []).filter((blocker) => !(blocker.action_id === actionId && blocker.code === reason)),
    ],
    unblock_options: buildUnblockOptions({
      task: nextTask,
      actionRequests: requests.filter((item) => item.status === "pending"),
      includeRetry: true,
      includeManualDone: true,
    }),
    review: {
      status: "system",
      completion_state: "incomplete_needs_user",
      required_action: "manual_fix",
      risk_level: reason === "action_cwd_outside_task" ? "medium" : "high",
      confidence: "high",
      summary: `Action request needs user recovery: ${reason}`,
      evidence: [],
      blockers: [{ code: reason, action_id: actionId }],
      required_user_input: null,
      approval_request: null,
      action_requests: [pendingRequest],
      unblock_options: buildUnblockOptions({
        task: nextTask,
        actionRequests: [pendingRequest],
        includeRetry: true,
        includeManualDone: true,
      }),
      continuation: null,
      continuation_attempts: 0,
      max_continuations: REVIEW_MAX_CONTINUATIONS,
      decided_at: nowIso(),
    },
  });
  await markProjectTaskStatus(taskStore, updated, "waiting_user", { action_requests: requests });
  writeLine(stdout, `task ${task.id} action ${actionId} waiting for user: ${reason}`);
  return updated;
}

export async function executeApprovedAction({
  taskStore,
  taskId,
  actionId,
  note = "",
  cwd,
  gitRunner,
  hostRunner,
  stdout,
  stderr,
  allowExternalCwd = false,
  bypassFreshness = false,
}) {
  let task = await taskStore.readTask(taskId);
  const statusBefore = task.status ?? null;
  const receiptKind = bypassFreshness ? "run-action" : "approve-action";
  let request = (task.action_requests ?? []).find((item) => item.id === actionId);
  if (!request) throw new Error(`unknown_action_request: ${actionId}`);
  request = normalizeActionRequest(request);
  if (request.status === "succeeded") {
    return withReceipt(task, feedbackReceipt({
      kind: receiptKind,
      message: `action ${actionId} not run: already_succeeded`,
      executed: false,
      statusBefore,
      statusAfter: task.status,
      reason: "already_succeeded",
      actionId,
      logPaths: actionResultLogPaths(request.result ?? {}),
    }));
  }
  if (request.status === "denied") {
    return withReceipt(task, feedbackReceipt({
      kind: receiptKind,
      message: `action ${actionId} not run: already_denied`,
      executed: false,
      statusBefore,
      statusAfter: task.status,
      reason: "already_denied",
      actionId,
    }));
  }
  if (!canApproveAction(request)) {
    return withReceipt(task, feedbackReceipt({
      kind: receiptKind,
      message: `action ${actionId} not run: not_actionable`,
      executed: false,
      statusBefore,
      statusAfter: task.status,
      reason: "not_actionable",
      actionId,
    }));
  }
  if (request.status !== "pending" || request.result || request.continuation_generation !== (task.continuation_generation ?? 0)) {
    request = {
      ...request,
      status: "pending",
      result: null,
      stale_reason: null,
      continuation_generation: task.continuation_generation ?? 0,
    };
    task = await taskStore.updateActionRequest(taskId, actionId, request);
  }

  if (
    request.provider === "git"
    && JSON.stringify(request.normalized_args) !== JSON.stringify((task.action_requests ?? []).find((item) => item.id === actionId)?.normalized_args ?? [])
  ) {
    task = await taskStore.updateActionRequest(taskId, actionId, { normalized_args: request.normalized_args });
  }

  // Read allowlist from config (host_command_allow defaults to [] = feature off).
  const _cfg = await taskStore.readConfig().catch(() => null);
  const hostCommandAllow = Array.isArray(_cfg?.host_command_allow) ? _cfg.host_command_allow : [];
  const unsafeReason = unsafeGitActionReason(request, task, { allowExternalCwd, hostCommandAllow });
  if (unsafeReason) {
    const updated = await recoverUnsafeActionRequest({ taskStore, task, actionId, request, reason: unsafeReason, stdout });
    return withReceipt(updated, feedbackReceipt({
      kind: receiptKind,
      message: `action ${actionId} not run: ${unsafeReason}`,
      executed: false,
      statusBefore,
      statusAfter: updated.status,
      reason: unsafeReason,
      actionId,
    }));
  }

  if (!bypassFreshness) {
    const staleReason = await validateActionFreshness({ gitRunner, task, request });
    if (staleReason) {
      const updated = await markStaleActionRequest({ taskStore, task, request, reason: staleReason });
      return withReceipt(updated, feedbackReceipt({
        kind: receiptKind,
        message: `action ${actionId} not run: ${staleReason}`,
        executed: false,
        statusBefore,
        statusAfter: updated.status,
        reason: staleReason,
        actionId,
      }));
    }
  }

  await taskStore.appendInteraction(taskId, {
    type: bypassFreshness ? "run_anyway" : "approval",
    actor: "user",
    body: note,
    action_id: actionId,
    approved: true,
    bypass_freshness: bypassFreshness,
  });
  task = await taskStore.updateActionRequest(taskId, actionId, { ...request, status: "running", stale_reason: null });
  const startedAt = Date.now();
  try {
    const result = await runActionRequest({ request, gitRunner, hostRunner });
    const logPaths = await writeActionLogs({
      task,
      actionId,
      stdoutText: result.stdout,
      stderrText: result.stderr,
    });
    const actionResult = buildActionResult({
      task,
      request,
      actionId,
      note,
      startedAt,
      output: result,
      stdoutPath: logPaths.stdoutPath,
      stderrPath: logPaths.stderrPath,
    });
    const requests = (task.action_requests ?? []).map((item) => (
      item.id === actionId
        ? {
            ...item,
            ...request,
            status: "succeeded",
            result: actionResult,
          }
        : item
    ));
    task = await taskStore.updateTask(taskId, {
      active_approval: null,
      action_requests: requests,
    });
    writeLine(stdout, `task ${taskId} action ${actionId} succeeded`);
    const settled = await settleActionGate({
      taskStore,
      taskId,
      cwd,
      stdout,
      stderr,
      gitRunner,
      continuationPrompt: buildActionContinuationPrompt({ request, note, result: actionResult }),
      preferAgentContinuation: Boolean(String(note ?? "").trim()),
    });
    return withReceipt(settled, feedbackReceipt({
      kind: receiptKind,
      message: `action ${actionId} executed`,
      executed: true,
      statusBefore,
      statusAfter: settled.status,
      actionId,
      logPaths: actionResultLogPaths(actionResult),
    }));
  } catch (error) {
    const failureKind = classifyBrokerFailure(error, request);
    const logPaths = await writeActionLogs({
      task,
      actionId,
      stdoutText: error.stdout,
      stderrText: error.stderr ?? error.message,
    });
    const actionResult = buildActionResult({
      task,
      request,
      actionId,
      note,
      startedAt,
      output: {
        code: exitCodeFromError(error),
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? error.message ?? ""),
      },
      stdoutPath: logPaths.stdoutPath,
      stderrPath: logPaths.stderrPath,
    });
    const requests = (task.action_requests ?? []).map((item) => (
      item.id === actionId
        ? {
            ...item,
            ...request,
            status: "failed",
            result: actionResult,
          }
        : item
    ));
    const nextStatus = "waiting_user";
    task = await taskStore.updateTask(taskId, {
      status: nextStatus,
      active_step: null,
      action_requests: requests,
      blockers: [
        ...(task.blockers ?? []),
        { code: failureKind, action_id: actionId, error: error.message },
      ],
      unblock_options: buildUnblockOptions({
        task: { ...task, action_requests: requests },
        actionRequests: requests.filter((item) => ["failed", "pending"].includes(item.status)),
        includeRetry: true,
        includeManualDone: true,
      }),
    });
    await markProjectTaskStatus(taskStore, task, nextStatus, { action_requests: requests });
    writeLine(stdout, `task ${taskId} action ${actionId} failed: ${failureKind}`);
    return withReceipt(task, feedbackReceipt({
      kind: receiptKind,
      message: `action ${actionId} failed: ${failureKind}`,
      executed: true,
      statusBefore,
      statusAfter: task.status,
      reason: failureKind,
      actionId,
      logPaths: actionResultLogPaths(actionResult),
    }));
  }
}
