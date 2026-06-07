# Symphony CLI Reference

## Invocation

```bash
node bin/symphony.mjs <command> [args...]
# or, after npm link:
symphony <command> [args...]
# or via npm script:
npm run symphony <command> [args...]
```

---

## Global Flags

| Flag | Description |
|---|---|
| `--state-dir <path>` | Override the `.symphony/` directory (default: `PACKAGE_ROOT/.symphony`) |
| `--workflow-path <path>` | Override `WORKFLOW.md` / `workflow.json` path |
| `--port <n>` | HTTP API port (0 = disable) |

---

## Task Commands

### `task "<prompt>"`

Create and run a full pipeline: **planner → executor → reviewer**.

```bash
symphony task "Add a /healthcheck endpoint"
symphony task "Refactor auth module" --state-dir /path/to/project/.symphony
```

### `plan-only "<prompt>"`

Planner only. Produces a plan handoff and stops. Review it before running the full pipeline.

```bash
symphony plan-only "Migrate database schema to v2"
```

### `run-task <id>`

Re-run or continue an existing task by ID.

```bash
symphony run-task 20260608-120000-add-healthcheck
```

---

## State Commands

### `status`

Print orchestrator runtime state (active tasks, provider config, last run).

```bash
symphony status
```

### `inspect <id>`

Dump full JSON state for a task.

```bash
symphony inspect 20260608-120000-add-healthcheck
```

### `list` (alias for `status` in list mode)

```bash
symphony list
```

---

## Interaction Commands

These are used after a task emits `SYMPHONY_QUESTION` or `SYMPHONY_ACTION_REQUEST` and enters
`waiting_user` state.

### `message <id> "<text>"`

Send a text answer to a waiting task.

```bash
symphony message 20260608-120000-add-healthcheck "Use the existing Express router, not Fastify"
```

### `approve <id>`

Approve a task waiting for a go/no-go decision.

```bash
symphony approve 20260608-120000-add-healthcheck
```

### `deny <id> "<reason>"`

Deny a task; provide a reason that feeds back into the executor prompt.

```bash
symphony deny 20260608-120000-add-healthcheck "Do not touch the auth module"
```

### `approve-action <id> <action-id>`

Approve a specific `host_command` action request.

```bash
symphony approve-action 20260608-120000-add-healthcheck act_abc123
```

### `deny-action <id> <action-id> "<reason>"`

Deny a specific action request.

```bash
symphony deny-action 20260608-120000-add-healthcheck act_abc123 "unsafe command"
```

### `run-action <id> <action-id>`

Execute an approved action request immediately.

```bash
symphony run-action 20260608-120000-add-healthcheck act_abc123
```

### `edit-action <id> <action-id>`

Open the action request in an editor before approving.

### `retry <id>`

Retry a failed task from the last checkpoint.

```bash
symphony retry 20260608-120000-add-healthcheck
```

### `extend-timeout <id> <ms>`

Extend the timeout for a running task.

```bash
symphony extend-timeout 20260608-120000-add-healthcheck 60000
```

### `cancel <id>`

Cancel a running or waiting task.

```bash
symphony cancel 20260608-120000-add-healthcheck
```

### `mark-done <id>`

Manually mark a task as done (e.g. after out-of-band resolution).

```bash
symphony mark-done 20260608-120000-add-healthcheck
```

---

## Project Commands

### `project list`

List all projects.

### `project create "<name>"`

Create a new project scope.

### `project show <id>`

Show project state and tasks.

### `project close <id>`

Close a project (optional worktree merge/cleanup).

---

## TUI

### `tui`

Launch the full interactive terminal UI. Browse tasks, pick providers, edit workflow, respond to
waiting tasks, approve/deny action requests.

```bash
symphony tui
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SYMPHONY_BACKEND` | `"herdr"` | Set to `"terminal"` to bypass herdr and use direct spawn |
| `SYMPHONY_ROOT` | cwd walk | Override runtime root (parent of `.symphony/`) — used by MCP server |
| `SYMPHONY_CALLER_CWD` | — | Caller working directory (set by herdr integration) |
| `INIT_CWD` | — | npm-style caller cwd (set by npm when running scripts) |
| `HERDR_BIN` | `"herdr"` | Path to the herdr binary |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | herdr daemon unix socket |

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Error (see stderr) |
