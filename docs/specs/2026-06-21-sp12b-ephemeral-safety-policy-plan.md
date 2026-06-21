# SP12b — Ephemeral Safety Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the default-closed `server.ephemeral` config block and pure policy validators (command/provider/fan-out allowlists, gate-relaxation) with their error codes — primitives only; runtime enforcement is SP12e.

**Architecture:** One config block resolved+validated in `server-config.mjs`, and one pure validator module `src/ephemeral-policy.mjs` whose single entry point `validateEphemeralPolicy(workflow, policy)` returns every violation. Plus a command-matcher and a gate-relaxation comparator as small pure helpers. No submission endpoint, no sandbox wiring, no execution path this release.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` + `node:assert/strict`. Zero new dependencies.

## Global Constraints

- **Default-closed:** `server.ephemeral.enabled` defaults `false`; absent block resolves to closed. (spec §0, §2)
- **No runtime enforcement this release** — validators are pure and unit-tested; SP12e calls them and enforces the sandbox. (spec §0, §5, §7)
- **No new dependencies.**
- **Config keys** snake_case in `config.json`, resolved camelCase in `server-config.mjs` (follow the existing `agent`/`tracker` block convention).
- **Error style:** config-load failures use `typedError(code, message)` (server-config.mjs:21-26); validator violations use `issue(code, message)` objects `{ code, message }` (mirror `workflow-validate.mjs`). Do not invent a new error shape.
- **Validators return every violation,** not just the first. (spec §3)
- **New test files MUST be appended to the `test` script's file list in `package.json`** — the runner lists files explicitly; an unlisted test file never runs.

---

### Task 1: `server.ephemeral` config block

**Files:**
- Modify: `src/task-store.mjs` (`DEFAULT_SERVER_CONFIG`, add an `ephemeral` block)
- Modify: `src/setup/server-config.mjs` (resolve `raw.ephemeral`; validate enums + `max_fanout` in `validateServerConfig`)
- Test: `test/maestro-server-config.test.mjs`

**Interfaces:**
- Produces: `resolveServerConfig(config).ephemeral` →
  `{ enabled: boolean, commandAllowlist: string[], providerAllowlist: string[], maxFanout: number, sandbox: "required"|"optional", gateRelaxation: "forbid"|"allow", budget: { tokens?, usd?, wall_clock_ms? } | {} }`.
  Defaults: `enabled:false`, allowlists `[]`, `maxFanout:4`, `sandbox:"required"`, `gateRelaxation:"forbid"`, `budget:{}`.
- Produces config-error codes: `invalid_ephemeral_sandbox`, `invalid_ephemeral_gate_relaxation`, `invalid_ephemeral_max_fanout`.

> Note: the `budget` sub-key is shared with SP12c. If SP12c's branch is merged first, reconcile the single `ephemeral` block; this task owns the rest of the block.

- [ ] **Step 1: Write the failing test**

Add to `test/maestro-server-config.test.mjs`:

```js
test("resolveServerConfig defaults server.ephemeral to closed", () => {
  const e = resolveServerConfig({ server: {} }, { baseDir }).ephemeral;
  assert.equal(e.enabled, false);
  assert.deepEqual(e.commandAllowlist, []);
  assert.deepEqual(e.providerAllowlist, []);
  assert.equal(e.maxFanout, 4);
  assert.equal(e.sandbox, "required");
  assert.equal(e.gateRelaxation, "forbid");
});

test("resolveServerConfig resolves a populated server.ephemeral block", () => {
  const e = resolveServerConfig({
    server: { ephemeral: {
      enabled: true,
      command_allowlist: ["npm test", "npm run *"],
      provider_allowlist: ["claude", "codex"],
      max_fanout: 2,
      sandbox: "optional",
      gate_relaxation: "allow",
    } },
  }, { baseDir }).ephemeral;
  assert.equal(e.enabled, true);
  assert.deepEqual(e.commandAllowlist, ["npm test", "npm run *"]);
  assert.deepEqual(e.providerAllowlist, ["claude", "codex"]);
  assert.equal(e.maxFanout, 2);
  assert.equal(e.sandbox, "optional");
  assert.equal(e.gateRelaxation, "allow");
});

