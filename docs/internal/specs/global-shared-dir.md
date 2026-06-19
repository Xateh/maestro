# Design spec — Global shared dir (reusable workflows/config across sessions)

**Date:** 2026-06-19
**Status:** Proposed (design-level, not yet built). Pillar-2/4 item; gated on
nothing in Pillar 1 — additive, declarative, low blast radius.
**Audience:** Internal only (`docs/internal/`, git-ignored, never packaged).
**Companion docs:** [`../ROADMAP.md`](../ROADMAP.md) §4 Pillar 2 (the surface this
extends) + §8 (the open decision this answers in part) + §10.3 (the extension
ecosystem whose discovery/precedence question this overlaps);
[`../../configuration.md`](../../configuration.md) §"State Directory" (the
resolution this layers under).

---

## 0. Why this spec exists

The honest user story (ROADMAP §0) is one author running multi-step agent work
across **many directories**. Today every knob lives in a single project
`.maestro/`, resolved by walking up from cwd and taking the **first** match
(`cli/workspace-resolve.mjs:findStateDirUpwards` — first-match-wins, no merge).
There is no maestro-owned place to put a workflow, role unit, or default that
**every** project should see. The author re-runs `maestro init` and re-authors
or copies the same `full-audit-sweep` variant, the same provider defaults, the
same imported role bundles, per repo.

Note the asymmetry already in the tree: Maestro happily **reads** `~/.claude`,
`~/.codex`, `~/.gemini` as *import sources* (`setup/scanners/*.mjs`) and `herdr`
already owns `~/.config/herdr` (`herdr-client.mjs:17`). What's missing is a
maestro-**owned** global dir that contributes to resolution at run time, not
just a one-shot copy-in.

**This spec is feature A only.** The sibling idea — a full *parent-walk-up
cascade* that merges every `.maestro/` between `/` and cwd, subdir overriding
parent — is **feature B**, deliberately split out and **not** specced here.
ROADMAP §12 records B as a note with a standing caution (it may be net-negative).
A and B are different needs: A is "share one global baseline"; B is "per-subtree
override hierarchies." A delivers ~all of the stated reuse goal at a fraction of
B's risk (no cycles, no jumps, fixed two-layer merge).

---

## 1. Goal

A single, fixed, maestro-owned global directory that contributes **reusable
content and low-precedence defaults** to every session, overridable per project.

- **Location:** `$XDG_CONFIG_HOME/maestro/`, default `~/.config/maestro/`
  (matches the `herdr` precedent already in-tree). Overridable via
  `MAESTRO_GLOBAL_DIR` for tests and non-standard homes.
- **What it may hold (the *safe subset* — see §4):**
  - `config.json` — global defaults (provider map, behaviour flags). Lowest
    real-config precedence.
  - `workflows/<name>.json` (+ `.yaml`) — reusable workflow templates resolved
    alongside project `workflows/` and the in-tree `WORKFLOW_TEMPLATES`.
  - `prompts/` + role units — reusable instruction docs / MRC roles a global
    workflow references.
- **What it must NOT hold:** secrets (those stay project-local, mode 0600,
  `secrets.local.json`), machine-detected `config.local.json` values, or any
  per-run state (tasks, runs, db). The global dir is **shareable, declarative
  authoring content**, not state and not credentials.

---

## 2. Resolution model — one new layer, nothing reordered

### 2.1 Config

`task-store.readConfig()` today is exactly:

```
shimLegacyKeys(
  deepMergeConfig({ ...DEFAULT_LOCAL_CONFIG_V2, ...projectConfigJson }, projectConfigLocalJson),
  workflow,
)
```

i.e. **DEFAULT < config.json < config.local.json**. The global layer slots in as
the lowest *file* layer, above the hard-coded defaults:

```
DEFAULT_LOCAL_CONFIG_V2  <  GLOBAL config.json  <  project config.json  <  project config.local.json
```

`deepMergeConfig` (`config-local.mjs`) is the **exact** primitive — plain objects
merge recursively, arrays/scalars replace. Reuse it; add no new merge code. The
only change is one extra `deepMergeConfig` call seeded with the global config
read (or `{}` when absent — same lenient ENOENT/SyntaxError swallow as
`readLocalConfig`).

**Precedence is fixed and total.** Two layers of files, known locations, no
search. Project always wins over global. There is no scenario where resolution
order is ambiguous, so there is **no cycle and no jump** to detect — that hazard
is entirely confined to feature B.

### 2.2 Workflows

`task-store.workflowFilePath(name)` resolves `.maestro/workflows/<name>.json`
with no fallback. New resolution order for a named workflow:

```
project .maestro/workflows/<name>   →   GLOBAL workflows/<name>   →   in-tree WORKFLOW_TEMPLATES[<name>]
```

