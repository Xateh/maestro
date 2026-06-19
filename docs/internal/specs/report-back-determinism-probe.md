# Probe — Report-back determinism (v0.3.0 item D)

**Date:** 2026-06-18
**Status:** Probe complete — **verdict returned.** Feasibility write-up only; no
engine work, no code.
**Audience:** Internal only (`docs/internal/`, git-ignored, never packaged).
**Companion docs:** [`../ROADMAP.md`](../ROADMAP.md) §1 (the "deterministic" vs
"auditable / replayable" wording this probe adjudicates), §5 rung 4 (report-back
as the hardest topology rung), §5.5 (the instruction to run this probe *before*
any rename/benchmark copy commits to "deterministic").

---

## 0. The question

§5.5 mandates, *before* the rename and benchmark are built on a "deterministic
orchestration" claim:

> Can concurrent inter-node messaging be made deterministic on this engine? If
> **no**, soften the North-Star wording to "deterministic DAG traversal" and
> keep the lead on auditable / replayable gated handoffs.

This probe answers it against the **shipped** engine, not a hypothetical one.

---

## 1. Verdict

**No — report-back determinism is not achievable on the current engine, and even
on a future concurrent engine the strong (output-reproducible) reading of
"deterministic" cannot survive report-back. Keep the §1 softening: lead with
*auditable / replayable gated handoffs*; the strongest defensible determinism
claim is "deterministic DAG *traversal/wiring*," never "deterministic outputs."**

Two independent reasons, in increasing depth:

### 1.1 Report-back is not expressible on the shipped engine at all

The engine is **single-active-node, run-to-completion**:
- `graph.mjs` compiles a LangGraph `StateGraph` with `MemorySaver`; exactly one
  role node runs per superstep, returns a state slice, and a conditional edge
  (`addConditionalEdges`, keyed on `state.event`) selects the *single* next node.
- There is no live second node and no inter-node channel. A node cannot receive
  a message from another node while it is still running — the producer has
  already returned before the consumer starts.

Report-back (§5 rung 4) requires a spawned node reporting **back** to a
*still-running* supervisor — i.e. concurrent live nodes + a message bus or actor
mailbox. The current engine provides neither. So on today's engine the
determinism question is **moot**: there is no concurrent messaging to make
deterministic, because there is no concurrent messaging at all. (Fan-out, §5
rung 3, is the prerequisite and is itself unbuilt — see the `state.mjs`
reducers, which are last-write-wins `(_, y) => y` for `task`/`event`/
`currentState` and would clobber concurrent writers.)

### 1.2 Even with a concurrent engine, ordering ≠ output determinism

Suppose the actor/bus model is built. Message-*delivery* order can be made
deterministic by imposing a total order — e.g. a deterministic reducer that
sorts incoming report-back messages by a logical key (sender stateName + visit
counter) instead of arrival time, the same discipline fan-out will need for its
reducers. That buys **deterministic wiring and delivery order**.

It does **not** buy deterministic *outputs*, for the reason already stated in
ROADMAP §1 promise 2: the messages' *contents* are LLM emissions, which are
stochastic. A supervisor that branches on a report-back payload (`severity:
"high"` one run, `"medium"` the next) takes a different path regardless of how
perfectly ordered the delivery was. Determinism of the *transition function*
given *fixed inputs* is preservable; determinism of the *traversed path* and
*outputs* across real (stochastic) runs is not — concurrency does not change
this, it only adds a second nondeterminism source (arrival order) that a sorted
reducer can remove. The irreducible one (model output) remains.

**Net:** the ceiling for an honest claim is *auditable / replayable* (inputs +
wiring pinned and inspectable) plus, at most, *deterministic DAG traversal* for
the wiring/transition-function layer. "Deterministic orchestration" as a blanket
headline overclaims on both the current and the future engine.

---

## 2. Recommendation (wording + sequencing)

1. **Keep ROADMAP §1's existing softening unchanged.** Lead claim stays
   *auditable / replayable gated orchestration*; "deterministic" appears only as
   "deterministic DAG traversal / wiring," never unqualified and never applied
   to outputs. This probe ratifies that choice — it is correct, not provisional.
2. **No rename or benchmark copy may use "deterministic" unqualified.** Per
   §5.5/§6, this verdict is the gate; it is now returned, so the rename/benchmark
   work is unblocked *with the constrained wording* (DAG-traversal, not outputs).
3. **Gate report-back behind a deterministic-merge reducer design** if/when it is
   ever built. Report-back is **not** a reuse of the existing engine (§5 rung 4);
   it is a different execution model and must land with: (a) a total-order
   reducer for inbound messages (sort by logical key, not arrival), shared with
   fan-out's concurrency-safe reducers; (b) bounded-termination + gating intact;
   (c) a reproducibility check on wiring/delivery order — explicitly **not** on
   outputs. Absent that design, report-back stays parked at §5 rung 4.

---

## 3. Scope honesty

This is a feasibility write-up, as §5.5 specifies — it changes no code and
builds nothing. Its only deliverable is the verdict above and the wording
constraint it justifies. The engine facts cited (single-active-node,
last-write-wins reducers, `MemorySaver`, conditional-edge routing) are current
as of 2026-06-18 (`src/langgraph/graph.mjs`, `src/langgraph/state.mjs`).
