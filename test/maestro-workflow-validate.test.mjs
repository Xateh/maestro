import assert from "node:assert/strict";
import { test } from "node:test";

import { validateWorkflow, formatValidation } from "../src/workflow-validate.mjs";
import { DEFAULT_WORKFLOW } from "../src/task-store.mjs";

// Minimal valid v2 base; callers override roles/transitions as needed.
function baseWorkflow(roles, extra = {}) {
  const names = Object.keys(roles);
  const transitions = {};
  for (const n of names) transitions[n] = { done: "$complete", error: "$halt" };
  return {
    version: 2,
    initial: names[0],
    roles,
    transitions,
    ...extra,
  };
}

function codes(result) {
  return [...result.errors, ...result.warnings].map((i) => i.code);
}

test("unknown output_schema name → unknown_output_schema error", () => {
  const wf = baseWorkflow({ executor: { provider: "codex", output_schema: "nope" } });
  const result = validateWorkflow(wf);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("unknown_output_schema"));
});

test("inline output_schema that fails ajv compile → bad_output_schema error", () => {
  const wf = baseWorkflow({
    executor: { provider: "codex", output_schema: { type: "not-a-real-type" } },
  });
  const result = validateWorkflow(wf);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("bad_output_schema"));
});

test("valid inline output_schema compiles → no schema error", () => {
  const wf = baseWorkflow({
    executor: { provider: "codex", output_schema: { type: "object" } },
  });
  const result = validateWorkflow(wf);
  assert.ok(!codes(result).includes("bad_output_schema"));
  assert.ok(!codes(result).includes("unknown_output_schema"));
});

test("non-string / absolute / escaping output_schema_ref → bad_output_schema (no existence check)", () => {
  const abs = validateWorkflow(baseWorkflow({
    executor: { provider: "codex", output_schema_ref: "/etc/passwd" },
  }));
  assert.ok(codes(abs).includes("bad_output_schema"));

  const escaping = validateWorkflow(baseWorkflow({
    executor: { provider: "codex", output_schema_ref: "../outside.json" },
  }));
  assert.ok(codes(escaping).includes("bad_output_schema"));

  const notString = validateWorkflow(baseWorkflow({
    executor: { provider: "codex", output_schema_ref: 5 },
  }));
  assert.ok(codes(notString).includes("bad_output_schema"));

  // A plain relative path is fine (existence NOT checked here).
  const okRef = validateWorkflow(baseWorkflow({
    executor: { provider: "codex", output_schema_ref: "schemas/custom.json" },
  }));
  assert.ok(!codes(okRef).includes("bad_output_schema"));
});

test("bad gates → bad_gates error (unknown key, ranges, non-bool flags)", () => {
  const unknownKey = validateWorkflow(baseWorkflow(
    { executor: { provider: "codex" } },
    { gates: { totally_unknown: 1 } },
  ));
  assert.ok(codes(unknownKey).includes("bad_gates"));

  const badCoverage = validateWorkflow(baseWorkflow(
    { executor: { provider: "codex" } },
    { gates: { min_coverage: 150 } },
  ));
  assert.ok(codes(badCoverage).includes("bad_gates"));

  const badConfidence = validateWorkflow(baseWorkflow(
    { executor: { provider: "codex" } },
    { gates: { min_overall_confidence: 2 } },
  ));
  assert.ok(codes(badConfidence).includes("bad_gates"));

  const badFlag = validateWorkflow(baseWorkflow(
    { executor: { provider: "codex" } },
    { gates: { no_high_severity_findings: "yes" } },
  ));
  assert.ok(codes(badFlag).includes("bad_gates"));
});

test("valid gates → no bad_gates", () => {
  const wf = baseWorkflow(
    { executor: { provider: "codex" } },
    {
      gates: {
        min_coverage: 90,
        no_high_severity_findings: true,
        all_regressions_pass: true,
        min_overall_confidence: 0.8,
      },
    },
  );
  const result = validateWorkflow(wf);
  assert.ok(!codes(result).includes("bad_gates"));
});

test("verifier-named role with no resolvable schema → missing_output_schema warning", () => {
  const wf = baseWorkflow({ review: { provider: "codex" } });
  const result = validateWorkflow(wf);
  assert.ok(result.warnings.map((w) => w.code).includes("missing_output_schema"));
  // Still ok (it is only a warning).
  assert.equal(result.ok, true);
});

test("verifier-named role with a schema → no missing_output_schema", () => {
  const wf = baseWorkflow({ review: { provider: "codex", output_schema: "review" } });
  const result = validateWorkflow(wf);
  assert.ok(!result.warnings.map((w) => w.code).includes("missing_output_schema"));
});

test("v1 workflow → ok with no new codes", () => {
  const wf = {
    version: 1,
    initial: "executor",
    roles: { executor: { provider: "codex" } },
    transitions: { executor: { done: "$complete", error: "$halt" } },
  };
  const result = validateWorkflow(wf);
  const all = codes(result);
  for (const code of [
    "unknown_output_schema",
    "bad_output_schema",
    "bad_gates",
    "missing_output_schema",
  ]) {
    assert.ok(!all.includes(code), `unexpected ${code}`);
  }
});

test("DEFAULT_WORKFLOW (v2) validates with zero issues", () => {
  const result = validateWorkflow(DEFAULT_WORKFLOW);
  assert.deepEqual(result, { ok: true, errors: [], warnings: [] });
});

test("formatValidation surfaces unknown_output_schema verbatim", () => {
  const wf = baseWorkflow({ executor: { provider: "codex", output_schema: "nope" } });
  const text = formatValidation(validateWorkflow(wf));
  assert.ok(text.includes("unknown_output_schema"));
});
