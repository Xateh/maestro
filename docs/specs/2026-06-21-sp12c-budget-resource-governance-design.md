# SP12c — Budget & Resource Governance

**Date:** 2026-06-21
**Status:** Draft (design approved)
**Target:** 0.4.2 point release — **SP12c**, shipping alongside SP12b (ephemeral safety
policy) and the standalone SP13 (`maestro exec`).
**Depends on:** SP7 concurrent fan-out (`src/langgraph/graph.mjs`) ✅, per-step token
capture (`src/langgraph/nodes.mjs` `parseUsage` / `appendStep`) ✅, SP10b mid-run
cancellation ✅, the SP9 GitHub rate-limit backoff and `src/http-rate-limit.mjs` token
bucket ✅ — all shipped in 0.1–0.4.1.
**Companion:** [`2026-06-19-v0.4.0-roadmap.md`](2026-06-19-v0.4.0-roadmap.md); pairs with
[`2026-06-21-sp12b-ephemeral-safety-policy-design.md`](2026-06-21-sp12b-ephemeral-safety-policy-design.md).

---

## 0. Summary

Ephemeral, heterogeneous-provider, fan-out execution means an agent can decide to spend
unbounded tokens/money and spawn unbounded concurrent processes. SP12c bounds both.

Unlike SP12b — which is almost entirely policy primitives a future run core will enforce —
**most of SP12c can ship as real runtime behavior in 0.4.2**, because the machinery it
governs already exists: SP7's fan-out is live, per-step token usage is already captured,
SP10b cancellation is live, and a token-bucket rate limiter already exists. This is the
**hybrid** model:

**Live runtime now (applies to all runs, ephemeral or not):**

1. **Concurrency cap + queue** over the existing SP7 fan-out.
2. **Live cost accounting** — aggregate the per-step token usage already captured into a
   running per-run total and emit it on the stage-event stream.
3. **Per-provider rate limiter** — generalize the existing token bucket so multi-provider
   fan-out backs off per provider.

**Validated now, enforced at SP12e (0.4.3):**

4. **Per-run budget caps** (`budget: { tokens?, usd?, wall_clock_ms? }`) — the validators
   and operator-ceiling config ship and are tested now; the **kill-switch** (breach →
   cancel → `budget_exceeded` terminal status) needs the ephemeral run-request object and
   lands at SP12e. The cost-accounting stream from part 2 is exactly what feeds it.

The three live parts are pure wins that SP7 already unlocked; deferring them would leave
unbounded concurrency and silent spend in 0.4.2 for no benefit. The kill-switch is the one
piece genuinely coupled to the ephemeral run core, so only it waits.

---

## 1. Motivation — and the ponytail check

Why build runtime now instead of mirroring SP12b's validation-only posture?

- **The substrate is already live.** SP7 fan-out runs today via unbounded
  `Promise.allSettled`; per-step `tokens` are already written by `appendStep`; cancellation
  is shipped. The "build" for parts 1–3 is *bounding and surfacing things that already
  happen*, not new subsystems. Not doing it means shipping a known unbounded-concurrency
  and zero-visibility-into-cost gap that the very next release (ephemeral) would make
  dangerous.
- **Cost accounting must exist before the kill-switch.** The SP12e budget kill-switch can
  only fire if a live running-cost number exists to compare against the cap. Landing the
  accounting stream now means SP12e adds *only* the comparison + cancel, not the metering.
- **The ponytail cut:** we reuse `createRateLimiter`, the existing `tokens` capture, and
  SP10b cancellation rather than writing new metering, a new limiter, or a new cancel path.
  No new persistence tables — the running total derives from existing step rows plus one
  synthetic stage event. The only genuinely-deferred piece (kill-switch) is deferred
  because its input object does not exist yet, not to save effort.

---

## 2. Part 1 — Concurrency cap + queue (live now)

### Problem

`src/langgraph/graph.mjs` builds a parallel-group node that runs every member concurrently
via `Promise.allSettled` (`graph.mjs:24–56`). With N members it spawns N provider processes
at once — unbounded. Under ephemeral fan-out an agent could declare a large group and
oversubscribe the host.

### Design

