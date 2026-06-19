/**
 * Unit tests for the SP5 pure scoring + gate engine:
 *   src/scoring.mjs — deriveScores() + enforceGates()
 *
 * Both functions are PURE and TOTAL: no I/O, never throw. These tests cover the
 * derivation table (each formula), the never-fabricate rule (absent ⇒ 0.0 +
 * missing_evidence + score_inputs.missing), the product overall_confidence, and
 * gate enforcement (each gate passing/failing, fail-closed, false-gate skip).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveScores, enforceGates } from "../src/scoring.mjs";

// Full set of conforming upstream handoffs (all scores 1.0).
function fullHandoffs(overrides = {}) {
  return {
    evaluation: { pass_rate: 1.0, failures: [], coverage: {} },
    tests: { tests_created: ["a.test.js"], coverage_targets: [] },
    review: { severity: "none", findings: [], recommendations: [] },
    threat_model: { threats: [], mitigations: [] },
    regression: { regressions_run: [], new_failures: [], promoted_tests: [] },
    ...overrides,
  };
}

// ── deriveScores: full evidence ──────────────────────────────────────────────

test("deriveScores: full evidence yields six scores, all 1.0, no missing", () => {
  const { scores, score_inputs, missing_evidence } = deriveScores(fullHandoffs());
  assert.equal(scores.correctness_score, 1.0);
  assert.equal(scores.test_score, 1.0);
  assert.equal(scores.review_score, 1.0);
  assert.equal(scores.security_score, 1.0);
  assert.equal(scores.regression_score, 1.0);
  assert.equal(scores.overall_confidence, 1.0);
  assert.deepEqual(missing_evidence, []);
  assert.deepEqual(score_inputs.correctness_score, { from: "evaluation.pass_rate", value: 1.0 });
  assert.deepEqual(score_inputs.overall_confidence, { from: "product", value: 1.0 });
});

// ── deriveScores: review.severity enum map (all five) ────────────────────────

test("deriveScores: review.severity enum map (none/low/medium/high/critical)", () => {
  const cases = [["none", 1.0], ["low", 0.75], ["medium", 0.5], ["high", 0.25], ["critical", 0.0]];
  for (const [severity, expected] of cases) {
    const { scores, score_inputs } = deriveScores(fullHandoffs({
      review: { severity, findings: [], recommendations: [] },
    }));
    assert.equal(scores.review_score, expected, `severity ${severity}`);
    assert.deepEqual(score_inputs.review_score, { from: "review.severity", value: expected });
  }
});

// ── deriveScores: security mitigation ratio (0 / partial / full / clamp) ──────

test("deriveScores: security ratio zero (threats, no mitigations)", () => {
  const { scores } = deriveScores(fullHandoffs({
    threat_model: { threats: ["t1", "t2"], mitigations: [] },
  }));
  assert.equal(scores.security_score, 0.0);
});

test("deriveScores: security ratio partial", () => {
  const { scores } = deriveScores(fullHandoffs({
    threat_model: { threats: ["t1", "t2", "t3"], mitigations: ["m1"] },
  }));
  assert.equal(scores.security_score, 0.3333);
});

test("deriveScores: security ratio full (and over-mitigation clamps to 1)", () => {
  const { scores } = deriveScores(fullHandoffs({
    threat_model: { threats: ["t1"], mitigations: ["m1", "m2"] },
  }));
  assert.equal(scores.security_score, 1.0);
});

test("deriveScores: security vacuous-pass (no threats) ⇒ 1.0, not missing", () => {
  const { scores, missing_evidence } = deriveScores(fullHandoffs({
    threat_model: { threats: [], mitigations: [] },
  }));
  assert.equal(scores.security_score, 1.0);
  assert.ok(!missing_evidence.includes("threat_model"));
});

// ── deriveScores: regression pass ratio ──────────────────────────────────────

test("deriveScores: regression ratio (3 run, 1 failure ⇒ 0.6667)", () => {
  const { scores } = deriveScores(fullHandoffs({
    regression: { regressions_run: ["a", "b", "c"], new_failures: ["a"] },
  }));
  assert.equal(scores.regression_score, 0.6667);
});

test("deriveScores: regression vacuous-pass (empty regressions_run) ⇒ 1.0, not missing", () => {
  const { scores, missing_evidence } = deriveScores(fullHandoffs({
    regression: { regressions_run: [], new_failures: [] },
  }));
  assert.equal(scores.regression_score, 1.0);
  assert.ok(!missing_evidence.includes("regression"));
});

// ── deriveScores: test_score presence (F1) ───────────────────────────────────

test("deriveScores: test_score non-empty array ⇒ 1.0", () => {
  const { scores, missing_evidence } = deriveScores(fullHandoffs({
    tests: { tests_created: ["x"], coverage_targets: [] },
  }));
  assert.equal(scores.test_score, 1.0);
  assert.ok(!missing_evidence.includes("tests"));
});

test("deriveScores: test_score EMPTY array ⇒ 0.0 and NOT flagged missing (F1)", () => {
  const { scores, score_inputs, missing_evidence } = deriveScores(fullHandoffs({
    tests: { tests_created: [], coverage_targets: [] },
  }));
  assert.equal(scores.test_score, 0.0);
  assert.ok(!missing_evidence.includes("tests"), "empty array is evidence, not missing");
  assert.deepEqual(score_inputs.test_score, { from: "tests.tests_created", value: 0 });
});

test("deriveScores: test_score absent handoff ⇒ 0.0 + missing", () => {
  const h = fullHandoffs();
  delete h.tests;
  const { scores, score_inputs, missing_evidence } = deriveScores(h);
  assert.equal(scores.test_score, 0.0);
  assert.ok(missing_evidence.includes("tests"));
  assert.equal(score_inputs.test_score.missing, true);
});

test("deriveScores: test_score non-array field ⇒ 0.0 + missing", () => {
  const { scores, missing_evidence } = deriveScores(fullHandoffs({
    tests: { tests_created: "nope", coverage_targets: [] },
  }));
  assert.equal(scores.test_score, 0.0);
  assert.ok(missing_evidence.includes("tests"));
});

// ── deriveScores: correctness = pass_rate ────────────────────────────────────

test("deriveScores: correctness_score = evaluation.pass_rate directly", () => {
  const { scores, score_inputs } = deriveScores(fullHandoffs({
    evaluation: { pass_rate: 0.8, failures: [], coverage: {} },
  }));
  assert.equal(scores.correctness_score, 0.8);
  assert.deepEqual(score_inputs.correctness_score, { from: "evaluation.pass_rate", value: 0.8 });
});

// ── deriveScores: never-fabricate (omit threat_model) ────────────────────────

test("deriveScores: omit threat_model ⇒ security 0.0 + missing + overall 0 (product)", () => {
  const h = fullHandoffs();
  delete h.threat_model;
  const { scores, score_inputs, missing_evidence } = deriveScores(h);
  assert.equal(scores.security_score, 0.0);
  assert.ok(missing_evidence.includes("threat_model"));
  assert.equal(score_inputs.security_score.missing, true);
  assert.equal(score_inputs.security_score.value, 0);
  assert.equal(scores.overall_confidence, 0.0, "any zeroed axis zeroes the product");
});

// ── deriveScores: product math ───────────────────────────────────────────────

test("deriveScores: overall_confidence is the product of the five sub-scores", () => {
  const { scores } = deriveScores(fullHandoffs({
    evaluation: { pass_rate: 0.5, failures: [], coverage: {} },
    review: { severity: "medium", findings: [], recommendations: [] }, // 0.5
  }));
  // 0.5 (correctness) * 0.5 (review) * 1 * 1 * 1 = 0.25
  assert.equal(scores.overall_confidence, 0.25);
});

// ── deriveScores: totality (garbage input never throws) ──────────────────────

test("deriveScores: garbage / empty / null input never throws, all 0", () => {
  for (const bad of [undefined, null, {}, "x", 42, [], { evaluation: 5, review: null }]) {
    assert.doesNotThrow(() => deriveScores(bad), `input ${JSON.stringify(bad)}`);
    const { scores } = deriveScores(bad);
    assert.equal(scores.overall_confidence, 0.0);
  }
});

// ── enforceGates: no gates ⇒ passed ──────────────────────────────────────────

test("enforceGates: absent/empty gates ⇒ passed, empty evaluated + reasons", () => {
  for (const g of [undefined, null, {}]) {
    const r = enforceGates(g, { overall_confidence: 0.0 }, {});
    assert.equal(r.passed, true);
    assert.deepEqual(r.evaluated, {});
    assert.deepEqual(r.blocked_reasons, []);
  }
});

// ── enforceGates: min_overall_confidence ─────────────────────────────────────

test("enforceGates: min_overall_confidence pass", () => {
  const r = enforceGates({ min_overall_confidence: 0.7 }, { overall_confidence: 0.8 }, {});
  assert.equal(r.passed, true);
  assert.deepEqual(r.evaluated.min_overall_confidence, { required: 0.7, actual: 0.8, passed: true });
  assert.deepEqual(r.blocked_reasons, []);
});

test("enforceGates: min_overall_confidence fail", () => {
  const r = enforceGates({ min_overall_confidence: 0.7 }, { overall_confidence: 0.0 }, {});
  assert.equal(r.passed, false);
  assert.equal(r.evaluated.min_overall_confidence.passed, false);
  assert.deepEqual(r.blocked_reasons, ["min_overall_confidence: 0 < 0.7"]);
});

// ── enforceGates: all_regressions_pass (true / false / absent) ───────────────

test("enforceGates: all_regressions_pass true, no new failures ⇒ pass", () => {
  const r = enforceGates({ all_regressions_pass: true }, {}, {
    regression: { regressions_run: ["a"], new_failures: [] },
  });
  assert.equal(r.passed, true);
  assert.deepEqual(r.evaluated.all_regressions_pass, { required: true, actual: 0, passed: true });
});

test("enforceGates: all_regressions_pass true, has new failures ⇒ fail", () => {
  const r = enforceGates({ all_regressions_pass: true }, {}, {
    regression: { regressions_run: ["a"], new_failures: ["a"] },
  });
  assert.equal(r.passed, false);
  assert.deepEqual(r.blocked_reasons, ["all_regressions_pass: 1 new failures"]);
});

test("enforceGates: all_regressions_pass true, absent regression handoff ⇒ fail-closed", () => {
  const r = enforceGates({ all_regressions_pass: true }, {}, {});
  assert.equal(r.passed, false);
  assert.equal(r.evaluated.all_regressions_pass.passed, false);
  assert.deepEqual(r.blocked_reasons, ["all_regressions_pass: no regression evidence"]);
});

test("enforceGates: all_regressions_pass FALSE ⇒ not enforced (F2)", () => {
  const r = enforceGates({ all_regressions_pass: false }, {}, {
    regression: { regressions_run: ["a"], new_failures: ["a"] },
  });
  assert.equal(r.passed, true);
  assert.equal("all_regressions_pass" in r.evaluated, false);
  assert.deepEqual(r.blocked_reasons, []);
});

// ── enforceGates: no_high_severity_findings ──────────────────────────────────

test("enforceGates: no_high_severity_findings true, review none + no findings ⇒ pass", () => {
  const r = enforceGates({ no_high_severity_findings: true }, {}, {
    review: { severity: "none" },
    static_analysis: { findings: [] },
  });
  assert.equal(r.passed, true);
});

test("enforceGates: no_high_severity_findings true, review high ⇒ fail", () => {
  const r = enforceGates({ no_high_severity_findings: true }, {}, {
    review: { severity: "high" },
  });
  assert.equal(r.passed, false);
  assert.deepEqual(r.blocked_reasons, ["no_high_severity_findings: found high severity finding(s)"]);
});

test("enforceGates: no_high_severity_findings true, critical static_analysis finding ⇒ fail", () => {
  const r = enforceGates({ no_high_severity_findings: true }, {}, {
    review: { severity: "low" },
    static_analysis: { findings: [{ severity: "critical" }] },
  });
  assert.equal(r.passed, false);
  assert.deepEqual(r.blocked_reasons, ["no_high_severity_findings: found critical severity finding(s)"]);
});

test("enforceGates: no_high_severity_findings true, no review evidence ⇒ fail-closed", () => {
  const r = enforceGates({ no_high_severity_findings: true }, {}, {});
  assert.equal(r.passed, false);
  assert.deepEqual(r.blocked_reasons, ["no_high_severity_findings: no review evidence"]);
});

test("enforceGates: no_high_severity_findings FALSE ⇒ not enforced (F2)", () => {
  const r = enforceGates({ no_high_severity_findings: false }, {}, { review: { severity: "high" } });
  assert.equal(r.passed, true);
  assert.equal("no_high_severity_findings" in r.evaluated, false);
});

// ── enforceGates: min_coverage ───────────────────────────────────────────────

test("enforceGates: min_coverage present coverage percent ⇒ pass", () => {
  const r = enforceGates({ min_coverage: 80 }, {}, {
    evaluation: { coverage: { percent: 90 } },
  });
  assert.equal(r.passed, true);
  assert.deepEqual(r.evaluated.min_coverage, { required: 80, actual: 90, passed: true });
});

test("enforceGates: min_coverage below threshold ⇒ fail", () => {
  const r = enforceGates({ min_coverage: 80 }, {}, {
    evaluation: { coverage: { lines: 50 } },
  });
  assert.equal(r.passed, false);
  assert.deepEqual(r.blocked_reasons, ["min_coverage: 50 < 80"]);
});

test("enforceGates: min_coverage with empty coverage:{} ⇒ fail-closed", () => {
  const r = enforceGates({ min_coverage: 80 }, {}, {
    evaluation: { coverage: {} },
  });
  assert.equal(r.passed, false);
  assert.equal(r.evaluated.min_coverage.actual, null);
  assert.deepEqual(r.blocked_reasons, ["min_coverage: no coverage evidence < 80"]);
});

// ── enforceGates: output_schema_conformance (B) ──────────────────────────────

test("enforceGates: output_schema_conformance true, all handoffs conform ⇒ pass", () => {
  const r = enforceGates({ output_schema_conformance: true }, {}, {}, [
    { role: "review", schema_validation: { ok: true, schema: "review" } },
    { role: "tests", schema_validation: { ok: true, schema: "tests" } },
  ]);
  assert.equal(r.passed, true);
  assert.equal(r.evaluated.output_schema_conformance.passed, true);
  assert.equal(r.evaluated.output_schema_conformance.checked, 2);
  assert.deepEqual(r.blocked_reasons, []);
});

test("enforceGates: output_schema_conformance true, one handoff violates ⇒ fail (names role)", () => {
  const r = enforceGates({ output_schema_conformance: true }, {}, {}, [
    { role: "review", schema_validation: { ok: true, schema: "review" } },
    { role: "tests", schema_validation: { ok: false, schema: "tests", errors: [{ path: "/x", message: "bad" }] } },
  ]);
  assert.equal(r.passed, false);
  assert.equal(r.evaluated.output_schema_conformance.passed, false);
  assert.deepEqual(r.evaluated.output_schema_conformance.actual, ["tests"]);
  assert.equal(r.blocked_reasons.length, 1);
  assert.match(r.blocked_reasons[0], /output_schema_conformance/);
  assert.match(r.blocked_reasons[0], /tests/);
});

test("enforceGates: output_schema_conformance ignores handoffs with no declared schema (vacuous pass)", () => {
  const r = enforceGates({ output_schema_conformance: true }, {}, {}, [
    { role: "planner", schema_validation: null },
    { role: "executor" },
  ]);
  assert.equal(r.passed, true);
  assert.equal(r.evaluated.output_schema_conformance.checked, 0);
});

test("enforceGates: output_schema_conformance true, missing handoffMeta ⇒ vacuous pass", () => {
  const r = enforceGates({ output_schema_conformance: true }, {}, {});
  assert.equal(r.passed, true);
  assert.equal(r.evaluated.output_schema_conformance.passed, true);
  assert.equal(r.evaluated.output_schema_conformance.checked, 0);
});

test("enforceGates: output_schema_conformance FALSE ⇒ not enforced", () => {
  const r = enforceGates({ output_schema_conformance: false }, {}, {}, [
    { role: "tests", schema_validation: { ok: false, schema: "tests" } },
  ]);
  assert.equal(r.passed, true);
  assert.deepEqual(r.evaluated, {});
});

// ── enforceGates: multiple gates + totality ──────────────────────────────────

test("enforceGates: multiple gates, one fails ⇒ blocked with one reason", () => {
  const r = enforceGates(
    { min_overall_confidence: 0.5, all_regressions_pass: true },
    { overall_confidence: 0.9 },
    { regression: { regressions_run: ["a"], new_failures: ["a"] } },
  );
  assert.equal(r.passed, false);
  assert.equal(r.evaluated.min_overall_confidence.passed, true);
  assert.equal(r.evaluated.all_regressions_pass.passed, false);
  assert.equal(r.blocked_reasons.length, 1);
});

test("enforceGates: garbage input never throws; unknown keys ignored", () => {
  assert.doesNotThrow(() => enforceGates({ bogus_gate: 5 }, null, undefined));
  const r = enforceGates({ bogus_gate: 5 }, null, undefined);
  assert.equal(r.passed, true);
  assert.deepEqual(r.evaluated, {});
});
