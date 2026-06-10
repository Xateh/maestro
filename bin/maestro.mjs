#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runLangGraphTask } from "../src/langgraph/engine.mjs";
import { CodexAgentRunner } from "../src/codex-client.mjs";
import { startMaestroHttpServer } from "../src/http-server.mjs";
import { LinearTrackerClient } from "../src/linear-tracker.mjs";
import { StructuredLogger } from "../src/logger.mjs";
import { MaestroOrchestrator } from "../src/orchestrator.mjs";
import { evaluatePlannerDecision } from "../src/router.mjs";
import { DEFAULT_LOCAL_STATE_DIR, LocalTaskStore, slugifyTaskTitle } from "../src/task-store.mjs";
import { formatFeedbackReceipt, formatTaskDetails, runMaestroTui } from "../src/tui.mjs";
import {
  WorkflowStore,
  parseCliArgs,
  validateDispatchConfig,
} from "../src/workflow.mjs";
import { WorkspaceManager } from "../src/workspace.mjs";
export { parseReviewerOutput } from "../src/markers.mjs";

const LOCAL_COMMANDS = new Set([
  "project",
  "task",
  "run-task",
  "message",
  "retry",
  "extend-timeout",
  "mark-done",
  "run-action",
  "edit-action",
  "approve-action",
  "deny-action",
  "cancel",
  "approve",
  "deny",
  "status",
  "inspect",
  "tui",
]);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function hasStateDir(args) {
  return args.includes("--state-dir");
}

export function resolveWorkspaceLocalInvocation({
  args = process.argv.slice(2),
  env = process.env,
  processCwd = process.cwd(),
} = {}) {
  const callerCwd = env.MAESTRO_CALLER_CWD || env.INIT_CWD || processCwd;
  const nextArgs = [...args];
  if (LOCAL_COMMANDS.has(nextArgs[0]) && !hasStateDir(nextArgs)) {
    nextArgs.push("--state-dir", path.join(PACKAGE_ROOT, DEFAULT_LOCAL_STATE_DIR));
  }
  return {
    args: nextArgs,
    cwd: callerCwd,
  };
}

function buildTracker(config) {
  return new LinearTrackerClient({
    endpoint: config.tracker.endpoint,
    apiKey: config.tracker.apiKey,
    projectSlug: config.tracker.projectSlug,
  });
}

function buildWorkspaceManager(config, logger) {
  return new WorkspaceManager({
    root: config.workspace.root,
    hooks: config.hooks,
    logger,
  });
}

function buildRuntime({ workflowStore, logger }) {
  const { config } = workflowStore.current;
  const tracker = buildTracker(config);
  const workspaceManager = buildWorkspaceManager(config, logger);
  const runner = new CodexAgentRunner({
    workflowStore,
    workspaceManager,
    tracker,
    logger,
  });
  const orchestrator = new MaestroOrchestrator({
    config,
    tracker,
    runner,
    workspaceManager,
    logger,
  });
  return { tracker, workspaceManager, runner, orchestrator };
}

async function applyReload({ workflowStore, runtime, logger, previous }) {
  const { config } = workflowStore.current;
  try {
    validateDispatchConfig(config);
  } catch (error) {
    workflowStore.current = previous;
    logger.error("workflow_reload_rejected", { error: error.message });
    return false;
  }

  runtime.tracker = buildTracker(config);
  runtime.workspaceManager = buildWorkspaceManager(config, logger);
  runtime.runner.tracker = runtime.tracker;
  runtime.runner.workspaceManager = runtime.workspaceManager;
  runtime.orchestrator.tracker = runtime.tracker;
  runtime.orchestrator.workspaceManager = runtime.workspaceManager;
  runtime.orchestrator.updateConfig(config);
  logger.info("workflow_reload_applied", { workflow_path: workflowStore.workflowPath });
  return true;
}

export async function startMaestro({ workflowPath, port = null, env = process.env, logger = new StructuredLogger() }) {
  const workflowStore = new WorkflowStore({ workflowPath, env, logger });
  await workflowStore.loadInitial();
  validateDispatchConfig(workflowStore.current.config);

  const runtime = buildRuntime({ workflowStore, logger });
  let stopWatch = () => {};
  stopWatch = workflowStore.watch((next, previous) => {
    workflowStore.current = next;
    void applyReload({ workflowStore, runtime, logger, previous });
  });

  const effectivePort = port ?? workflowStore.current.config.server.port;
  const httpServer = effectivePort === null
    ? null
    : await startMaestroHttpServer({
      orchestrator: runtime.orchestrator,
      port: effectivePort,
      host: "127.0.0.1",
    });
  if (httpServer) {
    logger.info("maestro_http_started", { host: httpServer.host, port: httpServer.port });
  }

  const poll = async () => {
    const previous = workflowStore.current;
    const reload = await workflowStore.reloadIfChanged();
    if (reload.changed) {
      logger.info("workflow_reload_seen", { workflow_path: workflowStore.workflowPath, previous_ok: Boolean(previous) });
    }
    try {
      validateDispatchConfig(workflowStore.current.config);
      await runtime.orchestrator.tick();
    } catch (error) {
      logger.error("maestro_tick_failed", { error: error.message });
    }
  };
  const interval = setInterval(() => {
    void poll();
  }, workflowStore.current.config.polling.intervalMs);
  void poll();

  return {
    workflowStore,
    runtime,
    httpServer,
    stop: async () => {
      clearInterval(interval);
      stopWatch();
      await runtime.orchestrator.stop();
      if (httpServer) await httpServer.close();
    },
  };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (LOCAL_COMMANDS.has(rawArgs[0])) {
    const invocation = resolveWorkspaceLocalInvocation({ args: rawArgs });
    await runLocalMaestroCommand(invocation);
    return;
  }

  const args = parseCliArgs(process.argv);
  const logger = new StructuredLogger();
  const service = await startMaestro({ ...args, logger });
  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function parseTaskArgs(args, cwd) {
  let mode = "task";
  let stateDir = path.resolve(cwd, DEFAULT_LOCAL_STATE_DIR);
  let taskCwd = null;
  let timeoutMs = null;
  let plannerPolicy = null;
  let reviewEnabled = null;
  let projectId = null;
  let worktreeMode = null;
  let forceParallel = false;
  const writePaths = [];
  const promptParts = [];

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      // End of options — everything after is literal prompt text.
      for (let j = index + 1; j < args.length; j++) promptParts.push(args[j]);
      break;
    }
    if (arg === "--plan-only") {
      mode = "plan-only";
      continue;
    }
    if (arg === "--state-dir") {
      index += 1;
      stateDir = path.resolve(cwd, args[index] ?? "");
      continue;
    }
    if (arg === "--cwd") {
      index += 1;
      taskCwd = path.resolve(cwd, args[index] ?? "");
      continue;
    }
    if (arg === "--timeout-ms") {
      index += 1;
      const parsed = Number(args[index]);
      if (!Number.isInteger(parsed) || (parsed <= 0 && parsed !== -1)) {
        throw new Error(`invalid_timeout_ms: ${args[index]}`);
      }
      timeoutMs = parsed;
      continue;
    }
    if (arg === "--planner") {
      index += 1;
      plannerPolicy = args[index] ?? "";
      if (!["auto", "on", "off"].includes(plannerPolicy)) {
        throw new Error(`invalid_planner_policy: ${plannerPolicy}`);
      }
      continue;
    }
    if (arg === "--review") {
      index += 1;
      const value = args[index] ?? "";
      if (!["on", "off"].includes(value)) {
        throw new Error(`invalid_review: ${value}`);
      }
      reviewEnabled = value === "on";
      continue;
    }
    if (arg === "--project") {
      index += 1;
      projectId = normalizeProjectId(args[index] ?? "");
      continue;
    }
    if (arg === "--worktree-mode") {
      index += 1;
      worktreeMode = args[index] ?? "";
      if (!["current-cwd", "project-worktree", "new-project", "auto"].includes(worktreeMode)) {
        throw new Error(`invalid_worktree_mode: ${worktreeMode}`);
      }
      continue;
    }
    if (arg === "--paths" || arg === "--path") {
      index += 1;
      writePaths.push(args[index] ?? "");
      continue;
    }
    if (arg === "--force-parallel") {
      forceParallel = true;
      continue;
    }
    promptParts.push(arg);
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error("missing_task_prompt");
  }
  return {
    mode,
    prompt,
    stateDir,
    taskCwd,
    timeoutMs,
    plannerPolicy,
    reviewEnabled,
    projectId,
    worktreeMode,
    forceParallel,
    writePaths: normalizeWritePaths(writePaths),
  };
}

