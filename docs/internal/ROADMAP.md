# Maestro — Strategic Roadmap

**Date:** 2026-06-17
**Status:** Draft (direction-level). Revised per
[`ROADMAP-CRITIQUE.md`](ROADMAP-CRITIQUE.md) (2026-06-17): re-baselined against
the tree, sprawl cut, product-vs-tool fork resolved. Supersedes the
reliability-platform roadmap as the *top-level* strategic frame; that roadmap
(SP0–SP6) remains the implementation detail for Pillar 1.
**Audience:** Internal only (`docs/internal/`, git-ignored, never packaged).
**Companion docs:** [`MARKET-ANALYSIS.md`](MARKET-ANALYSIS.md) (why these
choices), [`AUDIT-FINDINGS.md`](AUDIT-FINDINGS.md) (the concrete v0.2 backlog),
[`ROADMAP-CRITIQUE.md`](ROADMAP-CRITIQUE.md) (the consolidated critique this
revision answers),
`../superpowers/specs/2026-06-14-maestro-reliability-platform-roadmap.md`
(Pillar 1 decomposition).

---

## 0. Resolution: this is a personal / portfolio-first power tool

The earlier objective order — power-tool #1, reference-impl #2, adoption #3 —
resolves the product-vs-tool fork in favour of a **personal / portfolio-first
tool**. The honest primary user is the author and a handful of power-users, not
an enterprise persona. Consequences carried through this document:

- Pillar 2 is **supporting**, not co-primary, and is cut to **one surface** (the
  MCP substrate — the only surface with a plausible near-term consumer).
- **Consuming third-party Agent-CLI plugins** (Claude Code / Codex / Gemini
  plugin packs), hosted/cloud, Windows, community programs, and GitHub-Issues
  parity are **out of scope**; they presuppose the adoption that is ranked last.
  *Disambiguation (2026-06-18):* "plugins" here means **being a host for the
  agent CLIs' own plugin formats** — that is out. A **Maestro-native extension
  ecosystem** (pluggable adapters / workflows / nodes authored *for this
  framework*) is a **different question and is now OPEN** — see §8 and §10.3.
- The **autonomous PR / CI-fix loop** is **deferred** — it is Pillar-4
  market-parity scope creep, not Pillar-1 trust work, and it contradicts the
  "don't chase fan-out / adoption third" stance. It does not appear in any
  near-term horizon; if it is ever revisited it is a tertiary Pillar-4 item
  gated on a *calibrated* reliability score (see §4 Next), never a v0.2/v0.3
  deliverable.
- The harness thesis stays; the co-primary/marketplace framing does not.

**Honest user story.** The author runs multi-step agent work — audits, refactors,
research sweeps — across CLI agents and wants each handoff to be scoped, typed,
and gate-checked so a single bad step can't silently poison the rest of the run,
and so any run can be re-opened and audited later. A worktree-swarm answers
"run more agents," not "make this one pipeline trustworthy and inspectable." That
is the need this tool serves first. If a power-user with the same itch adopts it,
good; that is a side effect, not the plan.

---

## 1. North Star

> A trustworthy, reliable **adapter** and a robust **framework** for
> **auditable / replayable gated** agentic workflows.

The product is the **harness** — gated, validated, contract-typed handoffs —
not a collection of agents. Where the market launches subagents arbitrarily and
loads skills "when needed," Maestro makes every transition **explicit,
validated, scoped, and auditable**.

Two promises define the harness:

1. **Controlled-context handoffs ("enforced subagents").** Each handoff carries
   custom instructions that control what the next agent reads, isolated from the
   previous agent's full context. The intent is context **engineered per edge**,
   not left to model discretion. *Caveat:* today the only per-node knob is
   per-role static instructions; the genuine per-edge contract is an unbuilt
   design item (§5.5), not a shipped property — do not write downstream promises
   against it until it is prototyped.

2. **Auditable / replayable gated orchestration.** Same manifest + same inputs →
   the same *wiring* and the same *transition function*, recorded and
   inspectable. LLM steps are stochastic, so the *traversed path* can differ run
   to run (an executor may emit `question` one run, `done` the next); what is
   pinned is inputs + graph wiring, not outputs. "Deterministic orchestration"
   is therefore softened to **auditable / replayable** as the lead claim. Whether
   the stronger "deterministic" word can survive concurrent report-back is an
   open feasibility question (§5.5).

The harness is meant to be **embeddable**, not just a standalone CLI — exposed
as an MCP-native substrate other agents can drive (the one supporting surface;
see §0).

---

## 2. Why this, not "another orchestrator"

From [`MARKET-ANALYSIS.md`](MARKET-ANALYSIS.md):

- **The category is crowded and against the grain.** Almost the entire 2026
  field is *fan-out / parallel* (run N agents in N worktrees, human reviews
  diffs; leaders at 20k–77k★). Competing as a generic "run agents in parallel"
  tool is late and outgunned.
- **The defensible niche is the vertical, contract-enforced pipeline.** Very few
  OSS tools (Antfarm/OpenClaw, josstei only partially) express "right model per
  role, typed handoffs, gated transitions." Maestro's LangGraph-graph +
  compact typed handoff + per-role provider mapping is the cleanest take on it.
