# Maestro Configuration

## State Directory

Maestro reads and writes all persistent state to a `.maestro/` directory. The location is
resolved as follows (first match wins):

1. `--state-dir <path>` CLI flag
2. Walk up from the caller's cwd (`MAESTRO_CALLER_CWD` / `INIT_CWD` / `process.cwd()`)
   until an existing `.maestro/` directory is found — create one with `maestro init`
3. `PACKAGE_ROOT/.maestro` (fallback for local commands — `PACKAGE_ROOT` = directory above `bin/maestro.mjs`)
4. `MAESTRO_ROOT` env var (used by the MCP server to find the runtime project root)

`maestro init` scaffolds `.maestro/` in the current directory (default `config.json`,
`workflow.json`, state subdirectories, and a `.gitignore` for the machine-local files),
and always targets the caller's directory — never the package checkout.

> **Nested package note:** if you install Maestro as a subpackage (e.g. `workspace/maestro/`),
> run `maestro init` in the workspace (or pass `--state-dir` / set `MAESTRO_ROOT`) to target
> the workspace's `.maestro/`; without one, CLI invocations fall back to
> `workspace/maestro/.maestro`.

---

## `.maestro/` Layout

```
.maestro/
  config.json            # v2 — runtime provider and behaviour config (shareable)
  config.local.json      # machine-local overlay — personal aliases, detected models (never share)
  secrets.local.json     # API keys, mode 0600 (never share)
  workflow.json          # v1 — roles, transitions, prompt templates
  import-manifest.json   # imported sources + credits (see docs/import-export.md)
  imported/              # snapshots of sources imported with --copy
  prompts/               # instruction docs materialized from imported bundles
  .gitignore             # written by the importer; covers the local-only files
  maestro.db             # SQLite — tasks, handoffs (LangGraph engine, default backend)
  tasks/                 # legacy per-task JSON files (pre-LangGraph)
  runs/                  # per-run artifact directories
    <task-id>/
      planner.stdout.log
      planner.stderr.log
      planner.prompt.txt
      planner.exit.txt
      planner.command.json
      handoff.planner.json
      executor.stdout.log
      ...
  projects/              # project state JSON files
  patches/               # stored patch files
```

---

## `config.json` (v2)

Key fields:

```jsonc
{
  "version": 2,
  "cwd": "/path/to/project",
  "planner_policy": "auto",       // "auto" | "on" | "off"
  "review_enabled": true,
  "timeout_ms": 300000,
  "max_steps": 10,
  "default_role": "executor",
  "stale_after_ms": 86400000,
  "stream_tail_bytes": 8192,
  "context_retry_limit": 3,

  // Worktree settings
  "worktree_root": ".maestro/worktrees",
  "worktree_mode_default": "none",  // "none" | "isolated" | "shared"
  "max_parallel_worktrees": 4,
  "project_close_merge_mode": "squash",
  "delete_closed_project_branches": false,

  // Provider configuration
  "providers": {
    "claude": {
      "label": "Claude",
      "adapter": "built-in:claude",
      "default_alias": "claude",
      "aliases": { "claude": "claude", "opus": "claude-opus-4-8" },
      "models": ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
      "efforts": ["low", "medium", "high"]
    },
    "codex": {
      "label": "Codex",
      "adapter": "built-in:codex",
      "default_alias": "codex",
      "aliases": {},
      "models": [],
      "efforts": ["low", "medium", "high"]
    }
    // ...copilot, gemini, antigravity
    // local agent runtimes (run `maestro setup local` to populate models):
    // ollama (built-in:ollama — `ollama run <model>`, prompt on stdin),
    // pi / hermes / openclaw (experimental custom command templates)
    "hermes": {
      "adapter": "custom",
      "custom": { "command_template": "{alias} --model {model}", "prompt_via": "stdin" },
      // optional per-provider env injected into the agent process at spawn
      // time; values are "$VAR" references resolved from the environment
      // (and .maestro/secrets.local.json) — never literals
      "env": { "OPENAI_API_KEY": "$OPENAI_API_KEY" }
    }
  },

  // Herdr terminal integration
  "herdr": {
    "close_tab_on": "success"     // "success" | "terminal" | "never"
  },

  // HTTP server (maestro serve)
  "server": {
    "port": 4000                  // set to null to disable
  },

  // Security
  "host_command_allow": []        // exact basenames; network binaries hard-denied
}
```

### Herdr Tab Lifecycle

Each task gets one herdr tab (label `mae:<taskId>`); all agent panes for the
task open inside it. The tab id is persisted on the task (`herdr_tab_id`), so
a resumed task reuses its original tab — the conversation stays in one place
instead of spawning blank new tabs.

`herdr.close_tab_on` controls when Maestro closes the tab:

