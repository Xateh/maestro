# Execution & Scope Critique — Maestro Roadmap

**Verdict (blunt):** This is a strong engineering team's roadmap attached to a
ten-day-old, single-author, zero-traction project. The *core* is real and
largely built — the document admits as much — but the roadmap is written as if
the maintainer has the bandwidth of a four-person team. It bundles a core
redesign (per-edge context contract), four-rung concurrency arc culminating in
real inter-node messaging, four surface products (Skills/MCP-substrate/plugin),
a rename, a benchmark, a docs site, and crash recovery / replay / regression-loop
work into "intent, not commitments" with no definition of done. The honest parts
(market analysis, "adoption is third," herdr de-risk) are genuinely good. The
roadmap part is a wishlist wearing a horizon-table costume. Cut it to: enforce
F4, the six small audit fixes, herdr de-risk, and a *minimal* per-edge contract.
Everything past v0.2 should be deleted from this document and re-derived only
after v0.2 actually ships, because half of what's in "Next/Later" is either
already built or will be invalidated by what you learn shipping v0.2.

---

## Critical

### C1. The v0.2 "grounded backlog" smuggles a redesign in with six bug fixes
**Issue.** §7 lists the per-edge context contract next to "UTF-8 streaming split
fix" and "rate-limiter bucket cap" as if they were peers. They are not. The
audit fixes (F6–F11) are each a few-line, well-understood patch. The
"per-edge context contract" is a new first-class abstraction. The current code
(`src/langgraph/prompt.mjs:111`, `buildPromptFromHandoffs`) shapes context
**per role** via `roleInstructions` + `outputSchema`. There is no per-*edge*
construct anywhere in `src/langgraph/`. Making "every transition declare the
input view the next node receives" means a new schema surface in workflow
manifests, validation in `workflow-validate.mjs`, engine plumbing in
`engine.mjs`/`nodes.mjs`, persistence, and migration of the two example
workflows plus all templates. That is the single largest design item in the
whole roadmap, and it is hidden in a table titled "grounded / low-ambiguity."
**Why it matters.** The roadmap's credibility rests on "Now is mostly already
scoped, low-ambiguity work." That is true for everything in §7 *except* the one
item it calls the "headline promise." A solo maintainer will burn the entire
v0.2 budget on this one contract and ship none of the audit fixes, or ship the
fixes and quietly drop the contract — either way the horizon as written does not
land as a unit.
**Recommendation.** Split it. Pull the per-edge context contract OUT of the v0.2
backlog and give it its own design spec *exactly like report-back gets one*
(§5.4). Ship v0.2 as: F4 enforcement + F6–F11 + herdr de-risk + gates-in-stock-
workflow. That is a real, finishable, two-to-three-week solo release. Treat the
context contract as v0.3's tentpole, designed before coded.

### C2. "Intent, not commitments / ships when the robustness bar is met" is an
accountability vacuum, not honesty
**Issue.** Every milestone (v0.2/v0.3/v1.0) is explicitly decoupled from any
calendar *and* from any stated robustness bar. "Robustness bar" is never
defined: no coverage target, no "all F-findings closed," no "replay reproduces
N corpus tasks," nothing. There is no definition of done anywhere in the
document.
**Why it matters.** For a solo internal/portfolio project, "ships when ready" is
defensible *if* "ready" is defined. Here it is not, so "v0.3" means "whenever I
feel like it" and "Later" means "never, deniably." With no DoD, scope silently
expands to fill available time and nothing is ever cuttable because nothing was
ever firmly in. This is the exact failure mode that kills ambitious solo
roadmaps: not missed dates, but the absence of any line that says "this and no
more, then we stop."
**Recommendation.** Keep the no-calendar stance — that part is healthy for a solo
maintainer. But attach a concrete exit checklist to each horizon. For v0.2:
"F4 enforced + payload validated against ref schema in `nodes.mjs`; F6–F11
closed with regression tests; plain `child_process` backend documented as
default; stock workflow has one gated edge." When the checklist is green, v0.2
ships. No checklist, no horizon.

