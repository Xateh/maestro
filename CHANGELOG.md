# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (BREAKING)

- **Dispatch consolidation & WORKFLOW.md removal (SP0b)** — the server (Linear
  poll → auto-dispatch) now runs issues through the *same* LangGraph task engine
  as `maestro task`. The standalone dispatch front-matter file and its bespoke
  Codex client are gone; configuration moves into `config.json`'s `server`
  block, and dispatched issues become graph tasks (one per issue, idempotent via
  a new `source_issue_id` field).
  - **Removed:** the dispatch front-matter file and its loader (`src/workflow.mjs`),
    the dispatch-only Codex client (`src/codex-client.mjs`), the
    `--workflow-path` flag, the positional dispatch-file argument to
    `maestro serve`, and the deprecated `maestro <file>.md` entry point.
  - **`maestro serve` surface:** now `maestro serve [--config <path>]
    [--state-dir <dir>] [--port <n>]` only. The tracker/workspace/agent settings
    come from `config.json`.
  - **Live config reload dropped:** `config.json` is read once at server start;
    changes require a restart.
  - **Cancellation is bookkeeping-only:** a terminal/stalled issue clears the
    orchestrator's running/retry maps; an in-flight graph run is left to finish
    (real mid-run engine cancellation is deferred).
  - **MCP `maestro_read_workflow`** no longer returns `workflow_md` (only
    `workflow_json`). Export bundles no longer include a dispatch front-matter
    file.
  - **Migration (manual):** move your old dispatch front-matter into
    `config.json` under `server`:

    | Old front-matter           | New `config.json` location                  |
    | -------------------------- | ------------------------------------------- |
    | `tracker.*`                | `server.tracker.*`                          |
    | `polling.*`                | `server.polling.*`                          |
    | `workspace.*`              | `server.workspace.*`                        |
    | `hooks.*`                  | `server.hooks.*`                            |
    | `agent.*`                  | `server.agent.*`                            |
    | `codex.stall_timeout_ms`   | `server.agent.stall_timeout_ms`             |
    | `codex.*` (sandbox)        | **dropped** (graph engine adapters own sandboxing) |
    | prompt body (Markdown)     | `server.intake_template` (Liquid string)    |
    | *(new)*                    | `server.workflow` (named graph workflow to run) |

### Added

- **Per-stage event emission (SP6a)** — every stage execution is exposed as a
  structured `stage_event` (`{workflow_id, stage, model, tokens, duration_ms,
  status, artifacts}` + additive `role`/`provider`), derived as a **projection
  over the steps maestro already records** — no events table, no second write
  path, so the stream can never diverge from the record it describes.
  - **`maestro events <id> [--json]`** — read-only inspection of the projected
    stream (`stage status model tokens duration_ms [artifacts]`, or a raw
    `stage_event` JSON array with `--json`).
  - **OpenTelemetry**: each event is mirrored as a `maestro.stage` span (fields
    as `maestro.*` attributes) when a collector is configured
    (`OTEL_EXPORTER_OTLP_ENDPOINT`); a fully-guarded no-op otherwise — emission
    never breaks a run.
  - **Real tokens**: a per-provider `parseUsage` reads the structured usage each
    CLI emits (claude stream-json `result.usage`; codex `--json`;
    copilot/antigravity/gemini JSON incl. gemini `usageMetadata`); ollama /
    unknown / parse-miss / truncated-tail ⇒ `0`. Parsed once at the
    agent-success step and stored on the step.
  - **Fixed `duration_ms` for non-LLM stages**: `stub`/`command`/`regression`/
    `scoring` branches now stamp `started_at`, so their projected duration is
    real instead of `0`. `model` stays empty (`""`) for non-LLM stages.
  - Additive only: no schema/kind/template change; the default 3-role workflow
    stays byte-identical. A persisted/indexed events table is deferred to SP6b.

