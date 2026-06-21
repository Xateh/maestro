import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { validateInline } from "../src/schemas/index.mjs";
import { validateWorkflow } from "../src/workflow-validate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(repoRoot, "schema", "workflow.schema.json");
const examplesDir = path.join(repoRoot, "examples");

const workflowSchema = JSON.parse(await fs.readFile(schemaPath, "utf8"));

function validWorkflow(extra = {}) {
  return JSON.parse(JSON.stringify({
    version: 2,
    initial: "implementation",
    roles: {
      implementation: {
        label: "Implementation",
        kind: "agent",
        provider: "codex",
        alias: "codex",
        model: "gpt-5.5",
        effort: "high",
        permission: "write",
        prompt_template: "implementation",
        skip: "never",
        source: "roles/implementation.md",
        fallback: ["claude"],
        tools: ["Read", "Bash(npm:*)", "mcp__lint__check"],
        deny_tools: ["Bash(rm:*)"],
        max_visits: 3,
        verifies: false,
        output_schema: { type: "object", additionalProperties: true },
        output_schema_ref: "schemas/implementation.json",
        enforce_output_schema: true,
        instructions: "Implement the task.",
      },
      review_a: {
        provider: "claude",
        permission: "read",
        verifies: true,
        output_schema: "review",
      },
      review_b: {
        provider: "gemini",
        permission: "read",
        verifies: true,
        output_schema: "review",
      },
      evaluation: {
        kind: "command",
        provider: null,
        permission: "read",
        output_schema: "evaluation",
        commands: [{
          name: "test",
          run: "npm test",
          category: "test",
          parser: { coverage: { format: "regex", path: "out.txt", pct: "Coverage: ([0-9.]+)%" } },
        }],
      },
    },
    transitions: {
      implementation: { done: "review_a", question: "$ask_user", error: "$halt" },
      review_a: { done: "evaluation", error: "$halt" },
      review_b: { done: "evaluation", error: "$halt" },
      evaluation: { done: "$complete", error: "$halt" },
    },
    modes: {
      task: { initial: "implementation", terminal_after: ["evaluation"], skip_when_planner_off: "implementation" },
    },
    parallel_groups: [["review_a", "review_b"]],
    gates: {
      min_coverage: 80,
      no_high_severity_findings: true,
      all_regressions_pass: true,
      min_overall_confidence: 0.8,
      output_schema_conformance: true,
    },
    per_edge_context: true,
    experimental_per_edge_context: false,
    edge_context: {
      "implementation:done": ["implementation"],
      "review_a:done": "scoped",
      "review_b:done": "full",
    },
    loop_limits: { default_max_visits: 3, on_exceeded: "ask_user" },
    require_distinct_reviewer: true,
    ...extra,
  }));
}

const structuralCorpus = [
  { name: "all structural fields valid", workflow: validWorkflow() },
  { name: "roles must be object", workflow: validWorkflow({ roles: [] }) },
  {
    name: "fallback must be array",
    workflow: validWorkflow({
      roles: { implementation: { provider: "codex", fallback: "claude" } },
    }),
  },
  {
    name: "tools must be valid tokens",
    workflow: validWorkflow({
      roles: { implementation: { provider: "codex", tools: ["rm -rf"] } },
    }),
  },
  {
    name: "role max_visits must be positive integer",
    workflow: validWorkflow({
      roles: { implementation: { provider: "codex", max_visits: 0 } },
    }),
  },
  {
    name: "command entries require name and run",
    workflow: validWorkflow({
      roles: {
        implementation: { provider: "codex" },
        evaluation: { kind: "command", commands: [{ name: "test" }] },
      },
      transitions: {
        implementation: { done: "evaluation" },
        evaluation: { done: "$complete" },
      },
      parallel_groups: undefined,
      gates: undefined,
    }),
  },
  { name: "loop_limits shape", workflow: validWorkflow({ loop_limits: { default_max_visits: 0, on_exceeded: "explode" } }) },
  { name: "gates shape", workflow: validWorkflow({ gates: { min_coverage: 120 } }) },
  { name: "edge_context shape", workflow: validWorkflow({ edge_context: { "implementation:done": 7 } }) },
  { name: "parallel_groups shape", workflow: validWorkflow({ parallel_groups: [["review_a"]] }) },
  { name: "boolean flags", workflow: validWorkflow({ per_edge_context: "yes" }) },
  {
    name: "output_schema_ref must be string",
    workflow: validWorkflow({
      roles: { implementation: { provider: "codex", output_schema_ref: 3 } },
    }),
  },
  {
    name: "semantic invalid transition target",
    semanticOnly: true,
    workflow: validWorkflow({
      transitions: {
        implementation: { done: "ghost" },
        review_a: { done: "evaluation" },
        review_b: { done: "evaluation" },
        evaluation: { done: "$complete" },
      },
    }),
  },
  {
    name: "semantic invalid output schema name",
    semanticOnly: true,
    workflow: validWorkflow({
      roles: {
        implementation: { provider: "codex", output_schema: "does_not_exist" },
        review_a: { provider: "claude", verifies: true, output_schema: "review" },
        review_b: { provider: "gemini", verifies: true, output_schema: "review" },
        evaluation: { kind: "command", commands: [], output_schema: "evaluation" },
      },
    }),
  },
];

test("workflow schema and validateWorkflow stay in structural parity on the golden corpus", () => {
  for (const fixture of structuralCorpus) {
    const schemaResult = validateInline(workflowSchema, fixture.workflow);
    const validatorResult = validateWorkflow(fixture.workflow);
    if (fixture.semanticOnly) {
      assert.equal(schemaResult.ok, true, `${fixture.name}: semantic fixture should pass schema`);
      continue;
    }
    assert.equal(
      schemaResult.ok,
      validatorResult.ok,
      `${fixture.name}: schema=${JSON.stringify(schemaResult.errors)} validator=${JSON.stringify(validatorResult.errors)}`,
    );
  }
});

test("every top-level workflow schema field has a golden corpus fixture", () => {
  const covered = new Set(structuralCorpus.flatMap((fixture) => Object.keys(fixture.workflow)));
  const missing = Object.keys(workflowSchema.properties ?? {}).filter((field) => !covered.has(field));
  assert.deepEqual(missing, []);
});

test("examples workflows all validate semantically", async () => {
  const expected = [
    "default.workflow.json",
    "full-audit-sweep.workflow.json",
    "github-tracker.workflow.json",
    "parallel-group.workflow.json",
  ];
  const files = (await fs.readdir(examplesDir)).filter((name) => name.endsWith(".workflow.json")).sort();
  assert.deepEqual(files, expected);

  for (const file of files) {
    const workflow = JSON.parse(await fs.readFile(path.join(examplesDir, file), "utf8"));
    const result = validateWorkflow(workflow);
    assert.equal(result.ok, true, `${file}: ${JSON.stringify(result.errors)}`);
  }
});
