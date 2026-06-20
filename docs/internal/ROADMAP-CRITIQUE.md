# Maestro Roadmap — Consolidated Critique

**Date:** 2026-06-17
**Sources:** three blunt single-lens critiques — Strategy/Market (`roadmap-critiques/strategy.md`),
Architecture (`roadmap-critiques/architecture.md`), Execution/Scope (`roadmap-critiques/execution.md`) —
consolidated against `docs/internal/ROADMAP.md`.

---

## Overall verdict (blunt)

The roadmap's shipped core is real and decent. The roadmap *document* is not. Across all three
lenses the same shape emerges: a strong engineering plan worn as a strategy, written for a
four-person team but owned by one maintainer with ten days of history and zero users. It optimizes
the comfortable, controllable work (harden the harness, close audit findings) and buries every
ego-threatening, externally-validated move (does anyone want this? is the name findable? is the
endgame even buildable?) in undated "later" tiers behind an undefined "robustness bar." Worse, the
two headline product promises are oversold against the actual tree: the **per-edge context
contract** that gates all of Pillar 2 *does not exist in the data model* and is a redesign, not a
formalization; and **report-back orchestration**, the thing that makes this "real orchestration"
instead of "a nicer DAG," is likely not expressible on the current engine at all — yet it's parked
last, deferring the one feasibility question that could invalidate the whole North Star. The
document also mis-states its own codebase (loopbacks already built, F4 nearly trivial, herdr ~90%
de-risked), which means it's stale against the tree and will mis-allocate effort. The robustness is
genuine. The strategy and the roadmap are mostly a permission slip to keep coding.

---

## Critical findings

### CR1. The per-edge context contract does not exist — it's a redesign filed as a one-line "formalize"
**Raised by all three critics** (Strategy implicitly via M2/sequencing; Architecture **C1**;
Execution **C1 + C4**). Highest cross-lens convergence in the entire critique.

The roadmap (§1 promise 1, §4 "Now", §6, §7) calls this "formalize the per-edge context contract"
and files it in the §7 table titled *"grounded / low-ambiguity"* next to few-line audit patches.
It is the single largest design item in the document.

Evidence it doesn't exist (Architecture):
- Transitions are a flat string→string map — `graph.mjs:62-70` iterates `{event: dest}` where
  `dest` is a bare role/sink **string**; `workflow-validate.mjs:107` and `findCycles`
  (`workflow-validate.mjs:48-51`) treat destinations as strings. An edge is not an object; it
  cannot carry a contract.
- Every node receives the **whole** handoff history — `nodes.mjs:193` passes `state.priorHandoffs`
  unmodified to `buildPromptFromHandoffs` (`nodes.mjs:853-860`); `prompt.mjs:_priorHandoffText`
  (`prompt.mjs:17-30`) renders all of them. Zero per-edge scoping.
- The only per-node knob is the role's static `instructions`/`instruction_paths`
  (`nodes.mjs:57-78`) — author-side text, **per role, not per edge** (Execution: `prompt.mjs:111`
  shapes context per role, no per-edge construct anywhere in `src/langgraph/`).

Why it's Critical: it is promise #1 of the North Star, the literal "enforced subagent" mechanism,
and §6 makes *every* Pillar-2 surface (Skills/MCP/plugin) ride on it ("never before"). The
benchmark (§4 Pillar 3) measures "context-tokens saved by typed/scoped handoffs," which presupposes
it works. It is the join point of all the pillars. Execution's sharpest point: if the prototype
shows edges in this graph are mostly 1:1 and the contract **collapses back into per-role config**,
the headline promise, all of Pillar 2, and the benchmark wedge fall together — that costs the
*thesis*, not just the endgame.

Latent hazard (Architecture m3): handoffs are keyed by `roleKey = prompt_template`
(`nodes.mjs:176-178`) while transitions key by `stateName`. Two nodes sharing a `prompt_template`
collide in `priorHandoffs` via the supersede reducer (`state.mjs:24-31`) — which undermines
"scoped per-edge context" before fan-out even multiplies node instances.