### C3. Report-back orchestration is the load-bearing claim, and it is parked
behind a spec that does not exist
**Issue.** The North Star sells "report-back" implicitly: "a robust framework for
deterministic agentic workflows" and "real orchestration, not DAG traversal"
(§5.4). The roadmap then defers it to "v1.0+, hardest, spec TBD." Everything up
to rung 3 (fan-out) is still just DAG traversal over LangGraph — which the doc
itself concedes the engine "already in place" handles. The thing that makes this
"real orchestration" instead of "a nicer Antfarm" is rung 4, and rung 4 has no
design, no spec, and is explicitly the last thing that will be attempted.
**Why it matters.** Parking the *easy-but-tedious* thing is prudent. Parking the
*thing that determines whether the entire differentiation is even achievable* is
not — it is deferring the feasibility question. Concurrent live nodes +
inter-node messaging while preserving "same manifest + same inputs → same gated
path" is a hard determinism problem (message ordering is the obvious
reproducibility hazard). If that turns out to be impossible-to-make-deterministic
in this architecture, the North Star is wrong and you'd want to know *now*, not
after shipping four horizons of work that assumed it.
**Recommendation.** Do not implement report-back early. But write the design spec
NOW, before v0.2, as a feasibility probe — specifically the determinism/replay
story for concurrent messaging. If it can't be made deterministic, the North Star
must soften from "deterministic orchestration" to "deterministic DAG traversal,"
and that reframing should happen before the rename and benchmark are built on the
stronger claim.

