# SP12b — Ephemeral Safety Policy

**Date:** 2026-06-21
**Status:** Draft (design approved)
**Target:** 0.4.2 point release — **SP12b**, shipping alongside SP12c (budget/resource
governance) and the standalone SP13 (`maestro exec`).
**Depends on:** `command-runner` ✅, workspace sandbox / worktree isolation ✅,
`workflow-validate.mjs` ✅, server-config resolution ✅ — all shipped in 0.1–0.4.1.
**No unshipped dependency** (no SP7, no SP12e).
**Companion:** [`2026-06-19-v0.4.0-roadmap.md`](2026-06-19-v0.4.0-roadmap.md) (the 0.4.x
train this slots into); pairs with
[`2026-06-21-sp12c-budget-resource-governance-design.md`](2026-06-21-sp12c-budget-resource-governance-design.md).

---

## 0. Summary

SP12b is the **security gate** for agent-authored (ephemeral) workflows. An ephemeral
workflow declares arbitrary `commands[]` (shell) and arbitrary roles; a server operator
must be able to bound what such a run may do **before it runs**.

This release ships the **policy primitives**: a default-closed `server.ephemeral` config
block, a set of pure validators that decide accept/reject against that policy, and the
typed error codes those validators raise — all unit-tested. It deliberately ships **no
runtime enforcement path**, because the thing it would gate (the ephemeral run core,
SP12e) does not land until 0.4.3.

This mirrors the SP12d precedent exactly: *"Nothing here executes a workflow — these are
the primitives the run core (0.4.3) consumes."* SP12b is the safety half of that same
contract. The validators are written, exported, and tested now; SP12e calls them at submit
time and enforces sandbox isolation at run time. See §7 (Now vs 0.4.3) and the roadmap
elevation note.

**Default-closed is the load-bearing guarantee:** `server.ephemeral.enabled` defaults
`false`, so until an operator explicitly opts in, *every* ephemeral submission is rejected
outright. Shipping the closed default in 0.4.2 means that when SP12e turns on ephemeral
execution in 0.4.3, it is closed by default and cannot be opened without a deliberate
operator decision.

---

## 1. Motivation — and the ponytail check

Why ship the policy a release before the thing it guards?

1. **Closed-by-default must precede the door.** If the safety config and its default-closed
   posture land *with* the ephemeral run core, there is a window — even if only in a dev
   build — where execution exists before the gate. Landing the gate first makes "ephemeral
   is off until an operator opts in" true from the moment execution becomes possible.
2. **The validators are pure and independently testable.** Allowlist matching, fan-out
   counting, and gate-relaxation comparison are deterministic functions of
   `(workflow, policy)`. They need no run core to be correct or to be tested. Writing them
   now de-risks SP12e, which becomes "call these, enforce the sandbox" rather than "design
   and build the policy."
3. **Config schema stability.** Operators configuring a server can write the
   `server.ephemeral` block in 0.4.2 and have it validated, so the shape is locked and
   documented before any workload depends on it.

What we are **not** doing (the ponytail cut): no ephemeral submission endpoint, no runtime
sandbox wiring, no new execution path. That is SP12e's scope and pulling it forward would
couple this low-risk config/validation work to the high-risk run core.

---

## 2. Config surface — `server.ephemeral`

New block added to `DEFAULT_SERVER_CONFIG` (`src/task-store.mjs`) and resolved/validated in
`src/setup/server-config.mjs` alongside the existing `tracker`, `agent`, `hooks` blocks.

