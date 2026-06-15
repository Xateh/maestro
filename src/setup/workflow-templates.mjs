// Built-in workflow templates for `maestro init --workflow <name>` and
// `maestro workflow use <name>`.
//
// "default"  — the stock planner → executor → reviewer pipeline.
// "extended" — default plus a read-only System Evaluator role: the reviewer
//   can escalate to it for a principal-level audit, and an "evaluate" mode
//   runs the evaluator standalone. The evaluator prompt lives in
//   templates/system-evaluator.md so it stays editable as markdown.
// "local"    — the default pipeline with every role on ollama (zero cloud).
// "solo"     — executor only; the fastest loop, no plan or review pass.

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_WORKFLOW, writeJsonAtomic } from "../task-store.mjs";

const SYSTEM_EVALUATOR_INSTRUCTIONS = readFileSync(
  new URL("./templates/system-evaluator.md", import.meta.url),
  "utf8",
).trim();

const REVIEWER_ESCALATION_NOTE = [
  "Escalation: if the review surfaces deep architectural risk, repeated failed",
  "execute → review cycles, or you cannot confidently judge correctness from a",
  "normal review, escalate to the system evaluator by also emitting exactly one line:",
  'MAESTRO_HANDOFF: {"event":"escalate","summary":"<why escalation is needed>"}',
].join("\n");

function buildExtendedWorkflow() {
  const workflow = structuredClone(DEFAULT_WORKFLOW);
  workflow.roles.reviewer.instructions = REVIEWER_ESCALATION_NOTE;
  workflow.roles.system_evaluator = {
    label: "System Evaluator",
    provider: "claude",
    alias: "claude",
    model: "",
    effort: "",
    permission: "read",
    prompt_template: "generic",
    skip: "never",
    instructions: SYSTEM_EVALUATOR_INSTRUCTIONS,
  };
  workflow.transitions.reviewer.escalate = "system_evaluator";
  workflow.transitions.system_evaluator = {
    done: "$complete",
    question: "$ask_user",
    error: "$halt",
  };
  workflow.modes.evaluate = {
    initial: "system_evaluator",
    terminal_after: ["system_evaluator"],
  };
  return workflow;
}

function buildLocalWorkflow() {
  const workflow = structuredClone(DEFAULT_WORKFLOW);
  for (const role of Object.values(workflow.roles)) {
    role.provider = "ollama";
    role.alias = "ollama";
    role.model = "";
  }
  return workflow;
}

function buildSoloWorkflow() {
  const base = structuredClone(DEFAULT_WORKFLOW);
  return {
    version: 2,
    initial: "executor",
    roles: { executor: base.roles.executor },
    transitions: {
      executor: { done: "$complete", question: "$ask_user", pause: "$pause", waiting: "$wait", error: "$halt" },
    },
    modes: {
      task: { initial: "executor" },
    },
  };
}

