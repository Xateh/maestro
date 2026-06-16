# Maestro Role Convention (MRC)

Maestro orchestrates **roles** — the stages of a `plan → execute → review`-style
workflow. The Maestro Role Convention lets you author a role **once** as a
portable unit and reuse it across workflows, and it lets maestro **consume the
agent units you already have** — Claude Code subagents and skills — without
rewriting them.

Three legs:

- **Subagents = roles.** A unit of agent behavior becomes a stage in any workflow.
- **Instructions = role bodies.** The markdown body of a unit is the role's `instructions`.
- **Tools = declared allowlists.** A role can declare the tools it may use; maestro
  enforces or advises that policy per provider (see the [capability matrix](#tool-capability-matrix)).

See the full design spec at
`docs/superpowers/specs/2026-06-16-maestro-role-convention-design.md`.

## Role unit format

A native unit is a markdown file at `.maestro/roles/<name>.md` — YAML
frontmatter (a superset of the Claude Code subagent format) plus a markdown body
that becomes the role's `instructions`.

```markdown
---
name: security-reviewer
description: Reviews diffs for security regressions   # → label
provider: claude                # built-in provider key (or use `alias`)
permission: read                # read | write | plan
model: ""                       # "" = provider default
effort: ""
tools: [Read, Grep, "Bash(npm:*)", mcp__lint__check]  # declared allowlist
deny_tools: ["Bash(rm:*)"]      # optional explicit denials
output_schema: review           # named schema or safe relative ref
kind: agent                     # agent | stub | command | regression | scoring
verifies: true
---

You are a security reviewer. Inspect the diff for injection, path-escape,
secret-handling, and authn/authz regressions...
```

### Frontmatter fields

| Field | Default | Notes |
|-------|---------|-------|
| `name` | file stem | Identity; used for `label` if `description` absent. |
| `description` | — | Human label for the stage. |
| `provider` / `alias` | `claude` (native, when neither set) | Provider key / adapter alias; `alias` wins for command selection. |
| `model`, `effort` | `""` | `""` ⇒ provider default. |
| `permission` | `read` | `read` \| `write` \| `plan`. |
| `tools` | unrestricted | Declared allowlist. Token grammar below. |
| `deny_tools` | — | Explicit denials, applied on top of `tools`. |
| `output_schema` | — | Named schema, inline object, or safe relative ref. |
| `kind` | `agent` | `agent` \| `stub` \| `command` \| `regression` \| `scoring`. |
| `verifies` | `false` | Marks a verification stage. |
| (body) | `""` | Markdown after the frontmatter → `instructions`. |

`skip` is workflow-positional, not a unit field — set it on the inline workflow
role, never on a portable unit.

### Tool token grammar

- **Bare tool name:** `Read`, `Grep`, `Write` — `[A-Za-z][A-Za-z0-9_]*`.
- **Scoped Bash:** `Bash(<spec>)`, e.g. `Bash(npm:*)`, `Bash(git status:*)`.
- **MCP tool:** `mcp__<server>__<tool>`, e.g. `mcp__lint__check`.

A token outside this grammar fails validation at load time (`role_tool_token_invalid`),
naming the offending token. `mcp__x` (no `__tool`) is malformed, not a bare name.

## Referencing a unit from a workflow

A workflow role stays **inline** (today's behavior, unchanged) or **references a
unit** via `source` and overrides any field inline:

```jsonc
{
  "roles": {
    "planner": { "provider": "claude", "permission": "plan", "prompt_template": "planner" },
    "review": {
      "source": ".claude/agents/reviewer.md",   // load + normalize the unit
      "provider": "codex",                       // override the unit's provider
      "prompt_template": "review"                // keep roleKey unique
    }
  }
}
```

Composition rules:

- Inline keys always win over the unit.
- `tools` / `deny_tools` given inline **replace** (not merge with) the unit's arrays.
- `prompt_template`, if unset by both, defaults to the stage's state name — keeping
  `roleKey`/handoffs/visits isolated.
- **No `source` ⇒ zero change.** The inline object is consumed exactly as today.

`source` must be a string path (validated against escape). It is distinct from
the `source` *object* that `maestro setup import` records as import provenance.

## Tool capability matrix

Maestro is honest about what each provider can actually enforce. `tools` is
mapped best-effort to the provider's real flags; everything else is advisory — a
deterministic **Tool Policy** block prepended to the role's instructions and
recorded in the run manifest.

| Provider | `tools` allowlist | `deny_tools` | Mechanism |
|----------|-------------------|--------------|-----------|
| **claude** | **Enforced** | **Enforced** | `--allowedTools` / `--disallowedTools` |
| **codex** | Partial (Bash → sandbox), rest advisory | Advisory | `--sandbox` profile + advisory block |
| **gemini** | Advisory | Advisory | Tool Policy block + manifest |
| **copilot** | Advisory | Advisory | Tool Policy block + manifest |
| **antigravity** | Advisory | Advisory | Tool Policy block + manifest |
| **ollama** | Advisory | Advisory | Tool Policy block + manifest |

Only **claude** hard-enforces tool allowlists. **codex** folds `Bash(...)` scope
into its sandbox profile and treats the rest as advisory. Everything else is
advisory only — maestro does not pretend to enforce what the provider cannot.

The advisory block is deterministic (allow tokens sorted, then deny tokens
sorted) so identical policy yields identical text and is deduped within a run.

## CLI

```sh
maestro role list [--json]      # discoverable units across .maestro/roles + .claude/agents
maestro role show <unit>        # print the normalized RoleDef
maestro role lint <unit>        # validate frontmatter + tool grammar (non-zero exit on error)
maestro import-agent <path>     # convert a .claude/agents subagent → native .maestro/roles unit
```

## Built-in workflows that use MRC

- **`triage`** — a single classifier role that branches `bug` / `feature` /
  `question`. Demonstrates a read-only, tool-restricted role authored as a unit.
- **`research`** — `gemini` read-only big-context gather → `claude` synthesize.
  Demonstrates tool-restricted gathering (advisory on gemini) followed by synthesis.

Apply either with `maestro init --workflow triage` or `maestro workflow use research`.

## Roadmap (not yet built)

Parallel subagent fan-out is the agentic-harness direction but is **not
implemented**: a future `$fanout:<role>` sink would spawn N parallel instances of
a role, and a `kind: gather` role would collect and merge the results before the
workflow continues. These require new engine machinery (parallel scheduling,
fan-in join semantics) and are recorded here only so the standard anticipates
them.