test("validateServerConfig rejects bad ephemeral enums and max_fanout", () => {
  const base = { tracker: { kind: "linear", api_key: "$K", project_slug: "p" } };
  const mk = (eph) => resolveServerConfig(
    { server: { ...base, ephemeral: { enabled: true, ...eph } } },
    { env: { K: "tok" }, baseDir },
  );
  assert.throws(() => validateServerConfig(mk({ sandbox: "nope" })), /invalid_ephemeral_sandbox/);
  assert.throws(() => validateServerConfig(mk({ gate_relaxation: "nope" })), /invalid_ephemeral_gate_relaxation/);
  assert.throws(() => validateServerConfig(mk({ max_fanout: 0 })), /invalid_ephemeral_max_fanout/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-server-config.test.mjs`
Expected: FAIL — `ephemeral` is `undefined`.

- [ ] **Step 3: Add the default block**

In `src/task-store.mjs`, add to `DEFAULT_SERVER_CONFIG` (after the `agent` block):

```js
  ephemeral: {
    enabled: false,
    command_allowlist: [],
    provider_allowlist: [],
    max_fanout: 4,
    sandbox: "required",
    gate_relaxation: "forbid",
    budget: {},
  },
```

- [ ] **Step 4: Resolve the block**

In `src/setup/server-config.mjs`, in `resolveServerConfig`, after the existing `const agent = ...` add:

```js
  const ephemeral = asObject(raw.ephemeral) ? raw.ephemeral : {};
```

and add to the returned object (after the `agent` key):

```js
    ephemeral: {
      enabled: ephemeral.enabled === true,
      commandAllowlist: listOfStrings(ephemeral.command_allowlist, []),
      providerAllowlist: listOfStrings(ephemeral.provider_allowlist, []),
      maxFanout: ephemeral.max_fanout === undefined
        ? 4
        : Number(ephemeral.max_fanout),
      sandbox: ephemeral.sandbox ?? "required",
      gateRelaxation: ephemeral.gate_relaxation ?? "forbid",
      budget: asObject(ephemeral.budget) ? ephemeral.budget : {},
    },
```

(Resolution stores the raw `maxFanout`; `validateServerConfig` enforces it's a positive integer so a bad value surfaces as a typed config error, consistent with how the tracker block defers shape checks to `validateServerConfig`.)

- [ ] **Step 5: Validate enums + max_fanout**

In `validateServerConfig` (before the final `return true`), add:

```js
  const eph = config.ephemeral;
  if (eph) {
    if (eph.sandbox !== "required" && eph.sandbox !== "optional") {
      throw typedError("invalid_ephemeral_sandbox", `expected "required" or "optional", got ${eph.sandbox}`);
    }
    if (eph.gateRelaxation !== "forbid" && eph.gateRelaxation !== "allow") {
      throw typedError("invalid_ephemeral_gate_relaxation", `expected "forbid" or "allow", got ${eph.gateRelaxation}`);
    }
    if (!Number.isInteger(eph.maxFanout) || eph.maxFanout <= 0) {
      throw typedError("invalid_ephemeral_max_fanout", `expected positive integer, got ${eph.maxFanout}`);
    }
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/maestro-server-config.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/task-store.mjs src/setup/server-config.mjs test/maestro-server-config.test.mjs
git commit -m "feat(sp12b): default-closed server.ephemeral config block"
```

---

### Task 2: Command allowlist matcher

**Files:**
- Create: `src/ephemeral-policy.mjs` (start the module with this helper)
- Test: `test/maestro-ephemeral-policy.test.mjs`
- Modify: `package.json` (append test file)

**Interfaces:**
- Produces: `matchCommand(candidate, allowlist) -> boolean` — true when whitespace-normalized `candidate` matches any entry: exact (`"npm test"`), prefix (entry ends ` *`, matches everything before the `*`), or regex (entry starts `re:`, remainder is a RegExp matched against the full candidate). An invalid `re:` pattern throws `bad_allowlist_pattern` (caught at config-load time, not per-call — see Task 4 note).

- [ ] **Step 1: Write the failing test**

Create `test/maestro-ephemeral-policy.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchCommand } from "../src/ephemeral-policy.mjs";

test("matchCommand exact match (whitespace-normalized)", () => {
  assert.equal(matchCommand("npm test", ["npm test"]), true);
  assert.equal(matchCommand("npm  test", ["npm test"]), true); // collapsed spaces
  assert.equal(matchCommand("npm test --watch", ["npm test"]), false);
});

test("matchCommand prefix via trailing ' *'", () => {
  assert.equal(matchCommand("npm run lint", ["npm run *"]), true);
  assert.equal(matchCommand("npm run build:prod", ["npm run *"]), true);
  assert.equal(matchCommand("pnpm run lint", ["npm run *"]), false);
});

test("matchCommand regex via 're:' prefix", () => {
  assert.equal(matchCommand("pytest", ["re:^pytest( .*)?$"]), true);
  assert.equal(matchCommand("pytest -q tests/", ["re:^pytest( .*)?$"]), true);
  assert.equal(matchCommand("rm -rf /", ["re:^pytest( .*)?$"]), false);
});

test("matchCommand returns false against an empty allowlist", () => {
  assert.equal(matchCommand("npm test", []), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-ephemeral-policy.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement matchCommand**

Create `src/ephemeral-policy.mjs`:

```js
// SP12b ephemeral safety policy — pure validators. No run core: SP12e calls
// these at submit time and enforces the sandbox at run time.

function issue(code, message) {
  return { code, message };
}

const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ");

export function matchCommand(candidate, allowlist = []) {
  const c = norm(candidate);
  return allowlist.some((entry) => {
    const e = String(entry ?? "");
    if (e.startsWith("re:")) {
      let re;
      try {
        re = new RegExp(e.slice(3));
      } catch {
        return false; // invalid pattern never matches; lint catches it at load
      }
      return re.test(c);
    }
    if (e.endsWith(" *")) {
      return c.startsWith(norm(e.slice(0, -2)) + " ") || c === norm(e.slice(0, -2));
    }
    return c === norm(e);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-ephemeral-policy.test.mjs`
Expected: PASS (all 4).

- [ ] **Step 5: Register the test file**

Append `test/maestro-ephemeral-policy.test.mjs` to the `test` script in `package.json`.

- [ ] **Step 6: Commit**

```bash
git add src/ephemeral-policy.mjs test/maestro-ephemeral-policy.test.mjs package.json
git commit -m "feat(sp12b): command allowlist matcher (exact/prefix/regex)"
```

---

### Task 3: Gate-relaxation comparator

**Files:**
- Modify: `src/ephemeral-policy.mjs` (add the comparator)
- Test: `test/maestro-ephemeral-policy.test.mjs`

**Interfaces:**
- Produces: `gatesAreWeaker(ephemeralGates, baselineGates) -> string[]` — returns a list of human-readable reasons the ephemeral gates are weaker than the baseline (empty ⇒ not weaker). Rules (spec §3.1): for each gate the baseline pins, the ephemeral value must be equal-or-stricter:
  - boolean gates (`require_distinct_reviewer`, `output_schema_conformance`): may not be `false` when baseline is `true`.
  - numeric floors (`min_coverage`): may not be below the baseline value.
  - a gate the baseline does not set is unconstrained.

- [ ] **Step 1: Write the failing test**

Add to `test/maestro-ephemeral-policy.test.mjs`:

```js
import { gatesAreWeaker } from "../src/ephemeral-policy.mjs";

test("gatesAreWeaker flags disabling a baseline-true boolean gate", () => {
  const reasons = gatesAreWeaker(
    { require_distinct_reviewer: false },
    { require_distinct_reviewer: true },
  );
  assert.equal(reasons.length, 1);
});

test("gatesAreWeaker flags a min_coverage below baseline", () => {
  assert.equal(gatesAreWeaker({ min_coverage: 50 }, { min_coverage: 80 }).length, 1);
});

test("gatesAreWeaker allows equal-or-stricter gates", () => {
  assert.deepEqual(gatesAreWeaker({ min_coverage: 90, require_distinct_reviewer: true },
                                  { min_coverage: 80, require_distinct_reviewer: true }), []);
});

test("gatesAreWeaker ignores gates the baseline does not pin", () => {
  assert.deepEqual(gatesAreWeaker({ min_coverage: 10 }, {}), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-ephemeral-policy.test.mjs`
Expected: FAIL — `gatesAreWeaker` not exported.

- [ ] **Step 3: Implement gatesAreWeaker**

Add to `src/ephemeral-policy.mjs`:

```js
const BOOL_GATES = ["require_distinct_reviewer", "output_schema_conformance"];
const NUMERIC_FLOORS = ["min_coverage"];

export function gatesAreWeaker(ephemeral = {}, baseline = {}) {
  const reasons = [];
  for (const g of BOOL_GATES) {
    if (baseline[g] === true && ephemeral[g] === false) {
      reasons.push(`gate "${g}" may not be disabled (baseline requires it)`);
    }
  }
  for (const g of NUMERIC_FLOORS) {
    if (baseline[g] !== undefined && ephemeral[g] !== undefined
        && Number(ephemeral[g]) < Number(baseline[g])) {
      reasons.push(`gate "${g}" (${ephemeral[g]}) is below baseline floor (${baseline[g]})`);
    }
  }
  return reasons;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-ephemeral-policy.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ephemeral-policy.mjs test/maestro-ephemeral-policy.test.mjs
git commit -m "feat(sp12b): gate-relaxation comparator"
```

---

### Task 4: `validateEphemeralPolicy` — the policy decision

**Files:**
- Modify: `src/ephemeral-policy.mjs` (add the entry point)
- Test: `test/maestro-ephemeral-policy.test.mjs`

**Interfaces:**
- Consumes: `matchCommand` (Task 2), `gatesAreWeaker` (Task 3).
- Produces: `validateEphemeralPolicy(workflow, policy) -> { ok, errors }` where `errors` are `issue(code, message)`. Codes, in this order:
  - `ephemeral_disabled` — `policy.enabled !== true` (returned alone; no other checks run).
  - `command_not_allowlisted` — a `roles[*].commands[*].run` matches no allowlist entry.
  - `provider_not_allowlisted` — a `roles[*].provider` not in `providerAllowlist`.
  - `fanout_exceeds_cap` — a `parallel_groups[*]` has more than `maxFanout` members.
  - `gate_relaxation_forbidden` — `policy.gateRelaxation === "forbid"` and `gatesAreWeaker(workflow.gates, baseline)` is non-empty.
- `policy` is the resolved `server.ephemeral` block (Task 1) plus a `baselineGates` field the caller supplies (the server's configured-workflow gates); default `{}`.

- [ ] **Step 1: Write the failing test**

Add to `test/maestro-ephemeral-policy.test.mjs`:

```js
import { validateEphemeralPolicy } from "../src/ephemeral-policy.mjs";

const openPolicy = {
  enabled: true,
  commandAllowlist: ["npm test"],
  providerAllowlist: ["claude"],
  maxFanout: 2,
  gateRelaxation: "forbid",
  baselineGates: { require_distinct_reviewer: true },
};

test("validateEphemeralPolicy rejects when disabled (alone)", () => {
  const r = validateEphemeralPolicy({}, { enabled: false });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.code), ["ephemeral_disabled"]);
});

test("validateEphemeralPolicy accepts a conforming workflow", () => {
  const wf = {
    roles: { exec: { provider: "claude", commands: [{ run: "npm test" }] } },
    parallel_groups: [],
    gates: { require_distinct_reviewer: true },
  };
  assert.equal(validateEphemeralPolicy(wf, openPolicy).ok, true);
});

test("validateEphemeralPolicy reports every violation at once", () => {
  const wf = {
    roles: {
      a: { provider: "rogue", commands: [{ run: "rm -rf /" }] },
    },
    parallel_groups: [["a", "b", "c"]],
    gates: { require_distinct_reviewer: false },
  };
  const codes = validateEphemeralPolicy(wf, openPolicy).errors.map((e) => e.code).sort();
  assert.deepEqual(codes, [
    "command_not_allowlisted",
    "fanout_exceeds_cap",
    "gate_relaxation_forbidden",
    "provider_not_allowlisted",
  ]);
});

test("validateEphemeralPolicy allows gate relaxation when policy permits", () => {
  const wf = { roles: {}, parallel_groups: [], gates: { require_distinct_reviewer: false } };
  const r = validateEphemeralPolicy(wf, { ...openPolicy, gateRelaxation: "allow" });
  assert.ok(!r.errors.some((e) => e.code === "gate_relaxation_forbidden"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-ephemeral-policy.test.mjs`
Expected: FAIL — `validateEphemeralPolicy` not exported.

- [ ] **Step 3: Implement the entry point**

Add to `src/ephemeral-policy.mjs`:

```js
export function validateEphemeralPolicy(workflow = {}, policy = {}) {
  if (policy.enabled !== true) {
    return { ok: false, errors: [issue("ephemeral_disabled", "ephemeral execution is not enabled on this server")] };
  }
  const errors = [];
  const roles = workflow.roles ?? {};
  const commandAllowlist = policy.commandAllowlist ?? [];
  const providerAllowlist = policy.providerAllowlist ?? [];

  for (const [roleName, role] of Object.entries(roles)) {
    for (const cmd of role.commands ?? []) {
      if (!matchCommand(cmd.run, commandAllowlist)) {
        errors.push(issue("command_not_allowlisted",
          `role "${roleName}" command "${cmd.run}" is not in the allowlist`));
      }
    }
    if (role.provider && !providerAllowlist.includes(role.provider)) {
      errors.push(issue("provider_not_allowlisted",
        `role "${roleName}" provider "${role.provider}" is not allowlisted`));
    }
  }

  for (const group of workflow.parallel_groups ?? []) {
    if (Array.isArray(group) && group.length > policy.maxFanout) {
      errors.push(issue("fanout_exceeds_cap",
        `parallel group of ${group.length} exceeds max_fanout ${policy.maxFanout}`));
    }
  }

  if (policy.gateRelaxation === "forbid") {
    const reasons = gatesAreWeaker(workflow.gates ?? {}, policy.baselineGates ?? {});
    for (const r of reasons) {
      errors.push(issue("gate_relaxation_forbidden", r));
    }
  }

  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-ephemeral-policy.test.mjs`
Expected: PASS (all tasks-2/3/4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ephemeral-policy.mjs test/maestro-ephemeral-policy.test.mjs
git commit -m "feat(sp12b): validateEphemeralPolicy entry point"
```

---

### Task 5: Full-suite regression + docs note

**Files:**
- Modify: `docs/configuration.md` (document the `server.ephemeral` block, default-closed, and that enforcement lands in a later release)

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS — including the new `maestro-ephemeral-policy.test.mjs` and the added server-config cases.

- [ ] **Step 2: Document the config**

Add a `server.ephemeral` subsection to `docs/configuration.md`: the keys and defaults (Task 1 table), the default-closed behavior, the three command-allowlist match modes (exact / ` *` prefix / `re:` regex), and a note that policy *validation* ships now while *runtime enforcement* (submission + sandbox isolation) lands with the ephemeral run core.

- [ ] **Step 3: Update the knowledge graph**

Run: `graphify update .`

- [ ] **Step 4: Commit**

```bash
git add docs/configuration.md graphify-out
git commit -m "docs(sp12b): document server.ephemeral safety policy config"
```

---

## Deferred to SP12e (0.4.3) — NOT in this plan

- **Submit-path wiring:** call `validateEphemeralPolicy(workflow, { ...resolvedEphemeral, baselineGates })` on a real ephemeral submission and reject on `!ok`. Needs the submission endpoint SP12e owns. (spec §5, §7)
- **Sandbox enforcement:** when `sandbox: "required"`, run ephemeral roles in an isolated worktree, never the live tree. Needs the run core that creates the worktree. (spec §5, §7)

---

## Self-Review

- **Spec coverage:** §2 config block → Task 1; §2.1 command matching → Task 2; §3 validators + every-violation contract → Task 4; §3.1 gate relaxation → Task 3; §4 error codes → Tasks 1/2/4; §6 testing → each task's tests + Task 5; §5/§7 deferred items → Deferred section. ✅
- **Placeholder scan:** every code step carries complete code; no TBD/TODO; test bodies are concrete.
- **Type consistency:** `validateEphemeralPolicy(workflow, policy)` consumes `matchCommand(candidate, allowlist)` and `gatesAreWeaker(ephemeral, baseline)` with the exact signatures defined in Tasks 2/3; resolved `policy` field names (`commandAllowlist`, `providerAllowlist`, `maxFanout`, `gateRelaxation`, `baselineGates`) match Task 1's resolved camelCase shape. Both validator return shapes are `{ ok, errors }` with `issue(code, message)` entries — consistent across Tasks 3/4.