- **The real product is the harness, not the default pipeline.** The
  plan→execute→review default is just one graph. The asset is the engine that
  makes *any* declared graph trustworthy: scoped context, typed I/O, gates,
  scoring, reproducibility.

**Objective priority (decided):**

1. **Best-in-class power tool** — the most robust, trustworthy harness that
   exists. Adoption is a side effect, not the goal.
2. **Reference / portfolio implementation** — clean, documented, demonstrable
   "LangGraph-over-CLIs with audit-grade handoffs."
3. **OSS product / adoption** — pursued, but third. Discovery work (rename,
   docs, benchmark) rides on top of a hardened core; we do not drive traffic to
   a leaky pipeline.

---

## 3. Pillars

| # | Pillar | Role | Priority |
|---|--------|------|----------|
| 1 | **The Harness** — trust + auditability | The core asset: scoped, typed, gated, replayable handoffs | Primary |
| 2 | **MCP substrate** — the "adapter" vision | Deliver the harness as one embeddable surface other agents can drive | Supporting |
| 3 | **Differentiation & Identity** | Rename, positioning, benchmark, reference polish | Supporting |
| 4 | **Reach & Adoption** | Discovery, docs, demos | Tertiary |

Pillar 1 is the product. Pillars 2–4 are how it's embedded, named, proven, and
found — and are gated on Pillar 1 being solid.

---

## 4. Horizon roadmap

Horizons are themed releases (B), grouped by pillar (A). Milestone tags are
intent, not commitments; a solo maintainer ships when a horizon's robustness bar
is met, not on a calendar.

### Pillar 1 — The Harness

**v0.2 "Harden the spine" — ✅ DONE (closed out by v0.1.2).** The hardening
backlog below is shipped and tested; see [`AUDIT-FINDINGS.md`](AUDIT-FINDINGS.md)
(F1–F11 RESOLVED, F12 ratified) and
[`SUBROADMAP-v0.2.0-v0.3.0.md`](SUBROADMAP-v0.2.0-v0.3.0.md) (the U1–U7 closeout).
Kept here for provenance:

- **Enforce stage output schemas at runtime (AUDIT F4) — DONE.** Refs are baked
  to inline at load time (`task-store._expandSchemaRefs`, path-guarded); the five
  node sites validate through one shared `validateRolePayload(roleDef, payload)`
  helper (`schemas/index.mjs`); validation is soft by default with **opt-in
  strict enforcement** (`enforce_output_schema: true` → `output_schema_violation`
  halt); a TUI round-trip guard keeps `output_schema_ref` authoritative.
- **Gates in the default workflow — DECIDED.** The lean default
  (`full-audit-sweep`) ships the `scoring` node with **no gates declared ⇒
  informational** (scoring always emits `passed`). Gated flows ship as a named
  template: `full-audit-sweep-gated` opts in to exactly one gate
  (`no_high_severity_findings`, reviewer-severity → `$halt`). Rejected the
  strict-by-default default on the same fail-closed-UX ground as opt-in schema
  enforcement.
- **Durability & lifecycle hardening — DONE:** SQLite `WAL` + `busy_timeout` (F6);
  timeout→SIGKILL escalation (F7); UTF-8 streaming split fix (F8); rate-limiter
  bucket cap (F9); KDF-param validation (F11) — each with a regression test.
- **`herdr` decoupling — DONE.** The zero-dependency terminal backend is
  documented as the default (README/CONTRIBUTING); `herdr` is an optional
  acceleration the engine auto-selects when present. A named
  `MAESTRO_BACKEND=terminal` lane (`npm run test:terminal`) runs the full suite in
  CI.

**Definition of done (v0.2): ✅ met.** F4 enforced + payload validated at all five
node sites via the shared helper; F6–F11 closed each with a regression test;
terminal backend documented as default and covered by a `MAESTRO_BACKEND=terminal`
test run; the gate decision ratified with a named gated template.

**Next · v0.3–0.5 "Prove the trust"**

- **Reliability score as a first-class verdict** surfaced in TUI, web dashboard,
  and run receipts (the scoring engine exists; make its output the headline).
  *Precondition (do not skip):* the score must be **calibrated against the
  regression corpus** — shown to predict real accept/reject outcomes — *before*
  it is promoted to a headline verdict or allowed to gate anything. An
  uncalibrated trust score is anti-trust; surfacing it as a verdict before it
  earns that status actively undermines the North Star. Until calibrated, it
  ships as advisory evidence, not a verdict.
- **Cross-provider enforcement default-on** — reviewer model ≠ executor model,
  enforced, not advisory.
