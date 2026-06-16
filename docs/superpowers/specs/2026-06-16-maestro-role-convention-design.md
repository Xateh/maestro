# Maestro Role Convention (MRC) — Design Spec

- **Date:** 2026-06-16
- **Status:** Approved design, ready for implementation
- **Scope:** A portable role standard plus a loader/normalizer, a tool-enforcement
  seam, two demo built-in workflows, and docs. Fan-out is documented as a roadmap
  only and is **not** built in this cut.

## 1. Overview & Goals

Maestro already runs workflows as JSON state machines:
`{ version, initial, roles{}, transitions{}, modes{}, loop_limits{} }` (see
`src/task-store.mjs` `DEFAULT_WORKFLOW` and `src/setup/workflow-templates.mjs`).
Each role is an object the engine consumes directly
(`{ provider, alias, model, effort, permission, prompt_template, output_schema,
instructions, verifies, skip, kind }`) and dispatches in
`src/langgraph/nodes.mjs`.

The Maestro Role Convention (MRC) reframes maestro as the **orchestration
backbone that consumes the existing agent ecosystem** rather than a competing
format. It unifies three legs behind one normalized `RoleDef`:

1. **Subagents = roles.** A unit of agent behavior authored once becomes a stage
   in any workflow.
2. **Instructions = role bodies.** The markdown body of a unit is the role's
   `instructions` (precedent already exists:
   `src/setup/templates/system-evaluator.md`).
3. **Tools = declared allowlists.** A role can declare the tools it is permitted
   to use; maestro enforces or advises that policy per provider.

**Goals:**

- Author a unit **once** — native (`.maestro/roles/<name>.md`), **or** a Claude
  Code subagent (`.claude/agents/*.md`) / skill (`SKILL.md`) you already have —
  and run it as a maestro stage.
- Add a declared tool-allowlist leg threaded through the existing adapter seam,
  with honest per-provider enforcement-vs-advisory semantics.
- Ship two demo built-in workflows that exercise the loader and tool leg.
- Keep today's inline-role behavior **byte-for-byte unchanged** when no unit is
  referenced.

**Non-functional goals:** parse/normalize each unit at most once per run (cache);
record the resolved tool policy in the run manifest for audit/repro.

## 2. Non-Goals (Scope Guard / YAGNI)

The following are explicitly **out of scope** for this deliverable:

- **No MCP gateway.** MCP tool tokens (e.g. `mcp__lint__check`) are validated and
  threaded through, but maestro does not host, proxy, or broker MCP servers.
- **No fan-out implementation.** `$fanout:<role>` and `kind:gather` are
  **documented as a roadmap only** (section 7) and are not implemented here.
- **No new role format beyond the superset.** MRC defines exactly one native
  format — a superset of the Claude Code subagent frontmatter. No second native
  schema, no bespoke DSL.
- **No changes to the transition sink set.** Sinks remain `$complete`, `$halt`,
  `$ask_user`, `$pause`, `$wait`. No parallel/fan-out sink is added in this cut.
- **No redesign of existing inline roles.** A workflow role without a `source`
  key behaves exactly as it does today.

**Deliverable = standard + loader + tool leg + 2 demo workflows + docs.**

## 3. Role Unit Format

### 3.1 Native unit (`.maestro/roles/<name>.md`)

A native unit is a markdown file with **YAML frontmatter** (a superset of the
Claude Code subagent format) and a **markdown body** that becomes the role's
`instructions`.

```markdown
---
# Identity / labeling
name: security-reviewer            # optional; defaults to the file stem
description: Reviews diffs for security regressions   # → label when name absent

# Provider selection (one of provider / alias; alias wins if both present)
provider: claude                   # built-in provider key
alias: claude                      # adapter alias / command name

# Execution knobs
model: ""                          # provider model id; "" = provider default
effort: ""                         # reasoning effort; "" = provider default
permission: read                   # read | write | plan

# Tool policy (NEW)
tools: [Read, Grep, "Bash(npm:*)", mcp__lint__check]
deny_tools: ["Bash(rm:*)"]         # optional explicit denials

# Contract / engine wiring
output_schema: review              # named schema OR safe relative ref
kind: agent                        # agent | stub | command | regression | scoring
verifies: true                     # marks this as a verification stage
---

You are a security reviewer. Inspect the diff for injection, path-escape,
secret-handling, and authn/authz regressions. Emit the review handoff...
```