- **Reliability scoring + gates engine (SP5)** — the `full-audit-sweep` gains a
  real, deterministic scoring stage. Additive only; the default 3-role workflow
  stays byte-identical.
  - **Role `kind: "scoring"`**: a non-LLM stage (sibling to
    `stub`/`command`/`regression`; the agent runner is never invoked and it never
    throws) that reads every prior stage handoff, derives the six SP1 `scoring`
    numbers, enforces the manifest's declared `gates:`, and emits an
    outcome-dependent event (`passed`/`blocked`, overridable via
    `pass_event`/`block_event`).
  - **Never fabricate confidence**: each sub-score is a pure function of one
    upstream field — `correctness_score`←`evaluation.pass_rate`,
    `test_score`←`tests.tests_created` (presence), `review_score`←`review.severity`
    (none→1.0 … critical→0.0), `security_score`←`threat_model` mitigation ratio,
    `regression_score`←`regression` pass ratio. Absent evidence (missing handoff
    or wrong-typed field) ⇒ `0.0`, the role named in `missing_evidence[]`, and
    `score_inputs[score].missing: true` — a `0` from absence stays distinguishable
    from a `0` from bad results. A vacuous-pass (e.g. empty `regressions_run`) is
    `1.0` and not flagged. `overall_confidence` is the **product** of the five
    sub-scores, so any zeroed axis drives it to `0`.
  - **Gate enforcement** of the four SP1 keys (`min_coverage`,
    `no_high_severity_findings`, `all_regressions_pass`, `min_overall_confidence`):
    only present keys are enforced; a `false`-valued bool gate is skipped; a gate
    with no evidence fails closed (e.g. `min_coverage` while `coverage:{}`).
    `gates` absent/`{}` ⇒ `passed` (informational). Gates are read from the
    top-level manifest `gates:` (a role-level `gates` override is also accepted).
  - **Pure module `src/scoring.mjs`** (`deriveScores` + `enforceGates`): no I/O,
    no imports, both total — trivially unit-testable.
  - **`bad_scoring_spec` validation**: a `kind: "scoring"` role must declare both
    its effective `pass_event` (default `passed`) and `block_event` (default
    `blocked`) transitions.
  - **Template**: `full-audit-sweep` inserts a `scoring` role between
    `regression` and `human_approval` (`regression.done` repointed to `scoring`;
    `scoring.passed → human_approval`, `scoring.blocked → $halt`). No `gates:`
    block is declared, so scoring is purely informational by default — users opt
    into enforcement by adding a `gates:` block. No new config key, no schema
    change.

- **Regression corpus stage (SP4)** — the `full-audit-sweep` `regression` stage
  is now real. Additive only; the default workflow stays byte-identical.
  - **Role `kind: "regression"`**: a non-LLM stage that loads an on-disk corpus
    (`<cwd>/.maestro/regression/*.json`, override via `corpus_dir`), re-runs each
    case via the SP3 `commandRunner`, auto-promotes upstream
    `evaluation.failures[]` into new corpus cases, and maps results to the
    `regression` schema `{regressions_run, new_failures, promoted_tests}` (plus
    `corpus_load_errors` and `outcome`). The agent runner is never invoked; a
    case failure, corpus load error, or promotion write error never throws —
    each is captured as evidence.
  - **Configurable `attempts`** (case ⟶ role ⟶ `config.regression_attempts` ⟶
    `1`): a case passes if any attempt passes, is a regression only after all
    attempts fail, and the first pass stops early. The `attempts` made are
    recorded per case.
  - **Outcome-driven routing**: emits `done` when `new_failures.length <
    fail_threshold` (default `1`), else the role's `fail_event` (default
    `regressions_found`). The stage never halts — the manifest's `transitions`
    decide routing; `error` stays reserved for internal faults.
  - **`regressionStore` op**: a new injectable (`src/regression-corpus.mjs`,
    fs-backed default, wired into the CLI ops bundle) with `loadCorpus` /
    `promoteFailures` / `deriveCaseId`; tests inject a fake.
  - **`bad_regression_spec` validation**: a `kind: "regression"` role must
    declare both a `done` and its effective `fail_event` transition;
    `attempts`/`fail_threshold`, if present, must be positive integers.
  - **Template**: `full-audit-sweep` `regression` converts from `kind: "stub"`
    to `kind: "regression"` and gains `regressions_found → implementation`
    (a loop-back bounded by `loop_limits`). New optional config key
    `regression_attempts` (default `1`, carried across config migration).