- **Auditable replay wired** — `rerun` today re-invokes the stochastic agents
  live and pins only inputs + workflow snapshot, so it reproduces the *wiring*,
  not the traversed path or outputs. True output-reproducible replay (cache each
  node's handoff, add `--replay-cached`) is a **separate, unbuilt** feature; the
  handoffs already persist, but no code path consumes them in lieu of running the
  agent. Don't market "replay" until that path exists.
- **Regression corpus loop closed end-to-end** — failures auto-promote into
  regression tests; every change is evaluated against the corpus.
- **Crash recovery** — resume any run from the last durable stage.

**Definition of done (v0.3–0.5):** reliability score surfaced in all three
output paths *and* validated against the regression corpus before it gates
anything; cross-provider enforcement on by default; cached-replay path lands and
reproduces N corpus tasks byte-for-byte, or the word "replay" stays out of the
public copy; regression loop auto-promotes a real failure end-to-end. No
calendar; this checklist is the gate.

**Later · v1.0+ "Scale the trust"** — see §5 (topology arc). Vision, not
commitment for a solo maintainer.

**Definition of done (v1.0+):** each topology rung lands only with its gating +
bounded-termination semantics intact and a passing reproducibility check; the
report-back feasibility/determinism probe (§5.5) has returned a verdict before
any of this is treated as committed. No calendar; this checklist is the gate.

### Pillar 2 — MCP substrate (supporting, one surface)

- **Now:** define the **embeddable harness boundary** — the clean core API that
  CLI/TUI/MCP already sit on — and document it as *the* integration contract.
- **Next:** deepen the **MCP** server from 8 tools into a composable harness
  *substrate* other agents can drive. This is the single supporting surface;
  Skills-harness, plugin host, hosted/cloud, and Windows are explicitly out of
  scope (§0).
- **Next (authoring):** the **agentic component → pipeline converter** (§10.2) —
  take a *set* of complex components (skills, instruction bundles, a plugin's
  agents, an MCP tool surface) and emit a complete, validate-passing draft
  workflow, not just one role. Extends today's single-component `import-agent`
  and fits the "composable substrate other agents can drive" goal.
- **Next (reuse):** the **global shared dir** (§11, spec
  `specs/global-shared-dir.md`) — a maestro-owned `~/.config/maestro/`
  contributing reusable workflows / role units / low-precedence config defaults
  to every session, overridable per project. One new merge layer
  (`DEFAULT < global < project < local`) reusing the existing `deepMergeConfig`;
  declarative/safe subset only (no global executable adapters or node kinds —
  those route through §10.3). Additive, gated on nothing in Pillar 1. Answers the
  declarative slice of the §10.3 discovery/precedence question. **Sibling feature
  B (parent-walk-up cascade) is deliberately split out and parked with a caution —
  see §12.**

### Pillar 3 — Differentiation & Identity

- **Now:** **decide the name this week and quiet-republish now.** Picking a name
  blocks nothing technical (no dependency on the spine hardening) and unblocks
  all Pillar-4 prep, so it does not wait on v0.2. Pick a name that signals
  "harness/adapter for auditable workflows," claim npm + GitHub, and quietly
  republish under it; every commit under `maestro` accretes equity in a dead,
  5-way-collided name. Reposition the README on the harness thesis + "**no API
  keys, no per-token billing**" (the clearest contrast vs AI21 Maestro and
  API-based frameworks — a baseline, not a moat vs CLI-orchestrator peers).
- **Next:** the **loud** launch (only this is gated on v0.2). Publish the
  **benchmark** — context-tokens saved by typed/scoped handoffs vs full-context
  passing — but run it *early and privately first* as a falsification test, and
  only after the per-edge contract (§5.5) ships and is proven distinct from
  per-role config, else it measures the wrong baseline. Reference-impl polish
  (architecture doc + clean demo) for objective #2.

### Pillar 4 — Reach & Adoption (tertiary)

- **Now:** the quiet republish under the new name (Pillar 3) is the only
  discovery move that happens before v0.2.
- **Next:** docs site + quickstart + asciinema demo; a flagship workflow
  template (e.g. `full-audit-sweep`) as the headline use case.
- **Next (content):** the **domain workflow template library** (§10.1) — curated
  first-party templates for real work domains (security, frontend, backend,
  fullstack, design, networking, OS/systems, mobile) on top of today's
  topology-shaped set. Ships as first-party content needing zero new runtime; a
  third-party-authored version of the same is the **native extension ecosystem**
  open decision (§10.3), not a blocker for the first-party library.

(Community programs, GitHub-Issues parity, hosted/cloud, and Windows are out of
scope — see §0.)

---

## 5. Topology & Orchestration arc (the architectural endgame)

The long-term vision is richer graph topology, in increasing order of
architectural difficulty. A correction on engine reuse up front: "reuses the
LangGraph engine already in place" is true **only** for branching (§5.1, shipped)
and bounded loops (§5.2, already built). Fan-out is *new engine work* (buildable
on LangGraph `^1.3.6` via `Send`, but needs concurrency-safe reducers and
per-branch isolation); report-back is a *different execution model* entirely.

1. **Conditional branching (Now).** Extend today's `done/question/error` edges
   into declared multi-way branches.
