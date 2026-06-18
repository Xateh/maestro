import assert from "node:assert/strict";
import { test } from "node:test";

import { validateWorkflow, formatValidation, findCycles, cycleHasTermination, isSafeRelativeRef } from "../src/workflow-validate.mjs";
import { DEFAULT_WORKFLOW } from "../src/task-store.mjs";
import { resolveWorkflowTemplate } from "../src/setup/workflow-templates.mjs";

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

test("enforce_output_schema must be a boolean (U2)", () => {
  const bad = validateWorkflow(baseWorkflow({
    executor: { provider: "codex", output_schema: "implementation", enforce_output_schema: "yes" },
  }));
  assert.equal(bad.ok, false);
  assert.ok(codes(bad).includes("bad_enforce_output_schema"));

  const okFlag = validateWorkflow(baseWorkflow({
    executor: { provider: "codex", output_schema: "implementation", enforce_output_schema: true },
  }));
  assert.ok(!codes(okFlag).includes("bad_enforce_output_schema"));
});

test("enforce_output_schema:true with no resolvable schema → advisory warning (U2)", () => {
  const result = validateWorkflow(baseWorkflow({
    executor: { provider: "codex", enforce_output_schema: true }, // no output_schema
  }));
  assert.ok(codes(result).includes("enforce_without_schema"));
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

// ── MRC: source / tools / deny_tools (P3) ────────────────────────────────────

test("isSafeRelativeRef is exported (D3)", () => {
  assert.equal(typeof isSafeRelativeRef, "function");
  assert.equal(isSafeRelativeRef(".maestro/roles/triage.md"), true);
  assert.equal(isSafeRelativeRef("/abs"), false);
  assert.equal(isSafeRelativeRef("../escape.md"), false);
});

test("unsafe string source → bad_role_source", () => {
  for (const bad of ["/abs/x.md", "../escape.md", "C:\\x.md"]) {
    const result = validateWorkflow(baseWorkflow({ executor: { provider: "codex", source: bad } }));
    assert.ok(codes(result).includes("bad_role_source"), bad);
  }
});

test("safe relative string source → no error", () => {
  const result = validateWorkflow(baseWorkflow({ executor: { provider: "codex", source: ".maestro/roles/x.md" } }));
  assert.ok(!codes(result).includes("bad_role_source"));
});

test("object source (legacy import provenance) is ignored (D5)", () => {
  const result = validateWorkflow(baseWorkflow({
    executor: { provider: "codex", source: { kind: "claude-subagent", path: "/abs/x.md", hash: "sha256:..." } },
  }));
  assert.ok(!codes(result).includes("bad_role_source"));
});

test("tools non-array → bad_tool_token; bad token → bad_tool_token naming token", () => {
  const nonArray = validateWorkflow(baseWorkflow({ executor: { provider: "codex", tools: "Read" } }));
  assert.ok(codes(nonArray).includes("bad_tool_token"));

  const badToken = validateWorkflow(baseWorkflow({ executor: { provider: "codex", tools: ["Read", "rm -rf"] } }));
  const issue = [...badToken.errors].find((e) => e.code === "bad_tool_token");
  assert.ok(issue);
  assert.ok(issue.message.includes("rm -rf"));
  assert.ok(issue.message.includes("tools"));
});

test("deny_tools validated the same way", () => {
  const bad = validateWorkflow(baseWorkflow({ executor: { provider: "codex", deny_tools: ["Bash("] } }));
  const issue = [...bad.errors].find((e) => e.code === "bad_tool_token");
  assert.ok(issue);
  assert.ok(issue.message.includes("deny_tools"));
});

test("valid tools/deny_tools → clean", () => {
  const result = validateWorkflow(baseWorkflow({
    executor: { provider: "codex", tools: ["Read", "Grep", "Bash(npm:*)"], deny_tools: ["Bash(rm:*)"] },
  }));
  assert.ok(!codes(result).includes("bad_tool_token"));
});

test("new named schemas classification/research resolve (source:name not unknown)", () => {
  const cls = validateWorkflow(baseWorkflow({ executor: { provider: "codex", output_schema: "classification" } }));
  assert.ok(!codes(cls).includes("unknown_output_schema"));
  const res = validateWorkflow(baseWorkflow({ executor: { provider: "codex", output_schema: "research" } }));
  assert.ok(!codes(res).includes("unknown_output_schema"));
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

// ── non_independent_role rule (SP2) ──────────────────────────────────────────

test("entry role that also verifies → non_independent_role error", () => {
  const wf = baseWorkflow(
    { build: { provider: "codex", verifies: true } },
    { modes: { task: { initial: "build" } } },
  );
  const result = validateWorkflow(wf);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("non_independent_role"));
});

test("distinct verifier role (not an entry role) → no non_independent_role", () => {
  const wf = baseWorkflow(
    {
      build: { provider: "codex" },
      check: { provider: "codex", verifies: true, output_schema: "review" },
    },
    { initial: "build", modes: { task: { initial: "build" } } },
  );
  // route build → check so check is reachable.
  wf.transitions.build = { done: "check", error: "$halt" };
  const result = validateWorkflow(wf);
  assert.ok(!codes(result).includes("non_independent_role"));
});

// ── full-audit-sweep template validity (SP2) ─────────────────────────────────

test("full-audit-sweep template validates with no errors", () => {
  const template = resolveWorkflowTemplate("full-audit-sweep");
  const result = validateWorkflow(template);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  for (const code of ["non_independent_role", "unknown_output_schema", "unreachable_role", "unterminated_cycle"]) {
    assert.ok(!codes(result).includes(code), `unexpected ${code}`);
  }
});

test("full-audit-sweep: rework cycles each terminate", () => {
  const template = resolveWorkflowTemplate("full-audit-sweep");
  const cycles = findCycles(template.transitions);
  // review/threat_model/edge_cases each loop to implementation (3) plus the SP4
  // regression → implementation back-edge (regressions_found) = 4.
  assert.equal(cycles.length, 4, "three review back-edges + regression loop-back");
  for (const cycle of cycles) {
    assert.ok(cycleHasTermination(cycle, template), `cycle ${cycle.join("→")} must terminate`);
  }
});

test("full-audit-sweep: implementation reaches human_approval which completes", () => {
  const template = resolveWorkflowTemplate("full-audit-sweep");
  // every role reachable from implementation
  const reachable = new Set();
  const queue = [template.initial];
  while (queue.length) {
    const s = queue.shift();
    if (reachable.has(s)) continue;
    reachable.add(s);
    for (const to of Object.values(template.transitions[s] ?? {})) {
      if (template.roles[to] && !reachable.has(to)) queue.push(to);
    }
  }
  for (const role of Object.keys(template.roles)) {
    assert.ok(reachable.has(role), `role ${role} unreachable`);
  }
  assert.equal(template.transitions.human_approval.done, "$complete");
});

// ── SP3 kind:"command" role spec validation (bad_command_spec) ───────────────

test("command role missing run → bad_command_spec error", () => {
  const wf = baseWorkflow({
    executor: { kind: "command", output_schema: "evaluation", commands: [{ name: "lint" }] },
  });
  const result = validateWorkflow(wf);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("bad_command_spec"));
});

test("command role missing name → bad_command_spec error", () => {
  const wf = baseWorkflow({
    executor: { kind: "command", output_schema: "evaluation", commands: [{ run: "npm test" }] },
  });
  const result = validateWorkflow(wf);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("bad_command_spec"));
});

test("command role duplicate name → bad_command_spec error", () => {
  const wf = baseWorkflow({
    executor: {
      kind: "command",
      output_schema: "evaluation",
      commands: [{ name: "x", run: "true" }, { name: "x", run: "false" }],
    },
  });
  const result = validateWorkflow(wf);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("bad_command_spec"));
});

