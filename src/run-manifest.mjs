// Run manifest — a self-contained snapshot of a run's *inputs*, written by the
// engine to <run_dir>/run-manifest.json at run start. It embeds the resolved
// workflow snapshot, the replayable task input knobs (an explicit allow-list),
// the provider/model settings, git start_head, and the maestro version, so a
// later edit to the named workflow cannot change what a replay runs.
//
// buildRunManifest and manifestToTaskInputs are PURE and TOTAL: they never read
// disk and never throw, degrading missing fields to null/[] rather than failing.
// The manifest is an internal artifact (shape-tested, not a registered schema).

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { isValidWorkflowName } from "./task-store.mjs";
import { buildToolPolicyRecord } from "./adapters/tool-flags.mjs";

export const MANIFEST_VERSION = 1;

// Exactly the replayable input knobs (snake_case as stored on the task object).
// Identity/derived/instance fields (id, status, steps, start_head, branch,
// worktree_path, run_dir, project_id, source_issue_id, timestamps, active_*,
// planner_decision/reason) are deliberately EXCLUDED so a replay is a clean new
// task, not a clone.
const TASK_INPUT_KEYS = [
  "prompt",
  "mode",
  "workflow",
  "cwd",
  "planner_policy",
  "review_enabled",
  "timeout_ms",
  "stream_tail_bytes",
  "context_retry_limit",
  "claude_command",
  "codex_command",
  "planner_model",
  "claude_effort",
  "executor_model",
  "executor_effort",
  "reviewer_model",
  "reviewer_effort",
  "worktree_mode",
  "write_paths",
];

// Map of manifest task-block snake_case keys → createTask camelCase arg names.
// `workflow` is intentionally absent — rerun's caller sets the pinned name.
const SNAKE_TO_CAMEL = {
  prompt: "prompt",
  mode: "mode",
  cwd: "cwd",
  planner_policy: "plannerPolicy",
  review_enabled: "reviewEnabled",
  timeout_ms: "timeoutMs",
  stream_tail_bytes: "streamTailBytes",
  context_retry_limit: "contextRetryLimit",
  claude_command: "claudeCommand",
  codex_command: "codexCommand",
  planner_model: "plannerModel",
  claude_effort: "claudeEffort",
  executor_model: "executorModel",
  executor_effort: "executorEffort",
  reviewer_model: "reviewerModel",
  reviewer_effort: "reviewerEffort",
  worktree_mode: "worktreeMode",
  write_paths: "writePaths",
};

/**
 * Read the maestro version from package.json. run-manifest.mjs lives in src/,
 * so package.json is one level up — req("../package.json"). Total: any failure
 * (missing/unreadable) degrades to "0.0.0".
 */
export function readMaestroVersion() {
  try {
    const req = createRequire(fileURLToPath(import.meta.url));
    return req("../package.json").version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Turn a source task id into a workflow name that satisfies WORKFLOW_NAME_RE
 * (`/^[a-z0-9][a-z0-9_-]{0,63}$/`, max 64 chars). Task ids routinely push
 * "rerun-<id>" past 64 chars, so sanitization is mandatory: lowercase, replace
 * invalid chars with "-", strip invalid leading chars, slice to 64, strip
 * trailing -/_. Falls back to "rerun" if nothing valid remains. The result is
 * always a valid workflow name. (A long-id prefix collision is acceptable:
 * re-pinning the same snapshot is idempotent.)
 */
export function sanitizeRerunWorkflowName(id) {
  const name = `rerun-${id ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-_]+$/, "");
  return isValidWorkflowName(name) ? name : "rerun";
}

/**
 * Build a run manifest from a task + resolved workflow. PURE and TOTAL: never
 * reads disk, never throws; missing task fields become null (write_paths → []).
 *
 * @param {object} args
 * @param {object} [args.task]            task object (snake_case input knobs)
 * @param {object} [args.workflow]        resolved workflow snapshot to embed
 * @param {string} [args.maestroVersion]
 * @param {string|null} [args.startHead]  git HEAD at run start (or null)
 * @returns {object} manifest
 */
export function buildRunManifest({ task, workflow, maestroVersion, startHead } = {}) {
  const t = task ?? {};
  const taskBlock = {};
  for (const key of TASK_INPUT_KEYS) {
    if (key === "write_paths") {
      taskBlock[key] = Array.isArray(t.write_paths) ? t.write_paths : [];
    } else {
      taskBlock[key] = t[key] ?? null;
    }
  }
  // Resolved per-role tool policy (MRC §5.6). Pure/total: any role with
  // declared tools/deny_tools contributes a record; degrades to [] otherwise.
  const toolPolicies = [];
  for (const [stateName, role] of Object.entries(workflow?.roles ?? {})) {
    if (!role || (role.tools === undefined && role.deny_tools === undefined)) continue;
    toolPolicies.push(buildToolPolicyRecord({
      role: stateName,
      provider: role.provider,
      tools: role.tools,
      deny_tools: role.deny_tools,
    }));
  }
  const manifest = {
    manifest_version: MANIFEST_VERSION,
    maestro_version: maestroVersion ?? null,
    created_at: new Date().toISOString(),
    source_task_id: t.id ?? null,
    task: taskBlock,
    workflow_snapshot: workflow ?? null,
    tool_policies: toolPolicies,
    git: { start_head: startHead ?? null },
    run_dir: t.run_dir ?? null,
  };
  if (Array.isArray(workflow?.parallel_groups) && workflow.parallel_groups.length > 0) {
    manifest.resolved_parallel_groups = workflow.parallel_groups;
  }
  return manifest;
}

/**
 * Map a manifest's task block to createTask() camelCase arguments. Does NOT set
 * `workflow` — the rerun caller pins the snapshot under a sanitized name and
 * sets it explicitly. Tolerates a partial/absent manifest (omits missing keys).
 */
export function manifestToTaskInputs(manifest) {
  const t = manifest?.task ?? {};
  const inputs = {};
  for (const [snake, camel] of Object.entries(SNAKE_TO_CAMEL)) {
    if (snake in t) inputs[camel] = t[snake];
  }
  return inputs;
}