2. **Bounded loopbacks (done / harden).** Already built: `resolveMaxVisits`
   resolves per-role `max_visits` then workflow `loop_limits.default_max_visits`;
   `nodes.mjs` enforces the ceiling (blocking to `waiting_user`/`halt`); the
   `visits` reducer sums per-role; `priorHandoffs` supersede-by-role so revisits
   re-run cleanly; the recursion ceiling is bounded at `(max_steps ?? 20) * 2`;
   `full-audit-sweep.json` exercises real loopbacks and `engine.mjs` handles
   `loop_limit_exceeded` recovery on resume. Remaining work is *hardening*, not
   building. Note: iteration *count* is stochastic (bounded ≠ fixed) — it
   inherits the replay nuance in §1 promise 2.
3. **Graph-native fan-out (Later · v1.0+) — new engine work.** A node's
   completion releases *N* downstream nodes concurrently, each with its **own**
   controlled-context handoff. Buildable now via `Send`/superstep parallelism but
   not a free reuse: it needs concurrency-safe reducers (today's last-write-wins
   `(_, y) => y` clobbers concurrent writes) and per-branch isolation. Principled
   and gated, not worktree-swarm.
4. **Report-back orchestration (Later · v1.0+, hardest) — different execution
   model.** A spawned node reporting **back** to a still-running supervisor node.
   This requires concurrent live nodes + inter-node messaging (an actor runtime
   or supervisor-polls-a-bus), which the current single-active-node, run-to-
   completion engine does not provide. It is **not** a reuse of the existing
   engine. See §5.5 for the feasibility probe that must run before this is
   treated as buildable.

Each rung rides on controlled-context handoffs and gates, so adding parallelism
and cycles never erodes the trust guarantees.

### 5.5 Design specs (highest-risk items, ink before code)

> **Status (2026-06-18, v0.3.0):** both items below have **returned verdicts.**
> The per-edge context contract shipped as a behind-a-flag prototype + spec with
> a **KEEP** verdict — it provably expresses what per-role config cannot
> (`docs/internal/specs/per-edge-context-contract.md`), so the North Star stands.
> The report-back determinism probe returned **no** — keep *auditable /
> replayable*, confine "deterministic" to DAG traversal/wiring, never outputs
> (`docs/internal/specs/report-back-determinism-probe.md`). The paragraphs below
> are retained as the original framing the verdicts answer.

**Per-edge context contract — highest-risk, highest-ambiguity item; the join
point of all pillars.** This is *not* the "low-ambiguity" formalization the
earlier draft filed it as: in the current data model transitions are a flat
string→string map, every node receives the *whole* handoff history, and the only
per-node knob is per-**role** static instructions — there is no per-edge construct
anywhere. A genuine per-edge contract (every transition declares the input view
the next node receives, decoupled from upstream context) is a redesign, and it is
promise #1 of the North Star, the literal "enforced subagent" mechanism, and the
thing §4 Pillar 2 and the Pillar 3 benchmark presuppose. It therefore gets its
own design spec, like report-back below.

