import { readFile, stat, watchFile, unwatchFile } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Liquid } from "liquidjs";
import YAML from "yaml";

import { nullLogger } from "./logger.mjs";

const readFileAsync = promisify(readFile);
const statAsync = promisify(stat);

export const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
export const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

const PROMPT_ENGINE = new Liquid({
  strictFilters: true,
  strictVariables: true,
});

function typedError(code, message = code, cause = null) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, fallback, code) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw typedError(code, `expected positive integer, got ${value}`);
  }
  return parsed;
}

function nonNegativeInteger(value, fallback, code) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw typedError(code, `expected non-negative integer, got ${value}`);
  }
  return parsed;
}

function listOfStrings(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item) => typeof item === "string");
}

export function resolveDollarValue(value, env) {
  if (typeof value !== "string") return value;
  if (!value.startsWith("$") || value.length === 1) return value;
  const resolved = env[value.slice(1)] ?? "";
  return resolved || null;
}

function expandPathValue(value, { env, baseDir }) {
  let expanded = resolveDollarValue(value, env);
  if (!expanded) return expanded;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => env[key] ?? "");
  if (!path.isAbsolute(expanded)) {
    expanded = path.resolve(baseDir, expanded);
  }
  return path.normalize(expanded);
}

function parseWorkflowText(text) {
  if (!text.startsWith("---")) {
    return { config: {}, promptTemplate: text.trim() };
  }

  const lines = text.split(/\r?\n/);
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      endIndex = index;
      break;
    }
  }
  if (endIndex === -1) {
    throw typedError("workflow_parse_error", "missing closing front matter delimiter");
  }

  let config;
  try {
    config = YAML.parse(lines.slice(1, endIndex).join("\n")) ?? {};
  } catch (error) {
    throw typedError("workflow_parse_error", error.message, error);
  }
  if (!asObject(config)) {
    throw typedError("workflow_front_matter_not_a_map", "front matter must decode to an object");
  }
  return {
    config,
    promptTemplate: lines.slice(endIndex + 1).join("\n").trim(),
  };
}

export async function loadWorkflowDefinition(workflowPath) {
  const resolvedPath = path.resolve(workflowPath);
  let text;
  try {
    text = await readFileAsync(resolvedPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw typedError("missing_workflow_file", resolvedPath, error);
    }
    throw typedError("workflow_parse_error", error.message, error);
  }

  const parsed = parseWorkflowText(text);
  return {
    path: resolvedPath,
    directory: path.dirname(resolvedPath),
    config: parsed.config,
    promptTemplate: parsed.promptTemplate,
  };
}

export function resolveEffectiveConfig(workflow, { env = process.env } = {}) {
  const raw = workflow.config ?? {};
  const tracker = asObject(raw.tracker) ? raw.tracker : {};
  const polling = asObject(raw.polling) ? raw.polling : {};
  const workspace = asObject(raw.workspace) ? raw.workspace : {};
  const hooks = asObject(raw.hooks) ? raw.hooks : {};
  const agent = asObject(raw.agent) ? raw.agent : {};
  const codex = asObject(raw.codex) ? raw.codex : {};
  const server = asObject(raw.server) ? raw.server : {};

  const trackerKind = tracker.kind ?? null;
  const trackerApiKey = resolveDollarValue(tracker.api_key ?? env.LINEAR_API_KEY ?? null, env);
  const workspaceRoot = expandPathValue(workspace.root ?? "/maestro_workspaces", {
    env,
    baseDir: workflow.directory,
  });
  const maxConcurrentAgentsByState = {};
  if (asObject(agent.max_concurrent_agents_by_state)) {
    for (const [state, value] of Object.entries(agent.max_concurrent_agents_by_state)) {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        maxConcurrentAgentsByState[state.toLowerCase()] = parsed;
      }
    }
  }

  const effectiveServer = {};
  if (server.port !== undefined) {
    effectiveServer.port = nonNegativeInteger(server.port, null, "invalid_port");
  } else {
    effectiveServer.port = null;
  }

  return {
    workflowPath: workflow.path,
    tracker: {
      kind: trackerKind,
      endpoint: tracker.endpoint ?? (trackerKind === "linear" ? "https://api.linear.app/graphql" : null),
      apiKey: trackerApiKey,
      projectSlug: tracker.project_slug ?? null,
      activeStates: listOfStrings(tracker.active_states, DEFAULT_ACTIVE_STATES),
      terminalStates: listOfStrings(tracker.terminal_states, DEFAULT_TERMINAL_STATES),
    },
    polling: {
      intervalMs: positiveInteger(polling.interval_ms, 30_000, "invalid_poll_interval"),
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: {
      afterCreate: hooks.after_create ?? null,
      beforeRun: hooks.before_run ?? null,
      afterRun: hooks.after_run ?? null,
      beforeRemove: hooks.before_remove ?? null,
      timeoutMs: positiveInteger(hooks.timeout_ms, 60_000, "invalid_hook_timeout"),
    },
    agent: {
      maxConcurrentAgents: positiveInteger(agent.max_concurrent_agents, 10, "invalid_max_concurrent_agents"),
      maxTurns: positiveInteger(agent.max_turns, 20, "invalid_max_turns"),
      maxRetryBackoffMs: positiveInteger(agent.max_retry_backoff_ms, 300_000, "invalid_max_retry_backoff_ms"),
      maxConcurrentAgentsByState,
    },
    codex: {
      command: codex.command ?? "codex app-server",
      approvalPolicy: codex.approval_policy ?? "never",
      threadSandbox: codex.thread_sandbox ?? "workspace-write",
      turnSandboxPolicy: codex.turn_sandbox_policy ?? {
        type: "workspaceWrite",
        networkAccess: false,
        writableRoots: [workspaceRoot],
      },
      turnTimeoutMs: positiveInteger(codex.turn_timeout_ms, 3_600_000, "invalid_turn_timeout"),
      readTimeoutMs: positiveInteger(codex.read_timeout_ms, 5_000, "invalid_read_timeout"),
      stallTimeoutMs: codex.stall_timeout_ms === undefined
        ? 300_000
        : Number(codex.stall_timeout_ms),
    },
    server: effectiveServer,
  };
}