```json
{
  "server": {
    "ephemeral": {
      "enabled": false,
      "command_allowlist": [],
      "provider_allowlist": [],
      "max_fanout": 4,
      "sandbox": "required",
      "gate_relaxation": "forbid"
    }
  }
}
```

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `enabled` | bool | `false` | Master switch. `false` ⇒ all ephemeral submission rejected (`ephemeral_disabled`). |
| `command_allowlist` | string[] | `[]` | Permitted `commands[].run` patterns (matching rules below). Empty + enabled ⇒ no command may run. |
| `provider_allowlist` | string[] | `[]` | Permitted role providers. Empty + enabled ⇒ no provider permitted. |
| `max_fanout` | int > 0 | `4` | Max members in any one `parallel_groups` entry. |
| `sandbox` | `"required" \| "optional"` | `"required"` | `required` ⇒ ephemeral roles always run in an isolated worktree, never the live tree. |
| `gate_relaxation` | `"forbid" \| "allow"` | `"forbid"` | `forbid` ⇒ an ephemeral workflow may not declare weaker gates than the server baseline. |

**Resolution rules** (in `server-config.mjs`, reusing existing helper validators):

- `enabled`, `gate_relaxation`/`sandbox` enums validated on load; a bad enum or a
  non-positive `max_fanout` is a config error at server start (consistent with how the
  existing `agent`/`polling` blocks fail fast), not a per-submission error.
- The block is optional; an absent `server.ephemeral` resolves to the default above
  (closed). This means existing configs keep working unchanged and stay closed.

### 2.1 Command allowlist matching

Each entry in `command_allowlist` matches a candidate `commands[].run` string by one of
three modes, chosen by the entry's own syntax (no separate mode flag — keeps the config one
flat list):

| Entry form | Mode | Matches when |
|------------|------|--------------|
| `"npm test"` | **exact** | candidate string equals the entry exactly |
| `"npm run *"` | **prefix** | a trailing ` *` makes it a prefix match on everything before the `*` |
| `"re:^pytest( .*)?$"` | **regex** | a `re:` prefix compiles the remainder as a RegExp, matched against the full candidate |

Exact is the default and the safest; prefix and regex are opt-in by syntax so an operator
cannot widen the allowlist by accident. Matching is whitespace-normalized (collapse runs of
spaces, trim) before comparison so cosmetic spacing differences do not bypass or break a
rule. A candidate matching **no** entry is a hard validation reject
(`command_not_allowlisted`), never a runtime failure.

---

## 3. Validators — the policy decision functions

A single pure entry point in a new module `src/ephemeral-policy.mjs`:

```js
validateEphemeralPolicy(workflow, policy) -> { ok, errors[] }
```

`workflow` is a parsed (already structurally-valid, per SP12a) ephemeral workflow object;
`policy` is the resolved `server.ephemeral` block. The function performs the checks below
and returns every violation (not just the first), so a caller can report all policy
failures in one pass.

| Check | Rejects with | Rule |
|-------|--------------|------|
| Master switch | `ephemeral_disabled` | `policy.enabled !== true` ⇒ reject before any other check. |
| Command allowlist | `command_not_allowlisted` | every `roles[*].commands[*].run` must match some allowlist entry (§2.1). |
| Provider allowlist | `provider_not_allowlisted` | every `roles[*].provider` must be in `provider_allowlist`. |
| Fan-out cap | `fanout_exceeds_cap` | every `parallel_groups[*]` must have ≤ `max_fanout` members. |
| Gate relaxation | `gate_relaxation_forbidden` | when `gate_relaxation: "forbid"`, the workflow's `gates{}` may not weaken the server baseline (§3.1). |

The function is **side-effect free**: it reads the workflow and policy, returns a verdict.
It does not touch disk, spawn anything, or mutate the registry. That is what makes it
fully unit-testable in 0.4.2 with no run core.

### 3.1 Gate-relaxation comparison

"Weaker than baseline" is defined narrowly and concretely against the server's configured
workflow gates (the baseline):

- **`require_distinct_reviewer`** — an ephemeral workflow may not set it to `false` if the
  baseline has it `true`.
- **`min_coverage`** (and any numeric gate floor) — an ephemeral workflow may not set a
  value **below** the baseline's value.
- **`output_schema_conformance`** and other boolean gates — may not be disabled if the
  baseline enables them.