### CR2. Report-back orchestration is likely not expressible on this engine — and "reuses the engine already in place" is false
**Raised by Architecture C2 and Execution C3** (two lenses converge).

Roadmap §5.4 sells "a spawned node reporting back to a still-running supervisor … concurrent live
nodes + inter-node messaging — real orchestration, not DAG traversal," while §5 asserts the topology
arc "reuses the LangGraph engine already in place."

Evidence (Architecture):
- Strictly single-active-node traversal: `graph.mjs` wires only `addConditionalEdges` (line 70) and
  `addNode` (line 54). No `Send`, no `Command`, no parallel primitive anywhere in `src/langgraph/`.
- Last-write-wins state, hostile to concurrency: `MaestroState.task` reducer is `(_, y) => y`
  (`state.mjs:13-16`); `event`/`currentState` likewise (`state.mjs:48-58`). Concurrent writes
  silently clobber.
- Single active step assumed in DB: `engine.mjs` mirrors one `active_step` (`_makeMarkActiveStep`
  247-251; `_mirrorPatch` 254-269).
- No actor mailbox / inter-node channel; nodes are run-to-completion functions, not live actors. A
  still-running supervisor cannot receive a message mid-execution.

Why it's Critical (Execution's framing): report-back is the load-bearing claim that distinguishes
this from "a nicer Antfarm," and it's deferred to "v1.0+, hardest, spec TBD." Parking the
*tedious* thing is prudent; parking the *feasibility question that determines whether the
differentiation is even achievable* is deferring the risk. Message-ordering is the obvious
reproducibility hazard against "same manifest + same inputs → same gated path." If it can't be made
deterministic in this architecture, the North Star is wrong and the rename + benchmark are being
built on a claim that won't hold. Nuance (Architecture): LangGraph `^1.3.6` *does* support fan-out
via `Send`/superstep parallelism, so **fan-out is buildable but is new engine work**;
**report-back is a different execution model** (actor runtime or supervisor-polls-a-bus), not a
reuse. The "reuses the engine already in place" sentence is credible only for conditional branching
(§5.1, shipped) and bounded loops (§5.2, already built — see RC1).

### CR3. The roadmap refuses to choose between "personal power-tool" and "product" — and that refusal drives the bad sequencing
**Raised by Strategy (C1 + core contradiction); reinforced by Execution M5 and Strategy M5.**