- **Automated evaluation stage (SP3)** — the `full-audit-sweep` `evaluation`
  stage is now real. Additive only; the default workflow, SP2 `kind: "stub"`
  behavior, and `static_analysis`/`regression` (still stubs) are unchanged.
  - **Role `kind: "command"`**: a non-LLM stage that runs declared shell
    commands in the task tree (`worktree_path ?? cwd`) and maps results to the
    `evaluation` schema `{pass_rate, failures, coverage}`. Evidence-only — **no
    gating**: every command runs and the stage always emits `event: "done"`; the
    agent runner is never invoked and a command failure never throws (a spawn
    error / timeout / thrown runner is captured as `exit_code: 127`).
  - **Hybrid `pass_rate`**: exit-code granularity by default; an optional
    per-command `parser` (`{passed, failed, total}` regexes) contributes finer
    test counts. A pass-rate is never fabricated — counts are used only when a
    total is derivable (a `total` regex, or both `passed`+`failed`); otherwise
    the command falls back to its exit code. `pass_rate` is `1.0` for empty
    `commands: []`. `coverage` is always `{}` in SP3.
  - **`commandRunner` op**: a new injectable runner (`src/command-runner.mjs`,
    wired into the CLI ops bundle) wrapping `sh -lc` with a timeout and a bounded
    output tail; tests inject a fake.
  - **`bad_command_spec` validation**: `validateWorkflow` rejects a command
    missing a non-empty `name`/`run`, a duplicate `name`, or a non-array
    `commands`. Empty `commands: []` is valid.
  - **Template**: `full-audit-sweep` `evaluation` converts from `kind: "stub"`
    to `kind: "command"` with `commands: []` (a vacuous no-op until populated).
    Honors optional `command_timeout_ms` (default `120000`) and existing
    `stream_tail_bytes` (default `65536`) config knobs without adding new
    default-config keys.
- **Verification pipeline spine (SP2)** — the 9-stage reliability pipeline as a
  runnable, opt-in named workflow. Additive only; the default
  planner→executor→reviewer workflow is unchanged.
  - **Role `kind` discriminator**: `kind: "agent"` (default; absent ⇒ agent)
    preserves existing behavior. `kind: "stub"` skips provider resolution and
    the agent call entirely, emitting a schema-conforming placeholder payload
    with `event: "done"` (the seam SP3 extends with `kind: "command"`).
  - **`verifies: true`** role flag tags verification stages declaratively
    (inert at runtime in SP2; consumed by the new validation rule and later
    scoring).
  - **Schema-aware prompts**: the generic (custom-role) prompt now renders the
    role's `output_schema` required-key skeleton plus enum notes into the
    `MAESTRO_HANDOFF` example, so verifier agents emit conforming JSON. Schema
    helpers `emptyPayloadForSchema` and `schemaSkeleton` added to
    `src/schemas/`. Planner/executor/reviewer prompts are unchanged.
  - **Independence validation**: `validateWorkflow` reports
    `non_independent_role` (error) when a role is both an implementation entry
    role and a verifier — distinct roles ⇒ distinct sessions ⇒ independent.
  - **`full-audit-sweep` template**: a new `WORKFLOW_TEMPLATES` entry —
    implementation → static_analysis → review → threat_model → edge_cases →
    tests → evaluation → regression → human_approval, with bounded
    `changes_requested` rework loops from the discovery verifiers back to
    implementation (`loop_limits.default_max_visits: 3`). Opt in with
    `maestro workflow use full-audit-sweep --as full-audit-sweep` and run via
    a task's `workflow` field. Not auto-scaffolded by `maestro init`.
- **Manifest & stage I/O contracts (SP1)** — a shared, declarative vocabulary
  for reliable pipelines.
  - **Schema registry** (`src/schemas/`): 10 canonical named JSON Schemas
    (draft 2020-12) — `implementation`, `static_analysis`, `review`,
    `threat_model`, `edge_cases`, `tests`, `evaluation`, `regression`,
    `scoring`, `stage_event` — compiled once with ajv. API: `getSchema`,
    `listSchemas`, `validatePayload`, `validateInline`, `resolveRoleSchema`.
  - **Workflow manifest v2**: roles may declare `output_schema` (registry name
    or inline JSON Schema) or `output_schema_ref` (relative path), plus a
    top-level `gates` block (`min_coverage`, `no_high_severity_findings`,
    `all_regressions_pass`, `min_overall_confidence`). `DEFAULT_WORKFLOW` is now
    `version: 2`; v1 workflows stay valid. Gates are validated now; enforcement
    is a later sub-project.
  - **Validation**: `validateWorkflow` reports `unknown_output_schema`,
    `bad_output_schema`, `bad_gates` (errors) and `missing_output_schema`
    (warning for verifier-named roles without a schema). Still pure / no I/O.
  - **Soft runtime validation**: when an agent emits a `MAESTRO_HANDOFF` and the
    role resolves a schema, `schema_validation: { ok, errors, schema }` is
    recorded in `priorHandoffs`, `handoff.<role>.json`, and the DB `handoffs`
    row (new nullable `schema_validation` column in both SQLite and Postgres).
    Additive evidence only — routing is never changed.
  - **YAML authoring**: workflows may be authored as `.maestro/workflows/<name>.yaml`
    or `.maestro/workflow.yaml`; JSON wins (with a `workflow_format_precedence`
    warning) when both exist for a slot.
  - Adds `ajv` as a direct dependency.
