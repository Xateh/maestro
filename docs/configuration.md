# Symphony Configuration

## State Directory

Symphony reads and writes all persistent state to a `.symphony/` directory. The location is
resolved as follows (first match wins):

1. `--state-dir <path>` CLI flag
2. `PACKAGE_ROOT/.symphony` (default for local commands — `PACKAGE_ROOT` = directory above `bin/symphony.mjs`)
3. `SYMPHONY_ROOT` env var (used by the MCP server to find the runtime project root)
4. Walk up from `process.cwd()` until a `.symphony/` directory is found (MCP server discovery)

> **Nested package note:** if you install Symphony as a subpackage (e.g. `workspace/symphony/`),
> the default state dir for CLI invocations is `workspace/symphony/.symphony`. The workspace's
> existing `.symphony/` state is unaffected. To target the workspace state, pass
> `--state-dir /path/to/workspace/.symphony` or set `SYMPHONY_ROOT`.

---

## `.symphony/` Layout

```
.symphony/
  config.json       # v2 — runtime provider and behaviour config
  workflow.json     # v1 — roles, transitions, prompt templates
  symphony.db       # SQLite — tasks, handoffs (LangGraph engine)
  tasks/            # legacy per-task JSON files (pre-LangGraph)
  runs/             # per-run artifact directories
    <task-id>/
      planner.stdout.log
      planner.stderr.log
      planner.prompt.txt
      planner.exit.txt
      planner.command.json
      handoff.planner.json
      executor.stdout.log
      ...
  projects/         # project state JSON files
  patches/          # stored patch files
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
  "worktree_root": ".symphony/worktrees",
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
  },

  // Security
  "host_command_allow": []        // exact basenames; network binaries hard-denied
}
```

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
      "halt": "$halt",
      "ask_user": "$ask_user"
    }
  }
}
```

The workflow can also be accompanied by a `WORKFLOW.md` file at the same path, which defines
per-role Liquid prompt templates in human-readable Markdown.

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
