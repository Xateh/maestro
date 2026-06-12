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
    version: 1,
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

export const EXTENDED_WORKFLOW = buildExtendedWorkflow();
export const LOCAL_WORKFLOW = buildLocalWorkflow();
export const SOLO_WORKFLOW = buildSoloWorkflow();

export const WORKFLOW_TEMPLATES = {
  default: DEFAULT_WORKFLOW,
  extended: EXTENDED_WORKFLOW,
  local: LOCAL_WORKFLOW,
  solo: SOLO_WORKFLOW,
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
