/**
 * Compact prompt builder for the LangGraph engine.
 *
 * Unlike router.mjs buildStepPrompt (which reads full stdout logs via
 * priorOutputs), this builder only consumes typed Handoff objects stored in
 * graph state. Raw log files are never read — the log_path pointer is surfaced
 * for the agent to inspect via MCP if needed.
 *
 * question_answers and approval_decisions are capped at 8 entries (same cap
 * as interactions/actions in the legacy builder).
 */

import { schemaSkeleton } from "../schemas/index.mjs";

const RECENT_CAP = 8;

function _priorHandoffText(priorHandoffs = []) {
  if (priorHandoffs.length === 0) return "None yet.";
  return priorHandoffs
    .map((h) => {
      const meta = h.log_path ? `Log: ${h.log_path}` : null;
      const lines = [
        `## Structured handoff from ${h.role}`,
        ...(meta ? [meta] : []),
        JSON.stringify(h.payload, null, 2),
      ];
      return lines.join("\n").trim();
    })
    .join("\n\n");
}

function _answersText(questionAnswers = []) {
  const entries = questionAnswers.slice(-RECENT_CAP);
  if (entries.length === 0) return "None.";
  return entries.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join("\n\n");
}

function _approvalsText(approvalDecisions = []) {
  const entries = approvalDecisions.slice(-RECENT_CAP);
  if (entries.length === 0) return "None.";
  return entries
    .map((e) =>
      [
        `Action: ${e.action ?? "-"}`,
        `Decision: ${e.approved ? "approved" : "denied"}`,
        e.note ? `Note: ${e.note}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function _interactionsText(interactions = []) {
  const entries = interactions.slice(-12);
  if (entries.length === 0) return "None.";
  return entries
    .map((e) =>
      [
        `${e.actor ?? "user"} ${e.type ?? "message"}${e.id ? ` ${e.id}` : ""}: ${e.body ?? ""}`,
        e.approved === undefined ? null : `Approved: ${e.approved ? "yes" : "no"}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function _actionsText(actionRequests = []) {
  const entries = actionRequests.slice(-12);
  if (entries.length === 0) return "None.";
  return entries
    .map((e) =>
      [
        `${e.id ?? "-"} ${e.type ?? "-"} ${e.status ?? "-"}`,
        e.result ? `Result: ${e.result.exit_code ?? "-"} ${e.result.stderr || e.result.stdout || ""}`.trim() : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function _resumeText(task = {}) {
  const parts = [];
  const continuation = String(task?.continuation_prompt ?? "").trim();
  if (continuation) parts.push(`Continuation request:\n${continuation}`);
  const recent = (task?.interactions ?? [])
    .slice(-RECENT_CAP)
    .filter((e) => String(e.body ?? "").trim() || e.approved !== undefined)
    .map((e) =>
      [
        `${e.actor ?? "user"} ${e.type ?? "message"}: ${String(e.body ?? "").trim()}`,
        e.approved === undefined ? null : `Approved: ${e.approved ? "yes" : "no"}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  if (recent.length > 0) parts.push(`Recent user notes:\n${recent.join("\n\n")}`);
  if (parts.length === 0) return "None.";
  return `${parts.join("\n\n")}\n\nDo not repeat the prior blocked action unchanged. Reevaluate before continuing.`;
}

/**
 * Build the per-step prompt from typed handoffs.
 * @param {string} role - "planner" | "executor" | "reviewer" | custom
 * @param {object} task - task object from DB
 * @param {Array}  priorHandoffs - compact typed handoff objects
 * @param {string} handoffMode - "normal" | "strict" (on context retry)
 */
export function buildPromptFromHandoffs({ role, task, priorHandoffs = [], handoffMode = "normal", roleInstructions = "", outputSchema = null }) {
  const taskText = task?.prompt ?? "";
  const prior = _priorHandoffText(priorHandoffs);
  const answers = _answersText(task?.question_answers ?? []);
  const approvals = _approvalsText(task?.approval_decisions ?? []);
  const interactions = _interactionsText(task?.interactions ?? []);
  const actions = _actionsText(task?.action_requests ?? []);
  const resume = _resumeText(task);
  const retryNote = handoffMode === "strict"
    ? "\nAuto-retry note: previous attempt exhausted context window. Use compacted handoffs below, inspect logs only if necessary.\n"
    : "";
  const instructionsBlock = String(roleInstructions ?? "").trim()
    ? `\nAdditional role instructions:\n${String(roleInstructions).trim()}\n`
    : "";

  if (role === "planner") {
    return `Claude plans only. Do not edit files. Do not run destructive commands.
${retryNote}${instructionsBlock}

Task:
${taskText}

User resume directives:
${resume}

User answers:
${answers}

Approval decisions:
${approvals}

Interactions:
${interactions}

Host action requests/results:
${actions}

If you need user input before continuing, output exactly one line starting with:
MAESTRO_QUESTION: <your question>

Return:
- goal
- repo surfaces likely touched
- implementation steps
- tests and verification
- risks or questions

When finished, include exactly one line starting with:
MAESTRO_HANDOFF: {"plan_summary":"","steps":[],"files_to_touch":[]}`;
  }

  if (role === "executor") {
    return `Codex owns execution. Inspect repository state before edits. Preserve user-owned dirty files.
${retryNote}${instructionsBlock}

Task:
${taskText}

User resume directives:
${resume}

User answers:
${answers}

Approval decisions:
${approvals}

Interactions:
${interactions}

Host action requests/results:
${actions}

Prior agent output:
${prior}

If you need user input before continuing, output exactly one line starting with:
MAESTRO_QUESTION: <your question>

If you need Maestro to run a host-side action, output exactly one line starting with:
MAESTRO_ACTION_REQUEST: {"provider":"git","type":"git_commit|git_merge|git_push|git_fetch|git_pull","cwd":"","normalized_args":[],"expected_branch":"","expected_head":"","expected_status_hash":"","expected_remote_url":""}
or:
MAESTRO_ACTION_REQUEST: {"provider":"host","type":"host_command","cwd":"","command":"","args":[],"env":{},"timeout_ms":600000}

When finished, include exactly one line starting with:
MAESTRO_HANDOFF: {"changed_files":[],"verification":[],"residual_risks":[]}

Finish with changed files and verification run.`;
  }

  if (role === "reviewer") {
    return `Codex reviews only. Do not edit files. Review for bugs, contract drift, missing tests, and unsafe agent behavior.
${retryNote}${instructionsBlock}

Task:
${taskText}

User resume directives:
${resume}

User answers:
${answers}

Approval decisions:
${approvals}

Interactions:
${interactions}

Host action requests/results:
${actions}

Prior agent output:
${prior}

If you need user input before continuing, output exactly one line starting with:
MAESTRO_QUESTION: <your question>

Reviewer output is advisory. Maestro decides final task status from the structured marker below.

Return findings first, then exactly one final line starting with:
MAESTRO_REVIEW: {"version":1,"completion_state":"","required_action":"","risk_level":"","confidence":"","summary":"","evidence":[],"blockers":[],"required_user_input":null,"approval_request":null,"action_requests":[],"unblock_options":[],"continuation":null}

Valid completion_state values: complete, incomplete_continueable, incomplete_needs_user, incomplete_needs_approval, blocked_external, blocked_repo_state, blocked_safety, failed_agent, uncertain.
Valid required_action values: none, continue, ask_user, request_approval, manual_fix, retry_after_environment_change, mark_failed.
Use completion_state complete plus risk_level for complete-with-risk cases.
For incomplete_continueable, include continuation: {"prompt":"...","reason":"..."}.`;
  }

  // Fallback for custom roles (e.g. imported subagents). Includes the full
  // marker protocol so custom roles can ask questions, hand off, and loop.
  // When the role declares a resolvable output_schema, the MAESTRO_HANDOFF
  // example is rendered from that schema's required-key skeleton (plus enum
  // notes) so verifier agents reliably emit conforming JSON.
  let handoffExample = '{"summary":"","details":{}}';
  let enumBlock = "";
  if (outputSchema) {
    const { skeleton, enumNotes } = schemaSkeleton(outputSchema);
    handoffExample = JSON.stringify(skeleton);
    if (enumNotes.length > 0) {
      enumBlock = `\nEnum constraints: ${enumNotes.join("; ")}\n`;
    }
  }
  return `Role: ${role}
${retryNote}${instructionsBlock}

Task:
${taskText}

User resume directives:
${resume}

User answers:
${answers}

Interactions:
${interactions}

Prior agent output:
${prior}

If you need user input before continuing, output exactly one line starting with:
MAESTRO_QUESTION: <your question>

When finished, include exactly one line starting with:
MAESTRO_HANDOFF: ${handoffExample}
${enumBlock}
If this role's workflow transitions define custom events (e.g. "revise"), you
may route the workflow by adding an "event" field to the handoff JSON, e.g.:
MAESTRO_HANDOFF: {"event":"revise","summary":"why revision is needed"}`;
}
