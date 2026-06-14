# Import & Export — the Maestro Workflow Ecosystem

Maestro can ingest existing agent setups (Claude Code skills, subagents,
AGENTS.md/CLAUDE.md instructions, `.mcp.json`, Codex/Gemini CLI configs) into
its workflow, and export workflows as portable bundles other Maestro
instances can import.

**Philosophy: wrap, don't replace.** Imported artifacts are referenced by
path by default, so your existing setup keeps working exactly as before —
Maestro just learns to orchestrate it. Every imported source is credited in
`.maestro/import-manifest.json`.

---

## Importing your setup

```bash
maestro setup import --dry-run     # scan default locations, show the plan
maestro setup import --yes         # apply it
```

With no source flags, Maestro scans `~/.claude/agents`, `~/.agents/skills`,
`~/.codex/config.toml`, `~/.gemini/settings.json`, and `./.mcp.json`.

### Sources and mapping rules

| Source | Flag | Becomes |
|---|---|---|
| Subagent `.md` (frontmatter: name/description/tools) | `--agents <dir>` | Workflow **role** + standalone **mode** (`maestro task --mode <role> "..."`) |
| Skill dirs (`*/SKILL.md`) | `--skills <dir>` | Recorded + creditable; attach to roles with `--attach` |
| Instruction docs (AGENTS.md, CLAUDE.md, any .md) | `--instructions <file>` | Recorded; attach with `--attach` |
| `.mcp.json` | `--mcp <file>` | Recorded-only (server names + commands; env **names** only, never values) |
| Claude settings hooks | `--hooks <settings.json>` | Recorded-only (Maestro doesn't execute external hooks) |
| Codex `config.toml` | `--codex <file>` | Recorded + model hint into `config.local.json` |
| Gemini `settings.json` | `--gemini <file>` | Recorded + model hint into `config.local.json` |

### Attaching docs to roles

```bash
maestro setup import --attach planner=~/.agents/skills/maestro/SKILL.md --yes
```

Adds the doc to the role's `instruction_paths`. At prompt time the engine
inlines it (capped 16 KB/file, 64 KB/role) under "Additional role
instructions".

### Wiring imported roles into the pipeline

Maestro does **not** infer transitions from prose. Subagents land as
standalone modes; to splice one into an existing flow, wire it explicitly:

```bash
maestro setup import --agents ~/.claude/agents \
  --wire "reviewer:revise=executor" \
  --wire "executor:audit=system_evaluator" --yes
```

`--wire "state:event=dest"` adds `transitions[state][event] = dest`. The
import validates the merged workflow first and refuses on structural errors;
cycle warnings (see below) are printed but don't block.

### Permission inference

Subagents whose description/body reads like review/audit/evaluation ("never
modifies", "review", "audit", "read-only") get `permission: "read"`;
everything else gets `"write"`. Override in `workflow.json` afterwards.

### Reference vs copy

Default (`reference`): the workflow points at the original path — your edits
to the source file take effect immediately. `--copy` snapshots sources into
`.maestro/imported/` for hermetic setups.

### The manifest (credits)

`.maestro/import-manifest.json` records every source: id, kind, path, sha256
at import time (drift detection), how it was imported, and a human-readable
credit line. Credits travel with exported bundles.

---

## Loops, feedback, and termination

Workflows are graphs, not one-way streets. Agents can route custom events:

```
MAESTRO_HANDOFF: {"event":"revise","summary":"tests missing"}
```

The event is honored only if `transitions[role][event]` is declared and the
event is not reserved (`done`, `error`, `question`, `waiting`,
`needs_review`, `pause`). Agents can also ask the calling side questions at
any time with `MAESTRO_QUESTION:` (task pauses; answer with
`maestro message <id> "..."`).

### Termination clauses

Any cycle should have a termination clause. `maestro workflow validate`
warns when one doesn't:

```
warning [unterminated_cycle]: cycle executor → reviewer → executor has no
termination clause — add "max_visits" to one of these roles, set workflow
"loop_limits": {"default_max_visits": N}, or add a transition from a state
in the cycle to a sink
```

Runtime enforcement:

```jsonc
// workflow.json
{
  "loop_limits": { "default_max_visits": 3, "on_exceeded": "ask_user" },
  "roles": { "executor": { "max_visits": 5 } }
}
```

When a role hits its cap, `on_exceeded: "ask_user"` (default) pauses the task
with a question (continue with `maestro message`), `"halt"` stops it with a
`loop_limit_exceeded` blocker. Answering grants one fresh visit budget: on
resume the whole capped cycle re-runs (stale handoffs are evicted), and your
answer reaches the agents through the prompt's user-answers section.

Validation runs automatically at engine start, during import, via
`maestro workflow validate [--json] [--strict]`, and through the
`maestro_validate_workflow` MCP tool.

---

## Exporting a workflow

```bash
maestro export --out ./my-flow-bundle            # directory bundle
maestro export --single-file --out ./my-flow     # one .maestro-bundle.json
```

Bundle contents: `manifest.json` (name, credits, sha256 per file),
`workflow.json` (with `instruction_paths` docs inlined under `prompts/` —
the target machine won't have your local paths), `providers.json`
(config.json providers only, secret-shaped values redacted).

**Never exported:** `config.local.json`, `secrets.local.json`, tasks, runs,
the SQLite db. Personal aliases and keys cannot leak into a bundle.

### Importing a bundle

```bash
maestro import ./my-flow-bundle [--dry-run] [--force]
```

Backs up `workflow.json` → `workflow.json.bak`, validates the incoming
workflow, materializes bundled prompt docs to `.maestro/prompts/<name>/`,
merges providers (your existing provider entries win unless `--force`), and
merges credits into your import manifest. Hashes are verified; tampered
bundles are rejected.

**Trust note:** bundle provider definitions execute commands — a `custom`
adapter's `command_template` runs on your machine the next time a task uses
that provider. Only import bundles you trust. The import prints every
provider the bundle would install (adapter, command template, env key names)
and asks for confirmation; provider env maps are additionally filtered
through the same denylist as agent action requests (`PATH`, `LD_*`,
`NODE_OPTIONS`, `GIT_SSH*`, … are never injected).

Round-trip guarantee: import → export → import → export produces an
identical canonical bundle (covered by `test/maestro-setup.test.mjs`).

---

## Machine-local overrides (no leakage)

| File | Purpose | Shared? |
|---|---|---|
| `.maestro/config.json` | project config (providers, defaults) | yes |
| `.maestro/config.local.json` | personal aliases, detected local models | **no** — overlay, gitignored, excluded from bundles |
| `.maestro/secrets.local.json` | API keys (mode 0600) | **no** |

`config.local.json` deep-merges over `config.json` at read time (objects
merge; arrays and scalars replace). Writes to shared config never persist
local values back. The importer writes a `.maestro/.gitignore` covering
`config.local.json`, `secrets.local.json`, and `imported/`.

```bash
maestro setup local          # detect installed runtimes → config.local.json
```

---

## API keys (optional)

Maestro drives provider CLIs that handle their own auth — keys are optional.
For trackers (Linear) or API-based agents:

```bash
maestro setup keys                          # interactive (input hidden)
maestro setup keys --var OPENAI_API_KEY < keyfile   # scripted
```

Values land in `.maestro/secrets.local.json` (0600) and are loaded into the
process env at startup (real env vars always win). Shareable files only ever
carry `"$VAR"` references, e.g.:

```jsonc
// config.json
{ "providers": { "hermes": { "env": { "OPENAI_API_KEY": "$OPENAI_API_KEY" } } } }
```

`providers.<p>.env` is resolved at spawn time and injected into the agent
process (terminal backend; key names are logged in `<role>.command.json`
`env_keys`, values never are). The herdr backend does not receive provider
env — pane scripts are user-visible.

---

## Local agent runtimes

Built-in providers: `ollama` (`ollama run <model>`, prompt on stdin), plus
experimental command templates for `pi` (`pi --model <m> -p "<prompt>"`),
`hermes`, and `openclaw` (`openclaw agent --message "<prompt>"`).

```bash
maestro setup local
```

probes the PATH for all runtimes, lists Ollama models (`ollama list`), reads
`~/.pi/agent/models.json` and `~/.openclaw/openclaw.json` when present, and
writes confirmed values to `config.local.json`. Use a role's `provider`
field to run any role on a local model:

```jsonc
{ "roles": { "reviewer": { "provider": "ollama", "model": "qwen2.5-coder:7b" } } }
```