A gate the baseline does not specify is unconstrained (the ephemeral workflow may set it
however it likes). Relaxation comparison is therefore "for each gate the baseline pins,
the ephemeral value must be ≥ as strict." Equal or stricter is always allowed.

---

## 4. Error codes

All raised as typed errors consistent with the existing `typedError(code, message)`
convention in `server-config.mjs` / `workflow-validate.mjs`:

| Code | Raised when | Surface |
|------|-------------|---------|
| `ephemeral_disabled` | submission attempted while `enabled:false` | submit-time (SP12e); validator returns it now |
| `command_not_allowlisted` | a command matches no allowlist entry | validator |
| `provider_not_allowlisted` | a role provider is not allowlisted | validator |
| `fanout_exceeds_cap` | a parallel group exceeds `max_fanout` | validator |
| `gate_relaxation_forbidden` | ephemeral gates weaken the baseline under `forbid` | validator |

Config-load errors (bad enum, non-positive `max_fanout`) reuse the existing
server-config error path and are not in this table — they fail server start, not a
submission.

---

## 5. What this is NOT (this release)

- **No ephemeral submission endpoint.** There is no caller wiring `validateEphemeralPolicy`
  into a live submit path yet — that is SP12e.
- **No runtime sandbox enforcement.** The `sandbox: "required"` *policy* is stored and
  validated, but the worktree-isolation enforcement at run time is SP12e (it owns the run
  core that would create the worktree).
- **No regex denial-of-service hardening beyond compile-time.** `re:` patterns are compiled
  and rejected if invalid; catastrophic-backtracking analysis is out of scope (operator
  writes their own allowlist; this is a trusted-operator surface, not user input).
- **No per-role granular policy.** Policy is server-wide for all ephemeral runs. Per-role /
  per-project policy is a future item if demand appears.

---

## 6. Testing

All testable in 0.4.2 with no run core (the validators are pure):

- **Default-closed:** absent `server.ephemeral` and explicit `enabled:false` both yield
  `ephemeral_disabled` for any submission.
- **Each rejection in isolation:** a fixture that violates exactly one rule returns exactly
  that one code; a fixture violating several returns all of them.
- **Allowlist modes:** exact match accepts/rejects; ` *` prefix accepts the prefix family
  and rejects outside it; `re:` regex accepts matches and rejects non-matches; an invalid
  `re:` pattern is a config-load error.
- **Whitespace normalization:** `"npm  test"` matches an allowlist entry `"npm test"`.
- **Fan-out cap:** a `parallel_groups` entry at the cap passes; cap+1 fails.
- **Gate relaxation:** disabling `require_distinct_reviewer` against a `true` baseline
  fails under `forbid` and passes under `allow`; a stricter-than-baseline gate always
  passes; lowering `min_coverage` below baseline fails.
- **Config resolution:** bad enum / non-positive `max_fanout` fail at server start with the
  existing config-error code path.

---

## 7. Now vs 0.4.3 (SP12e) — the hybrid boundary

| Capability | 0.4.2 (SP12b) | 0.4.3 (SP12e) |
|------------|---------------|---------------|
| `server.ephemeral` config + resolution | **ships** | consumed |
| `validateEphemeralPolicy` validators + error codes | **ships, unit-tested** | called at submit |
| Default-closed (`enabled:false` rejects all) | **ships** | honored |
| Submit-path wiring (call validators on a real submission) | — | **ships** |
| `sandbox: "required"` worktree isolation at run time | — | **ships** |

The roadmap is updated so the SP12b section records that runtime enforcement (submit-path
wiring + sandbox isolation) is **elevated to full enforcement at 0.4.3/SP12e**; the 0.4.x
train table row is unchanged.

---

## 8. Roadmap placement

SP12b is one half of the 0.4.2 guardrails pair (with SP12c), shipping beside the
independent SP13 (`maestro exec`). It is a prerequisite for SP12e: the ephemeral run core
must not execute an agent-authored workflow without these policy checks in any
shared/hosted mode. See the 0.4.x train table in the companion roadmap.