Introduce a **bounded worker pool** around the group-member execution. The pool size is
`server.agent.max_concurrent_roles` — a new key in the `agent` block of
`DEFAULT_SERVER_CONFIG` (`src/task-store.mjs`), resolved in `src/setup/server-config.mjs`
with the same `positiveInteger` validator the existing `max_concurrent_agents` uses.

- Members beyond the cap **queue** rather than start; as a running member settles, the next
  queued member starts (backpressure, no oversubscription).
- The **join semantics are unchanged**: the group still waits for all members (success or
  terminal failure), still records `parallel_failed[]`, still emits the same
  `parallel_join` stage event. Only *start scheduling* changes — observable results are
  identical to today, just with a ceiling on simultaneity.
- Default value chosen to preserve today's behavior for existing workflows where group size
  ≤ default (i.e. the cap is a ceiling, not a throttle, for current pipelines).

Implementation is a small async pool (settle-one-start-one) wrapping the existing
per-member `Promise`; no change to how an individual member runs.

### Why "roles" not "agents"

`max_concurrent_agents` (existing) bounds whole tasks/agents at the server scheduler level.
`max_concurrent_roles` is a distinct, finer ceiling on *role members within one task's
fan-out group*. They compose: a server runs ≤ `max_concurrent_agents` tasks, each task's
fan-out runs ≤ `max_concurrent_roles` members at once.

---

## 3. Part 2 — Live cost accounting (live now)

### Problem

`appendStep` already records `tokens: parseUsage(runProvider, result.stdout)` per step
(`nodes.mjs:1118`), but there is no **running per-run total** and nothing emits cost on the
event stream. The SP12f orchestrator (0.4.4) and the SP12e kill-switch (0.4.3) both need a
live running-cost signal.

### Design

- **Running total, derived (no new table).** After each step's `appendStep`, accumulate the
  step's `tokens` into a per-run in-memory tally and emit a `cost_update` stage event
  carrying `{ run_id, cumulative: { tokens, usd? }, last_step: { role, provider, tokens } }`.
  The authoritative per-step numbers already persist in step rows; the running total is a
  convenience aggregate re-derivable by summing them, so no schema change is required.
- **USD estimation (optional).** `usd` is populated when a provider/model price is known
  (a small static price table keyed by `(provider, model)`; unknown ⇒ `usd` omitted, tokens
  always present). Pricing is best-effort and clearly marked estimate — never a billing
  source of truth.
- **Emission point.** Reuse the existing stage-event emission path (the same one that emits
  `parallel_join` in `graph.mjs`); `cost_update` is one more synthetic event kind, so
  `maestro events <id>` surfaces it for free.

This part is what makes the kill-switch possible later: SP12e subscribes to `cost_update`
and compares `cumulative` against the run's budget cap.

---

## 4. Part 3 — Per-provider rate limiter (live now)

### Problem

SP9 added GitHub-specific rate-limit backoff. With multi-provider fan-out, each provider
has its own limits; a single global limiter or a GitHub-only one is wrong. Concurrent
calls to the same provider across fan-out members can trip provider rate limits.

### Design

Generalize `src/http-rate-limit.mjs`'s `createRateLimiter` (already a token-bucket with
`check(key, { capacity, refillPerSec })`) into a **shared provider-call limiter** keyed by
provider name:

- One limiter instance, `check(provider, providerLimits)` before each provider invocation
  in the run path; on refusal the call waits/backs off (reuse the existing backoff style
  from the SP9 path) rather than failing.
