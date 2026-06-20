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
  // With parallel_groups declared, review/threat_model/edge_cases are no longer
  // reachable via raw transitions (they run via the group node), so their
  // changes_requested back-edges no longer form cycles in the transition graph.
  // Only the SP4 regression → implementation back-edge remains = 1 cycle.
  assert.equal(cycles.length, 1, "regression loop-back (parallel group absorbs verifier cycles)");
  for (const cycle of cycles) {
    assert.ok(cycleHasTermination(cycle, template), `cycle ${cycle.join("→")} must terminate`);
  }
});

test("full-audit-sweep: implementation reaches human_approval which completes", () => {
  const template = resolveWorkflowTemplate("full-audit-sweep");
  // Parallel group members are co-reachable: reaching any member reaches all.
  const memberToSiblings = new Map();
  for (const group of (template.parallel_groups ?? [])) {
    for (const name of group) memberToSiblings.set(name, group);
  }
  const reachable = new Set();
  const queue = [template.initial];
  while (queue.length) {
    const s = queue.shift();
    if (reachable.has(s)) continue;
    reachable.add(s);
    for (const sibling of (memberToSiblings.get(s) ?? [])) {
      if (template.roles[sibling] && !reachable.has(sibling)) queue.push(sibling);
    }
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

// ── SP8 kind:"command" coverage.format validation ───────────────────────────
// Helper for SP8 tests: cmdWorkflow builds a minimal v2 workflow with command role
function cmdWorkflow(commands) {
  return {
    version: 2,
    initial: "eval",
    roles: { eval: { kind: "command", commands } },
    transitions: { eval: { done: "$complete" } },
  };
}

test("SP8 validate: unknown coverage.format → bad_command_spec", () => {
  const wf = cmdWorkflow([{
    name: "tests", run: "npm test",
    parser: { coverage: { format: "istanbul", path: "coverage.json" } },
  }]);
  const result = validateWorkflow(wf);
  assert.ok(result.errors.some((e) => e.code === "bad_command_spec" && e.message.includes("coverage.format")));
});

test("SP8 validate: coverage.format=regex without pct → bad_command_spec", () => {
  const wf = cmdWorkflow([{
    name: "tests", run: "npm test",
    parser: { coverage: { format: "regex", path: "output.txt" } },
  }]);
  const result = validateWorkflow(wf);
  assert.ok(result.errors.some((e) => e.code === "bad_command_spec" && e.message.includes("pct")));
});

test("SP8 validate: valid coverage.format=c8-json with path → no error", () => {
  const wf = cmdWorkflow([{
    name: "tests", run: "npm test",
    parser: { coverage: { format: "c8-json", path: "coverage/coverage-summary.json" } },
  }]);
  const result = validateWorkflow(wf);
  assert.ok(!result.errors.some((e) => e.code === "bad_command_spec" && e.message.includes("coverage")));
});

test("SP8 validate: valid coverage.format=regex with pct → no error", () => {
  const wf = cmdWorkflow([{
    name: "tests", run: "npm test",
    parser: { coverage: { format: "regex", path: "out.txt", pct: "Cov: ([\\d.]+)%" } },
  }]);
  const result = validateWorkflow(wf);
  assert.ok(!result.errors.some((e) => e.code === "bad_command_spec" && e.message.includes("coverage")));
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

// ── require_distinct_reviewer (v0.3.0 item C, opt-in) ────────────────────────

test("require_distinct_reviewer: same provider for entry + verifier ⇒ error", () => {
  const wf = baseWorkflow(
    {
      executor: { provider: "codex" },
      review: { provider: "codex", verifies: true, output_schema: "review" },
    },
    {
      transitions: {
        executor: { done: "review", error: "$halt" },
        review: { done: "$complete", error: "$halt" },
      },
      require_distinct_reviewer: true,
    },
  );
  const result = validateWorkflow(wf);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("non_distinct_reviewer"));
});

test("require_distinct_reviewer: distinct providers ⇒ clean", () => {
  const wf = baseWorkflow(
    {
      executor: { provider: "codex" },
      review: { provider: "claude", verifies: true, output_schema: "review" },
    },
    {
      transitions: {
        executor: { done: "review", error: "$halt" },
        review: { done: "$complete", error: "$halt" },
      },
      require_distinct_reviewer: true,
    },
  );
  const result = validateWorkflow(wf);
  assert.ok(!codes(result).includes("non_distinct_reviewer"));
});

test("require_distinct_reviewer absent ⇒ shared provider → non_distinct_reviewer WARNING (default-on v0.4.0)", () => {
  const wf = baseWorkflow(
    {
      executor: { provider: "codex" },
      review: { provider: "codex", verifies: true, output_schema: "review" },
    },
    {
      transitions: {
        executor: { done: "review", error: "$halt" },
        review: { done: "$complete", error: "$halt" },
      },
    },
  );
  const result = validateWorkflow(wf);
  assert.ok(result.ok, "warning only — result still ok");
  assert.ok(result.warnings.some((w) => w.code === "non_distinct_reviewer"), "emits warning");
  assert.ok(!result.errors.some((e) => e.code === "non_distinct_reviewer"), "not an error");
});

test("require_distinct_reviewer non-boolean ⇒ bad_require_distinct_reviewer", () => {
  const wf = baseWorkflow(
    { executor: { provider: "codex" } },
    { require_distinct_reviewer: "yes" },
  );
  const result = validateWorkflow(wf);
  assert.ok(codes(result).includes("bad_require_distinct_reviewer"));
});

// Helper: two-role workflow where reviewer shares provider with entry role
function sharedProviderWorkflow(requireDistinct) {
  const wf = {
    version: 2,
    initial: "executor",
    roles: {
      executor:  { provider: "claude" },
      reviewer:  { provider: "claude", verifies: true },
    },
    transitions: {
      executor: { done: "reviewer" },
      reviewer: { done: "$complete" },
    },
  };
  if (requireDistinct !== undefined) wf.require_distinct_reviewer = requireDistinct;
  return wf;
}

test("SP10a: absent require_distinct_reviewer + shared provider → non_distinct_reviewer WARNING (not error)", () => {
  const result = validateWorkflow(sharedProviderWorkflow(undefined));
  assert.ok(result.ok, "should still be ok (warning only)");
  assert.ok(
    result.warnings.some((w) => w.code === "non_distinct_reviewer"),
    "expected non_distinct_reviewer warning",
  );
  assert.ok(
    !result.errors.some((e) => e.code === "non_distinct_reviewer"),
    "must not be an error",
  );
});

test("SP10a: require_distinct_reviewer: false → deprecated_distinct_reviewer_opt_out warning, no check", () => {
  const result = validateWorkflow(sharedProviderWorkflow(false));
  assert.ok(result.ok);
  assert.ok(
    result.warnings.some((w) => w.code === "deprecated_distinct_reviewer_opt_out"),
    "expected deprecation warning",
  );
  assert.ok(
    !result.warnings.some((w) => w.code === "non_distinct_reviewer"),
    "no distinctness check when explicitly false",
  );
});

test("SP10a: require_distinct_reviewer: true + shared provider → non_distinct_reviewer ERROR", () => {
  const result = validateWorkflow(sharedProviderWorkflow(true));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "non_distinct_reviewer"));
});

test("SP10a: absent require_distinct_reviewer + DISTINCT providers → no warning", () => {
  const wf = sharedProviderWorkflow(undefined);
  wf.roles.reviewer.provider = "gemini";
  const result = validateWorkflow(wf);
  assert.ok(!result.warnings.some((w) => w.code === "non_distinct_reviewer"));
});

// ── SP10c: graduate experimental_per_edge_context → per_edge_context ─────────

test("SP10c: per_edge_context (new key) accepted without warning", () => {
  const wf = baseWorkflow({ executor: {} }, {
    per_edge_context: true,
    edge_context: { "executor:done": "full" },
  });
  const result = validateWorkflow(wf);
  assert.ok(!result.errors.some((e) => e.code === "bad_edge_context"), result.errors.map(e => e.message).join(", "));
  assert.ok(!result.warnings.some((w) => w.code === "deprecated_experimental_flag"));
});

test("SP10c: experimental_per_edge_context (old key) emits deprecated_experimental_flag warning", () => {
  const wf = baseWorkflow({ executor: {} }, {
    experimental_per_edge_context: true,
    edge_context: { "executor:done": "full" },
  });
  const result = validateWorkflow(wf);
  assert.ok(result.warnings.some((w) => w.code === "deprecated_experimental_flag"), "expected deprecated_experimental_flag");
});

test("SP10c: non-boolean per_edge_context → bad_edge_context error", () => {
  const wf = baseWorkflow({ executor: {} }, { per_edge_context: "yes" });
  const result = validateWorkflow(wf);
  assert.ok(result.errors.some((e) => e.code === "bad_edge_context"));
});

test("SP10c: both keys present → new key takes precedence + deprecated_experimental_flag warning fires", () => {
  const wf = baseWorkflow({ executor: {} }, {
    per_edge_context: true,
    experimental_per_edge_context: false,
    edge_context: { "executor:done": "full" },
  });
  const result = validateWorkflow(wf);
  // Old key present → deprecation warning fires
  assert.ok(
    result.warnings.some((w) => w.code === "deprecated_experimental_flag"),
    "expected deprecated_experimental_flag warning",
  );
  // New key takes precedence → per_edge_context: true means no bad_edge_context
  assert.ok(
    !result.errors.some((e) => e.code === "bad_edge_context"),
    result.errors.map(e => e.message).join(", "),
  );
});

// ── SP7: parallel_groups validation ──────────────────────────────────────────

function parallelWorkflow(groups, extraRoles = {}, extraTransitions = {}) {
  const roles = {
    planner:   { provider: "claude" },
    reviewerA: { provider: "gemini" },
    reviewerB: { provider: "gemini" },
    scoring:   { kind: "scoring", provider: "claude" },
    ...extraRoles,
  };
  const transitions = {
    planner:   { done: "reviewerA" }, // entry → first group member (remapped at build time)
    reviewerA: { done: "scoring" },
    reviewerB: { done: "scoring" },
    scoring:   { passed: "$complete", blocked: "$halt" },
    ...extraTransitions,
  };
  return {
    version: 2,
    initial: "planner",
    roles,
    transitions,
    parallel_groups: groups,
  };
}

test("SP7 validate: sibling edge inside group → bad_parallel_group", () => {
  // reviewerA → reviewerB (sibling dependency)
  const wf = parallelWorkflow([["reviewerA", "reviewerB"]], {}, {
    reviewerA: { done: "reviewerB" }, // sibling edge
    reviewerB: { done: "scoring" },
  });
  const result = validateWorkflow(wf);
  assert.ok(result.errors.some((e) => e.code === "bad_parallel_group" && e.message.includes("sibling")));
});

test("SP7 validate: scoring role in group → bad_parallel_group", () => {
  const wf = parallelWorkflow([["reviewerA", "scoring"]]);
  const result = validateWorkflow(wf);
  assert.ok(result.errors.some((e) => e.code === "bad_parallel_group" && e.message.includes("scoring")));
});

test("SP7 validate: group with only 1 member → bad_parallel_group", () => {
  const wf = parallelWorkflow([["reviewerA"]]);
  const result = validateWorkflow(wf);
  assert.ok(result.errors.some((e) => e.code === "bad_parallel_group" && e.message.includes("fewer than 2")));
});

test("SP7 validate: valid parallel group with 2 members → no bad_parallel_group", () => {
  const wf = parallelWorkflow([["reviewerA", "reviewerB"]]);
  const result = validateWorkflow(wf);
  assert.ok(!result.errors.some((e) => e.code === "bad_parallel_group"), result.errors.map(e => e.message).join(", "));
});

test("SP7 validate: role not defined → bad_parallel_group (unknown member)", () => {
  const wf = parallelWorkflow([["reviewerA", "ghost"]]);
  const result = validateWorkflow(wf);
  assert.ok(result.errors.some((e) => e.code === "bad_parallel_group" && e.message.includes("ghost")));
});