### C4. Single highest-risk item: the per-edge context contract (C1's redesign)
**Issue.** Asked for the one item that, if it fails, invalidates the roadmap: it
is **not** report-back (that's the *ceiling* risk). It is the per-edge context
contract. It is promise #1 of the North Star, it is the literal definition of
"enforced subagent," §6 makes *every surface* (Skills/MCP-substrate/plugin) ride
on it ("Surfaces ride on a contract-enforced core … never before"), and the
benchmark (§4 Pillar 3) measures "context-tokens saved by typed/scoped handoffs"
— which presupposes the contract exists and works. If the per-edge contract
proves awkward (e.g. it collapses back into per-role config because edges in this
graph are mostly 1:1, or it can't express the views authors actually need), then
the headline promise, all of Pillar 2, and the benchmark wedge all fall with it.
**Why it matters.** It is the join point of all four pillars. Report-back failing
costs you the endgame; the context contract failing costs you the *thesis*.
**Recommendation.** Prototype the contract on the stock workflow before writing
the roadmap's downstream promises in ink. Prove it expresses something
per-role config can't. If after the prototype it *is* just per-role config with
extra ceremony, kill the "per-edge" framing, keep per-role scoping (which already
works), and rewrite the North Star to not over-claim.

---

## Major

### M1. Four pillars, a four-rung arc, four surfaces, plus rename+benchmark+docs
is sprawl for one person
**Issue.** Counting deliverables across §4–§5: 2 product pillars × ~3 horizons,
a 4-rung topology arc, 3 surface products (Skills harness, MCP substrate, plugin
host), rename, benchmark, reference-polish doc, docs site, asciinema demo,
flagship template, GitHub Issues integration, crash recovery, replay,
regression-loop, autonomous PR/CI loop, Windows, hosted/cloud. That is 25+
distinct workstreams. The market analysis (§3) states the reality: 1 author,
10 days, 131 commits.
**Why it matters.** Pillars 3 and 4 (rename/benchmark/docs/community) are
correctly gated behind Pillar 1, but they still sit in the same document with
the same "Now/Next/Later" weight, which invites working on them. The plugin
architecture, hosted/cloud, Windows, and GitHub Issues integration are pure YAGNI
for a tool with zero users — you are designing extension points for third parties
who do not exist.
**Recommendation.** Delete Pillar 4's "Later" (community, GitHub Issues) and the
plugin architecture and hosted/cloud and Windows from this document entirely.
They are not roadmap; they are a someday-maybe list. Keep this doc to Pillar 1
v0.2/v0.3 and the *decision* (not execution) of the rename. One page.

### M2. F4 and "bounded loopbacks" are mis-stated as un-built; the roadmap is
stale against its own tree
**Issue.** §4 lists "Bounded loopbacks (Next)" with "mandatory termination
semantics — max-iterations + gate-driven exit." This is **already implemented**:
`src/workflow-validate.mjs:79-136` defines `loop_limits` / `max_visits` /
`default_max_visits`, and `src/langgraph/engine.mjs:440-459` handles
`loop_limit_exceeded` recovery on resume. Separately, F4 is framed as "declared
but never enforced," but `src/task-store.mjs:740-773` already loads and validates
the `output_schema_ref` file at expand time (`output_schema_ref_unreadable`,
`_escape`, `_invalid` warnings). The genuine remaining gap is narrow:
`resolveRoleSchema` (`src/schemas/index.mjs:81-84`) returns `schema:null` for
`source:"ref"`, and `nodes.mjs:859` uses `.schema ?? null`, so the *runtime
payload validation in nodes* is the no-op — not the whole feature.
**Why it matters.** A roadmap that mis-states what is already done will
mis-allocate effort (re-designing loopbacks that exist) and over-scope F4 (it's a
wiring fix from task-store into nodes, not a green-field schema-loading effort).
It also undermines trust in the rest of the "already built" claims.
**Recommendation.** Re-baseline the roadmap against the tree before publishing.
Move bounded loopbacks from "Next" to "done / harden." Re-scope F4 to its real
size: route the already-loaded ref schema into `resolveRoleSchema`/`nodes.mjs`
validation. This makes v0.2 *smaller*, which is the right direction.

### M3. Sequencing inversion: the rename decision and herdr de-risk are buried
under harder work but unblock the most
**Issue.** The rename and the herdr→optional change are the two cheapest,
highest-leverage moves (the market analysis calls rename "the highest-leverage
single change"). herdr de-risk is correctly in "Now." But the rename *decision*
is in §8 "Open decisions" with the name unchosen, and §6 defers *execution* to
the v0.3 launch — which is gated on v0.2 hardening which is gated on the context
contract (C1). So the cheapest win is transitively blocked on the riskiest item.
**Why it matters.** There is no technical dependency between picking a name and
hardening the spine. Coupling them means the discoverability fix waits on a
redesign. Meanwhile "republish npm under the new name" (Pillar 4 Now) literally
cannot happen until the name exists.
**Recommendation.** Decouple. Decide the name in the next week — it blocks
nothing and unblocks all of Pillar 4's prep. Keep the *public* rename launch
gated on v0.2 if you like (don't make noise on a leaky pipeline), but the name
choice is not a v0.2 dependency and should not read like one.

### M4. The benchmark presupposes the contract and is positioned as a Pillar-3
deliverable before its inputs exist
**Issue.** §4 Pillar 3 "Next": publish a benchmark of "context-tokens saved by
typed/scoped handoffs vs full-context passing." Typed/scoped handoffs are exactly
what the per-edge contract (C1/C4) is supposed to deliver. So the benchmark's
headline number depends on a feature that is still a redesign.
**Why it matters.** If you build the benchmark harness before the contract
stabilizes, you measure the wrong baseline and re-do it. If the contract collapses
to per-role (C4), the benchmark story changes.
**Recommendation.** Defer the benchmark until after the context contract ships
*and* is proven distinct from per-role config. Until then it's premature.

---

## Minor

### M5. "Co-primary" Pillar 2 contradicts "adoption is third"
§2 ranks the objectives power-tool > reference > adoption. §3 then labels
Adaptability/Surfaces "Co-primary." Surfaces (Skills/MCP-substrate/plugin) are
adoption/embeddability features — making them co-primary with the harness
contradicts the stated priority. Pick one: either surfaces are co-primary (then
adoption isn't third), or the harness is the sole primary and surfaces follow.

### M6. Autonomous PR/CI-fix loop is market-parity scope creep
§4 Pillar 1 "Next" adds an autonomous PR/CI-fix loop "for market parity." The doc
elsewhere says adoption is third and "don't chase fan-out." A PR/CI loop is a
chase-the-market item; it is not required by the harness thesis. Defer it out of
the core roadmap; it's a Pillar-4 nice-to-have, not Pillar-1 trust work.

### M7. Replay, crash recovery, and regression-loop-end-to-end are each
non-trivial but listed as bullet points
§4 "Next" lists "reproducible replay fully wired," "regression corpus loop closed
end-to-end," and "crash recovery — resume from last durable stage" as three
bullets. Each is a meaningful subsystem (replay determinism is the same hazard as
C3). They should not share a bullet-list with one-liners. At minimum, flag which
of these have specs (sp4 regression, sp6c reproducible-reruns exist in
`specs/`) versus which are green-field.

---

## One-line summary of what to do
Cut this document to one page: v0.2 = F4 wiring + F6–F11 + herdr de-risk +
gated stock edge, with a concrete exit checklist. Pull the per-edge context
contract out into its own spec (it is the real highest-risk item, C4) and
prototype it before writing any downstream promise. Write the report-back
feasibility spec now as a determinism probe (C3). Decide the rename name this
week (M3). Delete plugins/hosted/Windows/community/benchmark from the roadmap
until v0.2 ships and the contract is proven.
