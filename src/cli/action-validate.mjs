import path from "node:path";

import {
  actionableActionRequests,
  buildNextGitActionRequestForTask,
  buildUnblockOptions,
  hasResolvedGitIntent,
} from "./action-requests.mjs";
import { readGitSnapshot } from "./git-exec.mjs";
import {
  ACTION_REQUEST_TYPES,
  GIT_ACTION_TYPES,
  detectGitPublishIntent,
  gitPublishBlockerForTask,
  gitTypeForActionRequest,
  normalizeActionRequest,
  normalizeGitActionArgs,
  operationForActionType,
} from "./git-intent.mjs";
import { markProjectTaskStatus } from "./projects.mjs";
import { REVIEW_MAX_CONTINUATIONS, isInside, nowIso, writeLine } from "./util.mjs";

export function gitActionIsRemote(type) {
  return ["git_push", "git_fetch", "git_pull"].includes(type);
}

function validRemoteToken(value) {
  const text = String(value ?? "");
  return /^[A-Za-z0-9._-]+$/.test(text) && !text.startsWith("-");
}

function validGitRefToken(value) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9._/-]+$/.test(text)) return false;
  if (!text || /^[-+:]/.test(text)) return false;
  if (text.includes("..") || text.includes(":")) return false;
  if (/[*?[\]]/.test(text)) return false;
  return true;
}

function validCommitMessage(value) {
  const text = String(value ?? "");
  return text.length > 0 && !text.includes("\0");
}

function invalidGitActionArgsReason(type, args = []) {
  if (type === "git_commit") {
    if (args.length !== 3 || args[0] !== "commit" || args[1] !== "-m") return "invalid_git_action_args";
    return validCommitMessage(args[2]) ? null : "invalid_commit_message";
  }
  if (type === "git_merge") {
    if (args.length !== 3 || args[0] !== "merge" || args[1] !== "--no-ff") return "invalid_git_action_args";
    return validGitRefToken(args[2]) ? null : "invalid_git_ref";
  }
  if (type === "git_push") {
    if (args.length !== 3 || args[0] !== "push") return "invalid_git_action_args";
    if (!validRemoteToken(args[1])) return "invalid_git_remote";
    return validGitRefToken(args[2]) ? null : "invalid_git_ref";
  }
  if (type === "git_fetch") {
    if (args.length !== 2 || args[0] !== "fetch") return "invalid_git_action_args";
    return validRemoteToken(args[1]) ? null : "invalid_git_remote";
  }
  if (type === "git_pull") {
    if (args.length !== 4 || args[0] !== "pull" || args[1] !== "--ff-only") return "invalid_git_action_args";
    if (!validRemoteToken(args[2])) return "invalid_git_remote";
    return validGitRefToken(args[3]) ? null : "invalid_git_ref";
  }
  return "unsupported_action_type";
}

// Network and privilege-escalation binaries that should never be in an agent-driven allowlist.
// Shells and script interpreters are deliberately excluded: if a user explicitly allowlists
// "sh" or "python" in host_command_allow they are making an informed opt-in.
const HOST_COMMAND_BUILTIN_DENYLIST = new Set([
  "curl", "wget",                        // arbitrary network exfiltration
  "ssh", "scp", "sftp",                  // remote access / file transfer
  "nc", "netcat",                        // generic TCP/UDP
  "sudo", "su", "doas",                  // privilege escalation
]);

function unsafeHostActionReason(request, { hostCommandAllow = [] } = {}) {
  if (!request.command) return "missing_host_command";
  if (!request.cwd) return "missing_action_cwd";
  if (request.command.includes("\0")) return "invalid_host_command";
  if (!Array.isArray(request.args)) return "invalid_host_args";
  if (request.args.some((arg) => String(arg ?? "").includes("\0"))) return "invalid_host_args";
  if (request.env && (typeof request.env !== "object" || Array.isArray(request.env))) return "invalid_host_env";
  // host_command requires an explicit allowlist in config (default = feature off).
  if (!Array.isArray(hostCommandAllow) || hostCommandAllow.length === 0) return "host_command_not_allowed";
  const cmd = String(request.command);
  // Reject any path-qualified command. Allowlist entries are bare basenames;
  // a command containing a separator could point at an arbitrary binary whose
  // basename happens to match an allowlisted name.
  if (cmd.includes("/") || cmd.includes("\\")) return "host_command_path_not_allowed";
  if (HOST_COMMAND_BUILTIN_DENYLIST.has(cmd)) return "host_command_builtin_denied";
  if (!hostCommandAllow.includes(cmd)) return "host_command_not_allowlisted";
  return null;
}

