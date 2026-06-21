// Server-mode config resolution. Supersedes the old dispatch front-matter
// loader: the raw shape now lives under config.json's `server` block and
// defaults are owned by src/task-store.mjs (DEFAULT_SERVER_CONFIG).

import os from "node:os";
import path from "node:path";

import { Liquid } from "liquidjs";

import {
  DEFAULT_ACTIVE_STATES,
  DEFAULT_SERVER_CONFIG,
  DEFAULT_TERMINAL_STATES,
} from "../task-store.mjs";

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

function positiveIntegerOrThrow(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw typedError(code, `expected positive integer, got ${value}`);
  }
  return parsed;
}

function listOfStrings(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item) => typeof item === "string");
}

// Resolve a "$VAR" reference against the environment. Plain strings pass
// through; an unresolved/empty ref becomes null.
export function resolveDollarValue(value, env) {
  if (typeof value !== "string") return value;
  if (!value.startsWith("$") || value.length === 1) return value;
  const resolved = env[value.slice(1)] ?? "";
  return resolved || null;
}

function expandPathValue(value, { env, baseDir }) {
  if (typeof value !== "string" || value.length === 0) return value ?? null;
  let expanded = value;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => env[key] ?? "");
  if (!expanded) return null;
  if (!path.isAbsolute(expanded)) {
    expanded = path.resolve(baseDir, expanded);
  }
  return path.normalize(expanded);
}

// Strict liquid render for the intake template → task prompt. Unknown variables
// or filters throw (no silent blanks in dispatched prompts).
export async function renderPrompt(template, context) {
  const source = template?.trim() || "You are working on an issue from the tracker.";
  try {
    return await PROMPT_ENGINE.parseAndRender(source, context);
  } catch (error) {
    throw typedError("template_render_error", error.message, error);
  }
}

// Resolve config.json's `server` block into effective camelCase values. baseDir
// is the directory relative paths (e.g. workspace.root) resolve against — the
// state directory's parent in practice.
export function resolveServerConfig(config, { env = process.env, baseDir = process.cwd() } = {}) {
  const raw = asObject(config?.server) ? config.server : {};
  const tracker = asObject(raw.tracker) ? raw.tracker : {};
  const polling = asObject(raw.polling) ? raw.polling : {};
  const workspace = asObject(raw.workspace) ? raw.workspace : {};
  const hooks = asObject(raw.hooks) ? raw.hooks : {};
  const agent = asObject(raw.agent) ? raw.agent : {};
  const ephemeral = asObject(raw.ephemeral) ? raw.ephemeral : {};
  const providers = asObject(raw.providers) ? raw.providers : {};

  const trackerKind = tracker.kind ?? DEFAULT_SERVER_CONFIG.tracker.kind;
  const trackerApiKey = resolveDollarValue(tracker.api_key ?? env.LINEAR_API_KEY ?? null, env);
  const trackerToken = resolveDollarValue(tracker.token ?? env.GITHUB_TOKEN ?? null, env);
  const notify = asObject(raw.notify) ? raw.notify : null;
  const workspaceRoot = expandPathValue(
    workspace.root ?? DEFAULT_SERVER_CONFIG.workspace.root,
    { env, baseDir },
  );

  const maxConcurrentAgentsByState = {};
  if (asObject(agent.max_concurrent_agents_by_state)) {
    for (const [state, value] of Object.entries(agent.max_concurrent_agents_by_state)) {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        maxConcurrentAgentsByState[state.toLowerCase()] = parsed;
      }
    }
  }

  const resolvedProviders = {};
  for (const [provider, providerConfig] of Object.entries(providers)) {
    if (!asObject(providerConfig)) continue;
    const rateLimit = providerConfig.rate_limit;
    if (!rateLimit) continue;
    if (!asObject(rateLimit)) {
      throw typedError("invalid_provider_rate_limit", `expected server.providers.${provider}.rate_limit to be an object`);
    }
    resolvedProviders[provider] = {
      capacity: positiveIntegerOrThrow(rateLimit.capacity, "invalid_provider_rate_limit"),
      refillPerSec: positiveIntegerOrThrow(rateLimit.refill_per_sec, "invalid_provider_rate_limit"),
    };
  }

  return {
    workflow: raw.workflow ?? DEFAULT_SERVER_CONFIG.workflow,
    port: raw.port === undefined ? null : nonNegativeInteger(raw.port, null, "invalid_port"),
    tracker: {
      kind: trackerKind,
      endpoint: tracker.endpoint ?? (trackerKind === "linear" ? "https://api.linear.app/graphql" : null),
      apiKey: trackerApiKey,
      projectSlug: tracker.project_slug ?? DEFAULT_SERVER_CONFIG.tracker.project_slug,
      // GitHub-specific fields
      owner: tracker.owner ?? null,
      repo: tracker.repo ?? null,
      label: tracker.label ?? "maestro",
      token: trackerToken,
      activeStates: listOfStrings(tracker.active_states, DEFAULT_ACTIVE_STATES),
      terminalStates: listOfStrings(tracker.terminal_states, DEFAULT_TERMINAL_STATES),
      doneState: tracker.done_state || null,
      blockedState: tracker.blocked_state || null,
    },
    notify: notify ? {
      on: Array.isArray(notify.on) ? notify.on : [],
      url: notify.url ?? null,
      format: notify.format ?? "generic",
    } : null,
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
      maxConcurrentRoles: positiveInteger(agent.max_concurrent_roles, 4, "invalid_max_concurrent_roles"),
      maxTurns: positiveInteger(agent.max_turns, 20, "invalid_max_turns"),
      maxRetryBackoffMs: positiveInteger(agent.max_retry_backoff_ms, 300_000, "invalid_max_retry_backoff_ms"),
      stallTimeoutMs: nonNegativeInteger(agent.stall_timeout_ms, 300_000, "invalid_stall_timeout"),
      maxConcurrentAgentsByState,
    },
    ephemeral: {
      enabled: ephemeral.enabled === true,
      commandAllowlist: listOfStrings(ephemeral.command_allowlist, []),
      providerAllowlist: listOfStrings(ephemeral.provider_allowlist, []),
      maxFanout: ephemeral.max_fanout === undefined ? 4 : Number(ephemeral.max_fanout),
      sandbox: ephemeral.sandbox ?? "required",
      gateRelaxation: ephemeral.gate_relaxation ?? "forbid",
      budget: asObject(ephemeral.budget) ? ephemeral.budget : {},
    },
    providers: resolvedProviders,
    intakeTemplate: raw.intake_template ?? DEFAULT_SERVER_CONFIG.intake_template,
  };
}

