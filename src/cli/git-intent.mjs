import { sanitizeEnvObject } from "./util.mjs";

export const GIT_ACTION_TYPES = new Set(["git_commit", "git_merge", "git_push", "git_fetch", "git_pull"]);
export const ACTION_REQUEST_TYPES = new Set([...GIT_ACTION_TYPES, "external_cwd_git", "host_command"]);

const GIT_PUBLISH_PATTERNS = [
  {
    operation: "commit",
    pattern: /\b(?:git\s+commit|commit\s+(?:(?:the\s+)?changes?|current|all|staged|relevant|everything|worktree|working\s+tree|main|branch|then|and|before|after)|make\s+(?:a\s+)?commit|create\s+(?:a\s+)?commit)\b/i,
  },
  {
    operation: "merge",
    pattern: /\b(?:git\s+merge|merge\s+(?:from|to|into|main|origin|branch|feature|the\s+branch)|merged?)\b/i,
  },
  {
    operation: "push",
    pattern: /\b(?:git\s+push|push(?:ed|ing)?(?:\s+(?:current|changes?|the\s+branch|branch|to|main|remote|origin|upstream)|$)|pull\+push)\b/i,
  },
  {
    operation: "pull",
    pattern: /\b(?:git\s+pull|pull(?:ed|ing)?(?:\s+(?:latest|from|origin)|$)|pull\+push)\b/i,
  },
  {
    operation: "fetch",
    pattern: /\b(?:git\s+fetch|fetch(?:ed|ing)?\s+(?:origin|remote|upstream))\b/i,
  },
  {
    operation: "rebase",
    pattern: /\b(?:git\s+rebase|rebase(?:d|ing)?\s+(?:onto|from|main|origin|branch))\b/i,
  },
];

function isNegatedGitOperation(text, operation) {
  const escaped = operation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:do\\s+not|don't|no)\\s+(?:git\\s+)?${escaped}\\b`, "i").test(text);
}

export function detectGitPublishIntent(prompt = "") {
  const text = String(prompt ?? "");
  const operations = GIT_PUBLISH_PATTERNS
    .filter(({ operation, pattern }) => pattern.test(text) && !isNegatedGitOperation(text, operation))
    .map(({ operation }) => operation);
  return {
    required: operations.length > 0,
    operations,
  };
}

export function gitPublishBlockerForTask(task) {
  const intent = detectGitPublishIntent(task.prompt);
  if (!intent.required) return null;
  const remoteOperations = new Set(["push", "pull", "fetch"]);
  const unsupported = intent.operations.filter((operation) => (
    remoteOperations.has(operation) || !task.project_id
  ));
  if (unsupported.length === 0) return null;
  return {
    code: "git_publish_unsupported_in_agent_sandbox",
    operations: unsupported,
    detected_operations: intent.operations,
    reason: "Codex local tasks run with approval_policy=never in a sandbox; git metadata writes and network pushes can fail while the agent still exits 0.",
  };
}

export function actionTypeForOperation(operation) {
  if (operation === "commit") return "git_commit";
  if (operation === "merge") return "git_merge";
  if (operation === "push") return "git_push";
  if (operation === "fetch") return "git_fetch";
  if (operation === "pull") return "git_pull";
  return null;
}

export function operationForActionType(type) {
  return String(type ?? "").replace(/^git_/, "");
}

export function normalizeGitActionArgs(args = []) {
  const normalized = Array.isArray(args)
    ? args.map((arg) => String(arg ?? "")).filter((arg) => arg !== "")
    : [];
  return normalized[0] === "git" ? normalized.slice(1) : normalized;
}

export function normalizeActionRequest(request = {}) {
  const provider = request.provider || (request.type === "host_command" ? "host" : "git");
  if (provider === "host") {
    return {
      ...request,
      provider: "host",
      type: "host_command",
      args: Array.isArray(request.args) ? request.args.map((arg) => String(arg ?? "")) : [],
      env: sanitizeEnvObject(request.env),
    };
  }
  const next = {
    ...request,
    provider: "git",
    normalized_args: normalizeGitActionArgs(request.normalized_args ?? []),
  };
  if (next.type === "external_cwd_git" && !GIT_ACTION_TYPES.has(next.git_type)) {
    next.git_type = inferGitActionTypeFromArgs(next.normalized_args);
  }
  return next;
}

function inferGitActionTypeFromArgs(args = []) {
  const operation = normalizeGitActionArgs(args)[0];
  const type = actionTypeForOperation(operation);
  return GIT_ACTION_TYPES.has(type) ? type : null;
}

export function gitTypeForActionRequest(request = {}) {
  if (request.type === "external_cwd_git") return request.git_type || inferGitActionTypeFromArgs(request.normalized_args);
  return request.type;
}

export function operationForActionRequest(request = {}) {
  return operationForActionType(gitTypeForActionRequest(request));
}

export function extractMergeSource(prompt = "") {
  const text = String(prompt ?? "");
  const match = text.match(/\bmerge\s+(?:from\s+)?([A-Za-z0-9._/-]+)/i);
  if (!match) return null;
  const source = match[1];
  if (["from", "to", "into", "main", "branch", "feature", "the"].includes(source.toLowerCase())) return null;
  return source;
}