export function unsafeGitActionReason(request, task = null, { allowExternalCwd = false, hostCommandAllow = [] } = {}) {
  if (request.provider === "host") return unsafeHostActionReason(request, { hostCommandAllow });
  if (request.provider !== "git") return "unsupported_action_provider";
  if (!ACTION_REQUEST_TYPES.has(request.type) || request.type === "host_command") return "unsupported_action_type";
  const gitType = gitTypeForActionRequest(request);
  if (!GIT_ACTION_TYPES.has(gitType)) return "unsupported_action_type";
  if (!request.cwd) return "missing_action_cwd";
  if (task?.cwd) {
    const taskCwd = path.resolve(task.worktree_path ?? task.cwd);
    const actionCwd = path.resolve(request.cwd);
    if (!allowExternalCwd && actionCwd !== taskCwd && !isInside(taskCwd, actionCwd)) return "action_cwd_outside_task";
  }
  const args = normalizeGitActionArgs(request.normalized_args ?? []);
  if (args.length === 0) return "missing_normalized_args";
  if (args[0] !== operationForActionType(gitType)) return "action_type_args_mismatch";
  return invalidGitActionArgsReason(gitType, args);
}

export async function markStaleActionRequest({ taskStore, task, request, reason }) {
  const updatedRequests = (task.action_requests ?? []).map((item) => (
    item.id === request.id
      ? {
          ...item,
          status: "pending",
          stale_reason: reason,
        }
      : item
  ));
  const nextTask = { ...task, action_requests: updatedRequests };
  const updated = await taskStore.updateTask(task.id, {
    status: "waiting_user",
    active_step: null,
    action_requests: updatedRequests,
    blockers: [
      { code: "stale_action_request", action_id: request.id, reason },
      ...(task.blockers ?? []).filter((blocker) => !(blocker.code === "stale_action_request" && blocker.action_id === request.id)),
    ],
    unblock_options: buildUnblockOptions({
      task: nextTask,
      actionRequests: actionableActionRequests(nextTask),
      includeRetry: true,
      includeManualDone: true,
    }),
  });
  await markProjectTaskStatus(taskStore, updated, "waiting_user", { action_requests: updatedRequests });
  return updated;
}

export async function validateActionFreshness({ gitRunner, task, request }) {
  if (request.provider === "host") {
    if (request.continuation_generation !== (task.continuation_generation ?? 0)) return "task_generation_changed";
    return null;
  }
  const snapshot = await readGitSnapshot(gitRunner, request.cwd);
  if (request.continuation_generation !== (task.continuation_generation ?? 0)) return "task_generation_changed";
  if (request.expected_branch && snapshot.branch !== request.expected_branch) return "branch_changed";
  if (request.expected_head && snapshot.head !== request.expected_head) return "head_changed";
  if (request.expected_status_hash && snapshot.status_hash !== request.expected_status_hash) return "status_changed";
  if (gitActionIsRemote(gitTypeForActionRequest(request)) && request.expected_remote_url && snapshot.remote_url !== request.expected_remote_url) return "remote_url_changed";
  return null;
}

function hasUnmergedStatus(statusText = "") {
  return String(statusText ?? "")
    .split(/\r?\n/)
    .some((line) => /^(AA|DD|UU|AU|UA|DU|UD)\s/.test(line));
}

export async function validateManualDoneObservation({ gitRunner, task, request }) {
  const normalizedRequest = normalizeActionRequest(request);
  if (normalizedRequest.provider === "host") return null;
  const unsafeReason = unsafeGitActionReason(normalizedRequest, task, { allowExternalCwd: true });
  if (unsafeReason) return unsafeReason;
  const snapshot = await readGitSnapshot(gitRunner, normalizedRequest.cwd);
  if (normalizedRequest.expected_branch && snapshot.branch !== normalizedRequest.expected_branch) return "branch_changed";
  if (hasUnmergedStatus(snapshot.status_text)) return "conflicted_worktree";
  const gitType = gitTypeForActionRequest(normalizedRequest);
  if (["git_commit", "git_merge", "git_pull"].includes(gitType)) {
    if (normalizedRequest.expected_head && snapshot.head === normalizedRequest.expected_head) return "head_unchanged";
    return null;
  }
  if (["git_push", "git_fetch"].includes(gitType)) {
    if (normalizedRequest.expected_head && snapshot.head !== normalizedRequest.expected_head) return "head_changed";
    if (normalizedRequest.expected_remote_url && snapshot.remote_url !== normalizedRequest.expected_remote_url) return "remote_url_changed";
    return null;
  }
  return "unsupported_action_type";
}

