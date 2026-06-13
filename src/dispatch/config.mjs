// Dispatch (server-mode) config resolution. The server reads the same
// `.maestro/config.json` the CLI/TUI use; the `dispatch` block holds the
// Linear-polling + concurrency settings. This module normalizes that block and
// resolves the Linear API key from the environment (never from config.json, so
// the shareable config stays secret-free — same contract as `setup keys`).

function typedError(code, detail = code) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function listOfStrings(value, fallback) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : fallback;
}

// Returns a normalized dispatch config or throws a typed, actionable error when
// the server cannot run (no tracker key/slug). `env` defaults to process.env.
export function resolveDispatchConfig(config, { env = process.env } = {}) {
  const dispatch = config?.dispatch ?? {};
  const tracker = dispatch.tracker ?? {};

  if ((tracker.kind ?? "linear") !== "linear") {
    throw typedError("unsupported_tracker_kind", tracker.kind ?? "missing");
  }
  const apiKey = env.LINEAR_API_KEY || null;
  if (!apiKey) {
    throw typedError(
      "missing_tracker_api_key",
      "set LINEAR_API_KEY (env or .maestro/secrets.local.json via `maestro setup keys`)",
    );
  }
  if (!tracker.project_slug) {
    throw typedError(
      "missing_tracker_project_slug",
      "set dispatch.tracker.project_slug in .maestro/config.json",
    );
  }

  return {
    enabled: dispatch.enabled === true,
    tracker: {
      kind: "linear",
      endpoint: tracker.endpoint || "https://api.linear.app/graphql",
      apiKey,
      projectSlug: tracker.project_slug,
      activeStates: listOfStrings(tracker.active_states, ["Todo", "In Progress"]),
      terminalStates: listOfStrings(
        tracker.terminal_states,
        ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
      ),
      doneState: tracker.done_state || null,
      blockedState: tracker.blocked_state || null,
    },
    polling: { intervalMs: positiveInt(dispatch.polling?.interval_ms, 30_000) },
    maxConcurrent: positiveInt(dispatch.max_concurrent, 1),
    maxConcurrentByState: dispatch.max_concurrent_by_state ?? {},
    maxRetryBackoffMs: positiveInt(dispatch.max_retry_backoff_ms, 300_000),
    worktreeMode: dispatch.worktree_mode || "current-cwd",
    promptTemplate: typeof dispatch.prompt_template === "string" ? dispatch.prompt_template : null,
    server: { port: dispatch.server?.port ?? null },
  };
}
