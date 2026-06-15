import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveRoleProvider,
  describeAvailabilityFailure,
} from "../src/provider-availability.mjs";
import { isUsageLimitFailure } from "../src/markers.mjs";
import { buildUnblockOptions } from "../src/cli/action-requests.mjs";
import { planRoleFallbacks } from "../src/setup/local.mjs";
import { validateWorkflow } from "../src/workflow-validate.mjs";

// Config with two providers; codex is the "primary" most roles want.
const CONFIG = {
  providers: {
    codex: { label: "Codex", adapter: "built-in:codex", default_alias: "codex", models: ["gpt-5.5", "gpt-5.4"] },
    claude: { label: "Claude", adapter: "built-in:claude", default_alias: "claude", models: ["opus", "sonnet"] },
    gemini: { label: "Gemini", adapter: "built-in:gemini", default_alias: "gemini", models: ["gemini-2.5-pro"] },
  },
};

// probe factory: available is a Set of alias strings that "resolve".
const probeFor = (available) => async (alias) => available.has(alias);

test("resolves the primary provider when its command is available", async () => {
  const res = await resolveRoleProvider({
    roleDef: { provider: "codex", model: "gpt-5.5" },
    config: CONFIG,
    probe: probeFor(new Set(["codex", "claude"])),
  });
  assert.equal(res.ok, true);
  assert.equal(res.provider, "codex");
  assert.equal(res.alias, "codex");
  assert.equal(res.model, "gpt-5.5");
  assert.equal(res.substituted, false);
  assert.equal(res.modelDefaulted, false);
});

test("falls back to the first available provider in the chain", async () => {
  const res = await resolveRoleProvider({
    roleDef: { provider: "codex", model: "gpt-5.5", fallback: ["claude"] },
    config: CONFIG,
    probe: probeFor(new Set(["claude"])), // codex missing
  });
  assert.equal(res.ok, true);
  assert.equal(res.provider, "claude");
  assert.equal(res.alias, "claude");
  assert.equal(res.substituted, true);
  // Primary's model must not carry over to a different provider.
  assert.equal(res.model, "");
});