function parseSharedStateArgs(args, cwd) {
  let stateDir = path.resolve(cwd, DEFAULT_LOCAL_STATE_DIR);
  const positional = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--state-dir") {
      index += 1;
      stateDir = path.resolve(cwd, args[index] ?? "");
      continue;
    }
    positional.push(arg);
  }
  return { stateDir, positional };
}

function parseActionArgs(args, cwd) {
  let stateDir = path.resolve(cwd, DEFAULT_LOCAL_STATE_DIR);
  let note = "";
  let forceParallel = false;
  let force = false;
  let timeoutMs = null;
  const positional = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--state-dir") {
      index += 1;
      stateDir = path.resolve(cwd, args[index] ?? "");
      continue;
    }
    if (arg === "--note") {
      index += 1;
      note = args[index] ?? "";
      continue;
    }
    if (arg === "--force-parallel") {
      forceParallel = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      index += 1;
      const parsed = Number(args[index]);
      if (!Number.isInteger(parsed) || (parsed <= 0 && parsed !== -1)) {
        throw new Error(`invalid_timeout_ms: ${args[index]}`);
      }
      timeoutMs = parsed;
      continue;
    }
    positional.push(arg);
  }
  return { stateDir, note, forceParallel, force, timeoutMs, positional };
}

function parseEditActionArgs(args, cwd) {
  let stateDir = path.resolve(cwd, DEFAULT_LOCAL_STATE_DIR);
  let note = "";
  const patch = {};
  let parsedArgsJson = null;
  const positional = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--state-dir") {
      index += 1;
      stateDir = path.resolve(cwd, args[index] ?? "");
      continue;
    }
    if (arg === "--note") {
      index += 1;
      note = args[index] ?? "";
      continue;
    }
    if (arg === "--cwd") {
      index += 1;
      patch.cwd = path.resolve(cwd, args[index] ?? "");
      continue;
    }
    if (arg === "--type") {
      index += 1;
      patch.type = args[index] ?? "";
      continue;
    }
    if (arg === "--git-type") {
      index += 1;
      patch.git_type = args[index] ?? "";
      continue;
    }
    if (arg === "--command") {
      index += 1;
      patch.command = args[index] ?? "";
      patch.provider = "host";
      patch.type = "host_command";
      continue;
    }
    if (arg === "--args-json") {
      index += 1;
      const parsed = JSON.parse(args[index] ?? "[]");
      if (!Array.isArray(parsed)) throw new Error("invalid_args_json");
      parsedArgsJson = parsed.map((item) => String(item ?? ""));
      continue;
    }
    if (arg === "--env-json") {
      index += 1;
      patch.env = sanitizeEnvObject(JSON.parse(args[index] ?? "{}"));
      patch.provider = "host";
      patch.type = "host_command";
      continue;
    }
    if (arg === "--timeout-ms") {
      index += 1;
      const parsed = Number(args[index]);
      if (!Number.isInteger(parsed) || (parsed <= 0 && parsed !== -1)) throw new Error(`invalid_timeout_ms: ${args[index]}`);
      patch.timeout_ms = parsed;
      continue;
    }
    positional.push(arg);
  }
  if (parsedArgsJson) {
    if (patch.provider === "host" || patch.type === "host_command") {
      patch.args = parsedArgsJson;
    } else {
      patch.normalized_args = normalizeGitActionArgs(parsedArgsJson);
    }
  }
  return { stateDir, note, patch, positional };
}

function parseInspectArgs(args, cwd, stdout = process.stdout) {
  let stateDir = path.resolve(cwd, DEFAULT_LOCAL_STATE_DIR);
  let json = false;
  let color = stdout.isTTY === true && !process.env.NO_COLOR;
  const positional = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--state-dir") {
      index += 1;
      stateDir = path.resolve(cwd, args[index] ?? "");
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--color") {
      color = true;
      continue;
    }
    if (arg === "--no-color") {
      color = false;
      continue;
    }
    positional.push(arg);
  }
  return { stateDir, json, color, positional };
}

function parseProjectArgs(args, cwd) {
  const action = args[1];
  let stateDir = path.resolve(cwd, DEFAULT_LOCAL_STATE_DIR);
  let target = null;
  let mergeMode = null;
  const positional = [];
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--state-dir") {
      index += 1;
      stateDir = path.resolve(cwd, args[index] ?? "");
      continue;
    }
    if (arg === "--target") {
      index += 1;
      target = args[index] ?? "";
      continue;
    }
    if (arg === "--merge-mode") {
      index += 1;
      mergeMode = args[index] ?? "";
      if (!["squash"].includes(mergeMode)) {
        throw new Error(`invalid_project_merge_mode: ${mergeMode}`);
      }
      continue;
    }
    positional.push(arg);
  }
  return { action, stateDir, target, mergeMode, positional };
}