- **Multi-workflow selection (SP0a)** — a single state dir can hold multiple
  named workflows under `.maestro/workflows/<name>.json`, selectable per task.
  The legacy `.maestro/workflow.json` is treated as the `default` workflow (no
  forced migration; named `default.json` takes precedence with a
  `workflow_precedence` warning when both exist).
  - Store API: `readWorkflow(name)`, `writeWorkflow(name, workflow)` (back-compat
    single-arg default write retained), `listWorkflows()`,
    `applyWorkflowTemplate({name, as})`, plus `isValidWorkflowName` and the
    `^[a-z0-9][a-z0-9_-]{0,63}$` name rule.
  - Tasks carry a `workflow` field (default `"default"`); the engine loads the
    selected workflow and surfaces a typed `unknown_workflow` blocker for an
    unknown name instead of falling back silently.
  - CLI: `maestro task --workflow <name>`, `maestro workflow list`, and
    `maestro workflow use <name> --as <slot>`.
  - MCP: optional `workflow` param on `maestro_create_task` (name shape
    validated; existence checked by the spawned CLI).
  - TUI: workflow picker on task creation and a workflows list/edit view
    (defaults to `default`).

## [0.1.0] - 2026-06-14

Initial release.

### Added

- Plan → execute → review pipeline driven by a LangGraph state graph, with
  typed handoffs between roles (raw agent logs never re-enter prompt context).
- Six provider backends: claude, codex, copilot, gemini, antigravity, and a
  built-in ollama adapter for fully local models.
- Herdr terminal integration: one tab per task, agents run in visible panes.
  Tabs close automatically on success, persist as a conversation trail while a
  task waits on the user, and are reused when the task resumes
  (`herdr.close_tab_on`: `success` | `terminal` | `never`).
- **Dual-backend persistence** — SQLite task store (`node:sqlite`) by default,
  or PostgreSQL when `DATABASE_URL=postgres://…` is set. `openStore()` routes to
  `PostgresTaskStore` (`pg` pool) automatically; both backends share an
  identical schema and a uniform async store interface. JSON-file mirror kept
  for legacy readers.
- **Encrypted secret store** — `maestro setup keys --encrypt` migrates
  `.maestro/secrets.local.json` to an encrypted `secrets.local.enc.json`
  (scrypt + AES-256-GCM, zero new deps) and shreds the plaintext. Unlock with
  `MAESTRO_SECRET_PASSPHRASE` or an interactive prompt; real env vars still win.
  `maestro doctor` reports the store mode. `maestro setup harden` installs a
  Claude Code guardrail (PreToolUse hook + deny rules) so only maestro reads its
  secrets. See `docs/configuration.md` § Secrets.
- **OpenTelemetry tracing** — set `OTEL_EXPORTER_OTLP_ENDPOINT` to export
  traces and spans via OTLP/HTTP proto. Auto-instruments `http`, `pg`, and
  `dns`. Completely zero-overhead (no imports, no SDK init) when the env var
  is absent. Override the service name with `OTEL_SERVICE_NAME`.
- MCP server exposing eight `maestro_*` tools for agent callbacks.
- Interactive TUI (`maestro tui`) for reviewing, approving, and answering tasks.
- **Interactive web dashboard** — the HTTP server (`maestro serve`) serves a
  Linear-inspired browser UI at `/`:
  - Live task board polling `/api/v1/state` every 5 s (active) or 30 s (idle)
    with surgical DOM updates — no page reloads.
  - Filter tabs: All / Running / Retrying / Completed.
  - Click any row to open a slide-in detail panel that fetches
    `/api/v1/<identifier>`: shows issue state, attempt, timestamps,
    description, priority, assignee, and full JSON. Actions: Copy JSON,
    Raw endpoint link.
  - Trigger Refresh button (POST `/api/v1/refresh`) with loading spinner;
    Force-Poll button for immediate state sync.
  - Toast notifications and a live pulse indicator in the toolbar.
- Security model: host-command denylist, env secret stripping, path-traversal
  guards, config redaction.