async function markTaskWaitingForAction({ taskStore, task, actionRequests }) {
  const updated = await taskStore.updateTask(task.id, {
    status: "waiting_approval",
    active_approval: null,
    action_requests: task.action_requests ?? [],
    unblock_options: buildUnblockOptions({ task, actionRequests }),
  });
  await markProjectTaskStatus(taskStore, updated, "waiting_approval", { action_requests: updated.action_requests });
  return updated;
}

export async function blockUnsupportedGitAction({ taskStore, task, blocker, stderr }) {
  const updated = await taskStore.updateTask(task.id, {
    status: "waiting_user",
    active_step: null,
    blockers: [blocker],
    unblock_options: buildUnblockOptions({ task, includeRetry: true, includeManualDone: true }),
    review: {
      status: "system",
      completion_state: "incomplete_needs_user",
      required_action: "manual_fix",
      risk_level: "high",
      confidence: "high",
      summary: blocker.reason,
      evidence: [],
      blockers: [blocker],
      required_user_input: null,
      approval_request: null,
      action_requests: [],
      unblock_options: buildUnblockOptions({ task, includeRetry: true, includeManualDone: true }),
      continuation: null,
      continuation_attempts: 0,
      max_continuations: REVIEW_MAX_CONTINUATIONS,
      decided_at: nowIso(),
    },
  });
  await markProjectTaskStatus(taskStore, updated, "waiting_user", { blocker });
  if (stderr) writeLine(stderr, `task ${task.id} waiting for user: git publish unsupported (${blocker.operations.join(", ")})`);
  return updated;
}

export async function settleActionGate({ taskStore, taskId, cwd, stdout, stderr, gitRunner, continuationPrompt, preferAgentContinuation = false }) {
  let task = await taskStore.readTask(taskId);
  const actionable = actionableActionRequests(task);
  if (actionable.length > 0) {
    return markTaskWaitingForAction({ taskStore, task, actionRequests: actionable });
  }

  const intent = detectGitPublishIntent(task.prompt);
  if (!preferAgentContinuation && intent.required && !hasResolvedGitIntent(task, intent)) {
    const taskCwd = path.resolve(cwd, task.cwd ?? ".");
    const nextAction = await buildNextGitActionRequestForTask({ task, taskCwd, gitRunner });
    const blocker = gitPublishBlockerForTask(task);
    if (!nextAction) {
      return blockUnsupportedGitAction({
        taskStore,
        task,
        blocker: blocker ?? {
          code: "git_publish_unsupported_in_agent_sandbox",
          operations: intent.operations,
          detected_operations: intent.operations,
          reason: "Git host action requires explicit Maestro approval but no supported next action could be built.",
        },
        stderr,
      });
    }
    task = await taskStore.updateTask(taskId, {
      status: "waiting_approval",
      active_step: null,
      active_approval: null,
      blockers: blocker ? [blocker] : task.blockers,
      action_requests: [
        ...(task.action_requests ?? []),
        nextAction,
      ],
      unblock_options: buildUnblockOptions({ task, actionRequests: [nextAction] }),
      review: {
        status: "system",
        completion_state: "incomplete_needs_approval",
        required_action: "request_approval",
        risk_level: "high",
        confidence: "high",
        summary: "Git host action requires explicit Maestro approval.",
        evidence: [],
        blockers: blocker ? [blocker] : [],
        continuation_attempts: 0,
        max_continuations: REVIEW_MAX_CONTINUATIONS,
        action_requests: [nextAction],
        unblock_options: buildUnblockOptions({ task, actionRequests: [nextAction] }),
        decided_at: nowIso(),
      },
    });
    await markProjectTaskStatus(taskStore, task, "waiting_approval", { action_requests: task.action_requests });
    writeLine(stdout, `task ${taskId} waiting for git action approval (${nextAction.type.replace(/^git_/, "")})`);
    return task;
  }

  task = await taskStore.incrementContinuationGeneration(taskId, {
    status: "queued",
    active_approval: null,
    unblock_options: [],
    continuation_prompt: continuationPrompt,
  });
  await markProjectTaskStatus(taskStore, task, "queued", { action_requests: task.action_requests });
  return task;
}
