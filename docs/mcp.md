# Symphony MCP Server

Symphony exposes seven tools via the [Model Context Protocol](https://modelcontextprotocol.io)
stdio transport. Any MCP-compatible agent (Claude, Cursor, etc.) can use these to read Symphony
state and create tasks without shell access.

## Registration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "symphony": {
      "command": "node",
      "args": ["/absolute/path/to/symphony/src/mcp/server.mjs"]
    }
  }
}
```

The server auto-discovers the `.symphony/` state directory by walking up from its `cwd`, or from
the `SYMPHONY_ROOT` env var.

---

## Tools

### `symphony_list_tasks`

List tasks, sorted newest-first. DB-aware: reads SQLite (`symphony.db`) for LangGraph tasks,
falls back to `tasks/*.json` for legacy tasks.

**Input**

| Field | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 20 | Max tasks to return |
| `status` | string | — | Filter by status (see below) |

**Status values:** `queued` · `running` · `waiting_user` · `succeeded` · `failed` · `blocked` · `cancelled` · `denied` · `expired` · `open` · `pending` · `reviewed` · `system`

**Output** — array of `{ id, prompt (120 chars), status, created_at, mode, engine? }`

---

### `symphony_show_task`

Full details for one task: task JSON + per-role handoffs + stdout log tails (8 KB each).

**Input** `{ id: string }` — required. Must match `^[0-9A-Za-z][0-9A-Za-z._-]*$`.

**Output**
- LangGraph tasks: `{ task, handoffs: Array<{role, provider, payload, log_path}>, logs: { [role]: string }, engine: "langgraph" }`
- Legacy tasks: `{ task, handoffs: { [role]: object }, logs: { [role]: string } }`

---

### `symphony_list_runs`

List `.symphony/runs/` directories sorted by mtime, newest first.

**Input** `{ limit?: number }` — default 20

**Output** — array of `{ name, mtime }`

---

### `symphony_show_run`

All files in one run directory. JSON files returned in full; log files tailed to 8 KB.

**Input** `{ id: string }` — required. Same ID validation as `symphony_show_task`.

**Output** `{ id, files: { [filename]: object|string } }`

---

### `symphony_create_task`

Spawn a new task. Launches `bin/symphony.mjs <mode> "<prompt>"` as a background process (non-blocking).

**Input**

| Field | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | — | Task description (required) |
| `mode` | string | `"task"` | `"task"` or `"plan-only"` |

**Output** `{ exitCode, taskId, stdout }` — `taskId` parsed from CLI output; may be `null` if unparseable.

---

### `symphony_get_state`

Runtime state snapshot. Tries `GET http://localhost:{port}/api/v1/state` first, falls back to
reading `config.json` + `workflow.json` + SQLite.

Sensitive keys are **redacted** before returning: anything matching
`*_key / *_token / *_secret / api_key / apikey / password / passwd`.

**Input** — none

**Output** — `{ config, workflow, activeTasks?, recentTasks? }`

---

### `symphony_read_workflow`

Returns the current `workflow.json` and the optional `WORKFLOW.md` content.

**Input** — none

**Output** `{ workflow: object, workflowMd: string|null }`

---

## Security

- Task and run IDs are validated against `^[0-9A-Za-z][0-9A-Za-z._-]*$` and path-verified to stay inside `.symphony/`. Invalid IDs throw `invalid_id`.
- Config output is redacted (see `symphony_get_state`).
- `symphony_create_task` spawns `bin/symphony.mjs` directly — no npm script dependency.

Full schema: [src/mcp/SCHEMA.md](../src/mcp/SCHEMA.md)