function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

function feedbackReceipt({
  kind,
  message,
  executed = false,
  statusBefore = null,
  statusAfter = null,
  status_before = null,
  status_after = null,
  reason = null,
  actionId = null,
  action_id = null,
  detached = false,
  logPaths = [],
  log_paths = [],
  nextActions = [],
  next_actions = [],
} = {}) {
  return {
    kind: kind ?? "action",
    message: message ?? "",
    executed: Boolean(executed),
    status_before: statusBefore ?? status_before ?? null,
    status_after: statusAfter ?? status_after ?? null,
    reason: reason ?? null,
    action_id: actionId ?? action_id ?? null,
    detached: Boolean(detached),
    log_paths: [...new Set([...(logPaths ?? []), ...(log_paths ?? [])].filter(Boolean))],
    next_actions: [...new Set([...(nextActions ?? []), ...(next_actions ?? [])].filter(Boolean))],
  };
}

function openNextActions(task = {}) {
  return (task.unblock_options ?? [])
    .filter((option) => option.status === "open")
    .map((option) => option.id)
    .filter(Boolean);
}

function actionResultLogPaths(result = {}) {
  return [result.stdout_path, result.stderr_path].filter(Boolean);
}

function attachReceipt(result = {}, receipt = null) {
  if (!receipt) return result;
  const task = result?.task ?? null;
  return {
    ...result,
    receipt: feedbackReceipt({
      ...receipt,
      statusAfter: task?.status ?? receipt.status_after ?? receipt.statusAfter ?? null,
      detached: result?.detached === true || receipt.detached === true,
      nextActions: receipt.next_actions?.length ? receipt.next_actions : openNextActions(task ?? {}),
    }),
  };
}

function withReceipt(task, receipt) {
  return attachReceipt({ task }, receipt);
}

function writeResultReceipt(stdout, result) {
  if (result?.receipt) writeLine(stdout, formatFeedbackReceipt(result.receipt, { cli: true }));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function normalizeProjectId(value) {
  const id = slugifyTaskTitle(value).slice(0, 48);
  if (!id) throw new Error("missing_project_id");
  return id;
}

function normalizeWritePaths(values = []) {
  return values
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter((value, index, all) => all.indexOf(value) === index);
}

function defaultGitRunner({ args = [], cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: 0 });
    });
  });
}

function defaultHostRunner({
  command,
  args = [],
  cwd = process.cwd(),
  env = {},
  timeoutMs = null,
} = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: 0 });
    });
  });
}

async function runGit(gitRunner, cwd, args) {
  return gitRunner({ args, cwd });
}

async function gitStdout(gitRunner, cwd, args) {
  const result = await runGit(gitRunner, cwd, args);
  return String(result.stdout ?? "").trim();
}

async function gitSucceeds(gitRunner, cwd, args) {
  try {
    await runGit(gitRunner, cwd, args);
    return true;
  } catch {
    return false;
  }
}

