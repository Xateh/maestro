# Maestro Configuration

## State Directory

Maestro reads and writes all persistent state to a `.maestro/` directory. The location is
resolved as follows (first match wins):

1. `--state-dir <path>` CLI flag
2. `PACKAGE_ROOT/.maestro` (default for local commands — `PACKAGE_ROOT` = directory above `bin/maestro.mjs`)
3. `MAESTRO_ROOT` env var (used by the MCP server to find the runtime project root)
4. Walk up from `process.cwd()` until a `.maestro/` directory is found (MCP server discovery)

> **Nested package note:** if you install Maestro as a subpackage (e.g. `workspace/maestro/`),
> the default state dir for CLI invocations is `workspace/maestro/.maestro`. The workspace's
> existing `.maestro/` state is unaffected. To target the workspace state, pass
> `--state-dir /path/to/workspace/.maestro` or set `MAESTRO_ROOT`.

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
  maestro.db             # SQLite — tasks, handoffs (LangGraph engine)
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

Defines the role graph loaded by LangGraph:

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

The workflow can also be accompanied by a `WORKFLOW.md` file at the same path, which defines
per-role Liquid prompt templates in human-readable Markdown.

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

Override the default prompt for any role by editing `workflow.json` `roles.<role>.prompt_template`
or by defining a `## <Role>` section in `WORKFLOW.md`. Templates are rendered with
[LiquidJS](https://liquidjs.com) and receive context variables:

| Variable | Description |
|---|---|
| `task.prompt` | Original task prompt |
| `task.id` | Task ID |
| `priorHandoffs` | Array of typed handoffs from previous roles |
| `userDirectives` | Resume directives (answers, approval text) |
| `stepIndex` | Zero-based step counter |
