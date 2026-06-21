# SP12c — Budget & Resource Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound concurrency, surface live cost, and rate-limit per provider over the existing SP7 fan-out, plus ship budget-cap validators (kill-switch deferred to SP12e).

**Architecture:** Four parts. Parts 1–3 are live runtime: a bounded worker pool around the existing `Promise.allSettled` fan-out in `graph.mjs`; a derived per-run cost aggregate emitted as a `cost_update` stage event; a per-provider generalization of the existing token-bucket limiter. Part 4 ships pure budget validators + config; the breach kill-switch is out of scope (needs the SP12e run-request object).

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` + `node:assert/strict`, LangGraph (`@langchain/langgraph`), SQLite task store. Zero new dependencies.

## Global Constraints

- **No new runtime dependencies** — reuse `src/http-rate-limit.mjs`, existing `parseUsage`, SP10b cancellation. (spec §1)
- **No new persistence tables** — the running cost total is derived from existing step rows + one synthetic stage event. (spec §3)
- **No budget kill-switch this release** — validators + accounting only; breach→cancel is SP12e. (spec §0, §5, §7)
- **Backward compatible** — absent config resolves to today's behavior; existing pipelines whose group size ≤ default cap run unchanged. (spec §2, §4)
- **Config keys** are snake_case in `config.json`, resolved to camelCase in `server-config.mjs` (follow the existing `agent` block convention). (server-config.mjs:155-161)
- **Error style:** `typedError(code, message)` in config code; `issue(code, message)` in validators — copy the existing helpers verbatim, do not invent a new error shape.
- **New test files MUST be appended to the `test` script's file list in `package.json`** — the runner lists files explicitly; an unlisted test file never runs.

---

### Task 1: Concurrency cap config — `max_concurrent_roles`

**Files:**
- Modify: `src/task-store.mjs` (the `agent` block of `DEFAULT_SERVER_CONFIG`, ~line 196-203)
- Modify: `src/setup/server-config.mjs:155-161` (the resolved `agent` block)
- Test: `test/maestro-server-config.test.mjs`

**Interfaces:**
- Produces: `resolveServerConfig(config).agent.maxConcurrentRoles : number` (default `4`); config error code `invalid_max_concurrent_roles` on non-positive.

- [ ] **Step 1: Write the failing test**

Add to `test/maestro-server-config.test.mjs`:

```js
test("resolveServerConfig resolves agent.max_concurrent_roles (default 4)", () => {
  const def = resolveServerConfig({ server: {} }, { baseDir });
  assert.equal(def.agent.maxConcurrentRoles, 4);

  const set = resolveServerConfig(
    { server: { agent: { max_concurrent_roles: 2 } } },
    { baseDir },
  );
  assert.equal(set.agent.maxConcurrentRoles, 2);
});

