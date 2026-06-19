// Pure reliability scoring + gate enforcement for the SP5 kind:"scoring" stage.
//
// Maps the accumulated upstream stage handoffs into the SP1 `scoring` schema
// payload (six unit scores) and enforces the manifest's declared `gates:`. No
// I/O, no imports — it only consumes the in-memory handoffs-by-role map, making
// it trivially unit-testable.
//
// NEVER FABRICATE CONFIDENCE: every sub-score is a pure function of a specific
// upstream field. When the evidence is absent (handoff missing OR field of the
// wrong type), the sub-score is 0.0, the role is named in `missing_evidence`, and
// `score_inputs[score].missing` is true — a 0 from absence stays distinguishable
// from a 0 from bad results. A vacuous-pass (e.g. empty `regressions_run`) is
// 1.0 and NOT flagged missing — it is real evidence of "nothing to fail."
//
// Both exports are PURE and TOTAL — they never throw; absent/garbage inputs are
// handled by the rules below (absent evidence ⇒ 0.0; gate with no evidence ⇒
// fail-closed).

// Stable 4-decimal precision, matching SP3 (round4 = Math.round(x*1e4)/1e4).
function round4(x) {
  return Math.round(x * 1e4) / 1e4;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function isNum(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function arr(x) {
  return Array.isArray(x) ? x : null;
}

// review.severity enum → unit score.
const SEVERITY_MAP = { none: 1.0, low: 0.75, medium: 0.5, high: 0.25, critical: 0.0 };
const HIGH_SEVERITIES = new Set(["high", "critical"]);

/**
 * Derive the six SP1 `scoring` numbers from the prior stage handoffs.
 *
 * @param {Object} handoffsByRole - { <role>: <payload> } (absent role ⇒ undefined).
 * @returns {{scores:Object, score_inputs:Object, missing_evidence:string[]}}
 */
export function deriveScores(handoffsByRole) {
  const byRole = handoffsByRole && typeof handoffsByRole === "object" ? handoffsByRole : {};
  const scores = {};
  const scoreInputs = {};
  const missing = [];

  // correctness_score ← evaluation.pass_rate (the unit directly)
  {
    const passRate = byRole.evaluation?.pass_rate;
    if (isNum(passRate)) {
      const v = round4(clamp01(passRate));
      scores.correctness_score = v;
      scoreInputs.correctness_score = { from: "evaluation.pass_rate", value: v };
    } else {
      scores.correctness_score = 0.0;
      scoreInputs.correctness_score = { from: "evaluation.pass_rate", value: 0, missing: true };
      missing.push("evaluation");
    }
  }

  // test_score ← tests.tests_created (presence of authored tests; empty = 0.0 NOT missing)
  {
    const created = arr(byRole.tests?.tests_created);
    if (created !== null) {
      const v = created.length > 0 ? 1.0 : 0.0;
      scores.test_score = v;
      scoreInputs.test_score = { from: "tests.tests_created", value: v };
    } else {
      scores.test_score = 0.0;
      scoreInputs.test_score = { from: "tests.tests_created", value: 0, missing: true };
      missing.push("tests");
    }
  }

  // review_score ← review.severity (enum map)
  {
    const severity = byRole.review?.severity;
    if (typeof severity === "string" && severity in SEVERITY_MAP) {
      const v = SEVERITY_MAP[severity];
      scores.review_score = v;
      scoreInputs.review_score = { from: "review.severity", value: v };
    } else {
      scores.review_score = 0.0;
      scoreInputs.review_score = { from: "review.severity", value: 0, missing: true };
      missing.push("review");
    }
  }

  // security_score ← threat_model.{threats,mitigations} (mitigation ratio)
  {
    const threats = arr(byRole.threat_model?.threats);
    const mitigations = arr(byRole.threat_model?.mitigations);
    if (threats !== null && mitigations !== null) {
      const v = threats.length === 0 ? 1.0 : round4(clamp01(mitigations.length / threats.length));
      scores.security_score = v;
      scoreInputs.security_score = { from: "threat_model", value: v };
    } else {
      scores.security_score = 0.0;
      scoreInputs.security_score = { from: "threat_model", value: 0, missing: true };
      missing.push("threat_model");
    }
  }

  // regression_score ← regression.{regressions_run,new_failures} (pass ratio)
  {
    const run = arr(byRole.regression?.regressions_run);
    const newFailures = arr(byRole.regression?.new_failures);
    if (run !== null && newFailures !== null) {
      const v = run.length === 0
        ? 1.0
        : round4(clamp01((run.length - newFailures.length) / run.length));
      scores.regression_score = v;
      scoreInputs.regression_score = { from: "regression", value: v };
    } else {
      scores.regression_score = 0.0;
      scoreInputs.regression_score = { from: "regression", value: 0, missing: true };
      missing.push("regression");
    }
  }

  // overall_confidence ← product of the five (any zeroed axis drives it to 0)
  {
    const v = round4(
      scores.correctness_score
        * scores.review_score
        * scores.security_score
        * scores.test_score
        * scores.regression_score,
    );
    scores.overall_confidence = v;
    scoreInputs.overall_confidence = { from: "product", value: v };
  }

  return { scores, score_inputs: scoreInputs, missing_evidence: missing };
}

// First numeric coverage percent of evaluation.coverage.{percent,lines,total}.
function coveragePercent(evidence) {
  const cov = evidence?.evaluation?.coverage;
  if (!cov || typeof cov !== "object") return null;
  for (const key of ["percent", "lines", "total"]) {
    if (isNum(cov[key])) return cov[key];
  }
  return null;
}

/**
 * Enforce the manifest's declared `gates:` against the derived scores + raw
 * evidence. Only present gate keys are enforced; a `false`-valued bool gate is
 * NOT enforced (omitted from `evaluated` and `blocked_reasons`). A gate with no
 * evidence fails closed.
 *
 * @param {Object} gates    - manifest gates block ({} / absent ⇒ no enforcement).
 * @param {Object} scores   - derived scores from deriveScores.
 * @param {Object} evidence - handoffsByRole (raw upstream payloads).
 * @param {Array}  handoffMeta - per-handoff `{role, schema_validation}` records
 *   (for the output_schema_conformance gate); defaults to [].
 * @returns {{passed:boolean, evaluated:Object, blocked_reasons:string[]}}
 */
export function enforceGates(gates, scores, evidence, handoffMeta = []) {
  const evaluated = {};
  const blockedReasons = [];
  const g = gates && typeof gates === "object" ? gates : {};
  const ev = evidence && typeof evidence === "object" ? evidence : {};
  const sc = scores && typeof scores === "object" ? scores : {};

  // min_coverage (percent 0–100): coverage present AND >= required; else fail-closed.
  if ("min_coverage" in g) {
    const required = g.min_coverage;
    const actual = coveragePercent(ev);
    const passed = isNum(actual) && actual >= required;
    evaluated.min_coverage = { required, actual: isNum(actual) ? actual : null, passed };
    if (!passed) {
      blockedReasons.push(`min_coverage: ${isNum(actual) ? actual : "no coverage evidence"} < ${required}`);
    }
  }

  // no_high_severity_findings (bool): only enforced when true (F2).
  if (g.no_high_severity_findings === true) {
    const severity = ev.review?.severity;
    const hasReview = typeof severity === "string" && severity in SEVERITY_MAP;
    const reviewHigh = hasReview && HIGH_SEVERITIES.has(severity);
    const findings = arr(ev.static_analysis?.findings) ?? [];
    const staticHigh = findings.find((f) => HIGH_SEVERITIES.has(f?.severity));
    // No review evidence ⇒ fail-closed.
    const passed = hasReview && !reviewHigh && staticHigh === undefined;
    const found = !hasReview
      ? "no review evidence"
      : reviewHigh
        ? severity
        : staticHigh !== undefined
          ? staticHigh.severity
          : null;
    evaluated.no_high_severity_findings = { required: true, actual: found, passed };
    if (!passed) {
      blockedReasons.push(
        hasReview
          ? `no_high_severity_findings: found ${found} severity finding(s)`
          : "no_high_severity_findings: no review evidence",
      );
    }
  }

  // all_regressions_pass (bool): only enforced when true (F2).
  if (g.all_regressions_pass === true) {
    const newFailures = arr(ev.regression?.new_failures);
    // Absent regression handoff ⇒ fail-closed.
    const passed = newFailures !== null && newFailures.length === 0;
    const n = newFailures === null ? "no regression evidence" : newFailures.length;
    evaluated.all_regressions_pass = { required: true, actual: n, passed };
    if (!passed) {
      blockedReasons.push(
        newFailures === null
          ? "all_regressions_pass: no regression evidence"
          : `all_regressions_pass: ${n} new failures`,
      );
    }
  }

  // output_schema_conformance (bool): only enforced when true. Promotes the
  // per-node soft `schema_validation` evidence into an auditable RUN verdict —
  // "every handoff that declared a schema conformed to it." Handoffs with no
  // declared schema (schema_validation null/absent) are not counted; a run with
  // zero schema-bearing handoffs passes vacuously (consistent with the file's
  // vacuous-pass rule — nothing to violate). Any single non-conforming handoff
  // blocks and names the offending role(s).
  if (g.output_schema_conformance === true) {
    const meta = Array.isArray(handoffMeta) ? handoffMeta : [];
    const validated = meta.filter((m) => m?.schema_validation);
    const violations = validated.filter((m) => m.schema_validation.ok !== true);
    const passed = violations.length === 0;
    const offenders = violations.map((m) => m.role);
    evaluated.output_schema_conformance = {
      required: true,
      checked: validated.length,
      actual: passed ? "all conforming" : offenders,
      passed,
    };
    if (!passed) {
      blockedReasons.push(
        `output_schema_conformance: ${violations.length} handoff(s) failed schema validation (${offenders.join(", ")})`,
      );
    }
  }

  // min_overall_confidence (unit 0–1): overall_confidence >= required.
  if ("min_overall_confidence" in g) {
    const required = g.min_overall_confidence;
    const actual = isNum(sc.overall_confidence) ? sc.overall_confidence : 0;
    const passed = actual >= required;
    evaluated.min_overall_confidence = { required, actual, passed };
    if (!passed) {
      blockedReasons.push(`min_overall_confidence: ${actual} < ${required}`);
    }
  }

  return { passed: blockedReasons.length === 0, evaluated, blocked_reasons: blockedReasons };
}
