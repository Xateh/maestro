// Canonical named JSON Schemas (draft 2020-12), one per pipeline stage.
//
// Each schema is permissive on optional detail (`additionalProperties: true`)
// but strict on required keys, value types and enums. Agents may add fields
// without failing validation. Names are stable — later sub-projects reference
// them from workflow manifests (`output_schema: "<name>"`).

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

const strArray = { type: "array", items: { type: "string" } };
const anyArray = { type: "array" };
const unit = { type: "number", minimum: 0, maximum: 1 };

export const SCHEMA_DEFINITIONS = {
  implementation: {
    $schema: DRAFT,
    $id: "maestro:implementation",
    type: "object",
    additionalProperties: true,
    required: ["summary", "files_changed", "assumptions", "risks"],
    properties: {
      summary: { type: "string" },
      files_changed: strArray,
      assumptions: strArray,
      risks: strArray,
    },
  },
  static_analysis: {
    $schema: DRAFT,
    $id: "maestro:static_analysis",
    type: "object",
    additionalProperties: true,
    required: ["findings", "tool_results"],
    properties: {
      findings: anyArray,
      tool_results: anyArray,
    },
  },
  review: {
    $schema: DRAFT,
    $id: "maestro:review",
    type: "object",
    additionalProperties: true,
    required: ["severity", "findings", "recommendations"],
    properties: {
      severity: { type: "string", enum: ["none", "low", "medium", "high", "critical"] },
      findings: anyArray,
      recommendations: anyArray,
    },
  },
  threat_model: {
    $schema: DRAFT,
    $id: "maestro:threat_model",
    type: "object",
    additionalProperties: true,
    required: ["threats", "mitigations"],
    properties: {
      threats: anyArray,
      mitigations: anyArray,
    },
  },
  edge_cases: {
    $schema: DRAFT,
    $id: "maestro:edge_cases",
    type: "object",
    additionalProperties: true,
    required: ["edge_cases"],
    properties: {
      edge_cases: anyArray,
    },
  },
  tests: {
    $schema: DRAFT,
    $id: "maestro:tests",
    type: "object",
    additionalProperties: true,
    required: ["tests_created", "coverage_targets"],
    properties: {
      tests_created: anyArray,
      coverage_targets: anyArray,
    },
  },
  evaluation: {
    $schema: DRAFT,
    $id: "maestro:evaluation",
    type: "object",
    additionalProperties: true,
    required: ["pass_rate", "failures", "coverage"],
    properties: {
      pass_rate: unit,
      failures: anyArray,
      coverage: { type: "object" },
    },
  },
  regression: {
    $schema: DRAFT,
    $id: "maestro:regression",
    type: "object",
    additionalProperties: true,
    required: ["regressions_run", "new_failures", "promoted_tests"],
    properties: {
      regressions_run: anyArray,
      new_failures: anyArray,
      promoted_tests: anyArray,
    },
  },
  scoring: {
    $schema: DRAFT,
    $id: "maestro:scoring",
    type: "object",
    additionalProperties: true,
    required: [
      "correctness_score",
      "review_score",
      "security_score",
      "test_score",
      "regression_score",
      "overall_confidence",
    ],
    properties: {
      correctness_score: unit,
      review_score: unit,
      security_score: unit,
      test_score: unit,
      regression_score: unit,
      overall_confidence: unit,
    },
  },
  classification: {
    $schema: DRAFT,
    $id: "maestro:classification",
    type: "object",
    additionalProperties: true,
    required: ["event", "rationale"],
    properties: {
      event: { type: "string", enum: ["bug", "feature", "clarify"] },
      rationale: { type: "string" },
    },
  },
  research: {
    $schema: DRAFT,
    $id: "maestro:research",
    type: "object",
    additionalProperties: true,
    required: ["findings", "sources"],
    properties: {
      findings: anyArray,
      sources: anyArray,
    },
  },
  stage_event: {
    $schema: DRAFT,
    $id: "maestro:stage_event",
    type: "object",
    additionalProperties: true,
    required: [
      "workflow_id",
      "stage",
      "model",
      "tokens",
      "duration_ms",
      "status",
      "artifacts",
    ],
    properties: {
      workflow_id: { type: "string" },
      stage: { type: "string" },
      model: { type: "string" },
      tokens: { type: "number" },
      duration_ms: { type: "number" },
      status: { type: "string" },
      artifacts: anyArray,
    },
  },
};

// Stable order (insertion order of the object literal above).
export const SCHEMA_NAMES = Object.keys(SCHEMA_DEFINITIONS);