test("command role non-array commands → bad_command_spec error", () => {
  const wf = baseWorkflow({
    executor: { kind: "command", output_schema: "evaluation", commands: "nope" },
  });
  const result = validateWorkflow(wf);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("bad_command_spec"));
});

test("command role empty commands:[] → clean", () => {
  const wf = baseWorkflow({
    executor: { kind: "command", output_schema: "evaluation", commands: [] },
  });
  const result = validateWorkflow(wf);
  assert.ok(!codes(result).includes("bad_command_spec"));
});

test("command role valid 2 commands → clean", () => {
  const wf = baseWorkflow({
    executor: {
      kind: "command",
      output_schema: "evaluation",
      commands: [{ name: "lint", run: "npm run lint" }, { name: "test", run: "npm test" }],
    },
  });
  const result = validateWorkflow(wf);
  assert.ok(!codes(result).includes("bad_command_spec"));
});

test("full-audit-sweep validates clean — no bad_command_spec", () => {
  const result = validateWorkflow(resolveWorkflowTemplate("full-audit-sweep"));
  assert.equal(result.ok, true);
  assert.ok(!codes(result).includes("bad_command_spec"));
});

// ── SP4 kind:"regression" role spec validation (bad_regression_spec) ─────────

test("regression role missing fail_event transition → bad_regression_spec", () => {
  // baseWorkflow auto-adds only {done, error}, so the default "regressions_found"
  // fail_event transition is absent.
  const wf = baseWorkflow({ r: { kind: "regression", output_schema: "regression" } });
  const result = validateWorkflow(wf);
  assert.ok(codes(result).includes("bad_regression_spec"));
});