### 3.2 Frontmatter field table

| Field | Type | Required | Default | Maps to `RoleDef` | Notes |
|-------|------|----------|---------|-------------------|-------|
| `name` | string | no | file stem | (identity) | Used for `label` if `description` absent. |
| `description` | string | no | — | `label` | Human label for the stage. |
| `provider` | string | no* | — | `provider` | Built-in provider key. *Native units default to `claude` if neither `provider` nor `alias` is set; subagents/skills default to `claude` (see §4). |
| `alias` | string | no | — | `alias` | Adapter alias / command name; takes precedence over `provider` for command selection (matches current adapter behavior). |
| `model` | string | no | `""` | `model` | `""` ⇒ provider default. |
| `effort` | string | no | `""` | `effort` | `""` ⇒ provider default. |
| `permission` | enum | no | `read` | `permission` | `read` \| `write` \| `plan`. Conservative default is `read`. |
| `tools` | string[] | no | — (unrestricted) | `tools` | **NEW** declared allowlist. Token grammar in §5.4. Absent ⇒ no allowlist constraint. |
| `deny_tools` | string[] | no | — | `deny_tools` | **NEW** explicit denials, applied on top of `tools`. |
| `output_schema` | string \| object | no | — | `output_schema` | Named schema (`review`, `implementation`, …), inline object, or a safe relative ref (validated by `isSafeRelativeRef`). |
| `kind` | enum | no | `agent` | `kind` | `agent` \| `stub` \| `command` \| `regression` \| `scoring`. Dispatched in `src/langgraph/nodes.mjs`. |
| `verifies` | boolean | no | `false` | `verifies` | Marks a verification stage. |
| `prompt_template` | string | no | (see §4.3) | `prompt_template` | Rarely set in a unit; usually supplied by the referencing workflow role to keep `roleKey` unique. |
| (body) | markdown | no | `""` | `instructions` | The markdown body after frontmatter. |

`skip` is **not** a unit field. It is workflow-positional (a role is `auto`/`never`
skipped relative to a pipeline) and is therefore set only on the inline workflow
role, never on a portable unit.

### 3.3 Referencing a unit from a workflow

