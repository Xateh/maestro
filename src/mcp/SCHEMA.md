# Maestro MCP Tool Schema

**SYNC RULE**: Keep this file up-to-date whenever `server.mjs` tool definitions change.

Server: `src/mcp/server.mjs`
Transport: stdio
Registration: `.mcp.json` → key `maestro`

---

## `maestro_list_tasks`
List tasks, sorted newest-first. **DB-aware**: reads from `.maestro/maestro.db` if it exists (LangGraph engine tasks), falls back to `.maestro/tasks/*.json` for legacy tasks.

**Input**
| Field | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 20 | Max tasks to return |
| `status` | string | — | Filter: `queued` / `running` / `waiting_user` / `succeeded` / `failed` / `blocked` / `cancelled` / `denied` / `expired` / `open` / `pending` / `reviewed` / `system` |

**Output** — array of `{ id, prompt (truncated 120 chars), status, created_at, mode, engine? }`
- `engine: "langgraph"` is present for DB-sourced tasks.

---

## `maestro_show_task`
Full details for one task: task JSON + per-role handoffs + stdout log tails (last 8 KB each).
**DB-aware**: reads from SQLite DB first (LangGraph tasks), falls back to JSON file.

**Input** `{ id: string }` — required. ID must match `^[0-9A-Za-z][0-9A-Za-z._-]*$`; no slashes or `..`. Throws `invalid_id` otherwise.

**Output**
- LangGraph tasks: `{ task, handoffs: Array<{role, provider, payload, log_path}>, logs: { [role]: string }, engine: "langgraph" }`
- Legacy tasks: `{ task, handoffs: { [role]: object }, logs: { [role]: string } }`

Note: LangGraph `handoffs` is a flat array (compact typed); legacy `handoffs` is a keyed object (full JSON with paths).

---

## `maestro_list_runs`
List `.maestro/runs/` dirs sorted by mtime newest-first.

**Input** `{ limit?: number }` — default 20

**Output** — array of `{ name, mtime }`

---

## `maestro_show_run`
All files in one run dir. JSON files returned fully; log files tailed to last 8 KB.

**Input** `{ id: string }` — required (directory name, same as task ID). ID must match `^[0-9A-Za-z][0-9A-Za-z._-]*$`; throws `invalid_id` otherwise.

**Output** `{ id, files: { [filename]: object|string } }`

---

## `maestro_create_task`
Spawns `bin/maestro.mjs <mode> "<prompt>"` via the bundled bin (self-contained, no npm script required). Non-blocking.

**Input**
| Field | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | — | Task description (required) |
| `mode` | string | `"task"` | Must be exactly `"task"` or `"plan-only"`. Throws `invalid_mode` otherwise. |

**Output** `{ exitCode, taskId, stdout }` — `taskId` is parsed from CLI output; may be `null` if unparseable.

---

## `maestro_get_state`
Runtime state snapshot. Tries `GET http://localhost:{port}/api/v1/state` first (2 s timeout). Falls back to reading config.json + workflow.json + live task state from SQLite (task mode).

**Input** none

**Output**
- HTTP mode: `{ source: "http", state: object }`
- Files mode: `{ source: "files", config, workflow, live_tasks?: { running: Array<{id,status,current_state,active_step,prompt,updated_at}>, recent: Array<{id,status,prompt,updated_at}> } }`

`live_tasks` is populated only when `.maestro/maestro.db` exists. `running` shows up to 10 currently-running tasks with active step details.

**Security:** `config` is redacted before return — any key matching `*_key`, `*_token`, `*_secret`, `api_key`, `apikey`, `password`, or `passwd` has its value replaced with `"[redacted]"`.

---

## `maestro_read_workflow`
Current workflow definition.

**Input** none

**Output** `{ workflow_json: object, workflow_md: string|null }`
