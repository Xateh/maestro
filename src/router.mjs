import { headroomCompact } from "./compress.mjs";

let _headroomWarnedThisRun = false;

export const DEFAULT_AGENT_POLICY = {
  agents: {
    planner: "claude",
    executor: "codex",
    reviewer: "codex",
    copilot: "disabled",
  },
  flows: {
    task: ["planner", "executor", "reviewer"],
    "plan-only": ["planner"],
  },
};

const PLANNER_AUTO_PATTERNS = [
  /\barchitect(?:ure|ural)?\b/i,
  /\bdesign\b/i,
  /\bplan(?:ning)?\b/i,
  /\brefactor\b/i,
  /\bmaxtwin\b/i,
  /\bmax-twin\b/i,
  /\bsecurity\b/i,
  /\bmigration\b/i,
  /\bapi contract\b/i,
  /\bcontract\b/i,
  /\btest(?:s|ing)?\b/i,
  /\bui\b/i,
  /\btui\b/i,
  /\bsettings?\b/i,
  /\bhistory\b/i,
  /\borchestrat(?:e|ion|or)\b/i,
  /\bmulti[- ]?file\b/i,
  /\bcross[- ]?app\b/i,
  /\bworkflow\b/i,
];

const PRIOR_OUTPUT_LIMITS = {
  normal: {
    entryBytes: 12_000,
    headBytes: 4_000,
    tailBytes: 4_000,
  },
  strict: {
    entryBytes: 6_000,
    headBytes: 2_000,
    tailBytes: 2_000,
  },
};