| Value | Behaviour |
|---|---|
| `"success"` (default) | Close when the task reaches `succeeded`. Failed and waiting tasks keep their tab as a trail. |
| `"terminal"` | Close on `succeeded` and `failed`. Note: hard agent failures currently park the task in `waiting_user` (tab kept), so today this behaves like `"success"`; the distinction is reserved for a future failed terminal state. |
| `"never"` | Never close tabs automatically. |

Tabs are **never** closed while a task is `waiting_user`, `waiting_approval`,
or `needs_review` — the conversation stays visible until the task resumes,
and the resume lands in the same tab (verified via `herdr tab get`; recreated
if the tab was closed manually).

### PostgreSQL Backend

By default Maestro stores all task and handoff state in SQLite
(`.maestro/maestro.db`). Set `DATABASE_URL` to a PostgreSQL connection string
to use PostgreSQL instead — useful for high-availability deployments where
multiple workers share a database, or for persisting state outside the project
directory.

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/maestro maestro serve
```

The schema is created automatically on first connection. Both backends expose
the same async API; no application code changes are needed to switch.

### Local Config Overlay — `config.local.json`

Machine-specific values (personal CLI aliases, locally detected models,
custom command-template tweaks) belong in `.maestro/config.local.json`. It
has the same shape as `config.json` (partial is fine) and is deep-merged
over it at read time: **objects merge, arrays and scalars replace**.

Writes to the shared config never persist overlay values back into
`config.json`, and export bundles always exclude the overlay — personal
aliases cannot leak into a repository or a shared bundle.

### Secrets — `secrets.local.json`

`maestro setup keys` stores key/value env pairs in
`.maestro/secrets.local.json` (chmod 0600). At startup they are loaded into
the process env with real environment variables taking precedence. Shareable
files reference them as `"$VAR"` strings (e.g. `tracker.api_key:
"$LINEAR_API_KEY"`, `providers.<p>.env`). The MCP server redacts
secret-shaped values (`*_key`, `*_token`, `*_secret`, …) on read.

### Planner Policy

| Value | Behaviour |
|---|---|
| `"auto"` | Planner runs on new tasks; skipped on retry if plan already exists |
| `"on"` | Planner always runs |
| `"off"` | Skip planner; go straight to executor |

---

## `workflow.json` (v1)

Defines the role graph loaded by LangGraph. `maestro init --workflow <name>`
(or `maestro workflow use <name>` after init) writes a built-in template:

| Template | Pipeline |
|---|---|
| `default` | planner → executor → reviewer |
| `extended` | `default` + a read-only `system_evaluator` role the reviewer can escalate to, plus an `evaluate` mode that runs the evaluator standalone |
| `local` | `default` with every role on `ollama` (the executor keeps write permission) |
| `solo` | executor only; defines only the `task` mode, so `--plan-only` errors with `unknown_mode` |

Both `maestro import` and `maestro workflow use` back up the previous file to
`workflow.json.bak` before writing (`workflow use` fully replaces the file;
`import` merges).

```jsonc
{
  "version": 1,
  "initial": "planner",
  "roles": {
    "planner": {
      "provider": "claude",
      "alias": "claude",
      "model": "",
      "effort": "high",
      "permission": "plan",
      "prompt_template": "..."    // Liquid template; null = use default
    },
    "executor": {
      "provider": "codex",
      "alias": "codex",
      "model": "",
      "effort": "high",
      "permission": "workspace-write",
      "prompt_template": null
    },
    "reviewer": {
      "provider": "codex",
      "alias": "codex",
      "model": "",
      "effort": "medium",
      "permission": "read-only",
      "prompt_template": null
    }
  },
  "transitions": {
    "planner": {
      "done": "executor",
      "halt": "$halt",
      "ask_user": "$ask_user"
    },
    "executor": {
      "done": "reviewer",
      "halt": "$halt",
      "ask_user": "$ask_user"
    },
    "reviewer": {
      "done": "$complete",
      "revise": "executor",        // custom event — agents route it via
                                   // MAESTRO_HANDOFF: {"event":"revise",...}
      "halt": "$halt",
      "ask_user": "$ask_user"
    }
  },
  // loop safety: cycles (like reviewer → executor above) should be bounded
  "loop_limits": {
    "default_max_visits": 3,       // applies to roles without their own max_visits
    "on_exceeded": "ask_user"      // "ask_user" (pause + question) | "halt"
  }
}
```

> **Note:** earlier versions used a separate server-only `WORKFLOW.md` file for
> `maestro serve`. That fork has been removed — the server now runs the same
> `workflow.json` engine as the CLI/TUI. Server polling/tracker settings live in
> the `dispatch` block of `config.json` (below). Per-role prompt customization
> uses the role `instructions` / `instruction_paths` fields.

### Role fields for imported/custom roles

| Field | Description |
|---|---|
| `max_visits` | Per-role visit cap per run (loops re-run roles) |
| `instructions` | Inline role instructions appended to the prompt |
| `instruction_paths` | Doc paths read at prompt time (16 KB/file, 64 KB total cap) |
| `source` | Attribution written by `setup import` (`kind`, `path`, `hash`, `imported_at`) |

Reserved events that handoff payloads may not redefine: `done`, `error`,
`question`, `waiting`, `needs_review`, `pause`. Custom events must be
declared in `transitions[role]` to be honored. Validate with
`maestro workflow validate` — unterminated cycles produce a warning with a
recommended termination clause. See [import-export.md](import-export.md).

---

## Dispatch (server mode)

`maestro serve` reads the **same** `.maestro/workflow.json` + `.maestro/config.json`
as the CLI/TUI. The `dispatch` block in `config.json` holds the Linear-polling and
concurrency settings; each eligible issue is run through the workflow.json engine
(planner → executor → reviewer), exactly like `maestro task`.

```jsonc
{
  "dispatch": {
    "enabled": false,                 // gate; doctor reports "configured" when true or a slug is set
    "tracker": {
      "kind": "linear",
      "endpoint": "https://api.linear.app/graphql",
      "project_slug": null,           // REQUIRED to serve
      "active_states": ["Todo", "In Progress"],
      "terminal_states": ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
      "done_state": null,             // set (e.g. "Done") to auto-move succeeded issues; null = humans move the card
      "blocked_state": null           // optional target for waiting_user/waiting_approval tasks
    },
    "polling": { "interval_ms": 30000 },
    "max_concurrent": 1,              // raise together with worktree_mode for isolation
    "max_concurrent_by_state": {},
    "max_retry_backoff_ms": 300000,
    "worktree_mode": "current-cwd",   // or "new-project" for a per-issue git worktree
    "prompt_template": null,          // Liquid template seeded with { issue }; null = issue title + description
    "server": { "port": null }        // HTTP dashboard port; --port overrides
  }
}
```

The Linear API key is **never** stored in `config.json` — set `LINEAR_API_KEY`
in the environment or `.maestro/secrets.local.json` (`maestro setup keys`).

When `done_state` is set the server writes the issue's state back to Linear on
success; left `null`, the issue is left for a human to move (the work is still
done). Tasks that reach `waiting_user`/`waiting_approval` are **not** re-run by
the server — answer them with `maestro message`/`maestro approve` against the
same `.maestro/` state and the task resumes.

### What config lives where

| Concern | File |
|---|---|
| Provider definitions, global policies (timeouts, worktrees, herdr) | `config.json` |
| Linear tracker, polling, dispatch concurrency, dashboard port | `config.json` → `dispatch` |
| Role graph (roles, transitions, modes, loop limits) | `workflow.json` |
| Per-role prompt instructions | `workflow.json` → role `instructions` / `instruction_paths` |
| Secrets (`LINEAR_API_KEY`, etc.) | `.maestro/secrets.local.json` |

Both `maestro task` and `maestro serve` read `config.json` + `workflow.json`.

---

## Provider Adapters

Each provider entry in `config.json` references a built-in adapter (`"built-in:claude"`) or a
custom adapter:

```jsonc
{
  "adapter": "custom",
  "command_template": "myagent --role {role} --model {model}",
  "prompt_via": "stdin"   // or "arg" with {prompt} in command_template
}
```

Supported `{placeholders}`: `alias`, `model`, `effort`, `role`, `permission`, `prompt`.

### Local LLMs (Ollama)

The `built-in:ollama` adapter dispatches a fully local model — no API key, no
network. It runs `ollama run <model>` with the prompt on stdin:

```jsonc
"ollama": {
  "label": "Ollama (local)",
  "adapter": "built-in:ollama",
  "default_alias": "ollama",
  "models": ["llama3.2", "qwen3", "llama3.2-vision"]
}
```

Assign it to any role (e.g. `reviewer`) in `workflow.json` or the TUI. Other
local runtimes (LM Studio, llama.cpp) work through the `custom` adapter.
Full guide: [local-llm.md](local-llm.md).

---

## Custom Workflow Templates

Customize a role's prompt by editing its `workflow.json` `roles.<role>` entry —
set `prompt_template` to a built-in template name, or add inline `instructions` /
`instruction_paths` (see the role-fields table above). Built-in templates are
rendered with [LiquidJS](https://liquidjs.com) and receive context variables:

| Variable | Description |
|---|---|
| `task.prompt` | Original task prompt |
| `task.id` | Task ID |
| `priorHandoffs` | Array of typed handoffs from previous roles |
| `userDirectives` | Resume directives (answers, approval text) |
| `stepIndex` | Zero-based step counter |
