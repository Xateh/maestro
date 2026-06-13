import { readGitSnapshot } from "./git-exec.mjs";
import {
  actionTypeForOperation,
  detectGitPublishIntent,
  extractMergeSource,
  normalizeActionRequest,
  normalizeGitActionArgs,
  operationForActionRequest,
  gitTypeForActionRequest,
} from "./git-intent.mjs";
import { stableJson } from "./util.mjs";

export function actionableActionRequests(task = {}) {
  return (task.action_requests ?? []).filter((request) => ["pending", "failed", "expired"].includes(request.status));
}

export function canApproveAction(request = {}) {
  return ["pending", "failed", "expired"].includes(request.status);
}

export function taskHasBlocker(task = {}, code) {
  return (task.blockers ?? []).some((blocker) => blocker.code === code);
}

function dedupeUnblockOptions(options = []) {
  const seen = new Set();
  const deduped = [];
  for (const option of options) {
    if (!option?.id || seen.has(option.id)) continue;
    seen.add(option.id);
    deduped.push(option);
  }
  return deduped;
}

export function buildUnblockOptions({ task, actionRequests = [], includeAnswer = false, includeRetry = false, includeManualDone = false } = {}) {
  const options = [];
  if (includeAnswer) {
    options.push({ id: `answer-${task.id}`, type: "answer", label: "Answer question", status: "open" });
  }
  for (const request of actionRequests.filter((item) => canApproveAction(item))) {
    options.push({
      id: `approve-${request.id}`,
      type: "approve_action",
      label: `Approve ${formatActionRequestLabel(request)}`,
      status: "open",
    });
    if (request.type === "external_cwd_git" || request.external_cwd === true) {
      options.push({
        id: `run-external-${request.id}`,
        type: "run_external",
        label: `Run outside sandbox ${formatActionRequestLabel(request)}`,
        status: "open",
      });
    } else if (request.stale_reason || request.status === "expired") {
      options.push({
        id: `run-anyway-${request.id}`,
        type: "run_anyway",
        label: `Run anyway ${formatActionRequestLabel(request)}`,
        status: "open",
      });
    }
    options.push({
      id: `edit-${request.id}`,
      type: "edit_action",
      label: `Edit ${formatActionRequestLabel(request)}`,
      status: "open",
    });
  }
  if (includeManualDone || actionRequests.length > 0) {
    options.push({ id: `manual-${task.id}`, type: "manual_done", label: "I handled this manually", status: "open" });
  }
  if (taskHasBlocker(task, "agent_timeout")) {
    options.push({ id: `timeout-${task.id}`, type: "extend_timeout", label: "Extend timeout", status: "open" });
  }
  if (includeRetry) {
    options.push({ id: `retry-${task.id}`, type: "retry", label: "Retry", status: "open" });
  }
  if (includeRetry) {
    options.push({ id: `instruct-${task.id}`, type: "instruct", label: "Give instructions", status: "open" });
  }
  options.push({ id: `cancel-${task.id}`, type: "cancel", label: "Cancel task", status: "open" });
  return dedupeUnblockOptions(options);
}

function formatActionRequestLabel(request = {}) {
  if (request.type === "external_cwd_git") {
    return `external ${String(request.git_type ?? "git").replace(/^git_/, "git ")}`;
  }
  if (request.type === "host_command") return "host command";
  return String(request.type ?? "action").replace(/^git_/, "git ");
}

function actionRequestSignature(request = {}) {
  const normalized = normalizeActionRequest(request);
  if (normalized.provider === "host") {
    return stableJson({
      provider: "host",
      type: "host_command",
      cwd: normalized.cwd ?? "",
      command: normalized.command ?? "",
      args: normalized.args ?? [],
      env: normalized.env ?? {},
      timeout_ms: normalized.timeout_ms ?? null,
    });
  }
  return stableJson({
    provider: "git",
    type: normalized.type,
    git_type: gitTypeForActionRequest(normalized),
    cwd: normalized.cwd ?? "",
    normalized_args: normalizeGitActionArgs(normalized.normalized_args ?? []),
    external_cwd: normalized.external_cwd === true || normalized.type === "external_cwd_git",
  });
}