test("reports provider_missing when nothing resolves", async () => {
  const res = await resolveRoleProvider({
    roleDef: { provider: "codex", fallback: ["claude"] },
    config: CONFIG,
    probe: probeFor(new Set()),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reasons.length, 2);
  assert.equal(res.reasons[0].code, "provider_missing");
  assert.equal(res.reasons[0].provider, "codex");
  assert.equal(res.reasons[1].provider, "claude");
});

test("alias_unresolved only when role overrides alias on the primary", async () => {
  const res = await resolveRoleProvider({
    roleDef: { provider: "codex", alias: "my-codex" },
    config: CONFIG,
    probe: probeFor(new Set(["codex"])), // the default resolves, the override does not
  });
  assert.equal(res.ok, false);
  assert.equal(res.reasons[0].code, "alias_unresolved");
  assert.equal(res.reasons[0].alias, "my-codex");
});

test("role.alias binds only the primary, not fallback providers", async () => {
  const res = await resolveRoleProvider({
    roleDef: { provider: "codex", alias: "my-codex", fallback: ["claude"] },
    config: CONFIG,
    probe: probeFor(new Set(["claude"])), // my-codex missing, claude default present
  });
  assert.equal(res.ok, true);
  assert.equal(res.provider, "claude");
  assert.equal(res.alias, "claude"); // fallback uses its own default_alias
});

test("provider_disabled when enabled:false, then honors fallback", async () => {
  const config = structuredClone(CONFIG);
  config.providers.codex.enabled = false;
  const res = await resolveRoleProvider({
    roleDef: { provider: "codex", fallback: ["claude"] },
    config,
    probe: probeFor(new Set(["codex", "claude"])), // codex installed but disabled
  });
  assert.equal(res.ok, true);
  assert.equal(res.provider, "claude");

  const blocked = await resolveRoleProvider({
    roleDef: { provider: "codex" },
    config,
    probe: probeFor(new Set(["codex"])),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reasons[0].code, "provider_disabled");
});

test("model unavailable on an available primary drops to the provider default", async () => {
  const res = await resolveRoleProvider({
    roleDef: { provider: "codex", model: "gpt-9-nope" },
    config: CONFIG,
    probe: probeFor(new Set(["codex"])),
  });
  assert.equal(res.ok, true);
  assert.equal(res.provider, "codex");
  assert.equal(res.model, ""); // dropped to default
  assert.equal(res.modelDefaulted, true);
});

test("unknown_provider when the chain references an unconfigured key", async () => {
  const res = await resolveRoleProvider({
    roleDef: { provider: "nope" },
    config: CONFIG,
    probe: probeFor(new Set(["codex"])),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reasons[0].code, "unknown_provider");
});

test("describeAvailabilityFailure renders a distinct message per code", async () => {
  const role = "executor";
  const missing = describeAvailabilityFailure({ provider: "codex", code: "provider_missing", alias: "codex" }, { role });
  assert.match(missing, /not installed/i);
  assert.match(missing, /codex/);

  const alias = describeAvailabilityFailure({ provider: "codex", code: "alias_unresolved", alias: "my-codex" }, { role });
  assert.match(alias, /my-codex/);
  assert.match(alias, /executor/);

  const disabled = describeAvailabilityFailure({ provider: "codex", code: "provider_disabled" }, { role });
  assert.match(disabled, /disabled/i);

  const model = describeAvailabilityFailure(
    { provider: "codex", code: "model_unavailable", model: "gpt-9", available: ["gpt-5.5"] },
    { role },
  );
  assert.match(model, /gpt-9/);
  assert.match(model, /gpt-5\.5/);

  const unknown = describeAvailabilityFailure({ provider: "nope", code: "unknown_provider" }, { role });
  assert.match(unknown, /not configured/i);

  const usage = describeAvailabilityFailure({ provider: "codex", code: "usage_limited" }, { role });
  assert.match(usage, /usage|quota|limit/i);
});

test("isUsageLimitFailure flags rate/usage/quota/credit errors, not generic ones", () => {
  const positives = [
    "Error: rate limit exceeded",
    "You have hit your usage limit for today",
    "quota exceeded for this project",
    "429 Too Many Requests",
    "insufficient credits remaining",
    "you are out of tokens",
    "You've reached your monthly limit",
  ];
  for (const text of positives) {
    assert.equal(isUsageLimitFailure({ stderr: text }), true, text);
  }
  const negatives = ["command not found", "context window exceeded", "syntax error near unexpected token"];
  for (const text of negatives) {
    assert.equal(isUsageLimitFailure({ stderr: text }), false, text);
  }
  assert.equal(isUsageLimitFailure({ message: "429 rate limit" }), true);
  assert.equal(isUsageLimitFailure({}), false);
});

test("buildUnblockOptions surfaces switch/skip for availability blockers", () => {
  const task = { id: "t1", blockers: [{ code: "provider_missing", role: "executor" }] };
  const types = buildUnblockOptions({ task, includeRetry: true }).map((o) => o.type);
  assert.ok(types.includes("switch_provider"));
  assert.ok(types.includes("skip_role"));
  assert.ok(types.includes("retry"));
  assert.ok(!types.includes("approve_substitution"));
});

test("buildUnblockOptions surfaces approve_substitution for a pending substitution", () => {
  const task = { id: "t2", blockers: [{ code: "provider_substitution_pending", role: "executor", to: "claude" }] };
  const types = buildUnblockOptions({ task }).map((o) => o.type);
  assert.ok(types.includes("approve_substitution"));
  assert.ok(types.includes("switch_provider"));
  assert.ok(types.includes("skip_role"));
});

test("buildUnblockOptions omits availability options for unrelated blockers", () => {
  const task = { id: "t3", blockers: [{ code: "agent_timeout" }] };
  const types = buildUnblockOptions({ task, includeRetry: true }).map((o) => o.type);
  assert.ok(!types.includes("switch_provider"));
  assert.ok(!types.includes("skip_role"));
  assert.ok(!types.includes("approve_substitution"));
});

test("planRoleFallbacks proposes installed providers for missing-provider roles", () => {
  const workflow = {
    roles: {
      planner: { provider: "claude" },
      executor: { provider: "codex" },
      reviewer: { provider: "codex", fallback: ["claude"] },
    },
  };
  const results = [
    { provider: "claude", found: true },
    { provider: "codex", found: false },
    { provider: "gemini", found: true },
  ];
  const plans = planRoleFallbacks(workflow, results);
  // planner(claude) is installed → no plan. reviewer already has installed
  // fallback(claude) → no plan. executor(codex) missing, no covered fallback.
  assert.equal(plans.length, 1);
  assert.equal(plans[0].role, "executor");
  assert.deepEqual(plans[0].candidates.sort(), ["claude", "gemini"]);
});

test("validateWorkflow flags bad and unknown fallback entries", () => {
  const config = { providers: { codex: {}, claude: {} } };
  const bad = validateWorkflow({
    initial: "executor",
    roles: { executor: { provider: "codex", fallback: "claude" } },
    transitions: { executor: { done: "$complete" } },
  }, { config });
  assert.ok(bad.errors.some((e) => e.code === "bad_fallback"));

  const unknown = validateWorkflow({
    initial: "executor",
    roles: { executor: { provider: "codex", fallback: ["nope"] } },
    transitions: { executor: { done: "$complete" } },
  }, { config });
  assert.ok(unknown.warnings.some((w) => w.code === "unknown_fallback"));
});
