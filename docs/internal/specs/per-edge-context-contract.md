# Design spec — Per-edge context contract (v0.3.0 item A)

**Date:** 2026-06-18
**Status:** Prototype landed + **verdict returned (KEEP).**
**Audience:** Internal only (`docs/internal/`, git-ignored, never packaged).
**Companion docs:** [`../ROADMAP.md`](../ROADMAP.md) §1 (North Star promise #1) +
§5.5 (the highest-risk design item this spec discharges);
[`../SUBROADMAP-v0.2.0-v0.3.0.md`](../SUBROADMAP-v0.2.0-v0.3.0.md) §2.A (the
prototype-before-promise instruction).

---

## 0. Why this spec exists

North-Star promise #1 — *controlled-context handoffs ("enforced subagents")* —
claims context is "engineered per edge." ROADMAP §5.5 flags this as **not yet
true**: in the shipped data model transitions are a flat `string → string` map,
every node receives the **whole** `priorHandoffs` history
(`prompt.mjs:_priorHandoffText`, fed from `nodes.mjs`), and the only per-node
knob is per-**role** static `instructions`. There is no per-edge construct.

§5.5 set a hard gate before any downstream promise (benchmark, MCP substrate)
may be written in ink:

> Build the minimal prototype and prove it expresses something per-role config
> can't. If it collapses back into per-role config, **kill the per-edge framing
> and rewrite the North Star.**

This document is that prototype's spec and its **verdict**.

---

## 1. Verdict — KEEP the per-edge framing

**The per-edge context contract expresses something per-role static config
provably cannot, and it is demonstrable on the *stock* `full-audit-sweep`
workflow — no synthetic graph required.**

The discriminator is a node with **multiple inbound edges that want different
input views**. In `full-audit-sweep` (`setup/workflow-templates.mjs:235-246`),
`implementation` is re-entered from four distinct edges:

| Inbound edge | Event | What the re-entered `implementation` should read |
|---|---|---|
| `review → implementation` | `changes_requested` | the **review** findings only |
| `threat_model → implementation` | `changes_requested` | the **threat_model** findings only |
| `edge_cases → implementation` | `changes_requested` | the **edge_cases** findings only |
| `regression → implementation` | `regressions_found` | the **regression** failures only |
| *(START)* | — | the task; no prior handoff |

Per-role config can attach exactly **one** static instruction/view to the
`implementation` node. It has no way to say "the view depends on which critic
sent me back." Per-edge config does: the view is a function of `(fromState,
event)`, not of the destination node. The prototype test
`test/maestro-context-contract.test.mjs` ("per-edge: implementation sees
DIFFERENT views by inbound edge") asserts the two re-entry edges resolve to
`["review"]` vs `["regression"]` — `assert.notDeepEqual`. That is the
falsification gate passing: **the framing survives.**

Consequence carried downstream (per §5.5 / SUBROADMAP §2 DoD): because A keeps
the per-edge framing alive, item **B** (schema-conformance gate) ships as a
first-class gate, and the benchmark/MCP-substrate copy may reference per-edge
scoping — *after* this feature graduates from experimental (see §6).

### 1.1 Where it would have *collapsed* (honest boundary)

On a purely 1:1 DAG (e.g. `research`: `gather → synthesize → $complete`) every
node has a single inbound edge, so per-edge and per-role coincide exactly. The
feature is **only** distinct in the presence of fan-in / loopbacks / branches.
That is not a defect — it is the precise statement of when the North-Star
promise has teeth. The stock default (`full-audit-sweep`) has loopbacks, so the
promise is meaningful for the headline workflow; trivially-linear templates
gain nothing, and that is fine.

---

## 2. The latent collision (resolved as documented, not yet structurally)

§5.5 names a hazard: handoffs key by `roleKey = roleDef.prompt_template`
(`nodes.mjs:176`) while transitions key by `stateName` (`graph.mjs:38`,
`nodes.mjs:178 transitionKey`). Two nodes sharing a `prompt_template` would
collide in `priorHandoffs`, undermining "scoped per-edge context" before it
starts.

**Current state:** the collision is real in the *data model* but neutralized by
**template convention** — every stock role sets `prompt_template` to its own
state name, with an explicit warning comment at
`setup/workflow-templates.mjs:99-103` ("prompt_templates would collide roleKeys
and corrupt the run"). So in practice `roleKey === stateName` for every shipped
workflow, and per-edge selection (which matches on `h.role`) is sound today.

**Structural fix (deferred, tracked):** make the engine key handoffs by
`stateName` (node instance) independent of `prompt_template`, so the contract
cannot be corrupted by an author who reuses a template. This touches the
resume-skip path (`nodes.mjs:206-211 completedBefore`), the revisit delete
(`nodes.mjs:273-275 deleteHandoffsByRole`), and the `visits` reducer keys
(`state.mjs:37`). It is **out of scope for the prototype** (it is a wide,
behavior-affecting change to the durable handoff key) and is recorded here as
the first hardening step when this feature graduates. Until then the convention
+ the validator warning (`bad_edge_context` on an unknown source role) hold the
invariant.

---

## 3. Prototype design (what landed)

Minimal, behind a flag, fully reversible — default workflows are byte-identical.

### 3.1 Manifest surface (additive, opt-in)

```jsonc
{
  "experimental_per_edge_context": true,      // master switch; off ⇒ inert
  "edge_context": {
    "review:changes_requested": ["review"],   // "<from>:<event>" → spec
    "regression:regressions_found": ["regression"],
    "implementation": "scoped"                 // per-source default (any event)
  }
}
```

`context` spec values:
- `"full"` — all prior handoffs (default; identical to non-experimental).
- `"scoped"` — only the handoff from the edge's **source** node (`fromState`).
- `["roleA", "roleB"]` — only handoffs whose `role` is in the list.

**Deliberately NOT changing the transition value type.** Transitions stay
`string → string`; the per-edge view lives in a *separate* `edge_context` map.
This keeps `graph.mjs`, `findCycles`, reachability, and the existing
transition-target validation untouched — the prototype's blast radius is one new
pure module + one call site.

### 3.2 Resolution (no state-shape change)

An edge is `(fromState, event)`. The destination node already knows both at
prompt-build time: `state.currentState` is the predecessor that ran and
`state.event` is the event that routed control here (set by the previous node's
return slice, consumed by `graph.addConditionalEdges`). So the contract is
resolved **at the destination**, with no new state field and no change to how
edges are wired.

`src/langgraph/context-contract.mjs`:
- `resolveEdgeContextSpec(workflow, from, event)` — precedence: exact
  `"from:event"` → per-source `"from"` → `"full"`; returns `"full"` whenever the
  flag is off (the no-op guarantee).
- `selectEdgeContext(priorHandoffs, spec, from)` — pure, total filter; unknown
  spec falls back to full.
- `contextForEdge(workflow, priorHandoffs, from, event)` — the one call the node
  makes.

### 3.3 Wiring

`nodes.mjs` LLM path, immediately before `buildPromptFromHandoffs`:

```js
const promptHandoffs = contextForEdge(workflow, priorHandoffs, state.currentState, state.event);
```

Only the **prompt's view** is narrowed. The durable `priorHandoffs` state, the
scoring node's full-history read (`nodes.mjs:628`), resume, and loop accounting
are all untouched — scoping is a presentation concern at the LLM boundary, not a
mutation of the audit record.

### 3.4 Validation

`workflow-validate.mjs` gains structural checks (errors on a non-boolean flag or
a malformed `edge_context`/spec; a warning when a key's source role is unknown).
Absent/false ⇒ no checks, no behavior.

---

## 4. What the prototype does NOT do (scope honesty)

- **No per-edge *instructions*, only per-edge *context selection*.** The richer
  "custom instructions per edge" reading of promise #1 is a superset; this
  prototype proves the load-bearing half (which handoffs the next node sees).
- **No structural handoff re-keying** (§2) — convention + validator hold it.
- **Non-LLM nodes are not scoped** (scoring/regression/command/stub still read
  full history) — they are deterministic aggregators that need the whole record.
- **Not on by default** — `full-audit-sweep` ships without the flag; the feature
  is exercised only by tests and opt-in manifests until §6's graduation bar.

---

## 5. Tests

`test/maestro-context-contract.test.mjs` — pure selector (full/scoped/array/
unknown), resolution precedence, the **no-op guarantee** (flag off ⇒ full), the
entry-node case (no inbound edge ⇒ full), and the **falsification
demonstration** on the stock `full-audit-sweep` graph.

---

## 6. Graduation bar (experimental → supported)

Before the flag is dropped and per-edge scoping is referenced in public copy:
1. Structural handoff re-keying by `stateName` (§2) lands with tests.
2. A shipped template uses `edge_context` non-trivially (the loopback critic
   views above are the natural first one).
3. The benchmark (ROADMAP Pillar 3) measures scoped vs full-history token cost
   on that template — the §5.5 "prove it's distinct from per-role config"
   measurement, now backed by a real graph.

Until then: **KEEP the North Star wording**, ship behind the flag, do not market
"scoped pipelines" as a finished property.
