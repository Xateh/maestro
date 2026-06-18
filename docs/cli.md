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
| `--state-dir <path>` | Override the `.maestro/` directory (default: nearest `.maestro/` at or above the caller's cwd, else `PACKAGE_ROOT/.maestro`) |
| `--config <path>` | Path to the state dir whose `config.json` the server reads (server mode) |
| `--port <n>` | HTTP API port (0 = disable) |

---

## Help

`maestro help`, `maestro --help`, and `-h` print the global command list.
Help is scoped to the longest valid command prefix:

```bash
maestro help project create     # per-command help
maestro project --help          # scoped to "project"
```

Unknown or partial commands exit 1 with help for the deepest matching
command plus "did you mean" suggestions:

```bash
$ maestro project creat
unknown command: maestro project creat
Did you mean: create?
...
```

---

## Init

### `init [--yes] [--dry-run] [--workflow <name>]`

Scaffold a `.maestro/` state directory in the current directory: default
`config.json` and `workflow.json`, the `tasks/ runs/ projects/ patches/
logs/` directories, and a `.gitignore` covering the machine-local files.
Idempotent — existing files are never overwritten.

`--workflow <name>` picks the workflow template:

- `default` — planner → executor → reviewer.
- `extended` — `default` plus a read-only **System Evaluator** role: the
  reviewer can escalate hard cases to a principal-level audit
  (`MAESTRO_HANDOFF: {"event":"escalate",...}`), and an `evaluate` mode runs
  the evaluator standalone (`maestro task --mode evaluate "audit X"`).
- `local` — the default pipeline with every role on `ollama` (zero cloud;
  the executor keeps write permission).
- `solo` — executor only, the fastest loop. Defines only the `task` mode, so
  `maestro task --plan-only` errors with `unknown_mode` on this template.

After scaffolding, it offers to chain the setup wizards (`setup local`,
`setup keys`, `setup import`). `--yes` skips the prompts and runs runtime
detection only; `--dry-run` prints the plan without writing.

```bash
cd /path/to/your/project
maestro init                       # scaffold + optional wizards
maestro init --yes                 # non-interactive (CI)
maestro init --workflow extended   # reviewer→system-evaluator escalation
```

Once a directory (or any parent) contains `.maestro/`, every local command
run from there uses it automatically — no `--state-dir` needed.

### `doctor [--json]`

Preflight checks, no mutations: node version against `engines.node`, each
provider CLI's presence + `--version` line, the herdr binary (with the
backend that will be used), and — when a `.maestro/` state dir is found —
`config.json` parseability, `workflow.json` validation, database openability,
and `secrets.local.json` file mode (key names are listed, values never
printed). Checks that don't apply show as `–` and never fail the run; any
`✗` sets exit code 1. Works outside a project too (state checks degrade to
skip).

```bash
maestro doctor            # human-readable table
maestro doctor --json     # machine-readable result
```

---

## Server Mode

Server mode polls Linear and auto-dispatches issues as graph tasks (the same
LangGraph engine `maestro task` uses), and starts the HTTP server, which serves
the **interactive web dashboard** at `/` and a JSON API at `/api/v1/*`.

There are two ways to start it.

### One-off foreground server — flag-first `maestro [--config <path>] [--state-dir <dir>] [--port <n>]`

Invoke `maestro` with **no subcommand word**, just flags. This runs a single
server in the foreground until you `Ctrl-C`.

```bash
maestro                       # reads ./.maestro/config.json
maestro --port 4100
maestro --config ./.maestro   # explicit state dir for config.json
maestro --state-dir ./alt     # reads ./alt/config.json
```

> **Breaking change (v0.2.0):** `maestro serve --config …` no longer starts a
> server — `serve` is now a service-manager subcommand group (below), so the bare
> flag form (no `serve` word) is the one-off equivalent. `maestro serve --config`
> errors with `unknown serve subcommand`.

### Managed background services — `serve <subcommand>`

`serve` registers, runs, and supervises multiple tracker-backed services from a
single state dir. Each service is a named definition backed by an owner-checked
`0600` store; lifecycle is identity-verified against the recorded pid.

| Subcommand | Synopsis | Purpose |
|---|---|---|
| `serve list` | `serve list [--json]` | show all services + state |
| `serve add` | `serve add <name> --slug <SLUG> [--port N --workflow W --var NAME --workspace DIR --shared-state]` | register a service |
| `serve edit` | `serve edit <name> [--slug … --port … …]` | update a service definition |
| `serve rm` | `serve rm <name> [--force]` | remove a service |
| `serve start` | `serve start <name\|--all>` | start service(s) in the background |
| `serve stop` | `serve stop <name\|--all>` | stop service(s) |
| `serve pause` | `serve pause <name>` | stop + mark paused |
| `serve resume` | `serve resume <name>` | clear paused + start |
| `serve status` | `serve status <name>` | detail for one service |
| `serve logs` | `serve logs <name> [-f] [-n N]` | tail a bounded worker log |
| `serve adopt` | `serve adopt [name]` | materialize a legacy single-tracker config as a `default` service |

```bash
maestro serve add prod --slug PROD --port 4100 --workflow full-audit-sweep
maestro serve start prod
maestro serve list
maestro serve logs prod -f
maestro serve stop --all
```

Service overlays resolve the `server` config block with a var denylist and
port/api-key validation, failing fast at start on an unset api-key var or a port
collision.