First hit wins (these are whole-document selections, not deep-merged — a workflow
is an atomic graph; merging two graphs is out of scope and undesirable). This
generalizes the existing two-tier "named file else in-tree template" lookup into
three tiers by inserting global between them. `maestro workflow use <name>` and
`maestro init --workflow <name>` consume the same resolver, so both pick up
global templates for free.

### 2.3 Role units / prompts

A global workflow that references a role/prompt resolves it from the global dir's
`prompts/` / role units when the project doesn't define it locally — same
project-first, global-fallback rule as workflows. (Role-unit loading already
centralizes in `setup/role-loader.mjs`; the fallback hooks there.)

---

## 3. Reproducibility — the one real obligation

North-Star promise #2 is **auditable / replayable** (ROADMAP §1). A run that
silently pulled a workflow or defaults from a global dir is **not** reconstructable
from the project alone — the global dir can change or differ across machines. This
is the single non-negotiable design constraint A imposes:

> When a run resolves *any* artifact (config keys, workflow, role unit) from the
> global dir, the **flattened, resolved** value is snapshotted into the run
> manifest / receipt (`run-manifest.mjs`), tagged with its source layer
> (`global` vs `project` vs `local` vs `builtin`). Replay reads the snapshot,
> never the live global dir.

The cost is bounded and small: A adds **one** extra source layer, and the
manifest already records the workflow snapshot today. Tagging provenance per
resolved key is the increment. This keeps "reproduce from one manifest" true even
though inputs now span two dirs.

---

## 4. Scope discipline — the safe subset, and where it stops

The biggest fork (raised at design time): **what may live in the global dir.**

- **YES (declarative, low blast radius):** `config.json` defaults, `workflows/`,
  `prompts/`, role units. These are data the engine already parses and validates;
  a global one is the same data in a different dir. No new trust surface.
- **NO, deferred to §10.3, not this spec:** global **adapters** (provider
  command-builders) and global **node kinds**. These execute code inside
  Maestro's trust boundary. The moment the global dir can contribute *executable
  extension code*, this stops being "feature A" and becomes the §10.3 native
  extension ecosystem, which is gated on the embeddable-boundary API **and** a
  security/sandboxing spec. A must ship the declarative subset only and explicitly
  refuse to load executable units from the global dir until §10.3 lands.

This boundary is what keeps A low-risk. If a future need wants global adapters,
it goes through §10.3's trust model, not through widening A.

**Relationship to §8 / §10.3 discovery question.** ROADMAP §10.3 lists an open
"how are units named / found / resolved (npm? registry? `.maestro/plugins/`?),
precedence vs in-tree built-ins." A answers a slice of that for the *declarative*
case: the answer is a fixed `~/.config/maestro/` dir with project-first
precedence. §10.3 should reference this rather than re-deciding precedence for
declarative content.

---

## 5. Surfaces & commands

- **`maestro global init`** — scaffold `~/.config/maestro/` (mirror of `init`,
  minus state/secrets/db). Idempotent.
- **`maestro global path`** — print the resolved global dir (honours
  `MAESTRO_GLOBAL_DIR` / `XDG_CONFIG_HOME`).
- **Existing commands gain global awareness transparently** — `workflow list`
  shows global templates tagged `(global)`; `workflow use`, `init --workflow`,
  and config reads pick them up via the resolvers in §2. No per-command special
  casing beyond the shared resolver change.
- **MCP:** the global dir is read-only from the MCP substrate's perspective in v1
  (a driving agent resolves *against* it but does not author into it), keeping the
  Pillar-2 surface narrow.

---

## 6. Definition of done

- Global `config.json` deep-merges **under** project config via the existing
  `deepMergeConfig`; precedence test asserts
  `DEFAULT < global < project < local` end-to-end, including the absent-global
  (`{}`) path.
- Named workflow resolves `project → global → builtin` first-hit; test covers all
  three tiers + the "project shadows global" case.
- A run that resolves a workflow/config key from global writes the **flattened**
  value + `source: global` provenance into the run manifest; a replay reproduces
  it from the snapshot with the global dir deleted (the reproducibility gate).
- The loader **refuses** to load adapters/node-kinds from the global dir and says
  why (points at §10.3) — test asserts the refusal.
- `MAESTRO_GLOBAL_DIR` / `XDG_CONFIG_HOME` honoured; default `~/.config/maestro`;
  docs in `configuration.md` describe the layer order.
- Zero new merge primitives, zero new state types, no secrets in the global dir.

---

## 7. Explicit non-goals (this spec)

- **Parent-walk-up cascade (feature B)** — separate item, ROADMAP §12. Not here.
- **Global secrets / credentials** — stay project-local. Never.
- **Global executable extensions (adapters, node kinds)** — §10.3, gated on a
  trust model. Not the safe subset.
- **Merging two workflow graphs** — workflows resolve atomically (whole-document
  first-hit), never deep-merged.
- **A registry / network discovery** — the global dir is a local filesystem path,
  full stop. Network-published units are §10.3 territory.