test("resolveServerConfig rejects non-positive max_concurrent_roles", () => {
  assert.throws(
    () => resolveServerConfig({ server: { agent: { max_concurrent_roles: 0 } } }, { baseDir }),
    /invalid_max_concurrent_roles/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-server-config.test.mjs`
Expected: FAIL — `maxConcurrentRoles` is `undefined`.

- [ ] **Step 3: Add the default**

In `src/task-store.mjs`, inside `DEFAULT_SERVER_CONFIG.agent`, add the key:

```js
  agent: {
    max_concurrent_agents: 10,
    max_concurrent_roles: 4,
    max_turns: 20,
    max_retry_backoff_ms: 300_000,
    stall_timeout_ms: 300_000,
    max_concurrent_agents_by_state: {},
  },
```

- [ ] **Step 4: Resolve it**

In `src/setup/server-config.mjs`, in the returned `agent` block (after `maxConcurrentAgents`):

```js
      maxConcurrentAgents: positiveInteger(agent.max_concurrent_agents, 10, "invalid_max_concurrent_agents"),
      maxConcurrentRoles: positiveInteger(agent.max_concurrent_roles, 4, "invalid_max_concurrent_roles"),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/maestro-server-config.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/task-store.mjs src/setup/server-config.mjs test/maestro-server-config.test.mjs
git commit -m "feat(sp12c): add agent.max_concurrent_roles config"
```

---

### Task 2: Bounded async pool helper

**Files:**
- Create: `src/async-pool.mjs`
- Test: `test/maestro-async-pool.test.mjs`
- Modify: `package.json` (append the new test file to the `test` script)

**Interfaces:**
- Produces: `runPool(items, limit, fn) -> Promise<PromiseSettledResult[]>` — runs `fn(item, index)` over `items` with at most `limit` in flight at once, returns results in **input order** with the same shape as `Promise.allSettled` (`{ status, value | reason }`).

- [ ] **Step 1: Write the failing test**

Create `test/maestro-async-pool.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { runPool } from "../src/async-pool.mjs";

test("runPool caps concurrency and preserves input order", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fn = async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  };
  const results = await runPool([1, 2, 3, 4, 5], 2, fn);
  assert.equal(maxInFlight, 2);
  assert.deepEqual(results.map((r) => r.value), [2, 4, 6, 8, 10]);
  assert.ok(results.every((r) => r.status === "fulfilled"));
});

test("runPool reports rejections like allSettled, in order", async () => {
  const fn = async (n) => { if (n === 2) throw new Error("boom"); return n; };
  const results = await runPool([1, 2, 3], 3, fn);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.message, "boom");
  assert.equal(results[2].value, 3);
});