function policyValue(policy, key, fallback) {
  const value = policy?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

export function evaluatePlannerDecision({
  plannerPolicy = "auto",
  prompt = "",
  mode = "task",
} = {}) {
  if (mode === "plan-only") {
    return {
      policy: plannerPolicy,
      decision: "used",
      reason: "plan-only mode requires planner",
    };
  }
  if (plannerPolicy === "on") {
    return {
      policy: plannerPolicy,
      decision: "used",
      reason: "planner forced on",
    };
  }
  if (plannerPolicy === "off") {
    return {
      policy: plannerPolicy,
      decision: "skipped",
      reason: "planner forced off",
    };
  }

  const matched = PLANNER_AUTO_PATTERNS.find((pattern) => pattern.test(prompt));
  if (matched) {
    return {
      policy: "auto",
      decision: "used",
      reason: `matched ${matched.source}`,
    };
  }
  return {
    policy: "auto",
    decision: "skipped",
    reason: "no complexity trigger matched",
  };
}

export function resolveAgentFlow({
  mode = "task",
  policy = DEFAULT_AGENT_POLICY,
  plannerPolicy = "auto",
  reviewEnabled = true,
  prompt = "",
} = {}) {
  const agents = policyValue(policy, "agents", DEFAULT_AGENT_POLICY.agents);
  let roles;
  if (mode === "plan-only") {
    roles = ["planner"];
  } else {
    const planner = evaluatePlannerDecision({ plannerPolicy, prompt, mode });
    roles = [];
    if (planner.decision === "used") roles.push("planner");
    roles.push("executor");
    if (reviewEnabled) roles.push("reviewer");
  }
  return roles.map((role) => ({
    role,
    provider: agents[role] ?? role,
  }));
}

function trimUtf8(value, maxBytes, fromEnd = false) {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  const slice = fromEnd
    ? buffer.subarray(Math.max(0, buffer.length - maxBytes))
    : buffer.subarray(0, maxBytes);
  return slice.toString("utf8").replace(/^�|�$/g, "");
}

async function compactPriorOutput(entry = {}, { handoffMode = "normal", compression = "bytes" } = {}) {
  const limits = PRIOR_OUTPUT_LIMITS[handoffMode] ?? PRIOR_OUTPUT_LIMITS.normal;
  const output = String(entry.output ?? "");
  const originalBytes = entry.originalBytes ?? Buffer.byteLength(output, "utf8");
  const stdoutPath = entry.stdoutPath ?? entry.stdout_path;
  const stderrPath = entry.stderrPath ?? entry.stderr_path;
  if (originalBytes <= limits.entryBytes) {
    return {
      compacted: false,
      originalBytes,
      text: output,
      stdoutPath,
      stderrPath,
    };
  }

  if (compression === "headroom") {
    const hr = await headroomCompact(output);
    if (hr && !hr.error) {
      return {
        compacted: true,
        compressedBy: "headroom",
        originalBytes,
        compressedBytes: hr.compressedBytes,
        text: hr.text,
        stdoutPath,
        stderrPath,
      };
    }
    const head = trimUtf8(output, limits.headBytes);
    const tail = trimUtf8(output, limits.tailBytes, true);
    const omittedBytes = Math.max(0, originalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"));
    return {
      compacted: true,
      headroomFailed: hr?.error === true, // proxy error, not "no improvement"
      originalBytes,
      text: omittedBytes > 0
        ? `${head}\n\n[... ${omittedBytes} bytes omitted from prior agent stdout ...]\n\n${tail}`
        : output,
      stdoutPath,
      stderrPath,
    };
  }

  const head = trimUtf8(output, limits.headBytes);
  const tail = trimUtf8(output, limits.tailBytes, true);
  const omittedBytes = Math.max(0, originalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"));
  return {
    compacted: true,
    originalBytes,
    text: `${head}\n\n[... ${omittedBytes} bytes omitted from prior agent stdout ...]\n\n${tail}`,
    stdoutPath,
    stderrPath,
  };
}

async function priorOutputText(priorOutputs = [], { handoffMode = "normal", compression = "bytes" } = {}) {
  if (priorOutputs.length === 0) return "None yet.";
  const parts = await Promise.all(
    priorOutputs.map(async (entry) => {
      if (entry.handoff) {
        const metadata = [
          entry.stdoutPath ? `Log: ${entry.stdoutPath}` : null,
          entry.stderrPath ? `Error log: ${entry.stderrPath}` : null,
          entry.handoffPath ? `Handoff: ${entry.handoffPath}` : null,
        ].filter(Boolean);
        return [
          `## Structured handoff from ${entry.role}`,
          ...metadata,
          JSON.stringify(entry.handoff, null, 2),
        ].join("\n").trim();
      }
      const compacted = await compactPriorOutput(entry, { handoffMode, compression });
      if (compacted.headroomFailed && !_headroomWarnedThisRun) {
        _headroomWarnedThisRun = true;
        process.stderr.write(
          "[maestro:headroom] WARNING: headroom compression unavailable — proxy down or insufficient resources. " +
          "Fell back to byte-trim. Run: npm run headroom:setup\n",
        );
      }
      const heading = compacted.compacted
        ? `## ${entry.role} output compacted`
        : `## ${entry.role} output`;
      const compressNote = compacted.compressedBy === "headroom"
        ? `Compression: headroom (${compacted.compressedBytes} bytes)`
        : `Shown mode: ${handoffMode}`;
      const metadata = [
        `Original bytes: ${compacted.originalBytes}`,
        compacted.compacted ? compressNote : null,
        compacted.headroomFailed ? "Compression: headroom unavailable — byte-trim fallback active. Run: npm run headroom:setup" : null,
        compacted.stdoutPath ? `Log: ${compacted.stdoutPath}` : null,
        compacted.stderrPath ? `Error log: ${compacted.stderrPath}` : null,
      ].filter(Boolean);
      return [
        heading,
        ...metadata,
        compacted.text || "(no stdout)",
      ].join("\n").trim();
    }),
  );
  return parts.join("\n\n");
}

function questionAnswerText(questionAnswers = []) {
  if (questionAnswers.length === 0) return "None.";
  return questionAnswers
    .map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`)
    .join("\n\n");
}

function approvalDecisionText(approvalDecisions = []) {
  if (approvalDecisions.length === 0) return "None.";
  return approvalDecisions
    .map((entry) => [
      `Action: ${entry.action ?? "-"}`,
      `Decision: ${entry.approved ? "approved" : "denied"}`,
      entry.note ? `Note: ${entry.note}` : null,
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

function interactionText(interactions = []) {
  if (interactions.length === 0) return "None.";
  return interactions
    .slice(-12)
    .map((entry) => [
      `${entry.actor ?? "user"} ${entry.type ?? "message"}${entry.id ? ` ${entry.id}` : ""}: ${entry.body ?? ""}`,
      entry.approved === undefined ? null : `Approved: ${entry.approved ? "yes" : "no"}`,
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

function resumeDirectiveText(task = {}) {
  const parts = [];
  const continuation = String(task?.continuation_prompt ?? "").trim();
  if (continuation) {
    parts.push(`Continuation request:\n${continuation}`);
  }

  const recent = (task?.interactions ?? [])
    .slice(-8)
    .filter((entry) => {
      const body = String(entry.body ?? "").trim();
      return body || entry.approved !== undefined || entry.force_parallel === true || entry.observed === true;
    })
    .map((entry) => [
      `${entry.actor ?? "user"} ${entry.type ?? "message"}${entry.action_id ? ` ${entry.action_id}` : ""}: ${String(entry.body ?? "").trim()}`,
      entry.approved === undefined ? null : `Approved: ${entry.approved ? "yes" : "no"}`,
      entry.force_parallel === true ? "Force parallel: yes" : null,
      entry.observed === true ? "Observed: yes" : null,
    ].filter(Boolean).join("\n"));

  if (recent.length > 0) {
    parts.push(`Recent user notes/actions:\n${recent.join("\n\n")}`);
  }

  if (parts.length === 0) return "None.";
  return `${parts.join("\n\n")}\n\nDo not repeat the prior blocked action unchanged. Reevaluate the next action using this latest user direction before continuing.`;
}

function actionRequestText(actionRequests = []) {
  if (actionRequests.length === 0) return "None.";
  return actionRequests
    .slice(-12)
    .map((entry) => [
      `${entry.id ?? "-"} ${entry.type ?? "-"} ${entry.status ?? "-"}`,
      entry.cwd ? `Cwd: ${entry.cwd}` : null,
      Array.isArray(entry.normalized_args) ? `Args: git ${entry.normalized_args.join(" ")}` : null,
      entry.command ? `Command: ${[entry.command, ...(entry.args ?? [])].join(" ")}` : null,
      entry.result?.stdout_path ? `Stdout log: ${entry.result.stdout_path}` : null,
      entry.result?.stderr_path ? `Stderr log: ${entry.result.stderr_path}` : null,
      entry.result ? `Result: ${entry.result.exit_code ?? entry.result.code ?? "-"} ${entry.result.stderr || entry.result.stdout || ""}`.trim() : null,
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

export async function buildStepPrompt({ role, task, priorOutputs = [], handoffMode = "normal", compression = "bytes" }) {
  const taskText = task?.prompt ?? "";
  const prior = await priorOutputText(priorOutputs, { handoffMode, compression });
  const answers = questionAnswerText(task?.question_answers ?? []);
  const approvals = approvalDecisionText(task?.approval_decisions ?? []);
  const interactions = interactionText(task?.interactions ?? []);
  const resumeDirectives = resumeDirectiveText(task);
  const actions = actionRequestText(task?.action_requests ?? []);
  const retryNote = handoffMode === "strict"
    ? "\nAuto-retry note: the previous attempt exhausted the agent context window. Use the compacted handoff below, inspect referenced logs only when necessary, and continue the same task without asking the user to restate it.\n"
    : "";

  if (role === "planner") {
    return `Claude plans only. Do not edit files. Do not run destructive commands.
${retryNote}

Task:
${taskText}

User resume directives:
${resumeDirectives}

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
    return `Codex owns execution. Inspect repository state before edits. Preserve user-owned dirty files. Implement the task using the plan when useful.
${retryNote}

Task:
${taskText}

User resume directives:
${resumeDirectives}

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
    return `Codex reviews only. Do not edit files. Review the current work for bugs, contract drift, missing tests, and unsafe agent behavior.
${retryNote}

Task:
${taskText}

User resume directives:
${resumeDirectives}

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
Use completion_state complete plus risk_level for complete-with-risk cases. Use incomplete_continueable only when a safe next Codex executor pass can finish without user input, approval, privileged commands, remote push/pull/fetch, destructive git, or unsafe repo state.
For incomplete_needs_user, include required_user_input: {"question":"..."}.
For incomplete_needs_approval, include approval_request: {"action":"...","reason":"..."}.
For typed host approvals, include action_requests with provider git and type git_commit, git_merge, git_push, git_fetch, or git_pull, or provider host and type host_command with exact argv. Do not ask Maestro to run shell fragments unless the command is explicitly a shell executable plus argv.
For incomplete_continueable, include continuation: {"prompt":"...","reason":"..."}.
Never suggest commands that Maestro should execute directly; describe needed action only.`;
  }

  return `Role: ${role}
${retryNote}

Task:
${taskText}

User resume directives:
${resumeDirectives}

User answers:
${answers}

Approval decisions:
${approvals}

Interactions:
${interactions}

Host action requests/results:
${actions}

Prior agent output:
${prior}`;
}