All server settings (tracker, polling, workspace, hooks, agent limits, intake
template, and which named workflow to run) come from the `server` block in
`config.json`. There is no separate dispatch file. `config.json` is read **once**
at startup — edits require a restart. See
[configuration.md](configuration.md#server-mode-config) for the `server` schema.

**Dashboard** (`http://localhost:<port>/`): Linear-inspired browser UI with
live task polling (5 s when tasks are active, 30 s when idle), filter tabs
(All / Running / Retrying / Completed), and a slide-in detail panel per task.
Actions: Refresh (triggers `POST /api/v1/refresh`), Force Poll, Copy JSON.

**API endpoints:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/state` | Full orchestrator snapshot (JSON) |
| `GET` | `/api/v1/:id` | Single task detail |
| `POST` | `/api/v1/refresh` | Trigger a Linear sync |

> `maestro <file.md>` (bare path, no `serve`) still works when the file
> exists, but is deprecated — a note is printed to stderr.

---

## Task Commands

### `task "<prompt>"`

Create and run a full pipeline: **planner → executor → reviewer**.

```bash
maestro task "Add a /healthcheck endpoint"
maestro task "Refactor auth module" --state-dir /path/to/project/.maestro
```

Every run ends with a per-role summary table — role, provider, status,
duration, and stdout size — plus the run directory. It also prints when a
task pauses (`waiting_user` / `waiting_approval`), showing what ran before
the pause:

```
run summary: 20260612-103000-add-healthcheck succeeded
  planner    claude   succeeded     12s  4.1KB
  executor   codex    succeeded   3m02s  18.0KB
  reviewer   codex    succeeded     41s  2.2KB
  run dir: .maestro/runs/20260612-103000-add-healthcheck
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

### `task --workflow <name> "<prompt>"`

Run the task with a named workflow. Named workflows live in
`.maestro/workflows/<name>.json`; the name `default` is the legacy
`.maestro/workflow.json`. The name must match `^[a-z0-9][a-z0-9_-]{0,63}$`
(invalid shapes throw `invalid_workflow`); an unknown non-`default` name throws
`unknown_workflow`. Defaults to `default`.

```bash
maestro task --workflow solo "ship the hotfix"
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

### `setup keys [--var NAME] [--encrypt]`

Manage API keys in `.maestro/secrets.local.json` (mode 0600). Interactive by
default (typed input is masked); `--var NAME` reads the value from stdin for
scripts. Keys are optional — provider CLIs handle their own auth.

`--encrypt` migrates the plaintext store to an encrypted
`secrets.local.enc.json` (scrypt + AES-256-GCM) and shreds the plaintext file.
Unlock later with `MAESTRO_SECRET_PASSPHRASE` or the interactive prompt; real
environment variables still take precedence. `maestro doctor` reports the
active store mode.

### `setup tracker [--project-slug <slug>] [--api-key <key>] [--var NAME]`

Configure the Linear tracker for server mode: a wizard that writes
`server.tracker` to `config.json` and chains the `LINEAR_API_KEY` prompt.
`--project-slug` sets the Linear project slug/key; `--api-key` stores the key
non-interactively; `--var NAME` overrides the env var name the key is read from
(default `LINEAR_API_KEY`).

```bash
maestro setup tracker                              # interactive
maestro setup tracker --project-slug TEAM --api-key "$LINEAR_API_KEY"
```

### `setup harden [--project] [--dry-run]`

Install a Claude Code secret guardrail so only Maestro can read its secret
store: a `PreToolUse` hook plus deny rules that block other agents from reading
`secrets.local.json` / `secrets.local.enc.json`. `--project` installs into the
project's `.claude/` instead of the user scope; `--dry-run` prints the planned
changes without writing. See [configuration.md](configuration.md) § Secrets.

### `workflow validate [--json] [--strict]`

Validate `workflow.json`: structural errors (bad initial/transitions/modes,
invalid limits) and warnings (unreachable roles, unknown providers, cycles
without termination clauses). Exit 1 on errors, or on warnings with
`--strict`.

### `workflow list`

List available workflows as `<name> (<source>)`, where `source` is `named`
(a `.maestro/workflows/<name>.json` slot) or `legacy` (the root
`.maestro/workflow.json`, surfaced as `default`). `--json` emits the raw
`[{name, path, source}]` array. `default` is always sorted first.

```bash
maestro workflow list
maestro workflow list --json
```

### `workflow use <name> [--as <slot>]`

Apply a built-in template (`default | extended | local | solo`). Without
`--as`, it switches the default `workflow.json` (the previous file is backed up
to `workflow.json.bak`, then fully replaced — keys from the old workflow do not
survive the switch). With `--as <slot>`, it writes the template into the named
slot `.maestro/workflows/<slot>.json` instead, leaving the default untouched.

```bash
maestro workflow use solo
maestro workflow use solo --as fast
maestro workflow validate
```

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
| `DATABASE_URL` | — | PostgreSQL connection string (`postgres://…`). When set, all task/handoff state is stored in PostgreSQL instead of the default SQLite backend. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP/HTTP endpoint for OpenTelemetry trace export (e.g. `http://localhost:4318`). When unset, OTel is completely disabled (no imports, no overhead). |
| `OTEL_SERVICE_NAME` | `"maestro"` | Override the service name reported in OTel traces. |

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Error (see stderr) |
