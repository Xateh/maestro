# Maestro — Execution Subroadmap (v0.2.0 → v0.3.0)

**Date:** 2026-06-17
**Status update (2026-06-18):** §2 **v0.3.0 "Enforce the spine" — DONE.**
A (per-edge context contract) shipped as a behind-a-flag prototype
(`langgraph/context-contract.mjs`) + design spec + falsification **verdict
(KEEP)** (`docs/internal/specs/per-edge-context-contract.md`): per-edge context
provably expresses what per-role config cannot, demonstrated on the stock
`full-audit-sweep` `implementation` re-entry edges — so the North Star stands and
B lands as a first-class gate. B (`output_schema_conformance`) gate added to
`scoring.enforceGates` + `workflow-validate` + scoring-node wiring, with tests.
C (`require_distinct_reviewer`) opt-in assertion added to `workflow-validate`,
with tests. D (report-back determinism probe) returned its **verdict**
(`docs/internal/specs/report-back-determinism-probe.md`): keep *auditable /
replayable*, confine "deterministic" to DAG traversal — never outputs. Full suite
863 passing, lint clean. Version bumped to 0.3.0 in `package.json` + CHANGELOG;
the actual git tag/`npm publish` is left as a release-management action.
**Status update (2026-06-17):** §1 **v0.2.0 closeout — DONE.** U1 (shared
`validateRolePayload` helper at all 5 node sites), U2 (opt-in strict enforcement
via `enforce_output_schema` → `output_schema_violation` halt), U3 (TUI ref
round-trip guard in `writeWorkflow`), U4 (gate decision ratified +
`full-audit-sweep-gated` template), U5 (terminal-default docs +
`npm run test:terminal` CI lane), and U7 (AUDIT-FINDINGS + ROADMAP synced) all
landed with tests; full suite 853 passing. **U6 (markers last-wins) deliberately
NOT done** — the `markers.mjs` F12 comment already ratifies handoff/question as
first-wins for routing safety; flipping it adds routing risk for a malformed-input
case, so it stays as documented (now recorded WON'T-CHANGE in AUDIT-FINDINGS).
Version bump/tag deferred: `[Unreleased]` already carries a BREAKING change
(SP0b), so the next release number is a release-management call (likely 0.2.0).
§2 v0.3.0 feature suite is the next horizon.

**Status:** Draft (execution-level). Decomposes the "Now · v0.2 Harden the spine"
horizon of [`ROADMAP.md`](ROADMAP.md) §4/§7 into exact, file-level units.
**Audience:** Internal only (`docs/internal/`, git-ignored, never packaged).
**Companion docs:** [`ROADMAP.md`](ROADMAP.md) (direction),
[`AUDIT-FINDINGS.md`](AUDIT-FINDINGS.md) (the F-series backlog this finishes and
closes out).

---

## 0. Reality reconciliation — read this first

A code-grounded sweep (2026-06-17) found that **almost the entire v0.2 "Harden
the spine" backlog is already shipped and tested** in the working tree. The
ROADMAP §4/§7 "Now" list and `AUDIT-FINDINGS.md` open-findings section are
**stale**. Verified current state:

| Item | ROADMAP claim | Actual code state | Evidence |
|------|---------------|-------------------|----------|
| **F4** `output_schema_ref` enforcement | "declared but never enforced; wiring fix" | **~80% closed.** `_expandSchemaRefs` expands ref→inline at load time, path-guarded by `assertInsideDir`. Refs now inject into prompts and validate at all 5 node sites. | `task-store.mjs:740-781` (commit `507adf5`); `nodes.mjs:859` prompt inject resolves real schema |
| **F6** SQLite WAL + busy_timeout | "Now" | **Done.** | `db/store.mjs:83` `PRAGMA journal_mode=WAL; busy_timeout=5000` |
| **F7** SIGKILL escalation | "Now" | **Done, all 3 sites.** | `command-runner.mjs:65-69`, `agent-runner.mjs:295-299`, `workspace.mjs:50-54` |
| **F8** UTF-8 streaming split | "Now" | **Done + test.** | `bounded-tail.mjs:26` `StringDecoder`; `test/maestro-bounded-tail.test.mjs` |
| **F9** Rate-limiter bucket cap | "Now" | **Done + test.** | `http-rate-limit.mjs:28` `evictOldest()`; `test/maestro-http-ratelimit.test.mjs` |
| **F10** Denylist on secret load | "Later/hardening" | **Done.** | `setup/keys.mjs:120` `if (ENV_KEY_DENYLIST.test(key)) continue;` |
| **F11** KDF-param validation | "Now" | **Done + test.** | `secret-crypto.mjs:63-67` bounds `N≤2²⁰,r≤32,p≤16`; `test/maestro-secret-crypto.test.mjs:57` |
| **Terminal backend** default + test | "document + test" | **Mostly done.** Auto-fallback + `MAESTRO_BACKEND=terminal` force path live; covered in tests. | `langgraph/engine.mjs:41-62`; `setup/doctor.mjs:85`; used in `test/maestro-engine.test.mjs`, `test/maestro.test.mjs` |
| **Default-workflow gate shape** | "decide the shape" | **Decided implicitly.** SP2 9-stage template ships a `scoring` node; **no gates declared ⇒ informational** (event always `passed`). Named templates (`full-audit-sweep.json`, `triage.json`) exist for gated flows. | `setup/workflow-templates.mjs:213-244` |

**Consequence:** the "next suite of updates" is *not* the F-series backlog — that
is finished. It splits cleanly into:

- **v0.2.0 (closeout patch):** finish the genuine F4 *remainder* (the shared
  helper + the soft-vs-hard decision), ratify the gate decision, and **sync the
  docs to reality**. This is what makes the ROADMAP's "Definition of done (v0.2)"
  literally true.
- **v0.3.0 (next feature suite):** the first net-new trust features that build on
  the now-hardened spine.

---

## 1. v0.2.0 — "Closeout patch" (finish v0.2 DoD + doc-sync)

Small, low-ambiguity, no new surface area. Each unit names exact files and a
regression test (per the memory convention: write the failing test first).

### U1 — F4: collapse 5 duplicated validation branches into one helper

**Why:** ROADMAP DoD explicitly requires "payload validated at all five node
sites **via the shared helper** — not a sixth ad-hoc branch." Today the identical
`if (source==="name") … else if (source==="inline") …` block is **copy-pasted at
5 sites**: `nodes.mjs` ~258, ~366, ~554, ~640, ~1064. The `ref` case works only
because `_expandSchemaRefs` rewrote it to `inline` upstream — that is correct but
leaves the duplication and an implicit coupling.

**Do:**
- Add `validateRolePayload(roleDef, payload)` to `src/schemas/index.mjs`,
  returning the existing `{ ok, errors, schema }` shape (or `null` when
  `source==="none"|"unknown"|"ref"`). Signature mirrors the inlined logic:
  ```js
  export function validateRolePayload(roleDef, payload) {
    const resolved = resolveRoleSchema(roleDef);          // inline | name | …
    if (!resolved.schema) return null;                    // nothing to enforce
    const r = resolved.source === "name"
      ? validatePayload(resolved.name, payload)
      : validateInline(resolved.schema, payload);
    return { ok: r.ok, errors: r.errors,
             schema: resolved.source === "name" ? resolved.name : "inline" };
  }
  ```
- Replace all 5 inlined blocks with `const schemaValidation = validateRolePayload(roleDef, payload);`.
- Keep behaviour identical (still additive evidence; routing untouched — see U2
  for the policy decision).

**Test:** `test/maestro-schemas.test.mjs` — `validateRolePayload` returns the same
verdict for `name`, `inline`, and ref-expanded-to-inline roles; returns `null`
for `none`/`unknown`. Plus a `nodes`-level assertion that all 5 stage kinds emit
identical `schema_validation` evidence before and after the refactor (golden).

**Risk:** low — pure dedup, no semantic change.

### U2 — F4: opt-in strict enforcement (DECIDED)

**Why:** validation is currently **soft everywhere** ("additive evidence; never
alters routing", `nodes.mjs:1041,1061`). ROADMAP §1 promise #1 ("typed handoffs
actually typed") implies a *capable* hard mode. The author must pick the default.

**Decision (locked, 2026-06-17): opt-in strict enforcement.** Soft validation
stays the **default**; strict mode is **opt-in** via per-role
`enforce_output_schema: true`. On a failed validation in strict mode, emit
`error`/route to `$halt` with a typed reason (`output_schema_violation`) instead
of silently passing. Rationale: preserves good first-run UX (the lean default
never fails closed) while making "typed" *enforceable* where an author opts in —
symmetric with the gate-shape decision (U4). The rejected alternative
(strict-by-default for verifier-named roles) loses on the same fail-closed-UX
reason that drove the gate decision.

**Do:** thread the flag through `workflow-validate.mjs`
(accept + type-check `enforce_output_schema`), and in `nodes.mjs` after
`validateRolePayload`, branch to the existing error/halt path when
`roleDef.enforce_output_schema && schemaValidation && !schemaValidation.ok`.

**Test:** `test/maestro-runtime.test.mjs` (or `maestro-engine`) — a role with
`enforce_output_schema:true` and a non-conforming stub payload halts with
`output_schema_violation`; the same role without the flag passes with soft
evidence only.

**Risk:** medium — touches routing. Gated behind an opt-in flag, so default
behaviour is unchanged.

### U3 — F4: guard the TUI round-trip ref→inline bake

**Why:** `_expandSchemaRefs` mutates `role.output_schema` in place; the TUI editor
reads via `readWorkflow` (expanded) and writes back `workflow.roles`
(`tui-workflow.mjs:155+`), which would **persist the inlined schema and silently
drop the `output_schema_ref`**. Cosmetic data-integrity nit, not load-bearing.

**Do:** smallest fix — in `_expandSchemaRefs`, stash the original ref
(`role.__schema_ref_source = ref` non-enumerable, or expand into a derived field
the writer strips) OR have `writeWorkflow` drop an `output_schema` that equals the
ref-expanded value. Prefer: don't mutate `role` — return a shallow-cloned role
with the inline schema, leaving the persisted document's `output_schema_ref`
intact.

**Test:** `test/maestro-workflow-validate.test.mjs` or a task-store test — read a
ref-declared workflow, write it back unchanged, assert the on-disk JSON still
carries `output_schema_ref` and not a baked `output_schema`.

**Risk:** low.

### U4 — Ratify the default-workflow gate decision

**Why:** ROADMAP §8 lists "default-workflow gate shape" as an open decision to be
"resolved within v0.2." The code already resolved it (scoring node ships, gates
opt-in via template). Make it official.

**Do:** documentation-only. In `ROADMAP.md` §4/§8 and this doc, record the
decision: **"lean default ships the `scoring` node with no gates (informational);
gated flows ship as named templates (`full-audit-sweep`, `triage`)."** Optionally
add one minimal gated template that wires reviewer-severity →
`no_high_severity_findings` as the documented "gated example" (the machinery in
`scoring.mjs:182` already supports it).

**Test:** `test/maestro-workflow-templates.test.mjs` — assert the lean default's
`scoring` transition is `passed→human_approval` with no gates declared, and (if
the example template is added) that it declares exactly one gated edge.

### U5 — Terminal backend: document as default + name the test-matrix run

**Why:** ROADMAP DoD wants the terminal backend "documented as default and covered
by a `MAESTRO_BACKEND=terminal` test run." The code path is exercised in
`maestro-engine`/`maestro.test`, but it is not a *named, isolated* matrix run and
is undocumented as the default.

**Do:** (a) README/CONTRIBUTING note: terminal is the zero-dependency default;
`herdr` is an optional acceleration. (b) Add an explicit
`MAESTRO_BACKEND=terminal node --test` lane (npm script or CI matrix entry) so the
default backend is a first-class tested configuration, not incidental.

**Test:** the matrix lane itself is the deliverable.

### U6 — F12 (optional cleanup): marker first-vs-last consistency

**Why:** `AUDIT-FINDINGS.md` F12 (Info) — `parseAgentHandoff`/`parseAgentQuestion`
take the **first** marker; `parseReviewerOutput` takes the **last**. Harmless,
but last-wins is the safer default (final line = settled answer).

**Do:** make `markers.mjs` consistently last-wins; add a test with multiple
markers of one kind.

**Risk:** low; behaviour change only when an agent double-emits.

### U7 — Sync the docs to reality (do this last, after U1–U6 land)

- `AUDIT-FINDINGS.md`: mark **F4 (resolved-pending-U1/U2), F6, F8, F9, F10, F11**
  as RESOLVED with the file:line evidence from §0; F7 RESOLVED; keep F12 open
  (or resolved if U6 done).
- `ROADMAP.md` §4 "Now" + §7 backlog: strike the shipped items; reduce the "Now"
  list to the U1–U5 residual; update DoD to reflect what is actually outstanding.

**v0.2.0 Definition of done:** U1 (shared helper at all 5 sites) + U2 (enforcement
policy decided and, if opt-in, wired with a test) + U4 (gate decision ratified) +
U5 (terminal default documented + named matrix lane) + U7 (docs synced). U3/U6 are
nice-to-have. No calendar; this checklist is the gate.

---

## 2. v0.3.0 — "Enforce the spine" (next feature suite)

Net-new trust features that ride on the hardened spine. Ordered by
leverage-over-ambiguity. **Do not start any of these until v0.2.0's U7 doc-sync
lands** — otherwise we build on a misrepresented baseline.

### A — Per-edge context contract: prototype + spec (HEADLINE, highest-risk)

This is ROADMAP §5.5's load-bearing design item and North-Star promise #1. It is
**spec-before-code**; v0.3.0's job is the *prototype that returns a verdict*, not
the finished feature.

**Concrete prototype scope (on the stock SP2 workflow):**
- Today transitions are a flat `stateName → stateName` map and every node receives
  the **whole** `priorHandoffs` history (`buildPromptFromHandoffs`,
  `nodes.mjs:853`). Add a minimal per-edge *input view*: each transition may
  declare `{ to, context: ["roleKey", …] | "scoped" | "full" }` selecting which
  prior handoffs the next node sees.
- **Resolve the latent collision first (§5.5 hazard):** handoffs key by
  `roleKey = prompt_template` while transitions key by `stateName`; two nodes
  sharing a template collide in `priorHandoffs`. The prototype must key handoffs
  by `stateName` (node instance), not template, or scoped-per-edge context is
  undermined before it starts.
- **Falsification gate:** prove the per-edge view expresses something per-**role**
  static instructions cannot. If on the mostly-1:1 stock graph it collapses into
  per-role config, **kill the per-edge framing and rewrite the North Star** (per
  §5.5 instruction). Write no downstream promise (benchmark, MCP substrate) until
  this returns a verdict.

**Deliverable:** a `docs/internal/specs/per-edge-context-contract.md` design spec
+ a behind-a-flag prototype on the stock workflow + a written verdict.

### B — Schema enforcement promoted from opt-in to a first-class gate

Builds directly on v0.2.0 U2. Once strict mode exists per-role, add
`output_schema_conformance` as a declarable workflow **gate** (alongside
`no_high_severity_findings` in `scoring.mjs:163`), so "every handoff in this run
conformed to its declared schema" becomes an auditable run verdict, not just
per-node evidence. Low ambiguity; high trust payoff.

**Test:** `test/maestro-scoring.test.mjs` — gate passes when all stage
`schema_validation.ok`, blocks when any failed.

### C — Cross-provider enforcement, opt-in (pull-forward from v0.3)

ROADMAP §4 Next wants reviewer-model ≠ executor-model *default-on*. The small,
low-risk v0.3.0 slice: ship it as an **opt-in** workflow assertion
(`require_distinct_reviewer: true`) validated in `workflow-validate.mjs`, with the
default-on flip deferred to v0.3. Concrete, testable, no calibration dependency.

**Test:** `maestro-workflow-validate` — a workflow mapping the same provider to
executor and reviewer roles fails validation when the flag is set.

### D — Report-back determinism probe (spec/probe only, NOT engine work)

ROADMAP §5.5 says this probe should "run NOW, before the rename and benchmark are
built on the 'deterministic orchestration' claim." It is a *feasibility write-up*,
not v1.0 engine work: answer "can concurrent inter-node messaging be deterministic
on this single-active-node engine?" If **no**, soften the North-Star wording to
"deterministic DAG traversal." Cheap, unblocks Pillar-3 copy. Include here because
its verdict can invalidate headline positioning.

**v0.3.0 Definition of done:** A returns a written verdict (per-edge contract is
real, or the North Star is rewritten); B lands with a gate + test *iff* A's verdict
keeps the per-edge framing alive (else B still ships on per-role schemas); D's
probe returns a verdict before any rename/benchmark copy commits to
"deterministic." C is optional. No calendar; this checklist is the gate.

---

## 3. Ordered execution checklist

1. **v0.2.0 U1** — `validateRolePayload` helper; replace 5 branches. *(test-first)*
2. **v0.2.0 U2** — decide + wire opt-in strict enforcement.
3. **v0.2.0 U4** — ratify gate decision (+ optional gated example template).
4. **v0.2.0 U5** — terminal default docs + named `MAESTRO_BACKEND=terminal` lane.
5. **v0.2.0 U3, U6** — TUI ref round-trip + marker last-wins *(optional)*.
6. **v0.2.0 U7** — sync `AUDIT-FINDINGS.md` + `ROADMAP.md` to reality. **Tag v0.2.0.**
7. **v0.3.0 A** — per-edge context contract spec + prototype + **verdict**.
8. **v0.3.0 B/C/D** — schema-conformance gate, opt-in cross-provider, report-back
   probe. **Tag v0.3.0.**

Sequencing rule inherited from ROADMAP §6: nothing in §2 starts before §1's
doc-sync (step 6); the per-edge prototype (A) gates the benchmark/MCP-substrate
copy; "deterministic" wording waits on D's verdict.
