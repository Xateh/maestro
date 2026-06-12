# Maestro CLI Reference

## Invocation

```bash
node bin/maestro.mjs <command> [args...]
# or, after npm link:
maestro <command> [args...]
# or via npm script:
npm run maestro <command> [args...]
```

---

## Global Flags

| Flag | Description |
|---|---|
| `--state-dir <path>` | Override the `.maestro/` directory (default: `PACKAGE_ROOT/.maestro`) |
| `--workflow-path <path>` | Override `WORKFLOW.md` / `workflow.json` path |
| `--port <n>` | HTTP API port (0 = disable) |

---

## Task Commands

### `task "<prompt>"`

Create and run a full pipeline: **planner → executor → reviewer**.

```bash
maestro task "Add a /healthcheck endpoint"
maestro task "Refactor auth module" --state-dir /path/to/project/.maestro
```

### `task --plan-only "<prompt>"`

Planner only. Produces a plan handoff and stops. Review it before running the full pipeline.

```bash
maestro task --plan-only "Migrate database schema to v2"
```

### `task --mode <name> "<prompt>"`

Run a task in any mode defined in `workflow.json` `modes` — including
standalone modes created by `setup import` for imported subagents.
`--plan-only` remains an alias for `--mode plan-only`.

```bash
maestro task --mode system_evaluator "evaluate the markers module"
```

### `run-task <id>`

Re-run or continue an existing task by ID.

```bash
maestro run-task 20260608-120000-add-healthcheck
```

---

## State Commands

### `status`

Print orchestrator runtime state (active tasks, provider config, last run).

```bash
maestro status
```

### `inspect <id>`

Dump full JSON state for a task.

```bash
maestro inspect 20260608-120000-add-healthcheck
```

> `status` is also the task list — there is no separate `list` command.

---

## Interaction Commands

These are used after a task emits `MAESTRO_QUESTION` or `MAESTRO_ACTION_REQUEST` and enters
`waiting_user` state.

### `message <id> "<text>"`

Send a text answer to a waiting task.

```bash
maestro message 20260608-120000-add-healthcheck "Use the existing Express router, not Fastify"
```

### `approve <id>`

Approve a task waiting for a go/no-go decision.

```bash
maestro approve 20260608-120000-add-healthcheck
```

### `deny <id> "<reason>"`

Deny a task; provide a reason that feeds back into the executor prompt.

```bash
maestro deny 20260608-120000-add-healthcheck "Do not touch the auth module"
```

### `approve-action <id> <action-id>`

Approve a specific `host_command` action request.

```bash
maestro approve-action 20260608-120000-add-healthcheck act_abc123
```

### `deny-action <id> <action-id> "<reason>"`

Deny a specific action request.

```bash
maestro deny-action 20260608-120000-add-healthcheck act_abc123 "unsafe command"
```

### `run-action <id> <action-id>`

Execute an approved action request immediately.

```bash
maestro run-action 20260608-120000-add-healthcheck act_abc123
```

### `edit-action <id> <action-id>`

Open the action request in an editor before approving.

### `retry <id>`

Retry a failed task from the last checkpoint.

```bash
maestro retry 20260608-120000-add-healthcheck
```

### `extend-timeout <id> <ms>`

Extend the timeout for a running task.

```bash
maestro extend-timeout 20260608-120000-add-healthcheck 60000
```

### `cancel <id>`

Cancel a running or waiting task.

```bash
maestro cancel 20260608-120000-add-healthcheck
```

### `mark-done <id>`

Manually mark a task as done (e.g. after out-of-band resolution).

```bash
maestro mark-done 20260608-120000-add-healthcheck
```

---

## Setup, Import & Export Commands

See [import-export.md](import-export.md) for the full guide.

### `setup import [flags]`

Scan existing agent setups (subagents, skills, instruction docs, `.mcp.json`,
codex/gemini configs) and import them into the workflow with credits.
Flags: `--agents <dir>` `--skills <dir>` `--instructions <file>` `--mcp <file>`
`--codex <file>` `--gemini <file>` `--hooks <file>` `--attach <role>=<path>`
`--wire "state:event=dest"` `--copy` `--dry-run` `--yes`. With no source
flags, default locations are scanned.

```bash
maestro setup import --dry-run
maestro setup import --agents ~/.claude/agents --attach planner=~/.agents/skills/maestro/SKILL.md --yes
```

### `setup local [--json] [--yes]`

Detect installed agent runtimes (claude/codex/copilot/gemini/antigravity +
ollama/pi/hermes/openclaw), discover Ollama models, and record
machine-specific values in `config.local.json`.

### `setup keys [--var NAME]`

Manage API keys in `.maestro/secrets.local.json` (mode 0600). Interactive by
default (input hidden); `--var NAME` reads the value from stdin for scripts.
Keys are optional — provider CLIs handle their own auth.

### `workflow validate [--json] [--strict]`

Validate `workflow.json`: structural errors (bad initial/transitions/modes,
invalid limits) and warnings (unreachable roles, unknown providers, cycles
without termination clauses). Exit 1 on errors, or on warnings with
`--strict`.

### `export [--out <path>] [--single-file] [--name <n>]`

Package the workflow as a portable bundle (dir or single
`.maestro-bundle.json`). Excludes `config.local.json` and
`secrets.local.json`; includes credits and sha256 hashes.

### `import <bundle> [--dry-run] [--force]`

Import a bundle: backs up `workflow.json`, validates, materializes bundled
prompt docs, merges providers (existing entries win unless `--force`).

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

Launch the interactive terminal UI.

```bash
maestro tui
```

On a real terminal this opens the **full-screen TUI** (alternate screen,
keyboard-driven, live-refreshing, resize-aware):

| Screen | Keys | What it shows |
|---|---|---|
| **Tasks** (`1`) | `↑↓/jk` move · `⏎` open · `n` new task · `v` cycle view · `r` refresh | Filterable task table (active/needs-human/blocked/incomplete/failed/done/all) |
| **Task detail** (`⏎`) | `↑↓` scroll · `[ ]` pick action · `a/d` approve/deny · `m` message · `R` retry · `c` cancel · `x` mark-done · `o` resume · `e` extend · `esc` back | Full task state, pending action requests, blockers, review |
| **Workflow** (`2`) | `←→/hl` select role | Grid graph of roles, `done` handoff arrows, and every event transition; role detail panel |
| **Settings** (`3`) | `↑↓` select · `⏎` edit/cycle | config.json fields (planner policy, review, timeouts, herdr tab policy, …) and role seating |

`q` or `ctrl+c` quits; `tab` cycles screens. The layout reflows live on
terminal resize; the workflow graph collapses to a vertical stack when the
terminal is too narrow for the grid.

The classic prompt-driven TUI is used automatically when stdin/stdout are not
TTYs (pipes, scripts), or on demand with `MAESTRO_TUI_CLASSIC=1`.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MAESTRO_BACKEND` | `"herdr"` | Set to `"terminal"` to bypass herdr and use direct spawn |
| `MAESTRO_ROOT` | cwd walk | Override runtime root (parent of `.maestro/`) — used by MCP server |
| `MAESTRO_CALLER_CWD` | — | Caller working directory (set by herdr integration) |
| `INIT_CWD` | — | npm-style caller cwd (set by npm when running scripts) |
| `HERDR_BIN` | `"herdr"` | Path to the herdr binary |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | herdr daemon unix socket |

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Error (see stderr) |