export async function loadEffectiveWorkflow(workflowPath, options = {}) {
  const workflow = await loadWorkflowDefinition(workflowPath);
  return {
    workflow,
    config: resolveEffectiveConfig(workflow, options),
  };
}

export function validateDispatchConfig(config) {
  if (config.tracker.kind !== "linear") {
    throw typedError("unsupported_tracker_kind", config.tracker.kind ?? "missing");
  }
  if (!config.tracker.apiKey) {
    throw typedError("missing_tracker_api_key");
  }
  if (!config.tracker.projectSlug) {
    throw typedError("missing_tracker_project_slug");
  }
  if (!config.codex.command || typeof config.codex.command !== "string") {
    throw typedError("missing_codex_command");
  }
  return true;
}

export async function renderPrompt(template, context) {
  const source = template?.trim() || "You are working on an issue from Linear.";
  try {
    return await PROMPT_ENGINE.parseAndRender(source, context);
  } catch (error) {
    throw typedError("template_render_error", error.message, error);
  }
}

export function parseCliArgs(argv = process.argv) {
  const args = argv.slice(2);
  let workflowPath = null;
  let port = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      const value = args[index + 1];
      index += 1;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw typedError("invalid_port", value);
      }
      port = parsed;
      continue;
    }
    if (arg.startsWith("--")) {
      throw typedError("unknown_cli_arg", arg);
    }
    if (!workflowPath) {
      workflowPath = arg;
      continue;
    }
    throw typedError("unexpected_cli_arg", arg);
  }

  return {
    workflowPath: path.resolve(workflowPath ?? "WORKFLOW.md"),
    port,
  };
}

export class WorkflowStore {
  constructor({ workflowPath, env = process.env, logger = nullLogger() }) {
    this.workflowPath = path.resolve(workflowPath);
    this.env = env;
    this.logger = logger;
    this.current = null;
    this.lastMtimeMs = null;
    this.onReload = null;
  }

  async loadInitial() {
    this.current = await loadEffectiveWorkflow(this.workflowPath, { env: this.env });
    const fileStat = await statAsync(this.workflowPath);
    this.lastMtimeMs = fileStat.mtimeMs;
    return this.current;
  }

  async reload() {
    try {
      const previous = this.current;
      const next = await loadEffectiveWorkflow(this.workflowPath, { env: this.env });
      const fileStat = await statAsync(this.workflowPath);
      this.current = next;
      this.lastMtimeMs = fileStat.mtimeMs;
      this.logger.info("workflow_reload completed", { workflow_path: this.workflowPath });
      if (this.onReload) this.onReload(next, previous);
      return { ok: true, value: next };
    } catch (error) {
      this.logger.error("workflow_reload failed", {
        workflow_path: this.workflowPath,
        error: error.message,
      });
      return { ok: false, error };
    }
  }

  async reloadIfChanged() {
    let fileStat;
    try {
      fileStat = await statAsync(this.workflowPath);
    } catch (error) {
      this.logger.error("workflow_stat failed", { workflow_path: this.workflowPath, error: error.message });
      return { ok: false, error };
    }
    if (this.lastMtimeMs === fileStat.mtimeMs) {
      return { ok: true, value: this.current, changed: false };
    }
    const reloaded = await this.reload();
    return { ...reloaded, changed: reloaded.ok };
  }

  watch(callback) {
    this.onReload = callback;
    watchFile(this.workflowPath, { interval: 1_000 }, () => {
      void this.reload();
    });
    return () => unwatchFile(this.workflowPath);
  }
}
