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