> **Prototype on the stock workflow first.** Build the minimal prototype and
> prove it expresses something per-role config can't. If it collapses back into
> per-role config (likely if the graph's edges are mostly 1:1), **kill the
> per-edge framing and rewrite the North Star** — do not write any downstream
> promise (benchmark, surfaces) in ink until this prototype returns a verdict.
> Latent hazard to resolve in the spec: handoffs key by `roleKey =
> prompt_template` while transitions key by `stateName`, so two nodes sharing a
> template collide in `priorHandoffs` — "scoped per-edge context" is undermined
> before fan-out even multiplies node instances.

**Report-back feasibility / determinism probe — run NOW, before the rename and
benchmark are built on the "deterministic orchestration" claim.** Report-back is
the load-bearing claim that distinguishes this from "a nicer DAG," and its
message-ordering is the obvious reproducibility hazard against "same inputs →
same gated path." The probe's job is to answer: *can concurrent inter-node
messaging be made deterministic on this engine?* If **no**, the North Star's
"deterministic" wording must change — soften it to "deterministic DAG traversal"
and keep the lead positioning on **auditable / replayable gated handoffs**
(already done in §1). This is a near-term spec item, not v1.0+ parking, precisely
because its verdict can invalidate the headline promise.

---

## 6. Sequencing rules

- **The harness gates the *loud* launch — not the name.** Decide the name this
  week and quiet-republish now (no technical dependency on the spine). Only the
  loud launch / benchmark waits on v0.2 hardening.
- **The MCP substrate rides on a contract-enforced core.** It ships only on top
  of enforced schemas + a proven per-edge context contract — never before. (And
  only if the per-edge prototype survives its §5.5 verdict.)
- **Parallelism rides on gates.** Loopbacks (done), fan-out, and report-back land
  only with bounded-termination and gating semantics intact, so the
  auditable/replayable promise survives concurrency.
- **Two design specs come before code.** The per-edge context contract and
  report-back each get a spec (§5.5); the report-back determinism probe runs
  *before* the rename/benchmark copy commits to "deterministic."

---

## 7. Concrete v0.2 backlog (grounded)

The "Now" horizon is genuinely low-ambiguity work (this is *not* where the
per-edge context contract belongs — that is the highest-ambiguity item in the
document and now lives in §5.5). Most of the reliability platform (scoring,
regression corpus, evaluation, run-manifest, stage-events, schemas) is **already
built**; v0.2 is finishing a few load-bearing edges and closing audit findings.

**All items below shipped in v0.1.2 (✅).** Retained as a closed checklist.

| Item | Source | Status |
|------|--------|--------|
| Wire `output_schema_ref` into one `validateRolePayload` helper across 5 node sites | AUDIT **F4** | ✅ helper + opt-in strict enforcement + TUI round-trip guard |
| Decide default-workflow gate shape (named template *or* minimal gated default) | §4 / MA7 | ✅ lean default = informational scoring; `full-audit-sweep-gated` named template |
| SQLite `WAL` + `busy_timeout` | AUDIT **F6** | ✅ |
| Timeout → SIGKILL escalation | AUDIT **F7** | ✅ |
| UTF-8 streaming split fix | AUDIT **F8** | ✅ |
| Rate-limiter bucket cap | AUDIT **F9** | ✅ |
| KDF-param validation on decrypt | AUDIT **F11** | ✅ |
| Document terminal backend as default + `MAESTRO_BACKEND=terminal` test run | §4 | ✅ `npm run test:terminal` CI lane + README/CONTRIBUTING |

---

## 8. Open decisions

- **Rename — name choice (decide this week).** Highest-leverage single move
  (5-way brand collision, discovery effectively zero). The *decision to rename*
  is made and there is no technical dependency; only the *name* is open. Should
  signal harness/adapter/auditable-workflow, not "orchestrator/maestro." Pick it,
  claim npm + GitHub, quiet-republish now.
- ~~**Default-workflow gate shape**~~ — **RESOLVED (v0.1.2):** the lean default
  ships `scoring` with no gates (informational); the gated example ships as the
  `full-audit-sweep-gated` named template (one `no_high_severity_findings` edge).

- **Maestro-native extension ecosystem — OPEN (added 2026-06-18).** A
  first-class extension surface authored *for this framework* — pluggable
  adapters, workflows, and (maybe) node kinds — that the community can publish and
  install. Distinct from the §0 out-of-scope item (hosting the agent CLIs' *own*
  plugin formats). Direction is open per the maintainer; the shape, trust model,
  and sequencing are speced in §10.3. Decide the **safe subset** (adapters +
  workflow templates likely yes; arbitrary in-process node kinds need an
  isolation/signing answer first) and confirm it lands only **after** the Pillar-2
  embeddable-boundary API exists.

(Hosted/cloud, Windows, consuming third-party Agent-CLI plugin formats, the
Skills-harness, and community programs remain not-open — out of scope per §0.
The *native* extension ecosystem above is the one plugin-adjacent item that is
open.)

---

## 9. Relationship to the reliability-platform roadmap

The SP0–SP6 decomposition
(`../superpowers/specs/2026-06-14-maestro-reliability-platform-roadmap.md`) is
**the implementation plan for Pillar 1** and is largely shipped (scoring,
regression corpus, evaluation, manifest, stage-events, schemas all present in
`src/`). This document sits *above* it: it adds the strategic frame (the harness
thesis, the single MCP substrate, identity/reach), frames fan-out and report-back
as a deliberate topology arc with explicit feasibility gates rather than parked
nice-to-haves, and elevates **controlled-context handoffs** and **auditable /
replayable gated orchestration** from implicit properties to explicit product
promises — while flagging the per-edge contract and report-back determinism as
unresolved design questions (§5.5), not shipped guarantees.

---

## 10. Authoring & content backlog (added 2026-06-18)

Two requested additions, kept to the same discipline as the rest of this doc
(explicit gates, honest caveats, no promise written in ink before the load-
bearing prototype returns a verdict). Both are supporting/tertiary — they ride
on the Pillar-1 core, they do not precede it.

### 10.1 Domain workflow template library (Pillar 4 content; Pillar 1 surface reuse)

A curated set of prebuilt, **domain-specific** workflow templates, beyond the
current *topology-shaped* set (`default` / `extended` / `local` / `solo` /
`triage` / `research` / `full-audit-sweep[-gated]`). Proposed first wave:
`security`, `frontend`, `backend`, `fullstack`, `design`, `networking`,
`os` (systems), `mobile`. Each is a named entry in `WORKFLOW_TEMPLATES`
(`src/setup/workflow-templates.mjs`) plus a small set of MRC role units under
`templates/roles/`, selectable through the mechanism that **already ships** —
`maestro init --workflow <name>` and `maestro workflow use <name>`. Zero new
runtime.

- **Scope discipline.** This wave is **first-party content** — more entries in
  `WORKFLOW_TEMPLATES` + role units, zero new runtime. It is intentionally
  independent of the **native extension ecosystem** (§10.3): even if Maestro
  later grows a third-party-loadable plugin surface, these curated templates
  still ship in-tree as the vetted baseline. If a template needs a capability the
  engine lacks, that capability is a Pillar-1 item.
- **Anti-sprawl caveat (the real risk).** Domain templates are *opinion*, not
  *capability*. The failure mode is eight near-duplicates of plan→execute→review
  with relabeled instructions. Ship only genuinely distinct **shapes**: e.g.
  `security` = read-only audit lane + a `no_high_severity_findings` gate (reuse
  the `full-audit-sweep-gated` spine); `fullstack` = branch by area
  (frontend/backend) then converge on review; `design` = research→synthesize
  (reuse `research`) with no write role. A template that is the default with
  renamed roles belongs in docs as an example, **not** in `WORKFLOW_TEMPLATES`.
  Prefer 3–4 distinct shapes over eight cosmetic variants.
- **DoD.** Each shipped template validates under `workflow-validate`, ships with
  ≥1 role unit and a one-line `--workflow` help description, has a case in
  `test/maestro-workflow-templates.test.mjs`, and references **only shipped
  topology** (conditional branch + bounded loop) — no template may presuppose an
  unbuilt engine feature (fan-out, report-back, per-edge contract).

### 10.2 Agentic component → pipeline converter (Pillar 2 authoring; extends import-agent)

**Existing foundation.** `maestro import-agent` + `src/setup/role-convert.mjs`
+ `src/setup/role-loader.mjs` already convert **one** component — a
`.claude/agents` subagent, a `SKILL.md`, or a native unit — into **one**
`RoleDef`. **The gap:** nothing takes a *set* of complex components (multiple
skills, an instruction bundle, a plugin's bundled agents, or an MCP server's tool
surface) and emits a *complete, valid workflow pipeline* — a multi-role graph
with transitions and gates — rather than a single role.

- **Shape.** `maestro convert <sources...>` → proposes a `workflow.json`
  (roles + transitions) by (a) normalizing each source via the existing loader,
  (b) inferring role topology (read-only analyzers → a review/eval lane;
  write-capable agents → executor; a classifier → a triage branch), (c) emitting
  a draft that passes `workflow-validate`. The human edits from there.
- **MCP angle.** Expose the converter as an MCP tool so a driving agent can hand
  Maestro a pile of skill/MCP descriptors and get back a runnable pipeline —
  exactly the Pillar-2 "composable substrate other agents can drive" goal.
- **Honest caveats (do not skip — these decide whether it earns trust):**
  - **Topology inference is the hard, ambiguous part.** Mapping N components to a
    graph is a heuristic, not a deduction. Ship it as a **draft generator** that
    always produces a human-editable, validate-passing workflow — never as an
    autonomous "correct" pipeline. Same rule as the reliability score: advisory
    until proven, or it is anti-trust.
  - **An MCP server is not a role.** It is a *tool surface*, not an agent step.
    "Converting" one means wiring its tools into a role's `tools` allowlist, not
    minting a node per tool. State this explicitly or the abstraction leaks.
  - **Per-edge contract dependency.** A genuinely *scoped* generated pipeline
    presupposes the per-edge context contract (§5.5). Until that prototype
    returns its verdict, generated workflows inherit the flat whole-history
    handoff model — fine for a draft, but do **not** market "scoped pipelines"
    out of the converter before §5.5 lands.
- **DoD.** `convert` emits a workflow passing `workflow-validate` for a fixture
  set (≥1 skill + ≥1 subagent + ≥1 MCP descriptor), round-trips through
  `role list` / `role show`, has a converter test, and the docs state plainly it
  is a **draft generator requiring human review**, not an autonomous pipeline
  author.

### 10.3 Maestro-native extension ecosystem (OPEN — direction to decide)

**Not** the §0 out-of-scope item. §0 rejects Maestro *hosting the agent CLIs'
own plugin formats*. This is the inverse: a **first-class extension surface
authored for Maestro** so the community (and the author) can publish and install
units that plug into the framework's own seams. Kept **open** per the maintainer
(2026-06-18); recorded here so the shape is thought through before any code.

**Candidate extension points (the framework already has clean seams for most):**

- **Adapters** — new provider command-builders behind `resolveAdapter`
  (`src/adapters/registry.mjs`). Today: a fixed `BUILTIN_ADAPTERS` map + a
  generic `custom` template adapter. A plugin adapter would register a
  `built-in:<name>`-equivalent from an installed package. *(Lowest-risk seam:
  adapters are already pure `(providerDef, ctx) → {command,args,cwd,stdin}`
  functions.)*
- **Workflows** — installable workflow templates + their MRC role units,
  resolved alongside the in-tree `WORKFLOW_TEMPLATES`. This is §10.1 made
  third-party-loadable.
- **Nodes** — custom node *kinds* beyond the role-node factory (`nodes.mjs`
  already special-cases stub / command / regression / scoring node types). A
  plugin node kind is the highest-value and highest-risk extension: it executes
  inside the trust boundary.

**Load-bearing decisions to settle in the spec (before any loader is written):**

- **Trust & sandboxing.** A plugin adapter or node runs **inside Maestro's
  process with the user's privileges** — the same trust surface the security
  model (§ README) spends its effort containing. An npm-installed third-party
  node executing arbitrary code per step is a categorically larger attack surface
  than a declared `custom` command template. The spec must decide: in-process vs
  subprocess isolation, a capability/permission manifest per plugin, signing /
  provenance, and whether node-kind plugins are allowed at all vs adapters +
  workflows only (the safer subset).
- **Versioned contract.** Plugins bind to the adapter signature, the `RoleDef`
  shape, the node factory contract, and the handoff/marker format — all currently
  *internal* and free to change. An ecosystem freezes these into a **public,
  versioned extension API** (the Pillar-2 "embeddable harness boundary" must land
  first — §4 Pillar 2 "Now"). Don't invite third-party code against an unstable
  internal seam.
- **Discovery & resolution.** How units are named, found, and resolved
  (npm scope? a registry? a `.maestro/plugins/` dir?), and precedence vs in-tree
  built-ins.

**Sequencing.** Gated on the **embeddable harness boundary** (Pillar 2 "Now") and
on the **security spec** above — never before. Safe staging: **adapters +
workflow templates first** (declarative, low blast radius), **custom node kinds
last** (or never, if isolation can't be made sound). This is a Pillar-2 / Pillar-4
direction, still subordinate to the Pillar-1 core per §0's objective order.

---

## 11. Global shared dir (feature A — speced, additive)

**Spec:** [`specs/global-shared-dir.md`](specs/global-shared-dir.md). A
maestro-owned global directory (`$XDG_CONFIG_HOME/maestro/`, default
`~/.config/maestro/`; `herdr` precedent at `~/.config/herdr`) that contributes
**reusable declarative content** — `workflows/`, role units, `prompts/`, and a
low-precedence `config.json` — to every session, overridable per project.

- **One new merge layer, nothing reordered.** Config precedence becomes
  `DEFAULT < global config.json < project config.json < project config.local.json`,
  reusing the existing `deepMergeConfig` (`config-local.mjs`) verbatim — no new
  merge code. Named workflows resolve `project → global → in-tree
  WORKFLOW_TEMPLATES` (first-hit, atomic; graphs are never deep-merged).
- **No cycle / no jump hazard.** Two fixed, known locations, project-always-wins.
  The loop/jump risk lives entirely in feature B (§12), not here.
- **One real obligation: reproducibility.** A run that resolves any artifact from
  the global dir must snapshot the **flattened** value + `source: global`
  provenance into the run manifest, so North-Star promise #2
  (auditable/replayable, §1) survives inputs spanning two dirs. Replay reads the
  snapshot, never the live global dir.
- **Safe subset only.** Declarative content yes; **global executable extensions
  (adapters, node kinds) no** — those execute inside the trust boundary and route
  through §10.3 (extension ecosystem) with its security spec, never through
  widening A. This boundary is what keeps A low-risk.
- **Relationship to §8 / §10.3.** A answers the *declarative* slice of the §10.3
  open "discovery & resolution / precedence vs built-ins" question: a fixed local
  dir, project-first. §10.3 should reference this rather than re-deciding
  precedence for declarative content.

Gated on nothing in Pillar 1; additive. Pillar-2/4 reuse work.

---

## 12. Parent-walk-up config cascade (feature B — parked, with a standing caution)

**Status: NOTE ONLY. Not speced, not committed — and may be net-negative.** This
is the sibling of §11 deliberately split off. B is "merge every `.maestro/`
between `/` and cwd, subdir overriding parent" — *per-subtree override
hierarchies*, a different need from A's "one shared global baseline." Recorded
here so the idea is captured **with its hazards**, not so it is endorsed.

**Why it is filed as potentially not useful — possibly harmful:**

- **A likely already covers the real need.** The stated motivation was *reuse
  across dirs*; the global dir (§11) delivers that. A per-subtree cascade is a
  separate, more speculative want (different defaults for different *parts* of a
  tree) that has **not** actually been asked for. Building it speculatively is
  exactly the sprawl §0 warns against.
- **It introduces the cycle / jump hazard A doesn't have.** Pure parent-walk is a
  tree (safe), but the feature is only interesting if configs can *include* /
  *point at* other configs — and that turns the resolution chain into a graph
  with real cycle and unbounded-depth risks. Mitigable (visited-set on absolute
  paths, hard-error on revisit, depth cap — mirrors the engine's existing bounded
  `max_visits` / `loop_limits` machinery, §5.2), but it is **net-new risk surface
  that A entirely avoids.**
- **It is the worse reproducibility story.** A adds **one** bounded source layer;
  B adds an **unbounded, path-dependent N-layer** chain whose resolved value
  depends on *where you stood* when you invoked. Reconstructing a run means
  snapshotting and tagging the whole flattened chain — strictly harder than A's
  single global layer, and easier to get subtly wrong (promise #2 erosion).
- **It is surprising / footgun-prone.** "Why did this run behave differently in
  this subdir?" — silent inheritance from an ancestor `.maestro/` the user forgot
  about is a debugging tax. Today's first-match-wins
  (`workspace-resolve.findStateDirUpwards`) is boring and predictable; cascade
  trades that predictability for flexibility few users will exercise.

**If ever revisited (ink-before-code, like §5.5):** it gets its own spec and must
(a) justify a need A demonstrably cannot meet, (b) settle jumps-allowed
vs parent-walk-only **first** (that fork sets the entire complexity budget — and
parent-walk-only without jumps may be the only defensible subset), (c) solve
flattened-chain reproducibility, and (d) prove the cycle/depth bounds with a test.
Absent a concrete need clearing (a), the standing recommendation is **do not build
B** — ship A, watch whether a real per-subtree need ever materializes.

---

## 13. v0.5.x future features (carried up from the v0.4.0 roadmap) (added 2026-06-20)

The v0.4.0 roadmap & spec
([`../specs/2026-06-19-v0.4.0-roadmap.md`](../specs/2026-06-19-v0.4.0-roadmap.md))
parks two **0.5.x** candidates at its tail. They are surfaced here in the
strategic frame so the full product roadmap reflects the post-0.4.x horizon;
the detailed increments, validation codes, and DoDs live in that spec and are
**not** duplicated here. Both keep this doc's discipline: explicit gate, honest
caveat, nothing promised in ink before its gate clears.

### 13.1 Extensible hook system (0.5.x) — Pillar 2 / extension-adjacent

A per-role / per-stage / matcher hook surface, generalizing today's four global,
workspace-scoped shell hooks (`after_create` / `before_run` / `after_run` /
`before_remove`, run by `src/workspace.mjs`).

- **Gate:** a **real demand signal** — the same bar as *Role registry* (§"Not in
  0.4.0" of the v0.4.0 spec) and the native extension ecosystem (§10.3). No user
  is currently pulling on it; a full hook taxonomy is net-new **public config
  surface** (a stability commitment), so it waits on demand, not on capacity.
- **Cheap when demanded** — the substrate already exists: the shell-exec logic
  (`runHook`: spawn, timeout, capture) lives in `src/workspace.mjs` and only needs
  extracting into a shared runner; per-stage hooks subscribe to the existing
  `stage_event` stream (`src/stage-events.mjs`, SP6a) rather than inventing new
  instrumentation.
- **Increments (smallest-first):** HK1 per-role hooks (`before_role` /
  `after_role` / `on_role_fail`, blocking semantics; foundation, lowest risk) →
  HK2 stage-event subscription + matcher (the Claude-Code-style `event × match`
  surface, plus `on_gate_fail` / `on_approval_needed` sugar) → HK3 scope ladder
  (global + workflow scopes, ordered global → workflow → role).
- **Relationship to SP9 `notify`:** SP9 Part C ships its own small dispatch in
  0.4.0; HK3's global scope is its natural future home — `notify` re-expressible as
  a built-in `on_*` hook with an HTTP target. Not a dependency in either direction.
- **Strategic fit:** this is an **authoring / extensibility** surface, adjacent to
  the §10.3 native-extension-ecosystem open decision. Like §10.3 it freezes
  currently-internal contracts into public ones, so it rides on the Pillar-2
  embeddable-boundary work and stays subordinate to the Pillar-1 core (§0).

### 13.2 Process recovery & durable resume (0.5.x) — Pillar 1 (trust)

A single, named contract for *what every maestro process guarantees on
crash / restart / disconnect*, and the durability work to honour it. This gives
the §4 Pillar-1 "Next" line **"Crash recovery — resume any run from the last
durable stage"** a concrete shape, and discharges the lone "Concurrent engine
mid-run state persistence" deferral.

- **Gate:** the **0.4.x ephemeral train** landing (esp. SP12e) — agent-authored,
  long-running fan-outs are exactly the workloads that make mid-run crash loss
  expensive. RC therefore lands *after* the train, consuming its primitives (SP7
  engine, SP12e run core, SP12f reattach) rather than blocking them. Status is
  *scheduled-leaning*, not merely candidate.
- **Recovery taxonomy (the contract):** every long-lived or spawned process gets
  exactly one class — **resumable** (engine/task run), **reattach-only**
  (TUI / MCP client / CLI watcher), **restart-clean** (server daemon, MCP server),
  **supervised-child** (provider-CLI subprocesses), **fire-and-forget** (notify,
  audit writes).
- **Increments (smallest-first):** RC1 taxonomy & inventory (doc + in-repo
  registry; a test asserts no unclassified spawn/serve entry point) → RC2 **durable
  run checkpoints** (the headline 0.5.0 item: checkpoint at each role boundary,
  idempotent resume — completed/side-effecting roles gated by completion markers
  so resume never double-executes; interrupted runs carry a distinct
  `interrupted` status with partial handoffs) → RC3 agent-subprocess supervision &
  orphan reaping → RC4 startup reconciliation + crash-safe atomic writes
  (temp-write + rename) → RC5 uniform client reattach (generalizing SP12f's by-id
  reattach across TUI / CLI / MCP).
- **Strategic fit:** this is squarely **Pillar 1 trust** — North-Star promise #2
  (auditable / replayable, §1) is hollow if a crash mid-fan-out leaves a black hole
  instead of a resumable checkpoint. RC2 is the durable backbone the ephemeral run
  core (SP12e) and the budget kill-switch (SP12c) both lean on; it builds on
  already-persisted substrate (`run-manifest.json`, stage-events, SQLite) — no new
  store.