- Per-provider limits come from config: a `server.providers[*].rate_limit { capacity,
  refill_per_sec }` (optional; absent ⇒ unlimited, today's behavior). This slots beside the
  SP12d provider registry already shipped in 0.4.1.
- The GitHub backoff (SP9) is refactored to call through this shared limiter so there is one
  limiter, not two — collapsing the special case rather than adding a parallel one.

---

## 5. Part 4 — Per-run budget caps (validated now, enforced at SP12e)

### Design (config + validators ship now)

- **Run-request budget.** `budget: { tokens?, usd?, wall_clock_ms? }` on the (future)
  ephemeral run request. All fields optional; each must be a positive number when present.
- **Operator ceiling.** `server.ephemeral.budget { tokens?, usd?, wall_clock_ms? }` — an
  operator maximum. A run-request cap above the ceiling is clamped to the ceiling; a
  run-request cap below an operator **floor** (if configured) is nonsensical and rejected.
- **Validator** `validateBudget(budget, operatorBudget)` (in the SP12c module) ships and is
  unit-tested now:
  - non-positive / non-numeric field ⇒ `bad_budget_spec`.
  - run cap below an operator-configured floor ⇒ `budget_below_floor`.

### Kill-switch (enforced at SP12e)

The breach behavior is specified here but wired at SP12e because it needs the run-request
object and the live run loop:

- The run subscribes to the part-2 `cost_update` stream (and a wall-clock timer for
  `wall_clock_ms`). On the first cap breach, the run is **cancelled via the existing SP10b
  cancellation path** and reaches a `budget_exceeded` **terminal status**.
- **Partial handoffs are written** — already-completed role handoffs persist exactly as
  they do for any other terminal stop, so a budget-killed run is still inspectable/auditable
  like any task.

---

## 6. Error codes & statuses

| Code / status | Kind | Ships | Raised when |
|---------------|------|-------|-------------|
| `bad_budget_spec` | validation error | **now** | a budget field is non-positive or non-numeric |
| `budget_below_floor` | validation error | **now** | a run cap is below an operator-configured floor |
| `budget_exceeded` | terminal run status | wired SP12e | a live run breaches a tokens/usd/wall-clock cap |

Concurrency-cap and rate-limiter config errors (non-positive `max_concurrent_roles`, bad
`rate_limit` numbers) reuse the existing server-config fail-fast path at server start.

---

## 7. What this is NOT (this release)

- **No budget kill-switch at runtime** — validators + accounting ship; the cancel-on-breach
  wiring is SP12e (needs the run-request object). This is the one deferred piece.
- **No billing-grade cost** — `usd` is a best-effort estimate from a static price table, not
  a source of truth.
- **No cross-process / durable concurrency state** — the pool is per-run, in-process.
  Durable mid-run checkpoints are the separate 0.5.x RC2 item.
- **No per-role budget** — budget is per-run. Per-role/per-stage budgets are a future item
  if demand appears.

---

## 8. Now vs 0.4.3 (SP12e) — the hybrid boundary

| Capability | 0.4.2 (SP12c) | 0.4.3 (SP12e) |
|------------|---------------|---------------|
| Concurrency cap + queue (`max_concurrent_roles`) | **ships, live** | inherited |
| Live cost accounting (`cost_update` stage event) | **ships, live** | consumed by kill-switch |
| Per-provider rate limiter | **ships, live** | inherited |
| `budget` spec + `validateBudget` + error codes | **ships, unit-tested** | called on real run request |
| Budget kill-switch (breach → cancel → `budget_exceeded` + partials) | — | **ships** |

The roadmap is updated so the SP12c section records that the budget kill-switch is
**elevated to full enforcement at 0.4.3 / SP12e**, while parts 1–3 are already live in
0.4.2; the 0.4.x train table row is unchanged.

---

## 9. Testing

**Live parts (testable now):**

- **Concurrency cap:** a fan-out group larger than `max_concurrent_roles` runs at most the
  cap simultaneously; the rest queue and start as slots free; join result identical to the
  unbounded run (same `parallel_failed[]`, same handoffs).
- **Cost accounting:** after a multi-step run, the summed step `tokens` equals the final
  `cost_update` `cumulative.tokens`; `usd` present only when price known; `cost_update`
  appears in `maestro events`.
- **Rate limiter:** concurrent calls to one provider over the per-provider capacity back off
  (not fail); two providers limit independently; the GitHub path routes through the shared
  limiter (one limiter, not two).

**Validation parts (testable now):**

- `validateBudget`: non-positive/non-numeric field ⇒ `bad_budget_spec`; run cap below
  operator floor ⇒ `budget_below_floor`; run cap above operator ceiling clamps to ceiling.

**Deferred (asserted at SP12e):** breach cancels via SP10b, sets `budget_exceeded`, writes
partials — out of scope for 0.4.2 tests (no run-request object yet).

---

## 10. Roadmap placement

SP12c is the resource-governance half of the 0.4.2 guardrails pair (with SP12b), shipping
beside the independent SP13 (`maestro exec`). Its live parts (1–3) bound the SP7 fan-out
that already shipped; its budget kill-switch is a prerequisite input for SP12e. See the
0.4.x train table in the companion roadmap.
