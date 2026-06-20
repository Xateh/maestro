import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCoverage } from "../src/coverage-parsers.mjs";

// ── c8-json ──────────────────────────────────────────────────────────────────
const C8_SUMMARY = JSON.stringify({
  total: { lines: { pct: 87.23 }, statements: { pct: 85 }, functions: { pct: 90 } }
});
test("c8-json: extracts total.lines.pct", () => {
  const r = parseCoverage("c8-json", C8_SUMMARY);
  assert.equal(r?.pct, 87.23);
});
test("c8-json: malformed JSON → null", () => {
  assert.equal(parseCoverage("c8-json", "not json"), null);
});
test("c8-json: missing total.lines → null", () => {
  assert.equal(parseCoverage("c8-json", JSON.stringify({ total: {} })), null);
});

// ── jest-json ────────────────────────────────────────────────────────────────
// jest-json shares same shape as c8-json
test("jest-json: same shape as c8-json", () => {
  const r = parseCoverage("jest-json", C8_SUMMARY);
  assert.equal(r?.pct, 87.23);
});

// ── lcov ─────────────────────────────────────────────────────────────────────
const LCOV_CONTENT = `TN:
SF:src/foo.js
LF:100
LH:82
end_of_record
TN:
SF:src/bar.js
LF:50
LH:45
end_of_record`;
test("lcov: aggregates LF/LH across all records", () => {
  // total lines = 100+50 = 150, hit = 82+45 = 127
  // pct = 127/150 * 100 = 84.6667
  const r = parseCoverage("lcov", LCOV_CONTENT);
  assert.ok(r !== null);
  assert.ok(Math.abs(r.pct - 84.6667) < 0.001);
});
test("lcov: no LF/LH → null", () => {
  assert.equal(parseCoverage("lcov", "TN:\nend_of_record\n"), null);
});

// ── cobertura ────────────────────────────────────────────────────────────────
const COBERTURA = `<?xml version="1.0"?>
<coverage line-rate="0.856" branch-rate="0.75" version="1" timestamp="0">
</coverage>`;
test("cobertura: reads line-rate attribute × 100", () => {
  const r = parseCoverage("cobertura", COBERTURA);
  assert.ok(r !== null);
  assert.ok(Math.abs(r.pct - 85.6) < 0.001);
});
test("cobertura: missing attribute → null", () => {
  assert.equal(parseCoverage("cobertura", "<coverage></coverage>"), null);
});

// ── clover ───────────────────────────────────────────────────────────────────
const CLOVER = `<?xml version="1.0"?>
<coverage>
  <project>
    <metrics coveredelements="920" elements="1000" />
  </project>
</coverage>`;
test("clover: coveredelements/elements × 100", () => {
  const r = parseCoverage("clover", CLOVER);
  assert.ok(r !== null);
  assert.equal(r.pct, 92);
});
test("clover: elements=0 → null (no divide by zero)", () => {
  const zero = CLOVER.replace('elements="1000"', 'elements="0"').replace('coveredelements="920"', 'coveredelements="0"');
  assert.equal(parseCoverage("clover", zero), null);
});

// ── regex ─────────────────────────────────────────────────────────────────────
test("regex: extracts float from first capture group", () => {
  const text = "Coverage: 78.50% of lines";
  const r = parseCoverage("regex", text, { pct: "Coverage: ([\\d.]+)%" });
  assert.ok(r !== null);
  assert.equal(r.pct, 78.5);
});
test("regex: no match → null", () => {
  const r = parseCoverage("regex", "nothing here", { pct: "Coverage: ([\\d.]+)%" });
  assert.equal(r, null);
});
test("regex: missing opts.pct → null", () => {
  assert.equal(parseCoverage("regex", "Coverage: 80%"), null);
});

// ── unknown format ───────────────────────────────────────────────────────────
test("unknown format → null", () => {
  assert.equal(parseCoverage("istanbul", "{}"), null);
});
