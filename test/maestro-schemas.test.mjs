import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getSchema,
  listSchemas,
  validatePayload,
  validateInline,
  resolveRoleSchema,
  emptyPayloadForSchema,
  schemaSkeleton,
} from "../src/schemas/index.mjs";

const EXPECTED_NAMES = [
  "implementation",
  "static_analysis",
  "review",
  "threat_model",
  "edge_cases",
  "tests",
  "evaluation",
  "regression",
  "scoring",
  "stage_event",
];

test("listSchemas returns the 10 canonical names in stable order", () => {
  assert.deepEqual(listSchemas(), EXPECTED_NAMES);
});

test("getSchema returns the schema for a known name and null otherwise", () => {
  assert.ok(getSchema("implementation"));
  assert.equal(getSchema("nope"), null);
});

// Conformant + malformed samples per schema.
const SAMPLES = {
  implementation: {
    ok: { summary: "s", files_changed: ["a"], assumptions: [], risks: [] },
    bad: { files_changed: ["a"], assumptions: [], risks: [] }, // missing summary
  },
  static_analysis: {
    ok: { findings: [], tool_results: [] },
    bad: { findings: [] }, // missing tool_results
  },
  review: {
    ok: { severity: "high", findings: [], recommendations: [] },
    bad: { severity: "blocker", findings: [], recommendations: [] }, // bad enum
  },
  threat_model: {
    ok: { threats: [], mitigations: [] },
    bad: { threats: [] },
  },
  edge_cases: {
    ok: { edge_cases: [] },
    bad: {},
  },
  tests: {
    ok: { tests_created: [], coverage_targets: [] },
    bad: { tests_created: [] },
  },
  evaluation: {
    ok: { pass_rate: 0.5, failures: [], coverage: {} },
    bad: { pass_rate: 1.5, failures: [], coverage: {} }, // out of range
  },
  regression: {
    ok: { regressions_run: [], new_failures: [], promoted_tests: [] },
    bad: { regressions_run: [], new_failures: [] },
  },
  scoring: {
    ok: {
      correctness_score: 1,
      review_score: 0,
      security_score: 0.5,
      test_score: 0.5,
      regression_score: 0.5,
      overall_confidence: 0.9,
    },
    bad: {
      correctness_score: 2, // out of range
      review_score: 0,
      security_score: 0.5,
      test_score: 0.5,
      regression_score: 0.5,
      overall_confidence: 0.9,
    },
  },
  stage_event: {
    ok: {
      workflow_id: "wf",
      stage: "executor",
      model: "opus",
      tokens: 10,
      duration_ms: 5,
      status: "ok",
      artifacts: [],
    },
    bad: {
      workflow_id: "wf",
      stage: "executor",
      model: "opus",
      tokens: 10,
      duration_ms: 5,
      // missing status
      artifacts: [],
    },
  },
};

for (const name of EXPECTED_NAMES) {
  test(`validatePayload(${name}): conformant ok, malformed not`, () => {
    const conform = validatePayload(name, SAMPLES[name].ok);
    assert.equal(conform.ok, true, JSON.stringify(conform.errors));
    assert.deepEqual(conform.errors, []);

    const malformed = validatePayload(name, SAMPLES[name].bad);
    assert.equal(malformed.ok, false);
    assert.ok(malformed.errors.length > 0);
    for (const e of malformed.errors) {
      assert.ok(Object.hasOwn(e, "path"));
      assert.ok(typeof e.message === "string");
    }
  });
}

test("validatePayload with unknown name is not ok", () => {
  const result = validatePayload("nope", {});
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test("validateInline validates against an inline schema", () => {
  const schema = {
    type: "object",
    required: ["x"],
    properties: { x: { type: "number" } },
  };
  assert.equal(validateInline(schema, { x: 1 }).ok, true);
  const bad = validateInline(schema, { x: "no" });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
});

test("validateInline reports a compile error for a bad schema", () => {
  const result = validateInline({ type: "not-a-type" }, {});
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].message.includes("bad_schema"));
});

test("resolveRoleSchema: inline > ref > name precedence", () => {
  const inline = { type: "object" };
  // inline wins over everything
  assert.deepEqual(
    resolveRoleSchema({ output_schema: inline, output_schema_ref: "x" }),
    { name: null, schema: inline, source: "inline" },
  );
  // ref wins over name
  const ref = resolveRoleSchema({ output_schema: "review", output_schema_ref: "schemas/r.json" });
  assert.equal(ref.source, "ref");
  assert.equal(ref.schema, null);
  // name resolves
  const byName = resolveRoleSchema({ output_schema: "review" });
  assert.equal(byName.source, "name");
  assert.equal(byName.name, "review");
  assert.ok(byName.schema);
});

