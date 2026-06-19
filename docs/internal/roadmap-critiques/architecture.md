# Architecture Critique — Maestro Strategic Roadmap

**Verdict (blunt):** The roadmap's *shipped* core is real and decent — a single-active-node LangGraph traversal over CLI agents, typed compact handoffs, gate enforcement in `scoring.mjs`, and a run-manifest that pins inputs. But the two headline product promises are oversold relative to the code. "Deterministic agentic workflows" is true only of the *path-selection logic* and is undercut by the roadmap's own "reproducible replay" line, because `maestro rerun` re-executes the LLMs live (`local-command.mjs:777`) — it reproduces structure, not outputs. The "per-edge context contract / enforced subagent" promise does **not** exist in the data model at all: transitions are bare `{event: destinationString}` maps and every node is handed the *entire* accumulated `priorHandoffs` array. And the topology endgame degrades from "reuses the engine already in place" (false for fan-out, see the last-write-wins `task` reducer) to architecturally impossible-as-described (report-back demands concurrent live actors with bidirectional messaging, which this engine is not). Below, ranked.

---

## CRITICAL

### C1 — "Per-edge context contract / enforced subagent" is a redesign, not a formalization. The data model has no edge object.

**Claim (roadmap §1 promise 1, §4, §7):** "every transition declares the input view the next node receives … the *edge is the context contract*." Framed as "formalize" / "first-class" — i.e. presented as polishing something that exists.

**Evidence it does not exist:**
- Transitions are a flat string→string map. `graph.mjs:62-70` iterates `transitions[stateName]` as `{event: dest}` where `dest` is a role name or sink **string**. There is no place on an edge to hang an "input view." `workflow-validate.mjs:107` and `findCycles` (`workflow-validate.mjs:48-51`) both treat `Object.values(byEvent)` as destination strings. An edge is not an object; it cannot carry a contract.
- Every node receives the **whole** handoff history. `nodes.mjs:193` reads `state.priorHandoffs`, passes it unmodified to `buildPromptFromHandoffs({... priorHandoffs ...})` at `nodes.mjs:853-860`, and `prompt.mjs:_priorHandoffText` (`prompt.mjs:17-30`) renders **all** of them. There is zero per-edge or per-destination scoping of what the next node reads.
- The only per-node knob today is the role's own static `instructions` / `instruction_paths` (`nodes.mjs:_roleInstructions`, 57-78) — author-side text appended to the prompt. That is *not* a controlled handoff view; it cannot say "executor sees only planner's handoff, not reviewer's."

**Why it matters:** This is the roadmap's "headline promise" and the stated gate for *all* of Pillar 2 (§6: "Surfaces ride on … per-edge context contracts — never before"). It is described as a formalization but it is a schema change (edges become objects), a state-machine change (scoped handoff selection per transition), a prompt-builder change (`buildPromptFromHandoffs` must take a filtered view), and a validator change. Calling it "formalize the per-edge context contract" hides that the mechanism is absent. The whole surfaces pillar is gated on net-new design.

**Recommendation:** Stop calling it "formalize." Scope it honestly as: (1) extend the transition schema so an edge is `{to, context: {include_roles?, instructions?, payload_view?}}`; (2) thread a per-edge selector into `runLangGraphTask`/node so `priorHandoffs` is filtered *for the destination* before prompt assembly; (3) decide whether the contract attaches to the edge or to the destination node's "inbox" (cleaner — a node declares what it reads, edges stay simple). Write the spec before claiming it's v0.2 "finishing load-bearing edges."

---

### C2 — Report-back orchestration is not expressible on this engine as built, and the "reuses the engine already in place" framing is wrong.

**Claim (roadmap §5.4):** a spawned node reporting *back* to a still-running supervisor node, "concurrent live nodes + inter-node messaging — real orchestration, not DAG traversal." §5 also asserts fan-out/topology "rides on" and "reuses the LangGraph engine already in place."