test("runPool with limit >= length behaves like allSettled", async () => {
  const results = await runPool([1, 2], 10, async (n) => n);
  assert.deepEqual(results.map((r) => r.value), [1, 2]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-async-pool.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pool**

Create `src/async-pool.mjs`:

```js
// Bounded-concurrency settle-all helper. Runs fn over items with at most
// `limit` promises in flight, returning Promise.allSettled-shaped results in
// input order. limit <= 0 is treated as unbounded (today's behavior).

export async function runPool(items, limit, fn) {
  const list = Array.from(items);
  const results = new Array(list.length);
  if (!Number.isInteger(limit) || limit <= 0 || limit >= list.length) {
    const settled = await Promise.allSettled(list.map((item, i) => fn(item, i)));
    return settled;
  }
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(list[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-async-pool.test.mjs`
Expected: PASS (all 3).

- [ ] **Step 5: Register the test file**

In `package.json`, append `test/maestro-async-pool.test.mjs` to the space-separated file list in the `test` script.

- [ ] **Step 6: Commit**

```bash
git add src/async-pool.mjs test/maestro-async-pool.test.mjs package.json
git commit -m "feat(sp12c): bounded async pool helper (runPool)"
```

---

### Task 3: Wire the pool into the parallel-group node

**Files:**
- Modify: `src/langgraph/graph.mjs:34-58` (`buildGroupNode`) and `:171-176` (`groupOpts`)
- Test: `test/maestro-parallel-graph.test.mjs`

**Interfaces:**
- Consumes: `runPool` (Task 2), `resolveServerConfig().agent.maxConcurrentRoles` (Task 1).
- Produces: group execution capped at `maxConcurrentRoles`; join result (handoffs, `parallel_failed`, event precedence) **identical** to the unbounded path.

- [ ] **Step 1: Write the failing test**

Add to `test/maestro-parallel-graph.test.mjs` (follow the existing fixture style in that file; it already builds groups). Assert that with a 4-member group and a cap of 2, no more than 2 member fns run concurrently and the merged handoffs match the unbounded run. Use a member fn that records `maxInFlight` via a shared counter:

```js
test("buildGroupNode caps member concurrency at maxConcurrentRoles", async () => {
  // Arrange a 4-member parallel group with maxConcurrentRoles: 2 and a
  // member node that bumps a shared in-flight counter. (Reuse this file's
  // existing harness for constructing workflow/config/opts.)
  // Assert: observed max in-flight === 2, and the join handoffs equal the
  // handoffs produced by the same group run unbounded.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-parallel-graph.test.mjs`
Expected: FAIL — concurrency is still unbounded (max in-flight === 4).

- [ ] **Step 3: Thread the cap into groupOpts**

In `src/langgraph/graph.mjs`, where `groupOpts` is built (~line 171), add the cap from config:

```js
        const groupOpts = {
          db, runner, ops, availabilityProbe,
          contextRetryLimit: config.context_retry_limit ?? 1,
          resumeCompletedRoles, advisoryEmitted,
          maxConcurrentRoles: config.server?.agent?.maxConcurrentRoles
            ?? config.max_concurrent_roles
            ?? 0, // 0 ⇒ unbounded (back-compat when unset)
        };
```

(Use whichever of these the engine already threads resolved server config through — if `config` here is the raw `config.json`, read the resolved value the caller passes; confirm the call site in `engine.mjs` and pass `maxConcurrentRoles` explicitly rather than reaching through `config` if that is cleaner. The contract is: `buildGroupNode` receives a numeric `maxConcurrentRoles`, default `0`.)

- [ ] **Step 4: Replace allSettled with runPool**

At the top of `src/langgraph/graph.mjs` add the import:

```js
import { runPool } from "../async-pool.mjs";
```

In `buildGroupNode`, replace the `Promise.allSettled` block (lines 56-58):

```js
    // Run members with bounded concurrency (0/unset ⇒ unbounded, == today)
    const settled = await runPool(
      memberFns,
      opts.maxConcurrentRoles ?? 0,
      ({ fn }) => fn(state, lgConfig),
    );
```

The downstream merge loop is unchanged — `settled[i].status`/`.value`/`.reason` shapes match `allSettled`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/maestro-parallel-graph.test.mjs`
Expected: PASS — max in-flight === 2, handoffs identical.

- [ ] **Step 6: Run the engine regression suite**

Run: `node --test test/maestro-parallel-graph.test.mjs test/maestro-engine.test.mjs test/maestro-task-graph-runner.test.mjs`
Expected: PASS — fan-out semantics unchanged when cap unset.

- [ ] **Step 7: Commit**

```bash
git add src/langgraph/graph.mjs test/maestro-parallel-graph.test.mjs
git commit -m "feat(sp12c): bound parallel-group concurrency via runPool"
```

---

### Task 4: Live cost accounting — `cost_update` stage event

**Files:**
- Create: `src/cost-accounting.mjs`
- Test: `test/maestro-cost-accounting.test.mjs`
- Modify: `package.json` (append test file)
- Modify: `src/langgraph/nodes.mjs` (after the `appendStep` call that records `tokens`, ~line 1114-1126) to emit a `cost_update` step event

**Interfaces:**
- Produces:
  - `accumulateCost(prevTotals, step) -> { tokens: number, usd: number | undefined }` — pure aggregation. `step` is `{ provider, model, tokens }`. `usd` present only when `priceFor(provider, model)` is known (Task 5).
  - A `cost_update` step record `{ role: "__cost_update__", event: { kind: "cost_update", cumulative: { tokens, usd? }, last_step: { role, provider, tokens } } }` appended via the same `db.updateTask(... steps ...)` best-effort pattern used for `parallel_join` (graph.mjs:118).

- [ ] **Step 1: Write the failing test**

Create `test/maestro-cost-accounting.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { accumulateCost } from "../src/cost-accounting.mjs";

test("accumulateCost sums tokens across steps", () => {
  let t = { tokens: 0 };
  t = accumulateCost(t, { provider: "claude", model: "x", tokens: 100 });
  t = accumulateCost(t, { provider: "codex", model: "y", tokens: 50 });
  assert.equal(t.tokens, 150);
});

test("accumulateCost handles missing/zero tokens", () => {
  const t = accumulateCost({ tokens: 10 }, { provider: "claude", model: "x", tokens: undefined });
  assert.equal(t.tokens, 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-cost-accounting.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement accumulateCost**

Create `src/cost-accounting.mjs`:

```js
// Pure per-run cost aggregation. The authoritative per-step tokens already
// persist in step rows (parseUsage → appendStep); this derives a running total
// for the stage-event stream. No new persistence.

import { priceFor } from "./provider-pricing.mjs";

export function accumulateCost(prev, step) {
  const tokens = (prev?.tokens ?? 0) + (Number(step?.tokens) || 0);
  const stepUsd = priceFor(step?.provider, step?.model, Number(step?.tokens) || 0);
  const usd = stepUsd === undefined
    ? prev?.usd
    : (prev?.usd ?? 0) + stepUsd;
  return usd === undefined ? { tokens } : { tokens, usd };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-cost-accounting.test.mjs`
Expected: PASS.

- [ ] **Step 5: Register the test file**

Append `test/maestro-cost-accounting.test.mjs` to the `test` script in `package.json`.

- [ ] **Step 6: Emit cost_update from the node**

In `src/langgraph/nodes.mjs`, immediately after the `await db.appendStep(...)` that records `tokens: parseUsage(...)` (~line 1114), append a best-effort `cost_update` step using the same pattern as `parallel_join`:

```js
      // ── live cost accounting (SP12c): emit a cost_update stage event ──────
      try {
        const stepTokens = parseUsage(runProvider, result.stdout);
        await db.updateTask(task.id, (current) => {
          const prior = (current.steps ?? [])
            .filter((s) => s.role === "__cost_update__")
            .at(-1)?.event?.cumulative ?? { tokens: 0 };
          const cumulative = accumulateCost(prior, {
            provider: runProvider, model: runModel, tokens: stepTokens,
          });
          return {
            steps: [...(current.steps ?? []), {
              role: "__cost_update__",
              event: {
                kind: "cost_update",
                cumulative,
                last_step: { role: roleKey, provider: runProvider, tokens: stepTokens },
                timestamp: new Date().toISOString(),
              },
            }],
          };
        }).catch(() => {});
      } catch { /* observability never breaks a run */ }
```

Add the import at the top of `nodes.mjs`:

```js
import { accumulateCost } from "../cost-accounting.mjs";
```

- [ ] **Step 7: Verify nothing regressed**

Run: `node --test test/maestro-engine.test.mjs test/maestro-stage-events.test.mjs`
Expected: PASS — runs still complete; `cost_update` steps present in event output.

- [ ] **Step 8: Commit**

```bash
git add src/cost-accounting.mjs test/maestro-cost-accounting.test.mjs src/langgraph/nodes.mjs package.json
git commit -m "feat(sp12c): live cost accounting via cost_update stage event"
```

---

### Task 5: Best-effort USD price table

**Files:**
- Create: `src/provider-pricing.mjs`
- Test: `test/maestro-provider-pricing.test.mjs`
- Modify: `package.json` (append test file)

**Interfaces:**
- Produces: `priceFor(provider, model, tokens) -> number | undefined` — `undefined` when the `(provider, model)` price is unknown (caller then omits `usd`); a non-negative USD estimate otherwise.

- [ ] **Step 1: Write the failing test**

Create `test/maestro-provider-pricing.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { priceFor } from "../src/provider-pricing.mjs";

test("priceFor returns undefined for unknown provider/model", () => {
  assert.equal(priceFor("nope", "nope", 1000), undefined);
});

test("priceFor estimates a non-negative cost for a known model", () => {
  const usd = priceFor("claude", "claude-opus-4-8", 1_000_000);
  assert.equal(typeof usd, "number");
  assert.ok(usd >= 0);
});

test("priceFor returns 0 for zero tokens on a known model", () => {
  assert.equal(priceFor("claude", "claude-opus-4-8", 0), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-provider-pricing.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the table**

Create `src/provider-pricing.mjs`. Keep it a tiny static table; unknown ⇒ `undefined`. This is an *estimate*, never billing truth (spec §7).

```js
// Best-effort USD-per-token estimate. Static table keyed by (provider, model
// prefix). Unknown ⇒ undefined (caller omits usd). NOT a billing source.
// Blended $/token (input+output averaged) is good enough for a running estimate.

const TABLE = [
  // [provider, modelPrefix, usdPerToken]
  ["claude", "claude-opus", 30 / 1_000_000],
  ["claude", "claude-sonnet", 6 / 1_000_000],
  ["claude", "claude-haiku", 1 / 1_000_000],
  ["codex", "", 10 / 1_000_000],
];

export function priceFor(provider, model, tokens) {
  if (!provider) return undefined;
  const m = String(model ?? "");
  const row = TABLE.find(
    ([p, prefix]) => p === provider && m.startsWith(prefix),
  );
  if (!row) return undefined;
  return (Number(tokens) || 0) * row[2];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-provider-pricing.test.mjs`
Expected: PASS.

- [ ] **Step 5: Register the test file & re-run cost accounting**

Append the test file to `package.json`. Re-run `node --test test/maestro-cost-accounting.test.mjs` — now `usd` is populated for known models; add an assertion in that file that `accumulateCost` yields a numeric `usd` for a `claude-opus-*` step.

- [ ] **Step 6: Commit**

```bash
git add src/provider-pricing.mjs test/maestro-provider-pricing.test.mjs test/maestro-cost-accounting.test.mjs package.json
git commit -m "feat(sp12c): best-effort USD price table for cost estimates"
```

---

### Task 6: Per-provider rate limiter

**Files:**
- Create: `src/provider-rate-limit.mjs`
- Test: `test/maestro-provider-rate-limit.test.mjs`
- Modify: `package.json` (append test file)
- Modify: `src/setup/server-config.mjs` (resolve optional `server.providers[*].rate_limit`)

**Interfaces:**
- Consumes: `createRateLimiter` from `src/http-rate-limit.mjs` (existing token bucket).
- Produces: `createProviderLimiter(limitsByProvider, { now? }) -> { acquire(provider): Promise<void> }` — `acquire` resolves immediately when a token is available, otherwise waits `retryAfterMs` and retries; a provider with no configured limit is always immediately allowed.

- [ ] **Step 1: Write the failing test**

Create `test/maestro-provider-rate-limit.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderLimiter } from "../src/provider-rate-limit.mjs";

test("acquire is immediate when provider has no configured limit", async () => {
  const lim = createProviderLimiter({});
  const t0 = Date.now();
  await lim.acquire("claude");
  assert.ok(Date.now() - t0 < 20);
});

test("acquire backs off when a provider's bucket is empty", async () => {
  // capacity 1, refill 1000/sec ⇒ ~1ms per token. Two back-to-back acquires:
  // first immediate, second waits ~1ms.
  const lim = createProviderLimiter({ claude: { capacity: 1, refillPerSec: 1000 } });
  await lim.acquire("claude");
  const t0 = Date.now();
  await lim.acquire("claude");
  assert.ok(Date.now() - t0 >= 1);
});

test("providers limit independently", async () => {
  const lim = createProviderLimiter({
    claude: { capacity: 1, refillPerSec: 1 },
    codex: { capacity: 1, refillPerSec: 1 },
  });
  await lim.acquire("claude");
  const t0 = Date.now();
  await lim.acquire("codex"); // codex bucket still full ⇒ immediate
  assert.ok(Date.now() - t0 < 20);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-provider-rate-limit.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the limiter**

Create `src/provider-rate-limit.mjs`:

```js
// Per-provider call limiter built on the existing token bucket. One limiter
// instance for the whole run; keyed by provider. A provider with no configured
// limit is always allowed (today's behavior). Generalizes the SP9 GitHub backoff.

import { createRateLimiter } from "./http-rate-limit.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createProviderLimiter(limitsByProvider = {}, { now = Date.now } = {}) {
  const bucket = createRateLimiter({ now });
  async function acquire(provider) {
    const limit = limitsByProvider[provider];
    if (!limit) return; // unlimited
    // Retry until a token frees up; bounded by retryAfterMs each loop.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { allowed, retryAfterMs } = bucket.check(provider, {
        capacity: limit.capacity,
        refillPerSec: limit.refillPerSec,
      });
      if (allowed) return;
      await sleep(Math.min(retryAfterMs, 1000));
    }
  }
  return { acquire };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-provider-rate-limit.test.mjs`
Expected: PASS (all 3).

- [ ] **Step 5: Resolve provider rate-limit config**

In `src/setup/server-config.mjs`, resolve an optional `server.providers` map into `{ [provider]: { capacity, refillPerSec } }` (snake_case `refill_per_sec` → camelCase). A provider without a `rate_limit` block is omitted (⇒ unlimited). Add a resolved `providers` key to the returned object and a test in `maestro-server-config.test.mjs` asserting the shape and that bad numbers throw `invalid_provider_rate_limit`.

- [ ] **Step 6: Route the GitHub backoff through the shared limiter**

Find the SP9 GitHub rate-limit backoff (search the tracker/webhook modules) and refactor it to call `acquire("github")` on a shared `createProviderLimiter` instance rather than its own ad-hoc backoff — one limiter, not two (spec §4). Run `node --test test/maestro-github-tracker.test.mjs` and confirm PASS. If the GitHub path's existing tests pin its current backoff shape, keep behavior equivalent (same effective backoff) and update assertions only where the limiter changes the mechanism, not the outcome.

- [ ] **Step 7: Register test & commit**

```bash
git add src/provider-rate-limit.mjs test/maestro-provider-rate-limit.test.mjs src/setup/server-config.mjs test/maestro-server-config.test.mjs package.json
# plus the GitHub-path file(s) touched in Step 6
git commit -m "feat(sp12c): per-provider rate limiter over shared token bucket"
```

---

### Task 7: Budget caps — validators + config (kill-switch deferred)

**Files:**
- Create: `src/budget.mjs`
- Test: `test/maestro-budget.test.mjs`
- Modify: `package.json` (append test file)
- Modify: `src/task-store.mjs` (add `ephemeral.budget` to `DEFAULT_SERVER_CONFIG` — see SP12b plan Task 1; if SP12b is not merged first, add a minimal `ephemeral: { budget: {} }` stub here and reconcile at merge)

**Interfaces:**
- Produces:
  - `validateBudget(budget, operatorBudget) -> { ok, errors }` where `errors` are `issue(code, message)` objects. Codes: `bad_budget_spec` (a field is non-positive/non-numeric), `budget_below_floor` (a run cap is below an operator floor).
  - `clampBudget(budget, operatorCeiling) -> budget` — each field clamped down to the operator ceiling when the ceiling is set and lower.
  - Budget shape: `{ tokens?, usd?, wall_clock_ms? }`, all positive numbers.

- [ ] **Step 1: Write the failing test**

Create `test/maestro-budget.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateBudget, clampBudget } from "../src/budget.mjs";

test("validateBudget accepts positive fields and an empty budget", () => {
  assert.equal(validateBudget({}, {}).ok, true);
  assert.equal(validateBudget({ tokens: 1000, usd: 5, wall_clock_ms: 60000 }, {}).ok, true);
});

test("validateBudget rejects non-positive / non-numeric fields", () => {
  const r = validateBudget({ tokens: 0 }, {});
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "bad_budget_spec");
  assert.equal(validateBudget({ usd: "x" }, {}).errors[0].code, "bad_budget_spec");
});

test("validateBudget rejects a run cap below the operator floor", () => {
  const r = validateBudget({ tokens: 100 }, { floor: { tokens: 1000 } });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "budget_below_floor");
});

test("clampBudget lowers fields to the operator ceiling", () => {
  const c = clampBudget({ tokens: 10_000 }, { tokens: 5_000 });
  assert.equal(c.tokens, 5_000);
});

test("clampBudget leaves fields under the ceiling untouched", () => {
  const c = clampBudget({ tokens: 1_000 }, { tokens: 5_000 });
  assert.equal(c.tokens, 1_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/maestro-budget.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement budget.mjs**

Create `src/budget.mjs`:

```js
// Per-run budget validators + ceiling clamp. Pure functions, no run core.
// The breach kill-switch (cancel-on-exceed → budget_exceeded) is SP12e: it
// needs the run-request object and the live cost stream (see cost-accounting).

const FIELDS = ["tokens", "usd", "wall_clock_ms"];

function issue(code, message) {
  return { code, message };
}

export function validateBudget(budget = {}, operator = {}) {
  const errors = [];
  for (const f of FIELDS) {
    if (budget[f] === undefined || budget[f] === null) continue;
    const v = Number(budget[f]);
    if (!Number.isFinite(v) || v <= 0) {
      errors.push(issue("bad_budget_spec", `budget.${f} must be a positive number, got ${budget[f]}`));
      continue;
    }
    const floor = operator?.floor?.[f];
    if (floor !== undefined && v < Number(floor)) {
      errors.push(issue("budget_below_floor", `budget.${f} (${v}) is below operator floor (${floor})`));
    }
  }
  return { ok: errors.length === 0, errors };
}

export function clampBudget(budget = {}, ceiling = {}) {
  const out = { ...budget };
  for (const f of FIELDS) {
    const cap = ceiling?.[f];
    if (cap !== undefined && out[f] !== undefined && Number(out[f]) > Number(cap)) {
      out[f] = Number(cap);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/maestro-budget.test.mjs`
Expected: PASS (all 5).

- [ ] **Step 5: Register the test file**

Append `test/maestro-budget.test.mjs` to the `test` script in `package.json`.

- [ ] **Step 6: Commit**

```bash
git add src/budget.mjs test/maestro-budget.test.mjs package.json src/task-store.mjs
git commit -m "feat(sp12c): budget cap validators + ceiling clamp (kill-switch deferred to sp12e)"
```

---

### Task 8: Full-suite regression + docs note

**Files:**
- Modify: `docs/configuration.md` (document `agent.max_concurrent_roles`, `server.providers[*].rate_limit`, and the `budget` shape)

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS — all listed test files green, including the 6 new ones.

- [ ] **Step 2: Document the new config**

Add a short subsection to `docs/configuration.md` covering `agent.max_concurrent_roles` (default 4), per-provider `rate_limit { capacity, refill_per_sec }`, and the run `budget { tokens, usd, wall_clock_ms }` shape (note: enforcement of budget breach lands in a later release).

- [ ] **Step 3: Update the knowledge graph**

Run: `graphify update .`

- [ ] **Step 4: Commit**

```bash
git add docs/configuration.md graphify-out
git commit -m "docs(sp12c): document concurrency, rate-limit, and budget config"
```

---

## Deferred to SP12e (0.4.3) — NOT in this plan

- **Budget kill-switch:** subscribe a live run to the `cost_update` stream + a wall-clock timer; on first cap breach, cancel via the SP10b path, set `budget_exceeded` terminal status, write partial handoffs. Needs the ephemeral run-request object that SP12e owns. (spec §5, §7, §8)

---

## Self-Review

- **Spec coverage:** §2 concurrency cap → Tasks 1+3; §3 cost accounting → Task 4; §4 rate limiter → Task 6; §5 budget validators → Task 7; §5 kill-switch → explicitly deferred (Deferred section); §6 error codes → Tasks 4/7; §9 testing → each task's tests + Task 8. ✅
- **Placeholder scan:** Task 3 Step 1 intentionally describes the test against the existing harness rather than inventing a fixture API that may not match the file — the implementer reads `test/maestro-parallel-graph.test.mjs`'s existing helpers; this is the one place the exact harness is file-local. All other steps carry complete code.
- **Type consistency:** `accumulateCost(prev, step)` shape used in Task 4 matches Task 5's `priceFor(provider, model, tokens)`; `validateBudget`/`clampBudget` signatures consistent between Task 7 interface and impl; `runPool(items, limit, fn)` consistent Tasks 2↔3.