A workflow role either stays **inline** (today's behavior, untouched) or
**references a unit** via `source` and overrides any fields inline:

```jsonc
{
  "roles": {
    // inline — unchanged from today
    "planner": { "provider": "claude", "permission": "plan", "prompt_template": "planner", "skip": "auto" },

    // unit reference + overrides (composition)
    "review": {
      "source": ".claude/agents/reviewer.md",
      "provider": "codex",          // override the unit's provider
      "prompt_template": "review"   // keep roleKey unique for this stage
    }
  }
}
```

**No `source` key ⇒ zero change to current behavior.** The inline object is
consumed exactly as it is today.

## 4. Loader & Normalization

New module: **`src/setup/role-loader.mjs`**, exporting `loadRole(ref)` (and a
batch helper used by the engine/CLI). `loadRole` detects the source by path/shape
and normalizes all three input kinds into the canonical `RoleDef` the engine
already consumes. The loader never throws on a *recognized* source; malformed
input produces a structured error (see §9).

### 4.1 Source detection

| Detection | Source kind |
|-----------|-------------|
| Path under `.claude/agents/` or `*.md` with Claude subagent frontmatter shape (`name` + `description`, `tools` as CSV) | **Claude subagent** |
| File named `SKILL.md`, or a directory containing one | **Skill** |
| Path under `.maestro/roles/` or `*.md` with MRC superset frontmatter | **Native MRC unit** |

When a path is ambiguous (a bare `*.md` that could be either), MRC superset
frontmatter is detected by the presence of any MRC-only field (`provider`,
`alias`, `permission`, `deny_tools`, `output_schema`, `kind`, `verifies`); a file
with only `name`/`description`/`tools`/`model` is treated as a Claude subagent.

### 4.2 Per-source normalization rules → `RoleDef`

**Claude subagent (`.claude/agents/*.md`):**

| Subagent field | → `RoleDef` |
|----------------|-------------|
| `name` | identity (used for `label` if `description` absent) |
| `description` | `label` |
| `tools` (CSV string) | `tools` (split on commas, trimmed → array) |
| `model` | `model` |
| body | `instructions` |
| (none) | `provider` defaults to `claude` |
| (none) | `permission` defaults to `read` |

**Skill (`SKILL.md` / skill dir):**

| Skill field | → `RoleDef` |
|-------------|-------------|
| `description` | `label` |
| body | `instructions` |
| (none) | `permission` defaults to `read` (read-only default) |
| (none) | `provider` defaults to `claude` |

**Native MRC unit (`.maestro/roles/*.md`):**

- The superset passes through: every field in §3.2 maps to the identically named
  `RoleDef` field; the body maps to `instructions`.
- Defaults from §3.2 are applied for absent fields.

### 4.3 Override precedence (composition)

The resolved `RoleDef` for a workflow stage is computed as:

```
RoleDef = applyDefaults( normalize( loadSource(role.source) ) ) ⊕ inlineRoleKeys
```

where `⊕` means **inline workflow-role keys always win**. Concretely:

1. Load + normalize the unit at `role.source` → a base `RoleDef`.
2. Apply per-source/format defaults (§3.2, §4.2).
3. Shallow-merge the inline workflow role's own keys over the base; every key
   present on the inline role (except `source` itself) overrides the unit value.
   `tools`/`deny_tools`, if present inline, **replace** (not merge with) the
   unit's arrays — last-writer-wins, so an author can fully override policy.
4. `prompt_template`: if neither the unit nor the inline role sets it, default to
   the **stage's state name** (the key under `roles{}`). This preserves the
   invariant in `workflow-templates.mjs` that a unique `prompt_template` per stage
   keeps `roleKey`/handoffs/visits isolated and falls through to the schema-aware
   generic prompt (only `planner`/`executor`/`reviewer` are special-cased in
   `nodes.mjs:168`).

When `role.source` is absent, steps 1–2 are skipped and the inline object is used
verbatim — guaranteeing no behavior change for existing workflows.

## 5. Tool Wiring

New module: **`src/adapters/tool-flags.mjs`**. It threads the normalized
`tools`/`deny_tools` arrays through the existing adapter seam
(`buildXCommand({ prompt, cwd, role, model, effort, permission, alias,
commandName, tools, deny_tools })`). Each adapter applies the policy best-effort
for its provider; `tool-flags.mjs` owns the shared tokenization, the advisory
block builder, and the manifest record.

### 5.1 Claude — hard enforcement

`src/adapters/claude.mjs` gains `--allowedTools` / `--disallowedTools` (the
natural insertion point — claude.mjs currently has **no** tools handling). Tokens
are space-joined into a single argument value:

```
--allowedTools "Read Grep Bash(npm:*)"
--disallowedTools "Bash(rm:*)"
```

This is **hard enforcement**: Claude refuses tools outside the allowlist.

### 5.2 Codex — partial (sandbox fold)

`src/adapters/codex.mjs` maps `permission` → `--sandbox`
(`read`→`read-only`, `write`→`workspace-write`) today. Bash-shaped tokens
(`Bash(...)`) inform the sandbox profile selection; all other tokens are
**advisory** (codex has no per-tool allowlist flag). The advisory remainder is
emitted via the §5.5 block.

### 5.3 Gemini / Copilot / Antigravity / Ollama — advisory only

These adapters expose minimal flags and no tool-enforcement surface. The full
tool policy is **advisory**: a deterministic "Tool Policy" block (§5.5) is
prepended to the role's instructions, and the policy is recorded in the run
manifest. Maestro does not pretend to enforce what the provider cannot.

### 5.4 Tool token grammar

Tokens validated at load time (§9):

- **Bare tool name:** `Read`, `Grep`, `Write` — `[A-Za-z][A-Za-z0-9_]*`.
- **Scoped Bash:** `Bash(<spec>)` where `<spec>` is a command-prefix glob, e.g.
  `Bash(npm:*)`, `Bash(git status:*)`.
- **MCP tool:** `mcp__<server>__<tool>`, e.g. `mcp__lint__check`.

Unrecognized tokens fail validation with a structured error naming the offending
token.

### 5.5 Advisory "Tool Policy" block format

Prepended to `instructions` for advisory providers (and for the codex advisory
remainder). Deterministic ordering (allow tokens sorted, then deny tokens sorted)
so identical policy produces identical text — enabling dedupe:

```
## Tool Policy (advisory)
This provider does not enforce tool allowlists. You MUST restrict yourself to:
- Allowed: Bash(npm:*), Grep, Read
- Denied: Bash(rm:*)
Using any tool outside this list is a policy violation.
```

When multiple roles in a run share an identical advisory block, it is emitted once
and deduped (see §8 Perf). Empty allow + empty deny ⇒ no block emitted.

### 5.6 Capability matrix (also published in `docs/role-convention.md`)

| Provider | `tools` allowlist | `deny_tools` | Mechanism |
|----------|-------------------|--------------|-----------|
| claude | **Enforced** | **Enforced** | `--allowedTools` / `--disallowedTools` |
| codex | Partial (Bash→sandbox), rest advisory | Advisory | `--sandbox` profile + advisory block |
| gemini | Advisory | Advisory | Tool Policy block + manifest |
| copilot | Advisory | Advisory | Tool Policy block + manifest |
| antigravity | Advisory | Advisory | Tool Policy block + manifest |
| ollama | Advisory | Advisory | Tool Policy block + manifest |

`docs/role-convention.md` states this honestly: only claude hard-enforces; codex
partially folds Bash scope into its sandbox; everything else is advisory.

## 6. New Built-in Workflows

Added to `WORKFLOW_TEMPLATES` in `src/setup/workflow-templates.mjs` (alongside
`default`, `extended`, `local`, `solo`, `full-audit-sweep`). Both demo the
standard and exercise the loader + tool leg — they are not one-offs.

### 6.1 `triage`

A single classifier role loaded as a unit, branching to routes by classification.

- **Roles:**
  - `triage` — loaded from a unit (`.maestro/roles/triage.md` shipped with the
    template, or referenced via `source`). `kind: agent`, `permission: read`,
    read-only tool policy (`tools: [Read, Grep]`), `output_schema: classification`
    (a named schema added in §8/§9), `prompt_template: triage`.
- **Transitions:** the classifier emits one of `bug` / `feature` / `question`:

  ```jsonc
  "transitions": {
    "triage": {
      "bug": "$complete",
      "feature": "$complete",
      "question": "$ask_user",
      "error": "$halt"
    }
  }
  ```

  In this cut the branch targets are sinks (the workflow demonstrates
  classification + routing); downstream pipelines can replace the sink targets
  with role names when composing. `modes: { task: { initial: "triage" } }`.

### 6.2 `research`

A two-stage gather → synthesize pipeline that exercises read-only,
tool-restricted big-context gathering followed by synthesis.

- **Roles:**
  - `gather` — `provider: gemini` (big context window), `permission: read`,
    tool-restricted (`tools: [Read, Grep]`; advisory on gemini → Tool Policy block
    is prepended), `prompt_template: gather`, `output_schema` a named `research`
    schema (§9). Body instructs broad read-only collection of relevant context.
  - `synthesize` — `provider: claude`, `permission: read`, `prompt_template:
    synthesize`. Body instructs synthesis of the gathered material into a final
    answer.
- **Transitions:**

  ```jsonc
  "transitions": {
    "gather":     { "done": "synthesize", "question": "$ask_user", "error": "$halt" },
    "synthesize": { "done": "$complete",  "question": "$ask_user", "error": "$halt" }
  }
  ```

  `modes: { task: { initial: "gather" } }`.

Both templates set a unique `prompt_template` per stage (matching the
`full-audit-sweep` invariant) so `roleKey`s never collide.

## 7. Fan-out Roadmap (future — NOT built in this cut)

This section is documentation only. **Nothing here is implemented.**

A future cut may add parallel subagent spawn/collect:

- A new transition sink `$fanout:<role>` that spawns N parallel instances of
  `<role>` (the agentic-harness direction).
- A `kind: gather` role that collects and merges the parallel results before the
  workflow continues.

These require new engine machinery (parallel scheduling, result aggregation,
fan-in join semantics) and a new sink in `state-machine.mjs`. They are recorded
here so the standard anticipates them, but the SCOPE GUARD (§2) excludes them from
this deliverable.

## 8. QOL / Reliability / Performance (additive)

**QOL — CLI:**

- `maestro role list` — list discoverable units across `.maestro/roles/`,
  `.claude/agents/`, and skills.
- `maestro role show <unit>` — print the normalized `RoleDef` for a unit.
- `maestro role lint <unit>` — validate a unit (frontmatter shape, tool grammar,
  schema ref safety) and report problems.
- `maestro import-agent <path>` — convert a `.claude/agents/x.md` subagent into a
  native `.maestro/roles/x.md` unit (normalize + write the superset).

**Reliability:**

- Validate tool tokens against the §5.4 grammar **at load time** (fail fast with a
  named token in the error).
- Extend `src/workflow-validate.mjs` to validate `source` and `tools`/`deny_tools`
  (§9).
- Persist the **resolved tool policy** (per role, with enforced-vs-advisory
  status) in the run manifest for audit/repro.

**Performance:**

- Parse + normalize each unit **once per run** and cache by resolved absolute path
  (a unit referenced by multiple stages is read once).
- Dedupe identical advisory preambles within a run (deterministic block text from
  §5.5 makes this a string-equality dedupe).

## 9. Validation Changes (`src/workflow-validate.mjs`)

`src/workflow-validate.mjs` is pure (no I/O); the loader performs file existence
checks, and validation performs structural/grammar checks.

- **`source` reference:** when a role declares `source`, validate the path with the
  existing `isSafeRelativeRef` (no path escape, no absolute, no `..`). Loader-time
  existence/parse errors surface separately as structured load errors.
- **`tools` / `deny_tools`:** must be arrays of strings; each token must match the
  §5.4 grammar. A non-array or a malformed token is an error naming the field and
  token.
- **`output_schema`:** unchanged semantics — resolved via `resolveRoleSchema`
  (`src/schemas/index.mjs`); string-ref form already goes through
  `isSafeRelativeRef`. New named schemas `classification` and `research` are added
  to `src/schemas/definitions.mjs` (and surfaced via `src/schemas/index.mjs`) to
  back the demo workflows.
- **Verifier warning:** the existing `missing_output_schema` advisory for
  `VERIFIER_ROLE_NAMES` is unchanged; resolved units that declare `verifies: true`
  without a schema receive the same advisory.
- **Cycle detection / sinks:** unchanged. No new sink is introduced (§2), so
  `findCycles` / `cycleHasTermination` need no changes.

Structured load-error shape (loader, not validator):
`{ code, source, message, token? }` with codes such as
`role_source_not_found`, `role_source_parse_failed`, `role_tool_token_invalid`.

## 10. Testing Strategy

- **Loader normalization (golden snapshots):** one fixture per source kind
  (`.claude/agents/*.md`, `SKILL.md`, `.maestro/roles/*.md`) → assert the exact
  normalized `RoleDef` against a checked-in golden snapshot. Includes the
  defaulting rules (provider/permission) per source.
- **Override precedence:** unit + inline overrides → assert inline keys win,
  `tools` arrays replace (not merge), and `prompt_template` defaults to the stage
  state name when unset.
- **No-source invariance:** a workflow with only inline roles produces an
  identical `RoleDef` to today (regression guard).
- **Tool-flag mapping per provider:** assert claude emits
  `--allowedTools`/`--disallowedTools`; codex folds Bash tokens into the sandbox
  and emits an advisory remainder; gemini/copilot/antigravity/ollama emit the
  deterministic Tool Policy block and no enforcement flags.
- **Advisory block determinism + dedupe:** identical policy → identical block
  text; dedupe within a run.
- **Validation / error paths:** malformed `tools` tokens, escaping `source` refs,
  non-array `tools`, missing schema for a `verifies` role (advisory). Assert the
  structured error codes.
- **workflow-validate extensions:** `source`/`tools`/`deny_tools` checks; new named
  schemas resolve; cycle detection unchanged.
- **Built-in workflow templates:** `triage` and `research` load, normalize, and
  pass `workflow-validate` cleanly.

Per repo convention, write the failing tests first, then implement.

## 11. File-by-File Change List

**New files:**

- `src/setup/role-loader.mjs` — `loadRole(ref)` + batch helper; source detection,
  per-source normalization, override composition, structured load errors.
- `src/adapters/tool-flags.mjs` — shared tool tokenization, per-provider flag
  mapping helpers, advisory "Tool Policy" block builder, manifest record helper.
- `.maestro/roles/triage.md`, `.maestro/roles/gather.md`,
  `.maestro/roles/synthesize.md` — units backing the demo workflows (shipped with
  the templates).
- `docs/role-convention.md` — the published standard + capability matrix.

**Modified files:**

- `src/adapters/claude.mjs` — add `tools`/`deny_tools` params →
  `--allowedTools`/`--disallowedTools` (hard enforcement). Natural insertion point;
  currently has no tools handling.
- `src/adapters/codex.mjs` — accept `tools`/`deny_tools`; fold Bash tokens into the
  `--sandbox` profile; emit advisory remainder via `tool-flags.mjs`.
- `src/adapters/gemini.mjs`, `src/adapters/copilot.mjs`,
  `src/adapters/antigravity.mjs`, `src/adapters/ollama.mjs` — accept
  `tools`/`deny_tools`; prepend the advisory Tool Policy block to instructions.
- `src/adapters/registry.mjs` — pass `tools`/`deny_tools` through the adapter call
  seam (including the custom-command path).
- `src/langgraph/nodes.mjs` — resolve `source` via `role-loader.mjs` when present;
  apply override composition; thread the resolved tool policy into the adapter
  call and into the run manifest. `kind` dispatch (~248/311/421/610) unchanged.
- `src/setup/workflow-templates.mjs` — add `triage` and `research` to
  `WORKFLOW_TEMPLATES`; export their builders.
- `src/workflow-validate.mjs` — validate `source`, `tools`, `deny_tools`.
- `src/schemas/definitions.mjs` + `src/schemas/index.mjs` — add named
  `classification` and `research` schemas.
- `src/setup/import.mjs` (or a new CLI command wired from the bin entry) — back the
  `maestro role list|show|lint` and `maestro import-agent` commands.

(Read of `src/setup/role-loader.mjs` confirmed it does not yet exist — it is
net-new. All other cited paths exist.)

## 12. Open Questions (resolved with stated defaults)

No blocking open questions remain. Decisions taken to avoid ambiguity:

1. **Default provider for subagents/skills with no provider field.** Resolved:
   default to `claude` (the subagent format's home provider).
2. **`tools` merge vs replace on override.** Resolved: inline `tools`/`deny_tools`
   **replace** the unit's arrays (last-writer-wins) — predictable and lets an
   author fully override policy without partial-merge surprises.
3. **`prompt_template` when unset.** Resolved: default to the stage's state name to
   preserve the unique-`roleKey` invariant from `workflow-templates.mjs`.
4. **Ambiguous bare `*.md` detection.** Resolved: presence of any MRC-only
   frontmatter field marks it native; otherwise it is treated as a Claude
   subagent.
5. **Demo workflow branch targets for `triage`.** Resolved: branch to sinks in this
   cut (classification + routing demo); composing pipelines swap in role names.