- **HTTP endpoint hardening** — the dashboard/API server (`maestro serve`)
  applies a per-IP token-bucket rate limit (reads ~120/min, writes ~12/min;
  `429` + `Retry-After` when exceeded) and validates input on every route:
  issue identifiers are length-capped and charset-restricted (malformed input
  → `400` instead of `500`), and oversized `POST` bodies are rejected (`413`).
  Disable with `MAESTRO_HTTP_RATELIMIT=off`. MCP tool inputs (ids, prompt,
  status, mode) gained matching length/type validation.
- Headroom context compression for prior-output pipelines.
- Linear tracker integration (server mode).
- GitHub Actions CI: lint (Biome), test matrix (Node 22/24 on Linux plus a
  macOS leg), coverage (c8) with an enforced threshold gate, dependency
  audit; Dependabot for npm and Actions updates.
- `maestro init --workflow <name>` workflow templates: `default` (planner →
  executor → reviewer) and `extended`, which adds a read-only System
  Evaluator role — the reviewer can escalate hard cases via
  `MAESTRO_HANDOFF: {"event":"escalate",...}`, and
  `maestro task --mode evaluate` runs a standalone principal-level audit.
- Two more workflow templates: `local` (every role on ollama, zero cloud) and
  `solo` (executor only, fastest loop).
- `maestro workflow use <name>` — switch `workflow.json` to any built-in
  template; the previous file is always backed up to `workflow.json.bak`.
- `maestro doctor [--json]` — read-only preflight: node version, provider CLI
  presence + versions, herdr availability, and state-dir health (config,
  workflow validation, db, secret store mode). Exit 1 on any failing check.
- Automatic herdr → terminal backend fallback: when the herdr binary isn't on
  PATH, tasks run on the terminal backend with a one-line notice instead of
  failing (`MAESTRO_BACKEND=terminal` still forces/silences it).
- End-of-run summary: after `maestro task` / `run-task`, a per-role table
  with duration, stdout size, and status; steps now persist `started_at`
  alongside `completed_at`.
- npm publish metadata (`repository`, `license`, `author`, `keywords`,
  `prepublishOnly`) and a `RELEASING.md` release checklist.
- Tag-triggered GitHub Release workflow: pushing `vX.Y.Z` lints, tests,
  verifies the tag against `package.json`, and publishes a Release with the
  matching changelog section and the packed tarball (npm publish stays
  manual).
- Community health files: issue forms, Contributor Covenant 2.1 code of
  conduct, CODEOWNERS, and a documented platform policy (Linux/macOS;
  Windows via WSL2).

### Changed

- Project renamed from Symphony to Maestro.
- `maestro task --plan-only` now errors with `unknown_mode` when the workflow
  defines no `plan-only` mode (previously it silently fell back to
  `workflow.initial` and ran a full write-enabled pipeline).
- The init wizard prints a one-line explainer before each setup question.
- Full-screen TUI (`maestro tui` on a real terminal): keyboard-driven task
  board with filter views and live refresh, task detail with one-keystroke
  approve/deny/message/retry/cancel/mark-done/resume/extend, a settings
  editor, and a workflow graph screen that renders roles, handoff arrows, and
  event transitions as a responsive grid (vertical stack on narrow
  terminals). The classic prompt-driven TUI remains the fallback for non-TTY
  use and via `MAESTRO_TUI_CLASSIC=1`.
- `--help` / `-h` / `help` CLI usage output.
- `bin/maestro.mjs` is now a thin entry shim; the CLI implementation lives in
  `src/cli/` modules (no behavior or public-surface change).

### Fixed

- MCP server no longer throws at import time when no `.maestro` directory
  exists up-tree; root discovery is lazy and errors surface on first tool call.
- The `node:sqlite` ExperimentalWarning is no longer printed on every CLI and
  MCP server run; other process warnings still pass through.
- Captured agent stdout/stderr are stripped of ANSI/VT control sequences before
  entering handoff payloads and the console (on-disk logs stay raw), so CLIs
  that redraw streaming progress no longer leak cursor-move escapes.
- `scripts/` is now included in the published package, so `maestro setup harden`
  (which installs a hook backed by `scripts/secret-guard.mjs`), the
  `agent:ocr` / `agent:eval` example agents, and `headroom:setup` work from an
  installed package instead of only from a git clone.
- The `agent:ocr` / `agent:eval` scripts fail fast with an install hint when the
  Ollama binary is absent, instead of surfacing a raw spawn error mid-run.

[0.1.0]: https://github.com/Xateh/maestro/releases/tag/v0.1.0
