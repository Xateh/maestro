# Maestro MCP Server

Maestro exposes nine tools and one read-only resource via the
[Model Context Protocol](https://modelcontextprotocol.io) stdio transport. Any MCP-compatible
agent (Claude, Cursor, etc.) can use these to read Maestro state, validate workflow candidates,
and create tasks without shell access.

## Registration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "maestro": {
      "command": "node",
      "args": ["/absolute/path/to/maestro/src/mcp/server.mjs"]
    }
  }
}
```

The server auto-discovers the `.maestro/` state directory by walking up from its `cwd`, or from
the `MAESTRO_ROOT` env var.

---

## Tools

### `maestro_list_tasks`

List tasks, sorted newest-first. DB-aware: reads from the task store (SQLite
`maestro.db` by default, or PostgreSQL when `DATABASE_URL` is set) for
LangGraph engine tasks, then falls back to `tasks/*.json` for legacy tasks.

**Input**

| Field | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 20 | Max tasks to return |
| `status` | string | — | Filter by status (see below) |

**Status values:** `queued` · `running` · `waiting_user` · `succeeded` · `failed` · `blocked` · `cancelled` · `denied` · `expired` · `open` · `pending` · `reviewed` · `system`

**Output** — array of `{ id, prompt (120 chars), status, created_at, mode, engine? }`

---

### `maestro_show_task`

Full details for one task: task JSON + per-role handoffs + stdout log tails (8 KB each).

**Input** `{ id: string }` — required. Must match `^[0-9A-Za-z][0-9A-Za-z._-]*$`.

**Output**
- LangGraph tasks: `{ task, handoffs: Array<{role, provider, payload, log_path}>, logs: { [role]: string }, engine: "langgraph" }`
- Legacy tasks: `{ task, handoffs: { [role]: object }, logs: { [role]: string } }`

---

### `maestro_list_runs`

List `.maestro/runs/` directories sorted by mtime, newest first.

**Input** `{ limit?: number }` — default 20

**Output** — array of `{ name, mtime }`

---

### `maestro_show_run`

All files in one run directory. JSON files returned in full; log files tailed to 8 KB.

**Input** `{ id: string }` — required. Same ID validation as `maestro_show_task`.

**Output** `{ id, files: { [filename]: object|string } }`

---

### `maestro_create_task`

Spawn a new task. Launches `bin/maestro.mjs <mode> "<prompt>"` as a background process (non-blocking).

**Input**

| Field | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | — | Task description (required) |
| `mode` | string | `"task"` | `"task"` or `"plan-only"` |

**Output** `{ exitCode, taskId, stdout }` — `taskId` parsed from CLI output; may be `null` if unparseable.

---

### `maestro_get_state`

Runtime state snapshot. Tries `GET http://localhost:{port}/api/v1/state` first, falls back to
reading `config.json` + `workflow.json` + the task store (SQLite or PostgreSQL).

Sensitive keys are **redacted** before returning: anything matching
`*_key / *_token / *_secret / api_key / apikey / password / passwd`.

**Input** — none

**Output** — `{ config, workflow, activeTasks?, recentTasks? }`

---

### `maestro_read_workflow`

Returns the current `workflow.json` graph definition.

**Input** — none

**Output** `{ workflow_json: object|null }`

---

### `maestro_list_providers`

List configured providers from `.maestro/config.json` with read-only, offline-safe
preflight data. The tool checks local CLI reachability and whether declared provider
or alias env values resolve through Maestro's existing secret/env path. It does not
perform network calls or deep token validation.

**Input** — none

**Output**

```json
{
  "providers": [
    {
      "provider": "codex",
      "adapter": "built-in:codex",
      "default_alias": "codex",
      "models": ["gpt-5.5"],
      "capabilities": { "plan": true, "execute": true, "review": true },
      "permission": "read",
      "status": "ready"
    }
  ]
}
```

**Status values**

| Status | Meaning |
|---|---|
| `ready` | Default alias command resolves and any declared env refs resolve. |
| `missing_cli` | Default alias command is not found on PATH or as an interactive shell alias/function. |
| `missing_creds` | CLI is present, but at least one declared provider/alias env value is unresolved. |
| `disabled` | Provider has `enabled: false` in config. |
| `unknown` | Best-effort preflight could not determine status. |

Capability flags are an open map. Built-in adapters currently report
`plan`, `execute`, and `review`; provider config can override or extend that map
for future capabilities such as `image_gen`.

---

### `maestro_validate_workflow`

Validate a workflow. With no input, reads `.maestro/workflow.json` for backward
compatibility. With an inline `workflow` object, validates that candidate without
changing state, so clients can run an authoring repair loop before writing files.

Both paths first run the structural JSON Schema pre-check from
`schema/workflow.schema.json`. Structural failures return `bad_workflow_schema`
and do not run semantic validation. Structural success then runs
`validateWorkflow()` and returns its normal semantic `{ok, errors, warnings}`
verdict.

**Input**

| Field | Type | Default | Description |
|---|---|---|---|
| `workflow` | object | — | Optional inline workflow candidate. Omit to validate `.maestro/workflow.json`. |

**Output** `{ ok: boolean, errors: Array<{code, message}>, warnings: Array<{code, message}> }`
- Returns `{ ok: false, errors: [{code: "missing_workflow", ...}] }` when no
  readable `workflow.json` exists.
- Returns `{ ok: false, errors: [{code: "bad_workflow_schema", path, message}], warnings: [] }`
  when the schema pre-check fails.
- Inline validation is throttled per MCP session by `server.mcp.max_validate_attempts`
  (default `5`) and `server.mcp.validate_cooldown_ms` (default `60000`). At the
  limit, the tool returns `{ ok: false, errors: [{ code: "validate_attempts_exhausted",
  retry_after_ms }], warnings: [] }`. Disk-mode validation is exempt from this counter.

---

## Resources

### `maestro://schema/workflow.json`

Read-only JSON Schema resource for workflow authoring clients.

**ListResources** returns:

```json
{
  "uri": "maestro://schema/workflow.json",
  "name": "workflow.schema.json",
  "mimeType": "application/schema+json"
}
```

**ReadResource** returns the exact bytes of `schema/workflow.schema.json` as text
with MIME type `application/schema+json`.

---

## Validation Codes

| Code | Meaning |
|---|---|
| `bad_workflow_schema` | Structural schema-level rejection from `schema/workflow.schema.json`; returned before semantic validation on both disk and inline paths. |
| `validate_attempts_exhausted` | Inline repair-loop guard tripped; includes `retry_after_ms` telling the client when to retry. |

---

## Security

- Task and run IDs are validated against `^[0-9A-Za-z][0-9A-Za-z._-]*$` and path-verified to stay inside `.maestro/`. Invalid IDs throw `invalid_id`.
- Config output is redacted (see `maestro_get_state`).
- `maestro_create_task` spawns `bin/maestro.mjs` directly — no npm script dependency.

Full schema: [src/mcp/SCHEMA.md](../src/mcp/SCHEMA.md)