test("regression role custom fail_event missing transition → bad_regression_spec", () => {
  const wf = baseWorkflow({ r: { kind: "regression", fail_event: "oops", output_schema: "regression" } });
  // transitions auto-added: { done, error } — "oops" missing.
  const result = validateWorkflow(wf);
  assert.ok(codes(result).includes("bad_regression_spec"));
});

test("regression role non-positive attempts → bad_regression_spec", () => {
  for (const attempts of [0, -1, 1.5]) {
    const wf = baseWorkflow(
      { r: { kind: "regression", attempts, output_schema: "regression" } },
      { transitions: { r: { done: "$complete", regressions_found: "$complete", error: "$halt" } } },
    );
    const result = validateWorkflow(wf);
    assert.ok(codes(result).includes("bad_regression_spec"), `attempts ${attempts} should fail`);
  }
});

test("regression role non-positive fail_threshold → bad_regression_spec", () => {
  const wf = baseWorkflow(
    { r: { kind: "regression", fail_threshold: 0, output_schema: "regression" } },
    { transitions: { r: { done: "$complete", regressions_found: "$complete", error: "$halt" } } },
  );
  const result = validateWorkflow(wf);
  assert.ok(codes(result).includes("bad_regression_spec"));
});

test("well-formed regression role validates clean — no bad_regression_spec", () => {
  const wf = baseWorkflow(
    { r: { kind: "regression", attempts: 2, fail_threshold: 1, output_schema: "regression" } },
    { transitions: { r: { done: "$complete", regressions_found: "$complete", error: "$halt" } } },
  );
  const result = validateWorkflow(wf);
  assert.ok(!codes(result).includes("bad_regression_spec"));
});

test("full-audit-sweep validates clean — no bad_regression_spec", () => {
  const result = validateWorkflow(resolveWorkflowTemplate("full-audit-sweep"));
  assert.equal(result.ok, true);
  assert.ok(!codes(result).includes("bad_regression_spec"));
});

// ── SP5 kind:"scoring" role spec validation (bad_scoring_spec) ────────────────

test("scoring role missing blocked transition → bad_scoring_spec", () => {
  // baseWorkflow auto-adds only {done, error}; "passed"/"blocked" both absent.
  const wf = baseWorkflow(
    { s: { kind: "scoring", output_schema: "scoring" } },
    { transitions: { s: { passed: "$complete", error: "$halt" } } },
  );
  const result = validateWorkflow(wf);
  assert.ok(codes(result).includes("bad_scoring_spec"));
});

test("scoring role missing passed transition → bad_scoring_spec", () => {
  const wf = baseWorkflow(
    { s: { kind: "scoring", output_schema: "scoring" } },
    { transitions: { s: { blocked: "$halt", error: "$halt" } } },
  );
  const result = validateWorkflow(wf);
  assert.ok(codes(result).includes("bad_scoring_spec"));
});

test("scoring role custom events missing transitions → bad_scoring_spec", () => {
  const wf = baseWorkflow(
    { s: { kind: "scoring", pass_event: "ok", block_event: "stop", output_schema: "scoring" } },
    { transitions: { s: { done: "$complete", error: "$halt" } } },
  );
  const result = validateWorkflow(wf);
  assert.ok(codes(result).includes("bad_scoring_spec"));
});

test("well-formed scoring role validates clean — no bad_scoring_spec", () => {
  const wf = baseWorkflow(
    { s: { kind: "scoring", output_schema: "scoring" } },
    { transitions: { s: { passed: "$complete", blocked: "$halt", error: "$halt" } } },
  );
  const result = validateWorkflow(wf);
  assert.ok(!codes(result).includes("bad_scoring_spec"));
});

test("full-audit-sweep validates clean — no bad_scoring_spec", () => {
  const result = validateWorkflow(resolveWorkflowTemplate("full-audit-sweep"));
  assert.equal(result.ok, true);
  assert.ok(!codes(result).includes("bad_scoring_spec"));
});