test("resolveRoleSchema: unknown name → source unknown, no schema", () => {
  const result = resolveRoleSchema({ output_schema: "nope" });
  assert.equal(result.source, "unknown");
  assert.equal(result.schema, null);
  assert.equal(result.name, "nope");
});

test("resolveRoleSchema: no declaration → source none", () => {
  assert.deepEqual(resolveRoleSchema({}), { name: null, schema: null, source: "none" });
});

// ── emptyPayloadForSchema (SP2) ──────────────────────────────────────────────

test("emptyPayloadForSchema fills required keys by type", () => {
  assert.deepEqual(emptyPayloadForSchema(getSchema("implementation")), {
    summary: "",
    files_changed: [],
    assumptions: [],
    risks: [],
  });
  assert.deepEqual(emptyPayloadForSchema(getSchema("evaluation")), {
    pass_rate: 0,
    failures: [],
    coverage: {},
  });
  assert.deepEqual(emptyPayloadForSchema(getSchema("static_analysis")), {
    findings: [],
    tool_results: [],
  });
  assert.deepEqual(emptyPayloadForSchema(getSchema("regression")), {
    regressions_run: [],
    new_failures: [],
    promoted_tests: [],
  });
});

test("emptyPayloadForSchema uses the first enum member for enum required keys", () => {
  assert.deepEqual(emptyPayloadForSchema(getSchema("review")), {
    severity: "none",
    findings: [],
    recommendations: [],
  });
});

test("emptyPayloadForSchema tolerates falsy / propertyless schemas", () => {
  assert.deepEqual(emptyPayloadForSchema(null), {});
  assert.deepEqual(emptyPayloadForSchema(undefined), {});
  assert.deepEqual(emptyPayloadForSchema({ required: ["x"] }), { x: "" });
});

// ── schemaSkeleton (SP2) ─────────────────────────────────────────────────────

test("schemaSkeleton emits skeleton + enum notes", () => {
  const { skeleton, enumNotes } = schemaSkeleton(getSchema("review"));
  assert.deepEqual(Object.keys(skeleton).sort(), ["findings", "recommendations", "severity"]);
  assert.ok(enumNotes.includes("severity ∈ {none,low,medium,high,critical}"));
});

test("schemaSkeleton with no enum required keys → enumNotes empty", () => {
  const { skeleton, enumNotes } = schemaSkeleton(getSchema("implementation"));
  assert.deepEqual(skeleton, emptyPayloadForSchema(getSchema("implementation")));
  assert.deepEqual(enumNotes, []);
});

test("schemaSkeleton tolerates undefined", () => {
  assert.deepEqual(schemaSkeleton(undefined), { skeleton: {}, enumNotes: [] });
});

// ── SP3 evaluation math (src/evaluation.mjs) ─────────────────────────────────

import {
  parseCommandCounts,
  computeEvaluation,
  buildEvaluationPayload,
} from "../src/evaluation.mjs";

const okResult = (over = {}) => ({ name: "c", run: "x", category: null, exit_code: 0, signal: null, timed_out: false, spawn_error: false, output_tail: "", allow_failure: false, parser: null, ...over });

test("computeEvaluation: all commands pass → pass_rate 1, no failures", () => {
  const out = computeEvaluation([okResult(), okResult()]);
  assert.equal(out.pass_rate, 1);
  assert.deepEqual(out.failures, []);
});

test("computeEvaluation: one of two fails → pass_rate 0.5 + one failure", () => {
  const out = computeEvaluation([okResult({ name: "ok" }), okResult({ name: "bad", exit_code: 1 })]);
  assert.equal(out.pass_rate, 0.5);
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].name, "bad");
  assert.equal(out.failures[0].exit_code, 1);
});

test("computeEvaluation: empty results → pass_rate 1, no failures", () => {
  const out = computeEvaluation([]);
  assert.equal(out.pass_rate, 1);
  assert.deepEqual(out.failures, []);
});

test("parseCommandCounts: passed+failed regex on '# pass 8 # fail 2' → {total:10,passed:8}", () => {
  const parser = { passed: "# pass (\\d+)", failed: "# fail (\\d+)" };
  assert.deepEqual(parseCommandCounts(parser, "# pass 8 # fail 2"), { total: 10, passed: 8, onlyTotal: false });
});

test("computeEvaluation: parser path '# pass 8 # fail 2' → 0.8 + failure with parsed", () => {
  const parser = { passed: "# pass (\\d+)", failed: "# fail (\\d+)" };
  const out = computeEvaluation([okResult({ exit_code: 1, output_tail: "# pass 8 # fail 2", parser })]);
  assert.equal(out.pass_rate, 0.8);
  assert.equal(out.failures.length, 1);
  assert.deepEqual(out.failures[0].parsed, { total: 10, passed: 8 });
});

