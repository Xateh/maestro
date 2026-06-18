import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  WORKFLOW_TEMPLATES,
  resolveWorkflowTemplate,
} from "../src/setup/workflow-templates.mjs";
import { validateWorkflow } from "../src/workflow-validate.mjs";
import { loadRole, composeRole, _clearRoleCache } from "../src/setup/role-loader.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG = {
  version: 2,
  providers: {
    claude: { adapter: "built-in:claude" },
    gemini: { adapter: "built-in:gemini" },
  },
};

test("WORKFLOW_TEMPLATES contains triage and research", () => {
  assert.ok(Object.hasOwn(WORKFLOW_TEMPLATES, "triage"));
  assert.ok(Object.hasOwn(WORKFLOW_TEMPLATES, "research"));
});

test("triage template is structurally valid", () => {
  const wf = resolveWorkflowTemplate("triage");
  const result = validateWorkflow(wf, { config: CONFIG });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("research template is structurally valid", () => {
  const wf = resolveWorkflowTemplate("research");
  const result = validateWorkflow(wf, { config: CONFIG });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("triage transitions + initial per §6.1", () => {
  const wf = resolveWorkflowTemplate("triage");
  assert.equal(wf.modes.task.initial, "triage");
  assert.deepEqual(wf.transitions.triage, {
    bug: "$complete",
    feature: "$complete",
    clarify: "$ask_user",
    done: "$complete",
    error: "$halt",
  });
  assert.equal(wf.roles.triage.output_schema, "classification");
  assert.deepEqual(wf.roles.triage.tools, ["Read", "Grep"]);
  assert.equal(wf.roles.triage.prompt_template, "triage");
});

test("research transitions + initial per §6.2", () => {
  const wf = resolveWorkflowTemplate("research");
  assert.equal(wf.modes.task.initial, "gather");
  assert.deepEqual(wf.transitions.gather, { done: "synthesize", question: "$ask_user", error: "$halt" });
  assert.deepEqual(wf.transitions.synthesize, { done: "$complete", question: "$ask_user", error: "$halt" });
  assert.equal(wf.roles.gather.provider, "gemini");
  assert.equal(wf.roles.synthesize.provider, "claude");
  assert.equal(wf.roles.gather.output_schema, "research");
});

test("each stage sets a unique prompt_template == its state name", () => {
  for (const name of ["triage", "research"]) {
    const wf = resolveWorkflowTemplate(name);
    for (const [stateName, role] of Object.entries(wf.roles)) {
      assert.equal(role.prompt_template, stateName, `${name}.${stateName}`);
    }
  }
});

// ── U4: default-workflow gate decision (ratified) ────────────────────────────
// Decision: the lean default (full-audit-sweep) ships the `scoring` node with NO
// gates declared ⇒ informational (event always "passed"). Gated flows ship as a
// named example template that opts in to exactly one gate.

test("U4: lean full-audit-sweep ships scoring with no gates declared (informational)", () => {
  const wf = resolveWorkflowTemplate("full-audit-sweep");
  // scoring routes passed→human_approval, blocked→$halt — but with no gates the
  // scoring node always emits "passed", so the block edge is dormant by default.
  assert.deepEqual(wf.transitions.scoring, {
    passed: "human_approval",
    blocked: "$halt",
    error: "$halt",
  });
  assert.equal(wf.gates, undefined, "lean default must declare no workflow gates");
  assert.equal(wf.roles.scoring.gates, undefined, "lean default scoring role declares no gates");
});

test("U4: gated example template declares exactly one gate + stays valid", () => {
  assert.ok(Object.hasOwn(WORKFLOW_TEMPLATES, "full-audit-sweep-gated"));
  const wf = resolveWorkflowTemplate("full-audit-sweep-gated");
  assert.deepEqual(Object.keys(wf.gates), ["no_high_severity_findings"]);
  assert.equal(wf.gates.no_high_severity_findings, true);
  // same gated scoring edge as the lean default, now load-bearing.
  assert.equal(wf.transitions.scoring.blocked, "$halt");
  const result = validateWorkflow(wf, { config: { version: 2, providers: { claude: { adapter: "built-in:claude" }, codex: { adapter: "built-in:codex" } } } });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("shipped .maestro/roles units load + compose without error", async () => {
  _clearRoleCache();
  for (const name of ["triage", "gather", "synthesize"]) {
    const out = await loadRole(path.join(repoRoot, ".maestro", "roles", `${name}.md`));
    assert.equal(out.ok, true, `${name}: ${out.error?.message}`);
    const composed = composeRole(name, { prompt_template: name }, out.roleDef);
    assert.equal(composed.prompt_template, name);
    assert.ok(composed.instructions.length > 0);
  }
});