function hashText(value = "") {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

async function safeGitStdout(gitRunner, cwd, args) {
  try {
    return await gitStdout(gitRunner, cwd, args);
  } catch {
    return "";
  }
}

async function readGitSnapshot(gitRunner, cwd) {
  const [branch, head, statusResult, remoteUrl] = await Promise.all([
    safeGitStdout(gitRunner, cwd, ["branch", "--show-current"]),
    safeGitStdout(gitRunner, cwd, ["rev-parse", "HEAD"]),
    runGit(gitRunner, cwd, ["status", "--porcelain"]).catch(() => ({ stdout: "" })),
    safeGitStdout(gitRunner, cwd, ["config", "--get", "remote.origin.url"]),
  ]);
  const statusText = String(statusResult.stdout ?? "");
  return {
    branch,
    head,
    status_text: statusText,
    status_hash: hashText(statusText),
    remote_url: remoteUrl,
  };
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

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

function detectGitPublishIntent(prompt = "") {
  const text = String(prompt ?? "");
  const operations = GIT_PUBLISH_PATTERNS
    .filter(({ operation, pattern }) => pattern.test(text) && !isNegatedGitOperation(text, operation))
    .map(({ operation }) => operation);
  return {
    required: operations.length > 0,
    operations,
  };
}

function gitPublishBlockerForTask(task) {
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

function actionTypeForOperation(operation) {
  if (operation === "commit") return "git_commit";
  if (operation === "merge") return "git_merge";
  if (operation === "push") return "git_push";
  if (operation === "fetch") return "git_fetch";
  if (operation === "pull") return "git_pull";
  return null;
}

function operationForActionType(type) {
  return String(type ?? "").replace(/^git_/, "");
}

function normalizeGitActionArgs(args = []) {
  const normalized = Array.isArray(args)
    ? args.map((arg) => String(arg ?? "")).filter((arg) => arg !== "")
    : [];
  return normalized[0] === "git" ? normalized.slice(1) : normalized;
}

function normalizeActionRequest(request = {}) {
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

function gitTypeForActionRequest(request = {}) {
  if (request.type === "external_cwd_git") return request.git_type || inferGitActionTypeFromArgs(request.normalized_args);
  return request.type;
}

function operationForActionRequest(request = {}) {
  return operationForActionType(gitTypeForActionRequest(request));
}

function extractMergeSource(prompt = "") {
  const text = String(prompt ?? "");
  const match = text.match(/\bmerge\s+(?:from\s+)?([A-Za-z0-9._/-]+)/i);
  if (!match) return null;
  const source = match[1];
  if (["from", "to", "into", "main", "branch", "feature", "the"].includes(source.toLowerCase())) return null;
  return source;
}

function actionableActionRequests(task = {}) {
  return (task.action_requests ?? []).filter((request) => ["pending", "failed", "expired"].includes(request.status));
}

function canApproveAction(request = {}) {
  return ["pending", "failed", "expired"].includes(request.status);
}

function taskHasBlocker(task = {}, code) {
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

function buildUnblockOptions({ task, actionRequests = [], includeAnswer = false, includeRetry = false, includeManualDone = false } = {}) {
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

function hasResolvedGitIntent(task, intent) {
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

async function buildNextGitActionRequestForTask({ task, taskCwd, gitRunner }) {
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

function projectWorktreeRoot(cwd, config) {
  return path.resolve(cwd, config.worktree_root ?? ".maestro/worktrees");
}

function nowIso() {
  return new Date().toISOString();
}

const REVIEW_MAX_STRING_BYTES = 2_000;
const REVIEW_MAX_CONTINUATIONS = 1;
const GIT_ACTION_TYPES = new Set(["git_commit", "git_merge", "git_push", "git_fetch", "git_pull"]);
const ACTION_REQUEST_TYPES = new Set([...GIT_ACTION_TYPES, "external_cwd_git", "host_command"]);

function trimUtf8Bytes(value, maxBytes = REVIEW_MAX_STRING_BYTES) {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8").trim();
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/�$/g, "").trim();
}

function sanitizeReviewString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return trimUtf8Bytes(value, REVIEW_MAX_STRING_BYTES) || fallback;
}

// Keys that can subvert process execution regardless of intent — see ENV_KEY_DENYLIST for full list
const ENV_KEY_DENYLIST = /^(LD_|DYLD_|PATH$|IFS$|BASH_ENV$|ENV$|NODE_OPTIONS$|NODE_PATH$|PYTHON(STARTUP|PATH|HOME|BREAKPOINT)$|PERL(5OPT|5LIB|5DB|_UNICODE)$|RUBYOPT$|RUBYLIB$|JAVA_TOOL_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$|GCONV_PATH$|LOCPATH$|HOSTALIASES$|GIT_SSH|GIT_EXTERNAL_DIFF|GIT_PROXY|GIT_CONFIG)/i;

function sanitizeEnvObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 24)
      .map(([key, entry]) => [sanitizeReviewString(key), sanitizeReviewString(entry, "")])
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !ENV_KEY_DENYLIST.test(key)),
  );
}

async function assertMaestroRootIgnored({ gitRunner, cwd }) {
  try {
    await runGit(gitRunner, cwd, ["check-ignore", "-q", ".maestro/"]);
  } catch {
    throw new Error("maestro_root_not_ignored: add .maestro/ to .gitignore before using project worktrees");
  }
}

async function assertCleanTarget({ gitRunner, cwd, targetBranch }) {
  const status = await gitStdout(gitRunner, cwd, ["status", "--porcelain"]);
  if (status) {
    throw new Error(`dirty_target_branch: ${targetBranch} has uncommitted changes; commit first or use current-cwd mode`);
  }
}

async function assertBranchUnused({ gitRunner, cwd, branch }) {
  const exists = await gitSucceeds(gitRunner, cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (exists) throw new Error(`branch_exists: ${branch}`);
}

async function countWorktrees(worktreeRoot) {
  try {
    const projects = await fs.readdir(worktreeRoot, { withFileTypes: true });
    let count = 0;
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const entries = await fs.readdir(path.join(worktreeRoot, project.name), { withFileTypes: true });
      count += entries.filter((entry) => entry.isDirectory()).length;
    }
    return count;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function createProject({ taskStore, id, target, cwd, stdout, gitRunner }) {
  const config = await taskStore.readConfig();
  const projectId = normalizeProjectId(id);
  await assertMaestroRootIgnored({ gitRunner, cwd });
  const currentBranch = await gitStdout(gitRunner, cwd, ["branch", "--show-current"]);
  const targetBranch = target || currentBranch || "main";
  await assertCleanTarget({ gitRunner, cwd, targetBranch });
  const worktreeRoot = projectWorktreeRoot(cwd, config);
  const ownedCount = await countWorktrees(worktreeRoot);
  if (ownedCount >= (config.max_parallel_worktrees ?? 4)) {
    throw new Error(`max_parallel_worktrees_exceeded: ${ownedCount}`);
  }

  const integrationBranch = `maestro/${projectId}/integration`;
  await assertBranchUnused({ gitRunner, cwd, branch: integrationBranch });
  const integrationWorktree = path.join(worktreeRoot, projectId, "integration");
  const targetHead = await gitStdout(gitRunner, cwd, ["rev-parse", "HEAD"]);
  await fs.mkdir(path.dirname(integrationWorktree), { recursive: true });
  await runGit(gitRunner, cwd, ["worktree", "add", "-b", integrationBranch, integrationWorktree, targetBranch]);

  const localFileWarnings = [];
  if (await pathExists(path.join(cwd, ".env"))) {
    localFileWarnings.push({ path: ".env", status: "not_copied", sensitive: true });
  }

  const createdAt = nowIso();
  const project = await taskStore.createProject({
    id: projectId,
    status: "open",
    target_branch: targetBranch,
    target_head: targetHead,
    integration_branch: integrationBranch,
    integration_worktree: integrationWorktree,
    worktree_root: worktreeRoot,
    created_at: createdAt,
    updated_at: createdAt,
    tasks: [],
    path_leases: {},
    blockers: [],
    cleanup_blockers: [],
    local_file_warnings: localFileWarnings,
    ledger: [{
      event: "project_created",
      target_branch: targetBranch,
      target_head: targetHead,
      integration_branch: integrationBranch,
      integration_worktree: integrationWorktree,
      at: createdAt,
    }],
  });
  writeLine(stdout, `project ${project.id} open ${project.integration_branch}`);
  for (const warning of localFileWarnings) {
    writeLine(stdout, `local file ${warning.path} not copied (${warning.sensitive ? "sensitive" : "local"})`);
  }
  return { project };
}

function conflictingLeases(project, writePaths = [], { ignoreTaskId = null } = {}) {
  const leases = project.path_leases ?? {};
  return writePaths
    .filter((target) => leases[target] && leases[target].task_id !== ignoreTaskId)
    .map((target) => ({ path: target, ...leases[target] }));
}

function taskAliasForProject(project, prompt) {
  const base = slugifyTaskTitle(prompt).slice(0, 48) || "task";
  const used = new Set((project.tasks ?? []).map((task) => task.alias).filter(Boolean));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

async function addProjectTaskRecord(taskStore, project, record) {
  const next = await taskStore.updateProject(project.id, {
    tasks: [
      ...(project.tasks ?? []),
      record,
    ],
  });
  return next;
}

async function upsertProjectTaskRecord(taskStore, project, record) {
  const records = project.tasks ?? [];
  const exists = records.some((item) => item.id === record.id);
  const tasks = exists
    ? records.map((item) => (item.id === record.id ? { ...item, ...record } : item))
    : [...records, record];
  return taskStore.updateProject(project.id, { tasks });
}

async function acquirePathLeases(taskStore, projectId, taskId, writePaths) {
  if (writePaths.length === 0) return;
  const project = await taskStore.readProject(projectId);
  const pathLeases = { ...(project.path_leases ?? {}) };
  for (const writePath of writePaths) {
    pathLeases[writePath] = { task_id: taskId, mode: "write" };
  }
  await taskStore.updateProject(projectId, { path_leases: pathLeases });
}

async function releasePathLeases(taskStore, task) {
  if (!task.project_id || !task.write_paths?.length) return;
  const project = await taskStore.readProject(task.project_id);
  const pathLeases = { ...(project.path_leases ?? {}) };
  for (const writePath of task.write_paths) {
    if (pathLeases[writePath]?.task_id === task.id) delete pathLeases[writePath];
  }
  await taskStore.updateProject(task.project_id, { path_leases: pathLeases });
}

async function currentPathConflicts(taskStore, task) {
  if (!task.project_id || !task.write_paths?.length) return [];
  const project = await taskStore.readProject(task.project_id);
  return conflictingLeases(project, task.write_paths, { ignoreTaskId: task.id });
}

async function ensureProjectTaskSetup({ taskStore, task, cwd, gitRunner }) {
  if (!task.project_id) return task;
  let project = await taskStore.readProject(task.project_id);
  const existing = (project.tasks ?? []).find((record) => record.id === task.id) ?? null;
  let branch = task.branch ?? existing?.branch ?? null;
  let worktreePath = task.worktree_path ?? existing?.worktree_path ?? null;
  let taskCwd = task.cwd;
  let alias = existing?.alias ?? (branch ? branch.split("/").at(-1) : null);

  if (task.worktree_mode === "project-worktree" && (!branch || !worktreePath)) {
    alias = alias || taskAliasForProject(project, task.prompt);
    branch = `maestro/${project.id}/task/${alias}`;
    await assertBranchUnused({ gitRunner, cwd, branch });
    worktreePath = path.join(project.worktree_root, project.id, alias);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(gitRunner, cwd, ["worktree", "add", "-b", branch, worktreePath, project.integration_branch]);
    taskCwd = worktreePath;
  }

  const patch = {};
  if (branch !== task.branch) patch.branch = branch;
  if (worktreePath !== task.worktree_path) patch.worktree_path = worktreePath;
  if (taskCwd && taskCwd !== task.cwd) patch.cwd = taskCwd;
  if (Object.keys(patch).length > 0) {
    task = await taskStore.updateTask(task.id, patch);
  }

  project = await taskStore.readProject(task.project_id);
  await upsertProjectTaskRecord(taskStore, project, {
    id: task.id,
    alias: alias || slugifyTaskTitle(task.prompt),
    branch,
    worktree_path: worktreePath,
    write_paths: task.write_paths ?? [],
    status: task.status ?? "queued",
  });
  return taskStore.readTask(task.id);
}

async function createLocalTaskFromParsed({ parsed, taskStore, defaults, cwd, gitRunner, stdout = process.stdout }) {
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

async function markProjectTaskStatus(taskStore, task, status, patch = {}) {
  if (!task.project_id) return null;
  const project = await taskStore.readProject(task.project_id);
  return taskStore.updateProject(task.project_id, {
    tasks: (project.tasks ?? []).map((record) => (
      record.id === task.id ? { ...record, status, ...patch } : record
    )),
  });
}

async function recordProjectBlocker(taskStore, projectId, blocker) {
  const project = await taskStore.readProject(projectId);
  return taskStore.updateProject(projectId, {
    blockers: [
      ...(project.blockers ?? []),
      { ...blocker, at: nowIso() },
    ],
  });
}

function gitActionIsRemote(type) {
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

function unsafeGitActionReason(request, task = null, { allowExternalCwd = false, hostCommandAllow = [] } = {}) {
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

async function markStaleActionRequest({ taskStore, task, request, reason }) {
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

async function validateActionFreshness({ gitRunner, task, request }) {
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

async function validateManualDoneObservation({ gitRunner, task, request }) {
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

async function blockUnsupportedGitAction({ taskStore, task, blocker, stderr }) {
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

async function settleActionGate({ taskStore, taskId, cwd, stdout, stderr, gitRunner, continuationPrompt, preferAgentContinuation = false }) {
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

function classifyBrokerFailure(error, request) {
  const text = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
  if (/conflict|CONFLICT/i.test(text) || gitTypeForActionRequest(request) === "git_merge") return "merge_conflict";
  if (/auth|permission denied|protected branch|network|could not resolve|eai_again|403|401/i.test(text)) return "needs_user";
  return "failed";
}

function exitCodeFromError(error) {
  return Number.isInteger(error?.code) ? error.code : 1;
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

async function executeApprovedAction({
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

async function recoverStaleRunningTasks(taskStore) {
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

async function finalizeProjectTask({ taskStore, task, gitRunner, stdout }) {
  if (!task.project_id) return task;
  await releasePathLeases(taskStore, task);
  await markProjectTaskStatus(taskStore, task, "succeeded");
  if (!task.branch || !task.worktree_path) return task;

  const dirty = await gitStdout(gitRunner, task.worktree_path, ["status", "--porcelain"]);
  if (dirty) {
    await runGit(gitRunner, task.worktree_path, ["add", "-A"]);
    await runGit(gitRunner, task.worktree_path, ["commit", "-m", `maestro: ${task.id}`]);
  }
  const project = await taskStore.readProject(task.project_id);
  try {
    await runGit(gitRunner, project.integration_worktree, ["merge", "--no-ff", task.branch, "-m", `maestro: merge ${task.id}`]);
    writeLine(stdout, `task ${task.id} merged into ${project.integration_branch}`);
    return taskStore.updateTask(task.id, {
      blockers: (task.blockers ?? []).filter((blocker) => blocker.code !== "task_merge_conflict"),
      unblock_options: [],
    });
  } catch (error) {
    let abortResult = null;
    try {
      const abort = await runGit(gitRunner, project.integration_worktree, ["merge", "--abort"]);
      abortResult = { code: 0, stdout: abort.stdout ?? "", stderr: abort.stderr ?? "" };
    } catch (abortError) {
      abortResult = { code: exitCodeFromError(abortError), stdout: abortError.stdout ?? "", stderr: abortError.stderr ?? abortError.message };
    }
    const blocker = {
      code: "task_merge_conflict",
      task_id: task.id,
      branch: task.branch,
      integration_worktree: project.integration_worktree,
      error: error.message,
      merge_abort: abortResult,
    };
    await recordProjectBlocker(taskStore, task.project_id, blocker);
    await markProjectTaskStatus(taskStore, task, "waiting_user", { blocker });
    const nextTask = {
      ...task,
      blockers: [
        blocker,
        ...(task.blockers ?? []).filter((item) => item.code !== "task_merge_conflict"),
      ],
    };
    return taskStore.updateTask(task.id, {
      status: "waiting_user",
      active_step: null,
      blockers: nextTask.blockers,
      unblock_options: buildUnblockOptions({
        task: nextTask,
        includeRetry: true,
        includeManualDone: true,
      }),
    });
  }
}

async function runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner }) {
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
  return runLangGraphTask(taskId, {
    taskStore,
    maestroRoot: taskStore.root,
    runner,
    stdout,
    stderr,
    gitRunner,
    ops: {
      buildUnblockOptions,
      canonicalizeActionRequestsForTask,
      releasePathLeases: (t) => releasePathLeases(taskStore, t),
      markProjectTaskStatus: (t, s, p) => markProjectTaskStatus(taskStore, t, s, p),
      recordProjectBlocker: (pid, b) => recordProjectBlocker(taskStore, pid, b),
      finalizeProjectTask: (t) => finalizeProjectTask({ taskStore, task: t, gitRunner, stdout }),
      gitRunner,
    },
  });
}

async function startDetachedLocalTask({
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

function startDetachedExistingTask({
  task,
  cwd,
  taskStore,
  spawnProcess,
}) {
  const child = spawnProcess(process.execPath, [
    fileURLToPath(import.meta.url),
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

function resumeQueuedTask({
  task,
  taskStore,
  taskId = task?.id,
  cwd,
  stdout,
  stderr,
  runner,
  gitRunner,
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
  return runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner });
}

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

async function closeProject({ taskStore, id, cwd, stdout, gitRunner, mergeMode = "squash" }) {
  const project = await taskStore.readProject(normalizeProjectId(id));
  if (mergeMode !== "squash") throw new Error(`unsupported_project_merge_mode: ${mergeMode}`);
  try {
    await runGit(gitRunner, cwd, ["switch", project.target_branch]);
    await runGit(gitRunner, cwd, ["merge", "--squash", project.integration_branch]);
    await runGit(gitRunner, cwd, ["commit", "-m", `maestro: close ${project.id}`]);
    const targetMergeCommit = await gitStdout(gitRunner, cwd, ["rev-parse", "HEAD"]);
    const closed = await taskStore.updateProject(project.id, {
      status: "closed",
      target_merge_commit: targetMergeCommit,
      ledger: [
        ...(project.ledger ?? []),
        {
          event: "project_closed",
          mode: "squash",
          target_merge_commit: targetMergeCommit,
          at: nowIso(),
        },
      ],
    });
    writeLine(stdout, `project ${project.id} closed ${targetMergeCommit}`);
    return { project: closed };
  } catch (error) {
    const mergeFix = await taskStore.createTask({
      prompt: `Resolve Maestro merge conflict for project ${project.id}`,
      mode: "merge-fix",
      cwd: project.integration_worktree,
      plannerPolicy: "off",
      reviewEnabled: true,
      projectId: project.id,
      worktreeMode: "current-cwd",
    });
    const blocked = await taskStore.updateProject(project.id, {
      status: "close_blocked",
      blockers: [
        ...(project.blockers ?? []),
        {
          code: "target_merge_conflict",
          task_id: mergeFix.id,
          error: error.message,
          at: nowIso(),
        },
      ],
      tasks: [
        ...(project.tasks ?? []),
        {
          id: mergeFix.id,
          alias: "merge-fix",
          branch: project.integration_branch,
          worktree_path: project.integration_worktree,
          status: "queued",
        },
      ],
    });
    writeLine(stdout, `project ${project.id} close blocked: merge conflict`);
    return { project: blocked, task: mergeFix };
  }
}

async function cleanupProject({ taskStore, id, cwd, stdout, gitRunner }) {
  const project = await taskStore.readProject(normalizeProjectId(id));
  const cleanupBlockers = [];
  const cleaned = [];
  for (const task of project.tasks ?? []) {
    if (!task.worktree_path) continue;
    if (!isInside(project.worktree_root, task.worktree_path)) {
      cleanupBlockers.push({
        task_id: task.id,
        code: "worktree_outside_project_root",
        worktree_path: task.worktree_path,
      });
      continue;
    }
    const status = await gitStdout(gitRunner, task.worktree_path, ["status", "--porcelain"]);
    if (status) {
      const patch = await gitStdout(gitRunner, task.worktree_path, ["diff"]);
      const patchPath = path.join(taskStore.patchesDir, `${task.id}.patch`);
      await fs.writeFile(patchPath, `${patch}${patch.endsWith("\n") ? "" : "\n"}`);
      cleanupBlockers.push({
        task_id: task.id,
        code: "dirty_worktree",
        worktree_path: task.worktree_path,
        patch_path: patchPath,
      });
      continue;
    }
    await runGit(gitRunner, cwd, ["worktree", "remove", task.worktree_path]);
    if (project.delete_closed_project_branches !== false && task.branch) {
      const mergedIntoIntegration = await gitSucceeds(gitRunner, cwd, ["merge-base", "--is-ancestor", task.branch, project.integration_branch]);
      if (mergedIntoIntegration) {
        await runGit(gitRunner, cwd, ["branch", "-d", task.branch]);
      }
    }
    cleaned.push(task.id);
  }
  if (cleanupBlockers.length === 0 && project.target_merge_commit && project.integration_worktree) {
    if (!isInside(project.worktree_root, project.integration_worktree)) {
      cleanupBlockers.push({
        code: "integration_worktree_outside_project_root",
        worktree_path: project.integration_worktree,
      });
    } else {
      const integrationStatus = await gitStdout(gitRunner, project.integration_worktree, ["status", "--porcelain"]);
      if (integrationStatus) {
        const patch = await gitStdout(gitRunner, project.integration_worktree, ["diff"]);
        const patchPath = path.join(taskStore.patchesDir, `${project.id}-integration.patch`);
        await fs.writeFile(patchPath, `${patch}${patch.endsWith("\n") ? "" : "\n"}`);
        cleanupBlockers.push({
          code: "dirty_integration_worktree",
          worktree_path: project.integration_worktree,
          patch_path: patchPath,
        });
      } else {
        await runGit(gitRunner, cwd, ["worktree", "remove", project.integration_worktree]);
        await runGit(gitRunner, cwd, ["branch", "-D", project.integration_branch]);
      }
    }
  }
  const nextStatus = cleanupBlockers.length > 0 ? "cleanup_blocked" : project.status;
  const updated = await taskStore.updateProject(project.id, {
    status: nextStatus,
    cleanup_blockers: cleanupBlockers,
    cleaned_worktrees: cleaned,
  });
  writeLine(stdout, `project ${project.id} cleanup ${nextStatus}`);
  return { project: updated };
}

async function runProjectCommand({ args, cwd, stdout, store, gitRunner }) {
  const parsed = parseProjectArgs(args, cwd);
  const taskStore = makeStore(parsed, store);
  const projectId = parsed.positional[0];
  if (parsed.action === "create") {
    if (!projectId) throw new Error("missing_project_id");
    return createProject({
      taskStore,
      id: projectId,
      target: parsed.target,
      cwd,
      stdout,
      gitRunner,
    });
  }
  if (parsed.action === "status") {
    const projects = await taskStore.listProjects();
    if (projects.length === 0) {
      writeLine(stdout, "No Maestro projects");
    }
    for (const project of projects) {
      writeLine(stdout, `${project.id} ${project.status} ${project.target_branch ?? "-"}`);
    }
    return { projects };
  }
  if (parsed.action === "inspect") {
    if (!projectId) throw new Error("missing_project_id");
    const project = await taskStore.readProject(normalizeProjectId(projectId));
    writeLine(stdout, JSON.stringify(project, null, 2));
    return { project };
  }
  if (parsed.action === "sync-target") {
    if (!projectId) throw new Error("missing_project_id");
    const project = await taskStore.readProject(normalizeProjectId(projectId));
    const targetHead = await gitStdout(gitRunner, cwd, ["rev-parse", "HEAD"]);
    const updated = await taskStore.updateProject(project.id, {
      target_head: targetHead,
      target_synced_at: nowIso(),
    });
    writeLine(stdout, `project ${project.id} target ${targetHead}`);
    return { project: updated };
  }
  if (parsed.action === "close") {
    if (!projectId) throw new Error("missing_project_id");
    const config = await taskStore.readConfig();
    return closeProject({
      taskStore,
      id: projectId,
      cwd,
      stdout,
      gitRunner,
      mergeMode: parsed.mergeMode ?? config.project_close_merge_mode ?? "squash",
    });
  }
  if (parsed.action === "cleanup") {
    if (!projectId) throw new Error("missing_project_id");
    return cleanupProject({ taskStore, id: projectId, cwd, stdout, gitRunner });
  }
  throw new Error(`unknown_project_command: ${parsed.action}`);
}

function makeStore(parsed, store) {
  return store ?? new LocalTaskStore({ root: parsed.stateDir });
}

export async function runLocalMaestroCommand({
  args,
  cwd = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  store = null,
  runner = null,
  gitRunner = defaultGitRunner,
  hostRunner = defaultHostRunner,
  onTaskCreated = null,
  spawnProcess = spawn,
} = {}) {
  const command = args[0];

  if (command === "project") {
    return runProjectCommand({ args, cwd, stdout, store, gitRunner });
  }

  if (command === "tui") {
    const parsed = parseSharedStateArgs(args, cwd);
    const taskStore = makeStore(parsed, store);
    return runMaestroTui({
      cwd,
      stdout,
      stdin,
      store: taskStore,
      runTask: (form, callbacks = {}) => startDetachedLocalTask({
        form,
        cwd,
        taskStore,
        spawnProcess,
        onTaskCreated: callbacks.onTaskCreated,
        gitRunner,
      }),
      resumeTask: (task) => startDetachedExistingTask({
        task,
        cwd,
        taskStore,
        spawnProcess,
      }),
      approveAction: (task, actionId, note) => handleApproveAction({
        taskStore,
        taskId: task.id,
        actionId,
        note,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        hostRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
      runAction: (task, actionId, note) => handleRunAction({
        taskStore,
        taskId: task.id,
        actionId,
        note,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        hostRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
      denyAction: (task, actionId, note) => handleDenyAction({
        taskStore,
        taskId: task.id,
        actionId,
        note,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
      editAction: (task, actionId, patch, note) => handleEditAction({
        taskStore,
        taskId: task.id,
        actionId,
        patch,
        note,
        stdout,
      }),
      messageTask: async (task, note) => {
        const statusBefore = task.status;
        let updated = await taskStore.appendInteraction(task.id, {
          type: "message",
          actor: "user",
          body: note,
        });
        if (updated.status !== "running") {
          updated = await taskStore.incrementContinuationGeneration(task.id, {
            status: "queued",
            continuation_prompt: note ? `User message:\n${note}` : null,
          });
          const result = startDetachedExistingTask({
            task: updated,
            cwd,
            taskStore,
            spawnProcess,
          });
          return attachReceipt(result, feedbackReceipt({
            kind: "message",
            message: "message queued",
            executed: false,
            statusBefore,
            statusAfter: result.task?.status,
            detached: result.detached === true,
          }));
        }
        const result = { task: updated };
        return attachReceipt(result, feedbackReceipt({
          kind: "message",
          message: updated.status === "running" ? "message queued for continuation" : "message queued",
          executed: false,
          statusBefore,
          statusAfter: result.task?.status,
          detached: result.detached === true,
        }));
      },
      markDone: async (task, actionId, note, options = {}) => {
        const result = await handleMarkDone({
          taskStore,
          taskId: task.id,
          actionId,
          note,
          force: options.force === true,
          cwd,
          stdout,
          stderr,
          runner,
          gitRunner,
          resumeMode: "detached",
          spawnProcess,
        });
        return result.receipt ? result : attachReceipt(result, feedbackReceipt({
          kind: "mark-done",
          message: options.force === true ? "manual completion force-marked" : "manual completion checked",
          executed: false,
          statusBefore: task.status,
          statusAfter: result.task?.status,
          actionId,
          detached: result.detached === true,
        }));
      },
      extendTimeout: (task, timeoutMs, note) => handleExtendTimeout({
        taskStore,
        taskId: task.id,
        timeoutMs,
        note,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
      retryTask: (task, note, options = {}) => handleRetryTask({
        taskStore,
        taskId: task.id,
        note,
        forceParallel: options.forceParallel === true,
        cwd,
        stdout,
        stderr,
        runner,
        gitRunner,
        resumeMode: "detached",
        spawnProcess,
      }),
      cancelTask: (task, note) => handleCancelTask({
        taskStore,
        taskId: task.id,
        note,
        stdout,
      }),
    });
  }

  if (command === "task") {
    const parsed = parseTaskArgs(args, cwd);
    const taskStore = makeStore(parsed, store);
    const defaults = await taskStore.readConfig();
    const task = await createLocalTaskFromParsed({ parsed, taskStore, defaults, cwd, gitRunner, stdout });
    if (onTaskCreated) {
      onTaskCreated(task);
    }
    return runCreatedLocalTask({ taskStore, taskId: task.id, cwd, stdout, stderr, runner, gitRunner });
  }

  if (command === "run-task") {
    const parsed = parseSharedStateArgs(args, cwd);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    return runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner });
  }

  if (command === "approve" || command === "deny") {
    const parsed = parseActionArgs(args, cwd);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const approved = command === "approve";
    const before = await taskStore.readTask(taskId);
    const task = await taskStore.decideApproval(taskId, { approved, note: parsed.note });
    writeLine(stdout, `task ${task.id} approval ${approved ? "approved" : "denied"}`);
    let result = { task };
    if (task.status === "queued") {
      result = await runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner });
    }
    result = attachReceipt(result, feedbackReceipt({
      kind: command,
      message: `approval ${approved ? "approved" : "denied"}`,
      executed: false,
      statusBefore: before.status,
      statusAfter: result.task?.status,
      reason: approved ? null : "denied",
    }));
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "approve-action" || command === "deny-action" || command === "run-action") {
    const parsed = parseActionArgs(args, cwd);
    const [taskId, actionId] = parsed.positional;
    if (!taskId) throw new Error("missing_task_id");
    if (!actionId) throw new Error("missing_action_id");
    const taskStore = makeStore(parsed, store);
    let result;
    if (command === "deny-action") {
      result = await handleDenyAction({ taskStore, taskId, actionId, note: parsed.note, cwd, stdout, stderr, runner, gitRunner });
      writeResultReceipt(stdout, result);
      return result;
    }
    if (command === "run-action") {
      result = await handleRunAction({
        taskStore,
        taskId,
        actionId,
        note: parsed.note,
        cwd,
        gitRunner,
        hostRunner,
        stdout,
        stderr,
        runner,
      });
      writeResultReceipt(stdout, result);
      return result;
    }
    result = await handleApproveAction({
      taskStore,
      taskId,
      actionId,
      note: parsed.note,
      cwd,
      gitRunner,
      hostRunner,
      stdout,
      stderr,
      runner,
    });
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "edit-action") {
    const parsed = parseEditActionArgs(args, cwd);
    const [taskId, actionId] = parsed.positional;
    if (!taskId) throw new Error("missing_task_id");
    if (!actionId) throw new Error("missing_action_id");
    const taskStore = makeStore(parsed, store);
    const result = await handleEditAction({
      taskStore,
      taskId,
      actionId,
      patch: parsed.patch,
      note: parsed.note,
      stdout,
    });
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "message") {
    const parsed = parseActionArgs(args, cwd);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const before = await taskStore.readTask(taskId);
    let task = await taskStore.appendInteraction(taskId, {
      type: "message",
      actor: "user",
      body: parsed.note,
    });
    if (task.status === "running") {
      writeLine(stdout, `task ${task.id} message queued for continuation`);
      const result = withReceipt(task, feedbackReceipt({
        kind: "message",
        message: "message queued for continuation",
        executed: false,
        statusBefore: before.status,
        statusAfter: task.status,
      }));
      writeResultReceipt(stdout, result);
      return result;
    }
    task = await taskStore.incrementContinuationGeneration(taskId, {
      status: "queued",
      continuation_prompt: parsed.note ? `User message:\n${parsed.note}` : null,
    });
    writeLine(stdout, `task ${task.id} queued with message`);
    const resumed = await runCreatedLocalTask({ taskStore, taskId, cwd, stdout, stderr, runner, gitRunner });
    const result = attachReceipt(resumed, feedbackReceipt({
      kind: "message",
      message: "message queued",
      executed: false,
      statusBefore: before.status,
      statusAfter: resumed.task?.status,
    }));
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "retry") {
    const parsed = parseActionArgs(args, cwd);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const result = await handleRetryTask({
      taskStore,
      taskId,
      note: parsed.note,
      forceParallel: parsed.forceParallel,
      cwd,
      stdout,
      stderr,
      runner,
      gitRunner,
    });
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "extend-timeout") {
    const parsed = parseActionArgs(args, cwd);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    if (parsed.timeoutMs === null) throw new Error("missing_timeout_ms");
    const taskStore = makeStore(parsed, store);
    const before = await taskStore.readTask(taskId);
    const result = await handleExtendTimeout({
      taskStore,
      taskId,
      timeoutMs: parsed.timeoutMs,
      note: parsed.note,
      cwd,
      stdout,
      stderr,
      runner,
      gitRunner,
    });
    const withFallback = result.receipt ? result : attachReceipt(result, feedbackReceipt({
      kind: "extend-timeout",
      message: "timeout extended",
      executed: false,
      statusBefore: before.status,
      statusAfter: result.task?.status,
    }));
    writeResultReceipt(stdout, withFallback);
    return withFallback;
  }

  if (command === "mark-done") {
    const parsed = parseActionArgs(args, cwd);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const actionId = parsed.positional[1] ?? null;
    const taskStore = makeStore(parsed, store);
    const before = await taskStore.readTask(taskId);
    const result = await handleMarkDone({
      taskStore,
      taskId,
      actionId,
      note: parsed.note,
      force: parsed.force,
      cwd,
      stdout,
      stderr,
      runner,
      gitRunner,
    });
    const withFallback = result.receipt ? result : attachReceipt(result, feedbackReceipt({
      kind: "mark-done",
      message: parsed.force ? "manual completion force-marked" : "manual completion checked",
      executed: false,
      statusBefore: before.status,
      statusAfter: result.task?.status,
      actionId,
    }));
    writeResultReceipt(stdout, withFallback);
    return withFallback;
  }

  if (command === "cancel") {
    const parsed = parseActionArgs(args, cwd);
    const taskId = parsed.positional[0];
    if (!taskId) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const result = await handleCancelTask({ taskStore, taskId, note: parsed.note, stdout });
    writeResultReceipt(stdout, result);
    return result;
  }

  if (command === "status") {
    const parsed = parseSharedStateArgs(args, cwd);
    const taskStore = makeStore(parsed, store);
    const tasks = await recoverStaleRunningTasks(taskStore);
    if (tasks.length === 0) {
      writeLine(stdout, "No Maestro tasks");
    }
    for (const task of tasks) {
      writeLine(stdout, `${task.id} ${task.status} ${task.mode}`);
    }
    return { tasks };
  }

  if (command === "inspect") {
    const parsed = parseInspectArgs(args, cwd, stdout);
    const id = parsed.positional[0];
    if (!id) throw new Error("missing_task_id");
    const taskStore = makeStore(parsed, store);
    const task = await taskStore.readTask(id);
    writeLine(stdout, parsed.json
      ? JSON.stringify(task, null, 2)
      : formatTaskDetails(task, { color: parsed.color, sections: true }));
    return { task };
  }

  throw new Error(`unknown_local_command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`maestro_failed ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