// SP2 verification pipeline spine. Nine stages: a forward spine
// (implementation → static_analysis → review → threat_model → edge_cases →
// tests → evaluation → regression → human_approval) plus three bounded rework
// loops from the discovery verifiers back to implementation.
//
// CRITICAL: every role sets `prompt_template` to its own state name. The role
// node derives `roleKey` from `prompt_template`; a unique value per stage keeps
// handoffs/visits/resume isolated AND falls through to the schema-aware generic
// prompt (only planner/executor/reviewer are special-cased). Shared/absent
// prompt_templates would collide roleKeys and corrupt the run.
function buildFullAuditSweepWorkflow() {
  const role = (extra) => ({ model: "", effort: "", skip: "never", ...extra });
  return {
    version: 2,
    initial: "implementation",
    loop_limits: { default_max_visits: 3, on_exceeded: "ask_user" },
    roles: {
      implementation: role({
        label: "Implementation",
        provider: "codex",
        alias: "codex",
        permission: "write",
        prompt_template: "implementation",
        output_schema: "implementation",
        instructions: [
          "Implement the task. State every assumption you make and every residual",
          "risk explicitly — the handoff MUST include non-trivial `assumptions` and",
          "`risks` arrays when any exist. Do not silently paper over uncertainty.",
        ].join("\n"),
      }),
      static_analysis: role({
        label: "Static Analysis",
        kind: "stub",
        provider: null,
        permission: "read",
        prompt_template: "static_analysis",
        output_schema: "static_analysis",
        instructions: "Pass-through stub (SP3 wires real static-analysis runners).",
      }),
      review: role({
        label: "Review",
        provider: "claude",
        alias: "claude",
        permission: "read",
        prompt_template: "review",
        output_schema: "review",
        verifies: true,
        instructions: [
          "Review the implementation for correctness, maintainability, security,",
          "and contract drift. If rework is required, emit",
          'MAESTRO_HANDOFF: {"event":"changes_requested", ...} to route back to',
          "implementation; otherwise emit the review handoff with event done.",
        ].join("\n"),
      }),
      threat_model: role({
        label: "Threat Model",
        provider: "claude",
        alias: "claude",
        permission: "read",
        prompt_template: "threat_model",
        output_schema: "threat_model",
        verifies: true,
        instructions: [
          "Model misuse, adversarial inputs, concurrency hazards, and data",
          "corruption paths. If a threat demands code changes, emit",
          'MAESTRO_HANDOFF: {"event":"changes_requested", ...} to loop back.',
        ].join("\n"),
      }),
      edge_cases: role({
        label: "Edge Cases",
        provider: "claude",
        alias: "claude",
        permission: "read",
        prompt_template: "edge_cases",
        output_schema: "edge_cases",
        verifies: true,
        instructions: [
          "STRESS the implementation to discover failure modes — this is failure",
          "discovery, NOT review. Enumerate boundary, empty, huge, and concurrent",
          'inputs that break it. If a fix is needed, emit',
          'MAESTRO_HANDOFF: {"event":"changes_requested", ...} to loop back.',
        ].join("\n"),
      }),
      tests: role({
        label: "Tests",
        provider: "codex",
        alias: "codex",
        permission: "write",
        prompt_template: "tests",
        output_schema: "tests",
        verifies: true,
        instructions: [
          "Synthesize tests from the prior review/threat/edge-case handoffs you",
          "have received. Forward-only — do not loop back; emit the tests handoff.",
        ].join("\n"),
      }),
      evaluation: role({
        label: "Evaluation",
        kind: "command",
        provider: null,
        permission: "read",
        prompt_template: "evaluation",
        output_schema: "evaluation",
        commands: [],
        instructions: "Runs declared shell commands and records pass_rate/failures. Opt-in: ships with commands:[] (a no-op, pass_rate 1.0) until you populate it.",
      }),
      regression: role({
        label: "Regression",
        kind: "regression",
        provider: null,
        permission: "read",
        prompt_template: "regression",
        output_schema: "regression",
        corpus_dir: ".maestro/regression", // default; shown for clarity
        attempts: 1, // default single-shot
        fail_threshold: 1, // default: any new failure routes fail
        fail_event: "regressions_found", // default outcome event
        instructions: "Re-runs the on-disk regression corpus and auto-promotes evaluation failures. Empty corpus ⇒ pass-through (event done).",
      }),
      scoring: role({
        label: "Scoring",
        kind: "scoring",
        provider: null,
        permission: "read",
        prompt_template: "scoring",
        output_schema: "scoring",
        instructions: "Derives the six reliability scores from prior stage evidence and enforces declared workflow gates. No gates declared by default ⇒ informational (event passed).",
      }),
      human_approval: role({
        label: "Human Approval",
        provider: "claude",
        alias: "claude",
        permission: "read",
        prompt_template: "human_approval",
        instructions: [
          "Summarize all prior stage artifacts into an approval-ready report for a",
          "human to inspect, then emit the handoff with event done to complete.",
          "If you need clarification, ask via MAESTRO_QUESTION.",
        ].join("\n"),
      }),
    },
    transitions: {
      implementation: { done: "static_analysis", question: "$ask_user", error: "$halt" },
      static_analysis: { done: "review", error: "$halt" },
      review: { done: "threat_model", changes_requested: "implementation", question: "$ask_user", error: "$halt" },
      threat_model: { done: "edge_cases", changes_requested: "implementation", question: "$ask_user", error: "$halt" },
      edge_cases: { done: "tests", changes_requested: "implementation", question: "$ask_user", error: "$halt" },
      tests: { done: "evaluation", question: "$ask_user", error: "$halt" },
      evaluation: { done: "regression", error: "$halt" },
      regression: { done: "scoring", regressions_found: "implementation", error: "$halt" },
      scoring: { passed: "human_approval", blocked: "$halt", error: "$halt" },
      human_approval: { done: "$complete", question: "$ask_user", error: "$halt" },
    },
    modes: {
      task: { initial: "implementation" },
    },
  };
}

export const EXTENDED_WORKFLOW = buildExtendedWorkflow();
export const LOCAL_WORKFLOW = buildLocalWorkflow();
export const SOLO_WORKFLOW = buildSoloWorkflow();
export const FULL_AUDIT_SWEEP_WORKFLOW = buildFullAuditSweepWorkflow();

export const WORKFLOW_TEMPLATES = {
  default: DEFAULT_WORKFLOW,
  extended: EXTENDED_WORKFLOW,
  local: LOCAL_WORKFLOW,
  solo: SOLO_WORKFLOW,
  "full-audit-sweep": FULL_AUDIT_SWEEP_WORKFLOW,
};

export function resolveWorkflowTemplate(name) {
  const template = WORKFLOW_TEMPLATES[name];
  if (!template) {
    const known = Object.keys(WORKFLOW_TEMPLATES).join(", ");
    throw new Error(`unknown_workflow_template: ${name} (available: ${known})`);
  }
  return structuredClone(template);
}

// Copy workflow.json to workflow.json.bak before any destructive write.
// Returns the backup path, or null when there was nothing to back up.
export async function backupWorkflowFile(stateDir) {
  const workflowPath = path.join(stateDir, "workflow.json");
  const backupPath = `${workflowPath}.bak`;
  try {
    await fs.copyFile(workflowPath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

// Replace workflow.json with a named built-in template. Prompt-free: the old
// file is always backed up first. Full replace (not a merge) so stale keys
// from the previous workflow never survive a template switch.
export async function applyWorkflowTemplate({ name, stateDir }) {
  const template = resolveWorkflowTemplate(name);
  const backupPath = await backupWorkflowFile(stateDir);
  const workflowPath = path.join(stateDir, "workflow.json");
  await writeJsonAtomic(workflowPath, template);
  return { name, workflow: template, workflowPath, backupPath };
}