§2 declares objective priority power-tool > reference-impl > adoption, with "adoption is a side
effect, not the goal." But objectives #1 and #2 are consumed by an audience of one (the author): a
"power tool" with zero users is a hobby; a "reference implementation" only has value if someone
*references* it — i.e. discovery, the thing ranked last. The ordering is internally incoherent (#2
is a function of #4), and it's the exact signature of avoidance: every controllable task is "now,"
every externally-graded task is "later." Pillar 2 ("Adaptability/Surfaces") is then labelled
**"co-primary"** (§3) — but surfaces *are* adoption/embeddability features, contradicting "adoption
is third" (flagged independently by Strategy M5 and Execution M5). A solo project has exactly one
primary at a time.

Why it's Critical: this is the root cause the other findings hang off. Until the author picks —
(a) honestly a personal/portfolio tool, then cut the rename-urgency/benchmark/co-primary-surfaces/
fan-out-endgame theater; or (b) adoption matters, then discovery and one validated user come
*first* — the roadmap keeps optimizing engineering tidiness over strategic reality. "Robustness-
first, adoption-third" is the elegant sentence that lets the author avoid choosing.

### CR4. No definition of done anywhere — "ships when the robustness bar is met" is an infinitely-deferrable gate
**Raised by Execution C2; Strategy M3 (same gate, market lens).**

Every milestone (v0.2/v0.3/v1.0) is decoupled from calendar **and** from any stated bar. "Robustness
bar" / "leaky pipeline" are never defined: no coverage target, no "all F-findings closed," no
"replay reproduces N corpus tasks." With no DoD, scope silently expands to fill time and nothing is
ever cuttable. Strategy adds the market angle: gating discovery behind an undated quality bar is the
perfectionist's never-ship, and the "leaky pipeline" framing smuggles in a false premise — early
adopters of indie agent tools *expect* rough edges; with zero users the real risk is irrelevance,
not a bad first impression. You're protecting the reputation of a product no one has heard of.

The no-calendar stance is fine for a solo maintainer. The *absence of an exit checklist* is not.

---

## Major findings

### MA1. F4 (`output_schema_ref` runtime enforcement) is genuinely easy — but the roadmap both undersells the cleanup and overscopes the work
**Raised by Architecture M2 and Execution M2** — with a partial disagreement between them (see
Disagreements §, D1).

Both agree F4 is the correct linchpin ("typed handoffs not yet actually typed") and that it is
*small*. The schema infra makes runtime validation a near one-liner: `resolveRoleSchema` returns
`{schema:null, source:"ref"}` and does no I/O (`schemas/index.mjs:81-84`); `validateInline`
(`index.mjs:56-69`) already compiles+caches arbitrary schema objects. The real cost is duplication:
validation call sites for `name`/`inline` exist in **five** places (`nodes.mjs:261-266, 368-372,
556-560, 642-646, 1064-1069`). Fix = extract one path-guarded `validateRolePayload(roleDef, payload)`
resolver+loader helper used in all five — **not** a sixth ad-hoc `if (source==="ref")` branch per
site. Loading must be containment-guarded (per F3 precedent / `fs-safe.mjs`), since the ref is a
relative path.

### MA2. "Deterministic" + "reproducible replay" is conflated and partly marketing
**Raised by Strategy M4 and Architecture M1** (two lenses converge).

"Deterministic agentic workflows" is the headline (§1 promise 2); §4 promises "reproducible replay …
reproduce the gated path." But `maestro rerun` **re-executes the LLMs live** —
`local-command.mjs:742-787` reads the manifest, pins the workflow snapshot, creates a *fresh* task,
and calls `runCreatedLocalTask` (line 777). No cached-stdout replay; no temperature/seed pinning
anywhere. The run-manifest captures **inputs only** (`run-manifest.mjs:24-44`). With stochastic
agents the same inputs can take a **different** gated path (executor emits `question` one run,
`done` the next). So what's reproducible is the manifest→inputs→graph *wiring* and the *transition
function*, not the traversed path. Strategy's lens: "deterministic" promises reproducible *results*
to a buyer; the scare-quotes throughout the doc are the author's own admission the word is wrong.
Both recommend: lead with "auditable / replayable gated orchestration," not "deterministic." True
output-reproducible replay is a *separate, legitimately strong* feature (cache each node's handoff,
add `--replay-cached`) — the infra is close (handoffs persist to DB and `handoff.<role>.json`,
`nodes.mjs:130-143`) but no code path consumes them in lieu of running the agent. Don't market
replay until one exists.

### MA3. Sprawl: 25+ workstreams for one maintainer; Pillar 2's three surfaces are scope-spray; plugins/hosted/Windows/community are YAGNI
**Raised by Strategy M2 and Execution M1/M3** (two lenses converge).

Counting §4–§5: 2 pillars × ~3 horizons, a 4-rung topology arc, 3 surface products (Skills harness,
MCP substrate, plugin host), rename, benchmark, reference-polish, docs site, asciinema, flagship
template, GitHub Issues, crash recovery, replay, regression-loop, autonomous PR/CI loop, Windows,
hosted/cloud. The plugin architecture assumes a third-party ecosystem that requires the adoption
ranked last — building a marketplace floor before a single shopper. Strategy: cut Pillar 2 to *one*
surface (MCP substrate — the only one with a plausible near-term consumer) and demote it from
"co-primary." Execution: delete plugins/hosted/Windows/community/GitHub-Issues from the document
entirely — they're a someday-maybe list, not a roadmap — and keep the doc to Pillar 1 v0.2/v0.3 plus
the rename *decision*. One page.

### MA4. Sequencing inversion: the rename (cheapest, highest-leverage) is transitively blocked behind the riskiest item
**Raised by all three critics** (Strategy C3; Architecture implicitly; Execution M3). High
convergence.

The market analysis calls the rename "the highest-leverage single change." Yet the *name choice*
sits in §8 "Open decisions" (still unchosen), §6 defers *execution* to the v0.3 launch, and v0.3 is
gated on v0.2 hardening which is gated on the per-edge contract (CR1). So the cheapest win is
transitively blocked on the riskiest redesign. There is **no technical dependency** between picking
a name and hardening the spine. "Republish npm under the new name" (Pillar 4 "Now") literally cannot
happen until the name exists. Every commit under `maestro` accretes equity in a dead name (discovery
"effectively zero," 5-way brand collision). Decouple: pick the name this week, register/claim
npm+GitHub, quietly republish. Gate the *loud launch* on v0.2 if you like; the *name* is not a v0.2
dependency.

### MA5. "Don't chase fan-out" is contrarianism without a catalyst — and §5 contradicts §2
**Raised by Strategy M1.**

§2: "competing as a generic run-agents-in-parallel tool is late and outgunned" / "don't chase
fan-out." §5: fan-out "is *not* a market-chasing bolt-on … the natural consequence of the graph,"
parked at v1.0+. You can't have it both ways. Good contrarianism needs a thesis about *why the
market is wrong* and *when it corrects* (a regulatory shift, a wave of agent-caused incidents, an
enterprise-procurement requirement) — none is named. Deferring fan-out to v1.0+ cedes the throughput
crowd *now* while waiting to serve them *later*: losing both audiences in the interim. Either state
the catalyst with a falsifiable signal/date, or bring *bounded* parallel execution of independent
branches forward to v0.3 (the engine supports `Send` cheaply), or accept it's a niche personal tool
and stop framing the deferral as strategy.

### MA6. No identified user; the thesis is asserted, never grounded in a person who would switch
**Raised by Strategy C2** (demoted from the strategy critic's "Critical" to global Major only because
CR3 — the refusal to choose product-vs-tool — is its root; if (b) is chosen, this snaps back to
Critical).

Not one concrete persona, workflow, or "this person does X, suffers Y, the harness fixes it"
anywhere. The North Star describes a *mechanism*, not a *customer*. "Deterministic / enforced
subagents" are seller-side virtues; the agentmaxxing user's revealed preference is the opposite
(fire off N agents, skim diffs, merge). The people who value audit trails (regulated enterprises)
buy from vendors with SLAs, not 10-day-old solo repos. Write the single-paragraph user story
(*who / what task today / what failure / why gated typed handoffs fix it and a worktree-swarm can't*)
before anything else. If you can't write it convincingly, the thesis is internal narrative — and the
most likely honest answer ("the user is me") routes straight back to CR3(a).

### MA7. "Gates in the stock workflow" is a product decision mis-stated as a one-liner
**Raised by Architecture M3.**

`enforceGates` (`scoring.mjs:163-235`) keys entirely off `kind:"scoring"` stage evidence
(`min_coverage`, `no_high_severity_findings`, `all_regressions_pass`, `min_overall_confidence`),
which require upstream evaluation/review/regression stages. The **stock** `.maestro/workflow.json` is
plain `planner→executor→reviewer` (lines 4-34) with no scoring stage; gates only meaningfully run in
`full-audit-sweep.json`. So "add a gate to the default" either yields a vacuous gate that
`enforceGates` **fails closed** on (`no review evidence` → blocked, `scoring.mjs:189-203`) — bad
first-run UX — or balloons the lean 3-node default into something heavy. Decide explicitly: keep the
lean default and ship the gated example as a named template, or design a minimal gated default
(reviewer severity → one `no_high_severity_findings` gate) and accept the added reviewer-schema
requirement. Not a one-line "ship gates."

---

## Minor findings

- **MI1. Reliability score promoted to "first-class verdict" without calibration** (Strategy m1).
  §4 makes the score the headline and gates the autonomous PR loop behind it, but nothing validates
  it predicts real accept/reject outcomes. An uncalibrated trust score is anti-trust. Validate
  against the regression corpus before promoting.
- **MI2. Benchmark framed as marketing, not a falsification test** (Strategy m2; reinforced by
  Execution M4). It could *disprove* the thesis (if scoped context degrades output quality). Run it
  *early and privately* as a hypothesis test. Execution adds: it presupposes the per-edge contract
  (CR1/CR4) — defer until the contract ships *and* is proven distinct from per-role config, else you
  measure the wrong baseline and redo it.
- **MI3. "No API keys / no per-token billing" is a shared baseline, not a moat** (Strategy m3). Every
  CLI-orchestrator competitor has it. Fine for the AI21 contrast only; not a differentiator vs Vibe
  Kanban / Claude Squad et al.
- **MI4. Single-maintainer bus factor is invisible** (Strategy m4). A v1.0+ topology endgame with
  concurrent live nodes is a multi-quarter team effort. Either scope to what one maintainer ships in
  12 months (cut the endgame to a "vision, not commitment" appendix) or name the contributor plan
  (which needs the adoption ranked last).
- **MI5. Autonomous PR/CI-fix loop is market-parity scope creep** (Execution M6). The doc says
  "don't chase fan-out" / "adoption third," then adds a PR/CI loop "for market parity" in Pillar 1
  "Next." It's a Pillar-4 nice-to-have, not Pillar-1 trust work. Defer.
- **MI6. Replay / crash-recovery / regression-loop are subsystems listed as bullet points**
  (Execution M7). Each is non-trivial (replay determinism = the CR2 hazard). Flag which have specs
  (sp4 regression, sp6c reproducible-reruns exist in `specs/`) vs green-field; don't share a bullet
  list with one-liners.

---

## Cross-critic convergence (the signal)

Where 2+ critics independently hit the same issue — these are the highest-confidence findings:

| Finding | Strategy | Architecture | Execution |
|---|---|---|---|
| **CR1** Per-edge context contract is a redesign, mis-filed as "formalize" | ✓ (via Pillar-2 gating) | ✓ **C1** | ✓ **C1+C4** |
| **CR2** Report-back infeasible/misframed on current engine | — | ✓ **C2** | ✓ **C3** |
| **MA4** Rename buried behind harder work; decouple and pull forward | ✓ **C3** | (implied) | ✓ **M3** |
| **MA1** F4 is easy / small | — | ✓ **M2** | ✓ **M2** |
| **MA2** "Deterministic"/replay conflated, partly marketing | ✓ **M4** | ✓ **M1** | (M7 nods) |
| **MA3** Sprawl for one maintainer; cut surfaces/plugins/etc. | ✓ **M2** | — | ✓ **M1/M3** |
| **CR4** No definition of done / undated robustness bar | ✓ **M3** | — | ✓ **C2** |
| **CR3 / M5** "Co-primary" surfaces contradict "adoption third" | ✓ **M5** | — | ✓ **M5** |

The strongest signal: **CR1 is the only finding all three lenses raise**, and it is also Execution's
nominated single-highest-risk item. If you act on one thing, act on CR1.

---

## Disagreements between critics

**D1. F4 — "nearly trivial wiring" vs "easy but watch the five-site cleanup."**
Execution (M2) says the runtime payload validation in nodes is the *only* no-op and frames F4 as a
narrow wiring fix, noting that `task-store.mjs:740-773` **already loads and validates** the
`output_schema_ref` file at expand time. Architecture (M2) agrees F4 is easy but emphasizes the
**five scattered validation branches** (`nodes.mjs:261-266, 368-372, 556-560, 642-646, 1064-1069`)
as the real cost and warns against patching a sixth ad-hoc branch.
**Resolution:** not a real conflict — they're describing different halves. Execution is right that
the *schema is already loaded upstream* (so no green-field loader needed); Architecture is right that
the *node-side validation is duplicated five ways*. Combined correct scope: route the already-loaded
ref schema into a **single** `validateRolePayload` helper called at all five sites. Both critics
converge on "extract one helper, don't sprinkle ref branches."

**D2. Per-edge contract — "absent, a redesign" vs "may collapse into per-role config."**
Architecture (C1) treats it as a genuine net-new abstraction worth building (edges become objects;
scoped handoff selection). Execution (C4) is more skeptical it's even *distinct* — if edges are
mostly 1:1, it reduces to per-role config that already works.
**Resolution:** these are sequential, not opposed. Execution's prototype-first gate answers
Architecture's design question: build the minimal prototype on the stock workflow *first*; if it
proves it expresses something per-role config can't, do Architecture's redesign; if it doesn't, kill
the "per-edge" framing and rewrite the North Star. Prototype before ink.

**D3. Fan-out feasibility.** Roadmap §5 claims fan-out "reuses the engine already in place."
Architecture (C2) calls that **false** (needs concurrency-safe reducers + `Send` + per-branch
isolation) but confirms LangGraph `^1.3.6` *can* do it. Strategy (M1) separately recommends bringing
bounded parallel branches forward "cheaply." These aren't a contradiction so much as a tension: it's
*new engine work*, but it is *buildable now* — cheaper than report-back, more than "reuse." Net:
fan-out is a real v0.3 option, report-back is not.

---

## Roadmap-vs-reality corrections (the document is stale against the tree)

The critics found the roadmap mis-states its own codebase. These are factual errors to fix before
re-publishing:

1. **Bounded loopbacks (§4 "Next", §5.2) are ALREADY BUILT — not "Next."**
   (Architecture m2, Execution M2.) `resolveMaxVisits` (`state-machine.mjs:14-20`) resolves per-role
   `max_visits` then workflow `loop_limits.default_max_visits`; `nodes.mjs:217-246` enforces it
   (blocks to `waiting_user`/`halt` at the ceiling); the `visits` reducer sums per-role
   (`state.mjs:37-46`); `priorHandoffs` supersede-by-role so revisits re-run cleanly
   (`nodes.mjs:249-251`); recursion ceiling bounded at `(max_steps ?? 20) * 2` (`engine.mjs:486`);
   `full-audit-sweep.json` exercises real loopbacks (lines 146/152/158/173). `engine.mjs:440-459`
   handles `loop_limit_exceeded` recovery on resume. **Move loopbacks from "Next" to "done /
   harden."** Caveat (Architecture m2): iteration *count* is stochastic (bounded ≠ fixed) — note
   that, it inherits MA2's reproducibility nuance.

2. **F4 is near-trivial, not green-field.** (Both engine critics.) The schema registry already
   compiles/caches arbitrary schemas; `task-store.mjs:740-773` already loads+validates the ref file
   at expand time. The remaining gap is the node-side runtime payload validation no-op
   (`resolveRoleSchema` returns `schema:null` for refs; `nodes.mjs:859` uses `.schema ?? null`).
   **Re-scope F4 as a wiring fix into a single validation helper**, not a schema-loading effort. This
   makes v0.2 *smaller*.

3. **herdr is ~90% de-risked already — stop calling it a "flagship-UX dependency risk."**
   (Architecture m1.) Only `engine.mjs:14` imports `HerdrAgentRunner`; it's selected behind
   `resolveAgentRunner` (`engine.mjs:41-74`) which **already auto-falls-back** to
   `TerminalAgentRunner` when the binary is absent (one-line stderr notice). `MAESTRO_BACKEND=terminal`
   forces the plain backend; both runners implement the same `runStep`. The only residual coupling
   (`herdr_tab_id` persistence, `engine.mjs:69-72`) is harmless/unused on the terminal path.
   **Reframe as "document terminal backend as default + add a `MAESTRO_BACKEND=terminal` test matrix
   run"** — documentation + tests, not surgery.

4. **"Reproducible replay … reproduce the gated path" is not true today** (see MA2). `rerun`
   re-invokes stochastic agents; only inputs+wiring are pinned. Correct the §4 wording.

5. **"Reuses the LangGraph engine already in place" (§5) is false for fan-out and misleading for
   report-back** (see CR2). True only for §5.1 branching and §5.2 loops.

6. **§7 calls the per-edge contract "grounded / low-ambiguity"** — it is the opposite: the single
   highest-ambiguity, highest-risk item in the document (CR1). Remove it from that table.

Claims that **do** hold up (don't over-correct): typed compact handoffs (`state.mjs`, `prompt.mjs`),
gate *enforcement logic* (`scoring.mjs`), bounded loops, herdr decoupling, and the scoring/regression/
evaluation/manifest/stage-events/schema infra being largely shipped.

---

## Recommended changes (prioritized)

The top concrete edits to `ROADMAP.md`, in order:

1. **Pull the per-edge context contract OUT of the §7 v0.2 backlog and give it its own design spec
   (like report-back gets in §5.4). Prototype it on the stock workflow first.** It is not
   "low-ambiguity"; it is the highest-risk item and the join point of all pillars (CR1). Prove it
   expresses something per-role config can't *before* writing any downstream promise (benchmark,
   surfaces) in ink. If it collapses to per-role config, kill the "per-edge" framing and rewrite the
   North Star.

2. **Decouple the rename and decide the name this week; execute the quiet republish now, gate only
   the *loud* launch on v0.2.** Picking a name blocks nothing technical and unblocks all of Pillar 4
   prep (MA4). Stop accreting equity in a dead name.

3. **Re-baseline §4/§5/§7 against the tree:** move bounded loopbacks to "done/harden"; re-scope F4 to
   a single `validateRolePayload` wiring helper (five sites → one); reframe herdr as "document +
   test, ~90% done"; fix the "reproducible replay" and "reuses the engine already in place" wording.
   (Roadmap-vs-reality corrections 1–5.) This shrinks v0.2.

4. **Attach a concrete exit checklist (definition of done) to each horizon; keep the no-calendar
   stance.** e.g. v0.2 = "F4 enforced + payload validated in nodes; F6–F11 closed with regression
   tests; terminal backend documented as default; stock workflow has one gated edge." No checklist,
   no horizon (CR4).

5. **Resolve the product-vs-tool fork at the top of the document (CR3), and write the one-paragraph
   user story (MA6).** If personal/portfolio: cut the rename-urgency/benchmark/co-primary-surfaces/
   community theater. If product: move discovery + one validated user to "now." Demote Pillar 2 from
   "co-primary" to "supporting" and cut it to one surface (MC P substrate); delete plugins/hosted/
   Windows/community/GitHub-Issues from the doc entirely (MA3).

6. **Write the report-back feasibility/determinism spec NOW as a probe — before the rename and
   benchmark are built on the "deterministic orchestration" claim (CR2).** If concurrent inter-node
   messaging can't be made deterministic on this engine, soften the North Star from "deterministic
   orchestration" to "deterministic DAG traversal," and re-lead the positioning with "auditable /
   replayable gated handoffs" instead of "deterministic" (MA2).
