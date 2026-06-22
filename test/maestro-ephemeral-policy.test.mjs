import assert from "node:assert/strict";
import { test } from "node:test";
import { matchCommand, gatesAreWeaker, validateEphemeralPolicy } from "../src/ephemeral-policy.mjs";

test("matchCommand exact match (whitespace-normalized)", () => {
  assert.equal(matchCommand("npm test", ["npm test"]), true);
  assert.equal(matchCommand("npm  test", ["npm test"]), true);
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
  assert.deepEqual(gatesAreWeaker(
    { min_coverage: 90, require_distinct_reviewer: true },
    { min_coverage: 80, require_distinct_reviewer: true },
  ), []);
});

test("gatesAreWeaker ignores gates the baseline does not pin", () => {
  assert.deepEqual(gatesAreWeaker({ min_coverage: 10 }, {}), []);
});

test("validateEphemeralPolicy rejects disabled policy as ephemeral_disabled", () => {
  const result = validateEphemeralPolicy(
    {},
    { enabled: false },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.code), ["ephemeral_disabled"]);
});

test("validateEphemeralPolicy accepts a compliant workflow under policy", () => {
  const result = validateEphemeralPolicy(
    {
      parallel_groups: [["a", "b"]],
      roles: {
        a: { kind: "command", provider: "claude", commands: [{ name: "test", run: "npm test" }] },
        b: { kind: "command", provider: "claude", commands: [{ name: "lint", run: "npm run lint" }] },
      },
      gates: { require_distinct_reviewer: true, min_coverage: 80 },
    },
    {
      enabled: true,
      commandAllowlist: ["npm test", "npm run lint"],
      providerAllowlist: ["claude"],
      maxFanout: 2,
      gateRelaxation: "forbid",
      baselineGates: { require_distinct_reviewer: true, min_coverage: 70 },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateEphemeralPolicy gates commands on agent-kind roles too (no kind bypass)", () => {
  const result = validateEphemeralPolicy(
    {
      roles: {
        // agent-kind role (no kind: "command") that still declares a shell command
        impl: { provider: "claude", commands: [{ name: "danger", run: "rm -rf /" }] },
      },
    },
    {
      enabled: true,
      commandAllowlist: ["npm test"],
      providerAllowlist: ["claude"],
      maxFanout: 4,
      baselineGates: {},
    },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.code), ["command_not_allowlisted"]);
});

test("validateEphemeralPolicy reports command_not_allowlisted", () => {
  const result = validateEphemeralPolicy(
    {
      roles: {
        impl: { kind: "command", commands: [{ name: "lint", run: "npm run lint --fix" }] },
      },
    },
    {
      enabled: true,
      commandAllowlist: ["npm test"],
      providerAllowlist: [],
      maxFanout: 4,
      baselineGates: {},
    },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.code), ["command_not_allowlisted"]);
});

test("validateEphemeralPolicy reports provider_not_allowlisted", () => {
  const result = validateEphemeralPolicy(
    {
      roles: {
        impl: { kind: "command", provider: "external", commands: [{ name: "test", run: "npm test" }] },
      },
    },
    {
      enabled: true,
      commandAllowlist: ["npm test"],
      providerAllowlist: ["claude"],
      maxFanout: 4,
      baselineGates: {},
    },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.code), ["provider_not_allowlisted"]);
});

test("validateEphemeralPolicy reports fanout_exceeds_cap", () => {
  const result = validateEphemeralPolicy(
    {
      parallel_groups: [["a", "b", "c"]],
      roles: {
        a: { kind: "command", provider: "claude", commands: [{ name: "a", run: "npm test" }] },
        b: { kind: "command", provider: "claude", commands: [{ name: "b", run: "npm test" }] },
        c: { kind: "command", provider: "claude", commands: [{ name: "c", run: "npm test" }] },
      },
    },
    {
      enabled: true,
      commandAllowlist: ["npm test"],
      providerAllowlist: ["claude"],
      maxFanout: 2,
      baselineGates: {},
    },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.code), ["fanout_exceeds_cap"]);
});

test("validateEphemeralPolicy fails closed when maxFanout is absent/non-finite", () => {
  const result = validateEphemeralPolicy(
    { parallel_groups: [["a", "b"]], roles: {} },
    { enabled: true, commandAllowlist: [], providerAllowlist: [], baselineGates: {} },
  );
  // No usable cap ⇒ no fan-out permitted (must not silently pass via `> NaN`).
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.code), ["fanout_exceeds_cap"]);
});

test("validateEphemeralPolicy reports gate_relaxation_forbidden", () => {
  const result = validateEphemeralPolicy(
    {
      roles: {
        impl: { kind: "command", commands: [{ name: "test", run: "npm test" }] },
      },
      gates: { require_distinct_reviewer: false, min_coverage: 40 },
    },
    {
      enabled: true,
      commandAllowlist: ["npm test"],
      providerAllowlist: [],
      maxFanout: 4,
      gateRelaxation: "forbid",
      baselineGates: { require_distinct_reviewer: true, min_coverage: 80 },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every((e) => e.code === "gate_relaxation_forbidden"));
});

test("validateEphemeralPolicy returns all errors", () => {
  const result = validateEphemeralPolicy(
    {
      parallel_groups: [["a", "b", "c"]],
      roles: {
        a: { kind: "command", provider: "claude", commands: [{ name: "test", run: "npm run lint" }] },
        b: { kind: "command", provider: "mistral", commands: [{ name: "lint", run: "npm run lint" }] },
      },
      gates: { require_distinct_reviewer: false },
    },
    {
      enabled: true,
      commandAllowlist: ["npm test"],
      providerAllowlist: ["codex"],
      maxFanout: 2,
      gateRelaxation: "forbid",
      baselineGates: { require_distinct_reviewer: true },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 6);
  const codes = result.errors.map((e) => e.code);
  assert.equal(codes.filter((code) => code === "command_not_allowlisted").length, 2);
  assert.equal(codes.filter((code) => code === "provider_not_allowlisted").length, 2);
  assert.equal(codes.filter((code) => code === "fanout_exceeds_cap").length, 1);
  assert.equal(codes.filter((code) => code === "gate_relaxation_forbidden").length, 1);
});
