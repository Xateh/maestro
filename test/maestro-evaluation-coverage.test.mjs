import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvaluationPayload } from "../src/evaluation.mjs";

test("buildEvaluationPayload: single command with coverage_pct → overall_pct set", () => {
  const results = [
    { name: "unit tests", run: "npm test", exit_code: 0, timed_out: false,
      spawn_error: false, output_tail: "", coverage_pct: 87.2,
      parser: { coverage: { format: "c8-json" } } },
  ];
  const payload = buildEvaluationPayload(results);
  assert.equal(payload.coverage?.overall_pct, 87.2);
  assert.deepEqual(payload.coverage?.by_command?.["unit tests"], { pct: 87.2, format: "c8-json" });
});

test("buildEvaluationPayload: two commands with coverage → weighted average by command count (arithmetic mean when no total lines)", () => {
  const results = [
    { name: "unit", run: "a", exit_code: 0, timed_out: false, spawn_error: false,
      output_tail: "", coverage_pct: 90,
      parser: { coverage: { format: "c8-json" } } },
    { name: "integration", run: "b", exit_code: 0, timed_out: false, spawn_error: false,
      output_tail: "", coverage_pct: 70,
      parser: { coverage: { format: "lcov" } } },
  ];
  const payload = buildEvaluationPayload(results);
  assert.equal(payload.coverage?.overall_pct, 80); // (90+70)/2
});

test("buildEvaluationPayload: no coverage parsers → coverage remains {}", () => {
  const results = [
    { name: "unit", run: "npm test", exit_code: 0, timed_out: false,
      spawn_error: false, output_tail: "" },
  ];
  const payload = buildEvaluationPayload(results);
  assert.deepEqual(payload.coverage, {});
});

test("buildEvaluationPayload: command with coverage_parse_error → excluded from overall_pct", () => {
  const results = [
    { name: "unit", run: "a", exit_code: 0, timed_out: false, spawn_error: false,
      output_tail: "", coverage_pct: 80, parser: { coverage: { format: "c8-json" } } },
    { name: "broken", run: "b", exit_code: 0, timed_out: false, spawn_error: false,
      output_tail: "", coverage_parse_error: "file not found",
      parser: { coverage: { format: "lcov" } } },
  ];
  const payload = buildEvaluationPayload(results);
  // Only "unit" contributed; coverage_parse_error command excluded
  assert.equal(payload.coverage?.overall_pct, 80);
  assert.ok(!payload.coverage?.by_command?.broken);
});
