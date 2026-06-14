import path from "node:path";

import { DEFAULT_LOCAL_STATE_DIR, LocalTaskStore, WORKFLOW_NAME_RE, slugifyTaskTitle } from "../task-store.mjs";

import { normalizeGitActionArgs } from "./git-intent.mjs";
import { sanitizeEnvObject } from "./util.mjs";

export function normalizeProjectId(value) {
  const id = slugifyTaskTitle(value).slice(0, 48);
  if (!id) throw new Error("missing_project_id");
  return id;
}

export function normalizeWritePaths(values = []) {
  return values
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter((value, index, all) => all.indexOf(value) === index);
}

export function makeStore(parsed, store) {
  return store ?? new LocalTaskStore({ root: parsed.stateDir });
}

export function parseTaskArgs(args, cwd) {
  let mode = "task";
  let workflow = "default";
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
    if (arg === "--mode") {
      index += 1;
      mode = args[index] ?? "";
      if (!/^[a-z0-9_-]+$/.test(mode)) {
        throw new Error(`invalid_mode: ${mode}`);
      }
      continue;
    }
    if (arg === "--workflow") {
      index += 1;
      workflow = args[index] ?? "";
      if (!WORKFLOW_NAME_RE.test(workflow)) {
        throw new Error(`invalid_workflow: ${workflow}`);
      }
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
    if (arg.startsWith("--")) {
      throw new Error(`unknown_flag: ${arg} (not a recognized flag for 'task'; use -- to pass literal text)`);
    }
    promptParts.push(arg);
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error("missing_task_prompt");
  }
  return {
    mode,
    workflow,
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

export function parseSharedStateArgs(args, cwd) {
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

export function parseActionArgs(args, cwd) {
  let stateDir = path.resolve(cwd, DEFAULT_LOCAL_STATE_DIR);
  let note = "";
  let forceParallel = false;
  let force = false;
  let timeoutMs = null;
  const positional = [];
  const unknownFlags = [];
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
    if (arg.startsWith("--")) {
      unknownFlags.push(arg);
      continue;
    }
    positional.push(arg);
  }
  return { stateDir, note, forceParallel, force, timeoutMs, positional, unknownFlags };
}

export function parseEditActionArgs(args, cwd) {
  let stateDir = path.resolve(cwd, DEFAULT_LOCAL_STATE_DIR);
  let note = "";
  const patch = {};
  let parsedArgsJson = null;
  const positional = [];
  const unknownFlags = [];
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
    if (arg.startsWith("--")) {
      unknownFlags.push(arg);
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
  return { stateDir, note, patch, positional, unknownFlags };
}

export function parseInspectArgs(args, cwd, stdout = process.stdout) {
  let stateDir = path.resolve(cwd, DEFAULT_LOCAL_STATE_DIR);
  let json = false;
  let color = stdout.isTTY === true && !process.env.NO_COLOR;
  const positional = [];
  const unknownFlags = [];
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
    if (arg.startsWith("--")) {
      unknownFlags.push(arg);
      continue;
    }
    positional.push(arg);
  }
  return { stateDir, json, color, positional, unknownFlags };
}

export function parseProjectArgs(args, cwd) {
  const action = args[1];
  let stateDir = path.resolve(cwd, DEFAULT_LOCAL_STATE_DIR);
  let target = null;
  let mergeMode = null;
  const positional = [];
  const unknownFlags = [];
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
    if (arg.startsWith("--")) {
      unknownFlags.push(arg);
      continue;
    }
    positional.push(arg);
  }
  return { action, stateDir, target, mergeMode, positional, unknownFlags };
}

// Returns any --flag items in `args` not present in `knownFlags`.
export function findUnknownFlags(args, knownFlags) {
  return args.filter((a) => a.startsWith("--") && !knownFlags.has(a));
}

function serverArgsError(code, message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

// Parse `maestro serve` flags. The server's tracker/workflow now come from
// config.json's `server` block, so there is no legacy dispatch-file flag or
// positional dispatch-file surface — only --config, --state-dir, --port.
export function parseServerArgs(argv = process.argv) {
  const args = argv.slice(2);
  let configPath = null;
  let stateDir = null;
  let port = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      const value = args[index + 1];
      index += 1;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw serverArgsError("invalid_port", String(value));
      }
      port = parsed;
      continue;
    }
    if (arg === "--config") {
      const value = args[index + 1];
      index += 1;
      if (!value) throw serverArgsError("missing_config_path");
      configPath = value;
      continue;
    }
    if (arg === "--state-dir") {
      const value = args[index + 1];
      index += 1;
      if (!value) throw serverArgsError("missing_state_dir");
      stateDir = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw serverArgsError("unknown_cli_arg", arg);
    }
    throw serverArgsError("unexpected_cli_arg", arg);
  }

  return { configPath, stateDir, port };
}