// Validate a resolved server config. No codex check (sandboxing moved to the
// graph engine's adapters).
export function validateServerConfig(config) {
  const { kind } = config.tracker;
  if (kind !== "linear" && kind !== "github") {
    // The two failure shapes read very differently to a first-time user: a
    // totally unconfigured tracker (kind absent) vs. an explicit but bad kind.
    // Either way point at the wizard that fixes it.
    const detail = kind
      ? `${kind} (only "linear" and "github" are supported) — run \`maestro setup tracker\` to configure it`
      : "no tracker configured — run `maestro setup tracker` to set up Linear (or pass --config <path>)";
    throw typedError("unsupported_tracker_kind", detail);
  }

  if (kind === "linear") {
    if (!config.tracker.apiKey) {
      throw typedError(
        "missing_tracker_api_key",
        "set LINEAR_API_KEY (or run `maestro setup keys --var LINEAR_API_KEY`, or rerun `maestro setup tracker`)",
      );
    }
    if (!config.tracker.projectSlug) {
      throw typedError(
        "missing_tracker_project_slug",
        "run `maestro setup tracker --project-slug <slug>`",
      );
    }
  }

  if (kind === "github") {
    if (!config.tracker.owner || !config.tracker.repo) {
      throw typedError(
        "missing_github_owner_repo",
        "set server.tracker.owner and server.tracker.repo in config.json",
      );
    }
    if (!config.tracker.token) {
      throw typedError(
        "missing_github_token",
        "set GITHUB_TOKEN (or server.tracker.token in config.json)",
      );
    }
  }

  if (config.tracker.doneState !== null && typeof config.tracker.doneState !== "string") {
    throw typedError("invalid_tracker_done_state", "expected string or null");
  }
  if (config.tracker.blockedState !== null && typeof config.tracker.blockedState !== "string") {
    throw typedError("invalid_tracker_blocked_state", "expected string or null");
  }

  const eph = config.ephemeral;
  if (eph) {
    if (eph.sandbox !== "required" && eph.sandbox !== "optional") {
      throw typedError("invalid_ephemeral_sandbox", `expected "required" or "optional", got ${eph.sandbox}`);
    }
    if (eph.gateRelaxation !== "forbid" && eph.gateRelaxation !== "allow") {
      throw typedError("invalid_ephemeral_gate_relaxation", `expected "forbid" or "allow", got ${eph.gateRelaxation}`);
    }
    if (!Number.isInteger(eph.maxFanout) || eph.maxFanout <= 0) {
      throw typedError("invalid_ephemeral_max_fanout", `expected positive integer, got ${eph.maxFanout}`);
    }
  }

  return true;
}
