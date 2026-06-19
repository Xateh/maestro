# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Role Convention doc no longer pitches Maestro *as* the `plan → execute →
  review` pipeline.** `docs/role-convention.md` now frames that flow as just the
  stock graph, consistent with the README's positioning. Documentation only — no
  behavior or API change.

### Removed

- **Internal planning/spec docs under `docs/superpowers/` are no longer tracked.**
  They predated the `.gitignore` rule and were still committed; untracked now and
  a `.gitattributes export-ignore` keeps the tree out of `git archive` release
  tarballs. Files remain locally; history is unchanged (they document shipped
  v0.3.0 features).

## [0.3.0] - 2026-06-19

### Added

- **Per-edge context contract — experimental prototype (item A, headline).** A
  workflow may opt in with `experimental_per_edge_context: true` plus an
  `edge_context` map (`"<from>:<event>"` or per-source `"<from>"` →
  `"full"` | `"scoped"` | `["role", …]`) to declare, **per inbound edge**, which
  prior handoffs the destination node's prompt sees. Off by default — default
  workflows are byte-identical. New pure module `langgraph/context-contract.mjs`;
  wired into the LLM node path (only the prompt's view is narrowed, never the
  durable handoff record). Falsification **verdict: KEEP** — per-edge context
  provably expresses what per-role static config cannot, demonstrated on the
  stock `full-audit-sweep`, where `implementation` re-entered via different
  critics resolves different input views.
- **`output_schema_conformance` workflow gate (item B).** Promotes per-node soft
  `schema_validation` evidence into an auditable **run** verdict — "every handoff
  that declared a schema conformed to it." Declarable in `gates:` (validated in
  `workflow-validate.mjs`), enforced in `scoring.enforceGates` from per-handoff
  metadata; any non-conforming handoff blocks and names the offending role(s).
- **`require_distinct_reviewer` opt-in assertion (item C).** When `true`,
  `workflow-validate` errors (`non_distinct_reviewer`) if any verifier role
  (`verifies: true`) shares a provider with an implementation entry role — so a
  model never reviews its own work. Opt-in; the default-on flip is deferred.

### Notes

- **Report-back determinism probe (item D)** — feasibility write-up returning a
  **verdict**: report-back is not expressible on the single-active-node engine,
  and even on a future concurrent engine output-reproducible determinism cannot
  survive it. The
  North-Star wording stays *auditable / replayable*; "deterministic" is confined
  to DAG traversal/wiring, never outputs.

## [0.2.1] - 2026-06-18

### Fixed

- **Local LLM provider alignment.** `maestro doctor` and the CLI/config docs
  (`docs/cli.md`, `docs/configuration.md`, `docs/local-llm.md`) now match the
  experimental local providers actually shipped in the adapter registry, so
  doctor no longer reports drift against providers it doesn't recognize.

## [0.2.0] - 2026-06-18

### Added

- **Schema contract closeout (v0.2.0, AUDIT F4)** — `output_schema_ref` is now a
  first-class, enforceable contract end to end.
  - **One shared validator.** The five duplicated `resolve→validate` branches in
    `langgraph/nodes.mjs` (stub / command / regression / scoring + the LLM
    handoff) collapse into a single `validateRolePayload(roleDef, payload)` helper
    in `schemas/index.mjs`, returning the same `{ ok, errors, schema }` evidence
    (or `null` when nothing is declared).
  - **Opt-in strict enforcement.** A role may set `enforce_output_schema: true` to
    promote soft validation to a hard halt — a non-conforming payload routes to
    `$halt` with a typed `output_schema_violation` blocker instead of recording
    soft evidence and continuing. Soft validation stays the default; the flag is
    type-checked in `workflow-validate.mjs` (warns when set without a schema).
  - **TUI round-trip guard.** `writeWorkflow` strips a ref-derived `output_schema`
    before persisting, so editing a ref-declared workflow keeps `output_schema_ref`
    authoritative and never bakes the inline schema onto disk.
- **`full-audit-sweep-gated` workflow template** — the documented gated example
  (ratifies the default-workflow gate decision): the lean `full-audit-sweep`
  ships `scoring` with no gates (informational), while `full-audit-sweep-gated`
  opts in to exactly one `no_high_severity_findings` gate (reviewer-severity →
  `$halt`).
- **`npm run test:terminal`** — a named lane that runs the full suite under
  `MAESTRO_BACKEND=terminal`, pinning the zero-dependency terminal backend (the
  default) as a first-class tested configuration in CI. README/CONTRIBUTING now
  document the terminal backend as the default and `herdr` as optional
  acceleration.
- **`maestro serve` multi-service management** — `serve` becomes a service
  manager: register, run, and supervise multiple tracker-backed services from a
  single state dir. Each service is a named definition (`serve add <name> --slug
  … [--port --workflow --var --workspace --shared-state]`) backed by an
  owner-checked `0600` definition + pid-record store. Lifecycle is
  identity-verified against the recorded pid via `/proc` (liveness, `stop`,
  `pause`, `resume`) with a detached worker spawn under an exclusive start lock,
  so a stale pid can't be killed or double-started. `serve list`/`status`
  derive live state; `serve logs <name> [-f] [-n N]` tails a bounded worker log;
  `serve adopt` materializes a legacy single-tracker config as a `default`
  service. Service overlays resolve the `server` config block with a var
  denylist and port/api-key validation, failing fast at start on an unset
  api-key var or a port collision.
- **Portable roles — Maestro Role Convention (MRC)** — author a role once and
  reuse it across workflows, and consume Claude Code subagents and skills
  directly. A role loader normalizes `.claude/agents`, `SKILL.md`, and native
  `.maestro/roles` units into one `RoleDef`; a role's `source` plus inline
  overrides compose (no `source` ⇒ unchanged behavior). Per-role
  `tools`/`deny_tools` allowlists thread through the adapter seam — claude
  hard-enforces via `--allowedTools`/`--disallowedTools`, codex folds Bash scope
  into `--sandbox`, other providers record advisory scope in the run manifest.
  Ships `triage` (classifier branch) and `research` (gather→synthesize) demo
  workflows, `maestro role list|show|lint` + `import-agent` CLI,
  classification/research schemas, and `docs/role-convention.md`.
- **Per-alias env for multi-account CLIs** — provider aliases may now be objects
  `{name, command?, env?}`, so multiple accounts of the same CLI (e.g. two
  Claude logins on different `CLAUDE_CONFIG_DIR`s) work purely through
  `config.json` instead of hand-written shell aliases. Alias env merges over
  provider env (alias wins) with `~`/`$VAR` expansion; the resolved binary is
  spawned directly (no `bash -ic`) while the account name stays the routing
  identity. Bare-string aliases are unchanged. New module `src/providers.mjs`
  plus a full TUI account manager (add/edit/delete + env editor with denylist
  rejection).
- **Opt-in autonomous claude write mode** — a write-permission role may set
  `MAESTRO_CLAUDE_WRITE_MODE` (e.g. `acceptEdits`, `bypassPermissions`) so a
  non-interactive claude applies edits without a human at the CLI, matching
  codex's `approval_policy=never`. Unset preserves the legacy permission mode.
- **TUI & CLI authoring** — `maestro setup tracker` wizard writes
  `server.tracker` (Linear) and chains the `LINEAR_API_KEY` prompt; the
  full-screen TUI gains workflow editing (switch / new / delete / remove-role /
  apply-template / validate) and detail-screen actions (run / edit /
  approve-substitution / skip-role / switch-provider). Role detail and footer
  keybinds wrap (ANSI-aware) instead of clipping.

### Changed (BREAKING)

- **`maestro serve` is now a subcommand group**, not a one-shot foreground
  server. The v0.1.1 `maestro serve [--config] [--state-dir] [--port]`
  invocation no longer starts a server (`maestro serve --config …` errors with
  `unknown serve subcommand`). Use `maestro serve start <name>` after `serve
  add`, or start a server directly with the flag-first form `maestro [--config
  <path>] [--port <n>]` (no `serve` word).

### Changed

- **Bare `maestro` prints help** (like git/docker/npm) instead of defaulting to
  server mode, which previously died with a cryptic
  `unsupported_tracker_kind: missing`. Flag-first invocations (`maestro --port
  4100`) still start the server.

### Fixed

- **Engine — robust agent failure handling.** Failure classifiers
  (`isUsageLimitFailure`/`isContextWindowFailure`) now read only the error
  channel (message + stderr + genuine stream-json error lines), so an agent that
  merely *discusses* "rate limits" or "context windows" no longer false-trips a
  retry. A claude run that emits a terminal `subtype:"success"` is salvaged
  instead of discarded as `agent_failed` on a non-zero exit (e.g. after gated
  tool denials). A custom event routed to `$complete` now finalizes the run as
  succeeded instead of stranding it as running. F7: SIGTERM timeouts escalate to
  SIGKILL after a 2s grace. F8: stream tails decode through a `StringDecoder` so
  a multibyte codepoint split across chunks reassembles.
- **Persistence — data-integrity + resource bounds.** F5: `updateTask` reads
  synchronously so concurrent updates to one id can't interleave and drop a
  patch. F6: SQLite opens with WAL + `busy_timeout=5000`. F9: the rate-limiter
  evicts the LRU bucket past `maxBuckets`. F4 (base): `output_schema_ref` expands
  to an inline schema at workflow-load time (guarded by `assertInsideDir`) — the
  foundation the schema-contract closeout above completes.
- **Project cleanup tolerates out-of-band-removed worktrees** — a vanished
  worktree path is no longer `cd`'d into (which failed with an opaque `spawn git
  ENOENT`); cleanup clears git metadata best-effort and stays idempotent.

### Security

- **Dashboard XSS (F1)** — the inlined snapshot JSON neutralized only lowercase
  `</script>`; every `<` is now escaped, closing mixed-case `</Script>` and
  `<!--` breakouts via attacker-influenced issue titles/descriptions.
- **Symlink-escape read boundary (F2/F3)** — `assertInsideDirReal` /
  `isInsideDirReal` (realpath both ends) gate the MCP read tools, so a symlink
  planted in an agent-writable run dir can't exfiltrate arbitrary files; the
  `assertInsideDir` docstring is corrected to state it is lexical-only.
- **Role `source` path-escape** — the engine's source-resolution loop now guards
  `role.source` with `isSafeRelativeRef` before `loadRole` (a `..`/absolute
  source becomes a `bad_role_source` blocker), the sole enforceable gate since
  `composeRole` strips `source` before the non-blocking validator. An
  imported/shared workflow could otherwise read an arbitrary file into the agent
  prompt and the run-manifest.
- **Secret handling (F10/F11)** — stored secrets skip `ENV_KEY_DENYLIST` keys on
  load (no `LD_PRELOAD`/`NODE_OPTIONS` promotion into `process.env`); KDF
  `N`/`r`/`p` read from the secret envelope are bounds-checked before scrypt, so
  a tampered envelope can't drive a decrypt-time CPU/memory DoS.
- **`serve` hardening** — service overlays apply a var denylist and reject name
  traversal; start fails fast on an unset api-key var or a port collision.
- **Dependency** — bump the transitive `hono` pin to 4.12.25
  (GHSA-wwfh-h76j-fc44, path traversal); `npm audit --omit=dev` reports 0
  vulnerabilities.

## [0.1.1] - 2026-06-16

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

- **Reproducible re-runs (SP6c)** — captures a run's *inputs* so it can be
  replayed and compared. Reproducible inputs, not bit-identical output: LLM
  stages stay non-deterministic, so `stdout`/`handoff` artifacts differ across
  runs while the deterministic `command`/`prompt` inputs match when the replay
  is faithful — exactly what `compare` surfaces.
  - **`run-manifest.json`** — written by the engine to `run_dir` at run start
    (best-effort; a write failure is logged to stderr and never breaks a run).
    Self-contained: embeds the *resolved workflow snapshot* inline, an explicit
    allow-list of the 19 replayable task input knobs (identity/derived fields
    like `id`/`steps`/`branch` are excluded), `git.start_head`, and the maestro
    version. A later edit to the named workflow cannot change what a replay runs.
  - **`maestro rerun <id>`** — recreate + run a clean task from the manifest.
    Pins the captured snapshot as a `rerun-<id>` workflow file (name sanitized to
    the 64-char limit, `isValidWorkflowName`-checked) and creates a new task via
    the unchanged by-name load path. `--dry-run` prints the manifest + resolved
    inputs and writes nothing; `--no-run` creates the task queued and prints its
    id (run later via `run-task`). A task with no manifest (pre-SP6c) ⇒
    `no_run_manifest`. Each rerun writes its own manifest, so reruns are
    themselves reproducible.
  - **`maestro compare <id1> <id2> [--json]`** — diffs the two runs' per-artifact
    `sha256`s, joining by `(role, kind)` → `MATCH` / `DIFFER` / `ONLY-1` /
    `ONLY-2`. Matching `command`/`prompt` artifacts are the reproducibility
    signal; `stdout`/`handoff` legitimately `DIFFER`.
  - Pure helpers `buildRunManifest` / `manifestToTaskInputs` (`src/run-manifest.mjs`)
    and `compareArtifactIndexes` (`src/artifacts.mjs`) are total and unit-tested.
    The manifest is an internal artifact (shape-tested, not a registered schema);
    no schema/kind/template change and `DEFAULT_WORKFLOW` is byte-identical.

- **Artifact store + inspection (SP6b)** — every run's artifacts are now
  discoverable and the stage-event stream is persisted for cross-task history.
  - **Derived artifact index** — `buildArtifactIndex(task)` scans `run_dir` and
    returns one entry per file (`role`, `kind`, `name`, `path`, `bytes`,
    `modified`, `sha256`, `status`). No persisted manifest and no artifacts
    table — the index is recomputed from disk, so it can never drift (same
    projection principle as SP6a events). Per-artifact `sha256` is an integrity
    fingerprint that SP6c (reproducible re-runs) will consume.
  - **`maestro artifacts <id> [<selector>] [--cat|--tail|--json]`** — list a
    run's artifacts (`role kind bytes modified sha256 name`, or full entries
    with `--json`), or read one by `<role>.<kind>` selector or raw filename.
    Reads are path-safe: a traversing/raw-path selector resolves to `null` (a
    clean `unknown_artifact` error), never escaping `run_dir`.
  - **Materialised events table** — the SP6a `getStageEvents` projection is
    persisted into a queryable `events` table once per run at the existing
    engine completion seam, via delete-then-insert (`replaceStageEvents`) — a
    regenerable cache, not a second write path; `getStageEvents` stays canonical.
  - **`maestro events --all [--stage S] [--status S] [--workflow W] [--json]`**
    — cross-task/historical query over the materialised table
    (`queryStageEvents`); `maestro events <id>` stays the live projection
    (correct even before materialisation / mid-run).
  - **`src/fs-safe.mjs`** — `assertInsideDir` / `listDir` / `tailFile` extracted
    from the MCP server into a shared module (behaviour identical), imported by
    both the MCP server and the artifact index/CLI.
  - No schema, kind, template, or workflow change; the default 3-role workflow
    is byte-identical.

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

[0.2.1]: https://github.com/Xateh/maestro/releases/tag/v0.2.1
[0.2.0]: https://github.com/Xateh/maestro/releases/tag/v0.2.0
[0.1.1]: https://github.com/Xateh/maestro/releases/tag/v0.1.1
[0.1.0]: https://github.com/Xateh/maestro/releases/tag/v0.1.0