function nextActionRequestId(used, baseId) {
  if (!used.has(baseId)) return baseId;
  let suffix = 2;
  while (used.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}

export function canonicalizeActionRequestsForTask(task = {}, incomingRequests = []) {
  const requests = (task.action_requests ?? []).map((request) => normalizeActionRequest(request));
  const used = new Set(requests.map((request) => request.id));
  const replacedIds = new Set();

  for (const rawRequest of incomingRequests ?? []) {
    if (!rawRequest) continue;
    let request = normalizeActionRequest({
      ...rawRequest,
      status: rawRequest.status || "pending",
      stale_reason: null,
      result: rawRequest.result ?? null,
    });
    const id = request.id || `act-${requests.length + 1}`;
    request = { ...request, id };
    const existingIndex = requests.findIndex((item) => item.id === id);
    if (existingIndex >= 0) {
      if (actionRequestSignature(requests[existingIndex]) === actionRequestSignature(request)) {
        requests[existingIndex] = {
          ...requests[existingIndex],
          ...request,
          stale_reason: null,
          result: request.result ?? null,
        };
        replacedIds.add(id);
        continue;
      }
      const nextId = nextActionRequestId(used, id);
      request = { ...request, id: nextId };
    }
    used.add(request.id);
    requests.push(request);
  }

  const blockers = (task.blockers ?? []).filter((blocker) => (
    !replacedIds.has(blocker.action_id)
  ));
  const nextTask = { ...task, blockers, action_requests: requests };
  return {
    ...nextTask,
    unblock_options: buildUnblockOptions({
      task: nextTask,
      actionRequests: actionableActionRequests(nextTask),
    }),
  };
}

export function hasResolvedGitIntent(task, intent) {
  const resolved = new Set();
  for (const request of task.action_requests ?? []) {
    if (request.status === "succeeded") resolved.add(operationForActionRequest(request));
  }
  return intent.operations.every((operation) => resolved.has(operation));
}

function buildGitActionRequest({ task, operation, taskCwd, snapshot, index }) {
  const type = actionTypeForOperation(operation);
  if (!type) return null;
  const base = {
    id: `act-${index + 1}`,
    provider: "git",
    type,
    status: "pending",
    cwd: taskCwd,
    expected_branch: snapshot.branch,
    expected_head: snapshot.head,
    expected_status_hash: snapshot.status_hash,
    expected_remote_url: snapshot.remote_url,
    continuation_generation: task.continuation_generation ?? 0,
    result: null,
  };
  if (operation === "commit") {
    return {
      ...base,
      normalized_args: ["commit", "-m", `maestro: ${task.id}`],
      file_set_summary: snapshot.status_text,
    };
  }
  if (operation === "merge") {
    const source = extractMergeSource(task.prompt);
    if (!source) return null;
    return {
      ...base,
      normalized_args: ["merge", "--no-ff", source],
      source_branch: source,
    };
  }
  if (operation === "push") {
    return {
      ...base,
      normalized_args: ["push", "origin", snapshot.branch || "HEAD"],
    };
  }
  if (operation === "fetch") {
    return {
      ...base,
      normalized_args: ["fetch", "origin"],
    };
  }
  if (operation === "pull") {
    return {
      ...base,
      normalized_args: ["pull", "--ff-only", "origin", snapshot.branch || "HEAD"],
    };
  }
  return null;
}

function uniqueActionRequestId(task, baseId) {
  const used = new Set((task.action_requests ?? []).map((request) => request.id));
  if (!used.has(baseId)) return baseId;
  let suffix = 2;
  while (used.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}

export async function buildNextGitActionRequestForTask({ task, taskCwd, gitRunner }) {
  const intent = detectGitPublishIntent(task.prompt);
  if (!intent.required) return null;
  const resolved = new Set(
    (task.action_requests ?? [])
      .filter((request) => request.status === "succeeded")
      .map((request) => operationForActionRequest(request)),
  );
  const operation = intent.operations.find((item) => !resolved.has(item));
  if (!operation) return null;
  const snapshot = await readGitSnapshot(gitRunner, taskCwd);
  const index = intent.operations.indexOf(operation);
  const request = buildGitActionRequest({ task, operation, taskCwd, snapshot, index });
  if (!request) return null;
  return {
    ...request,
    id: uniqueActionRequestId(task, request.id),
  };
}