**Evidence of the gap:**
- The engine is strictly single-active-node traversal. `graph.mjs` wires only `addConditionalEdges(stateName, s => s.event, edgeMap)` (line 70) and `addNode` (line 54). There is **no** `Send`, no `Command`, no parallel branch primitive anywhere in `src/langgraph/` (grep confirms zero hits). One node runs, emits one `event`, one edge fires, next node runs.
- State is last-write-wins, hostile to concurrency. `MaestroState.task` reducer is `(_, y) => y` (`state.mjs:13-16`); `event` and `currentState` are likewise `(_, y) => y` (`state.mjs:48-58`). If two nodes ever wrote concurrently, the second silently clobbers the first. `priorHandoffs` appends (replacing by role), so concurrent same-role writes also collide. The reducers were written for sequential execution.
- DB writes assume one active step. `engine.mjs` mirrors a single `active_step` to the legacy store (`_makeMarkActiveStep`, 247-251; `_mirrorPatch`, 254-269) — one running step per task, not N.
- There is no actor mailbox / inter-node channel. The only inter-node medium is the shared handoff list, which is read once at node entry. A *still-running* supervisor cannot receive a message mid-execution; nodes are run-to-completion functions, not live actors.

**Why it matters:** LangGraph (the `@langchain/langgraph ^1.3.6` here) *does* support fan-out via the `Send` API and superstep parallelism, but "report-back to a **still-running** supervisor" is not graph-superstep semantics — a node that has emitted its slice has *returned*. Bidirectional live messaging between concurrently-executing nodes is an actor-model feature. Building it means either (a) abandoning node-as-pure-function for a supervisor that polls a message bus and re-enters, or (b) leaving LangGraph for an actor runtime. The roadmap's "reuses the engine already in place" is credible *only* for conditional branching (§5.1, already there) and arguably bounded loops (§5.2, mechanism exists — see C3). It is **false** for fan-out (needs new reducers + `Send` + per-branch handoff isolation) and **misleading** for report-back.

**Recommendation:** Split §5 honestly. §5.1 = shipped. §5.2 = small (see C3). §5.3 fan-out = *new* engine work (concurrency-safe reducers, `Send`, isolated per-branch context, join/aggregation node) — not "reuse." §5.4 report-back = different execution model; the roadmap already concedes "the execution model must be precise" and "gets its own spec" — good, but then delete the "reuses the engine already in place" sentence that covers it, because it does not.

---

## MAJOR

### M1 — "Deterministic" + "reproducible replay" is conflated and partly marketing.

**Claim (roadmap §1 promise 2, §4 "Next"):** "Same manifest + same inputs → the same gated path, reproducibly"; "Reproducible replay fully wired — the concrete substance behind the 'deterministic' claim: re-run any task and reproduce the gated path."

**Evidence:**
- `maestro rerun` **re-runs the LLMs live**. `local-command.mjs:742-787`: it reads `run-manifest.json`, pins the workflow snapshot under a sanitized name, creates a *fresh* task, and calls `runCreatedLocalTask` (line 777) — which executes agents again. It does **not** replay cached stdout. There is no temperature/seed pinning anywhere (grep for `temperature`/`seed` finds only `regression-corpus` "deterministic" comments, unrelated).
- The run-manifest captures **inputs only** (`run-manifest.mjs:24-44` `TASK_INPUT_KEYS`, workflow snapshot, git `start_head`, version) — by design "a replay is a clean new task, not a clone" (`run-manifest.mjs:22-23`). So outputs are *not* part of replay.

**Why it matters:** The "deterministic" framing in §1 is actually defensible and the roadmap *does* hedge it ("LLM steps are stochastic, but the *orchestration* … is deterministic"). The problem is §4's "reproducible replay … reproduce the gated path" reads like reproducing the *run*. With stochastic agents, replaying the same inputs can take a **different** gated path (executor emits `question` one run, `done` the next; reviewer flips `complete`↔`incomplete_continueable`). So "reproduce the gated path" is not guaranteed — only the *deterministic transition function given a fixed event sequence* is. What's reproducible is the manifest→inputs→graph wiring, not the traversal.

**Recommendation:** Be precise in the doc: "replay = re-execute the same pinned graph + inputs; the *transition logic* is deterministic, the *path taken* may differ because agents are stochastic." If you want true output-reproducible replay (a legitimately strong selling point), that's a separate feature: cache each node's handoff and offer a `--replay-cached` mode that feeds recorded handoffs instead of invoking the runner. The infra is close — handoffs are already persisted to DB and `handoff.<role>.json` (`nodes.mjs:130-143`) — but no code path consumes them in lieu of running the agent. Don't market replay until one exists.