test("computeEvaluation: parser that does not match → exit-code fallback", () => {
  const parser = { passed: "# pass (\\d+)", failed: "# fail (\\d+)" };
  // exit 0, no match → total 1 passed 1
  const pass = computeEvaluation([okResult({ output_tail: "no counts here", parser })]);
  assert.equal(pass.pass_rate, 1);
  // exit 1, no match → total 1 passed 0
  const fail = computeEvaluation([okResult({ exit_code: 1, output_tail: "no counts here", parser })]);
  assert.equal(fail.pass_rate, 0);
});

test("parseCommandCounts: only-passed parser → null (not derivable)", () => {
  assert.equal(parseCommandCounts({ passed: "ok (\\d+)" }, "ok 5"), null);
});

test("computeEvaluation: only-passed parser falls back to exit code", () => {
  const out = computeEvaluation([okResult({ exit_code: 1, output_tail: "ok 5", parser: { passed: "ok (\\d+)" } })]);
  assert.equal(out.pass_rate, 0); // null parse → exit1 → 0/1
});

test("parseCommandCounts: total regex derives total directly", () => {
  assert.deepEqual(parseCommandCounts({ total: "ran (\\d+)", failed: "fail (\\d+)" }, "ran 10 fail 3"), { total: 10, passed: 7, onlyTotal: false });
});

test("parseCommandCounts: only-total parser flags onlyTotal (provisional full pass)", () => {
  assert.deepEqual(parseCommandCounts({ total: "total (\\d+)" }, "total 10"), { total: 10, passed: 10, onlyTotal: true });
});

test("computeEvaluation: only-total parser + exit 0 → counts as full pass", () => {
  const parser = { total: "total (\\d+)" };
  const out = computeEvaluation([okResult({ output_tail: "total 10", parser })]);
  assert.equal(out.pass_rate, 1); // 10/10
  assert.deepEqual(out.failures, []);
});

test("computeEvaluation: only-total parser + non-zero exit → 0 passed AND in failures (consistent)", () => {
  const parser = { total: "total (\\d+)" };
  const out = computeEvaluation([okResult({ name: "bad", exit_code: 1, output_tail: "total 10", parser })]);
  // contributes 0 (not 10) to pass_rate: 0/10 = 0
  assert.equal(out.pass_rate, 0);
  // and is still recorded as a failure — no longer contradictory
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].name, "bad");
  assert.deepEqual(out.failures[0].parsed, { total: 10, passed: 10 });
});

test("computeEvaluation: allow_failure failing command excluded from pass_rate + failures", () => {
  const out = computeEvaluation([okResult({ name: "ok" }), okResult({ name: "flaky", exit_code: 1, allow_failure: true })]);
  assert.equal(out.pass_rate, 1);
  assert.deepEqual(out.failures, []);
});

test("computeEvaluation: round4 — 1 of 3 passing → 0.3333", () => {
  const out = computeEvaluation([
    okResult({ name: "a" }),
    okResult({ name: "b", exit_code: 1 }),
    okResult({ name: "c", exit_code: 1 }),
  ]);
  assert.equal(out.pass_rate, 0.3333);
});

test("buildEvaluationPayload: conforms to the evaluation schema + coverage always {}", () => {
  const payload = buildEvaluationPayload([okResult({ name: "ok" }), okResult({ name: "bad", exit_code: 1 })]);
  assert.deepEqual(payload.coverage, {});
  const r = validatePayload("evaluation", payload);
  assert.equal(r.ok, true);
});

test("buildEvaluationPayload: empty → vacuous pass + coverage {}", () => {
  const payload = buildEvaluationPayload([]);
  assert.equal(payload.pass_rate, 1);
  assert.deepEqual(payload.failures, []);
  assert.deepEqual(payload.coverage, {});
});

test("SP4 regression payload (with extra fields) conforms to the regression schema", () => {
  const payload = {
    regressions_run: [
      { id: "a", run: "x", category: null, exit_code: 1, signal: null, timed_out: false, passed: false, attempts: 1, output_tail: "" },
    ],
    new_failures: [
      { id: "a", run: "x", category: null, exit_code: 1, signal: null, timed_out: false, attempts: 1, output_tail: "" },
    ],
    promoted_tests: [{ id: "b", source: "evaluation.failures", run: "y", category: "unit", path: "/tmp/b.json" }],
    corpus_load_errors: [{ file: "broken.json", error: "bad" }],
    outcome: "regressions_found",
  };
  const r = validatePayload("regression", payload);
  assert.equal(r.ok, true);
});
