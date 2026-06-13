# Maestro MCP Server

Maestro exposes eight tools via the [Model Context Protocol](https://modelcontextprotocol.io)
stdio transport. Any MCP-compatible agent (Claude, Cursor, etc.) can use these to read Maestro
state and create tasks without shell access.

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

Returns the current `workflow.json` and the optional `WORKFLOW.md` content.

**Input** — none

**Output** `{ workflow: object, workflowMd: string|null }`

---

### `maestro_validate_workflow`

Validate `.maestro/workflow.json`: structural errors (bad initial state,
dangling transitions, invalid modes, bad `max_visits`/`loop_limits`) and
warnings (unreachable roles, unknown providers, cycles without termination
clauses — each warning includes the recommended fix). Read-only; never mutates
anything.

**Input** — none

**Output** `{ ok: boolean, errors: Array<{code, message}>, warnings: Array<{code, message}> }`
- Returns `{ ok: false, errors: [{code: "missing_workflow", ...}] }` when no
  readable `workflow.json` exists.

---

## Security

- Task and run IDs are validated against `^[0-9A-Za-z][0-9A-Za-z._-]*$` and path-verified to stay inside `.maestro/`. Invalid IDs throw `invalid_id`.
- Config output is redacted (see `maestro_get_state`).
- `maestro_create_task` spawns `bin/maestro.mjs` directly — no npm script dependency.

Full schema: [src/mcp/SCHEMA.md](../src/mcp/SCHEMA.md)