### M2 — `output_schema_ref` runtime enforcement (F4) is genuinely easy; the roadmap is right but undersells the cleanup needed.

**Claim (roadmap §7, AUDIT F4):** "Enforce `output_schema_ref` at runtime … Load-bearing." Listed as low-ambiguity.

**Assessment — accurate, and the schema infra makes it cheap:**
- `resolveRoleSchema` already returns `{schema:null, source:"ref"}` and deliberately does no I/O (`schemas/index.mjs:81-84`). `validateInline(schema, payload)` (`index.mjs:56-69`) already compiles+caches an arbitrary schema object. So once the ref file is loaded into an object, validation is a one-liner reusing existing code.
- The validation call sites are already there for `name`/`inline` — and there are **five** of them: `nodes.mjs:261-266, 368-372, 556-560, 642-646, 1064-1069`. Each only handles `source==="name"|"inline"`. That duplication is the real cost: adding a `ref` branch in five places is error-prone. The ref also must be loaded once (it's a file path) and injected into the prompt skeleton (`nodes.mjs:859` passes `resolveRoleSchema(roleDef).schema` which is `null` for refs, so the schema skeleton silently isn't shown either — F4's "neither injected nor validated" is exactly right).

**Why it matters:** F4 is correctly the linchpin ("typed handoffs not yet actually typed"). The risk isn't difficulty, it's the **five scattered validation branches** — fix it by extracting one `validateRolePayload(roleDef, payload)` helper that resolves *and* loads the ref (guarded by `assertInsideDir` against the state dir, per F4's recommendation) and returns `{ok, errors, schema}`, then call it in all five places. Don't patch a sixth ad-hoc ref branch into each.

**Recommendation:** Land F4 as a single resolver+loader helper, not five inline `if (source==="ref")` blocks. Loading must be path-guarded (the ref is a relative path; `workflow-validate.mjs:277` already syntactically checks `isSafeRelativeRef`, but runtime load needs the realpath/containment guard from `fs-safe.mjs` per F3 precedent).

### M3 — "Ship gates in the stock workflow" overstates what the stock workflow can demonstrate.

**Claim (roadmap §4, §7):** "The default graph should demonstrate a gated transition out of the box."

**Evidence:** Gate enforcement (`scoring.mjs enforceGates`, 163-235) keys entirely off `kind:"scoring"` stage evidence: `min_coverage`, `no_high_severity_findings`, `all_regressions_pass`, `min_overall_confidence`. Those require upstream stages (`evaluation`, `review`, `threat_model`, `regression`) to exist and emit structured payloads. The **stock** `.maestro/workflow.json` is plain `planner→executor→reviewer` (lines 4-34) with **no** scoring/evaluation/regression stages. The gate machinery only meaningfully runs in `full-audit-sweep.json` (which has the full `scoring` stage, lines 110-121, and declares `loop_limits`). So "gates in the stock workflow" either (a) means a vacuous gate with no evidence — which `enforceGates` **fails closed** on (e.g. `no review evidence` → blocked, `scoring.mjs:189-203`), or (b) means grafting evaluation+scoring stages into the default, turning the 3-node default into something much heavier.

**Why it matters:** A naive "add a gate to the default" will either fail-closed-on-no-evidence (bad first-run UX) or balloon the default workflow. The roadmap treats this as trivial; it's a UX/design decision about what the *default* product is.

**Recommendation:** Decide explicitly: keep the lean 3-node default and ship the *gated* example as a named template (`full-audit-sweep` already is one), OR design a minimal gated default (e.g. reviewer severity → a single `no_high_severity_findings` gate) and accept the added reviewer-schema requirement. Either way it's a product decision, not a one-line "ship gates."

---

## MINOR

### m1 — herdr de-risk is already ~90% done; the roadmap slightly overstates the remaining risk.

**Assessment:** Coupling is genuinely thin. Only `engine.mjs:14` imports `HerdrAgentRunner`, and it's selected behind `resolveAgentRunner` (`engine.mjs:41-74`) which already auto-falls-back to `TerminalAgentRunner` when the binary is absent, with a one-line stderr notice. `MAESTRO_BACKEND=terminal` forces the plain backend. Both runners implement the same `runStep` contract. So "make the plain `child_process` backend a documented, tested, first-class default" is mostly **documentation + tests + flipping the default narrative**, not surgery. The one real coupling left: `herdr_tab_id` persistence is threaded through the task object and DB (`engine.mjs:69-72`, `_mirrorPatch:267`) — harmless for the terminal path (it's just unused), so even that doesn't block de-risking.

**Why it matters:** Low. This item is over-weighted as "dependency risk." It's nearly free.

**Recommendation:** Reframe as "document terminal backend as default + add a test matrix run with `MAESTRO_BACKEND=terminal`," and stop calling herdr a "flagship-UX dependency risk" — the fallback already exists and works.

### m2 — Bounded loopbacks vs determinism: these compose fine; the mechanism is already there.

**Assessment:** The §5.2 "mandatory termination semantics" already exist. `resolveMaxVisits` (`state-machine.mjs:14-20`) resolves per-role `max_visits` then workflow `loop_limits.default_max_visits`. `nodes.mjs:217-246` enforces it: on `visitCount >= maxVisits` it blocks to `waiting_user` (or `halt`). The `visits` reducer sums per-role (`state.mjs:37-46`), and `priorHandoffs` supersede-by-role (`state.mjs:24-31`) so a revisited role re-runs cleanly (`nodes.mjs:249-251` deletes the stale handoff). `full-audit-sweep.json` exercises real loopbacks (`changes_requested → implementation`, lines 146/152/158/173) with `default_max_visits:3`. The recursion ceiling is also bounded: `recursionLimit: (max_steps ?? 20) * 2` (`engine.mjs:486`). So bounded loops and determinism don't fight — termination is by construction.

**Caveat:** The roadmap's claim that loops preserve the "reproducible" promise inherits M1's problem — a stochastic role can loop a *different* number of times across runs, so the *number of iterations* is not reproducible even though it's *bounded*. Bounded ≠ deterministic count.

**Recommendation:** Keep §5.2 as "Next" but note iteration *count* is stochastic (bounded, not fixed). The mechanism is the lowest-risk item in §5 — arguably already done.

### m3 — Minor: `prompt_template` is the de-facto context/role key, conflated with graph state name.

**Observation:** `roleKey = roleDef.prompt_template ?? roleDef.label?.toLowerCase() ?? "executor"` while `transitionKey = stateName` (`nodes.mjs:176-178`). Handoffs are keyed by `roleKey` (`prompt_template`), transitions by `stateName`. For default workflows they coincide, but a custom workflow with two nodes sharing a `prompt_template` would collide in `priorHandoffs` (same role key → supersede each other via the `state.mjs:24-31` reducer). This is latent and worth noting before fan-out (C2) multiplies node instances. Not a roadmap claim, but it undermines "scoped per-edge context" (C1) if two edges' destinations share a key.

---

## Summary of claims the codebase does NOT support

1. **"Per-edge context contract" / "enforced subagent" exists and just needs formalizing** — FALSE. Edges are bare strings; every node gets the full handoff history (C1).
2. **Topology fan-out/report-back "reuses the engine already in place"** — FALSE for fan-out (needs concurrency-safe reducers + `Send`), impossible-as-described for report-back on this traversal engine (C2).
3. **"Reproducible replay … reproduce the gated path"** — MISLEADING. `rerun` re-invokes stochastic agents; only inputs+wiring are pinned, the traversed path is not guaranteed (M1).
4. **"Ship gates in the stock workflow" is trivial** — UNDERSPECIFIED. Stock workflow has no evidence-producing stages; gates fail-closed on no evidence (M3).

Claims that **do** hold up: typed compact handoffs (`state.mjs`, `prompt.mjs`), gate *enforcement logic* (`scoring.mjs`), bounded loops (M2), herdr decoupling (m1), and F4 being easy given the schema registry (M2/index.mjs).
