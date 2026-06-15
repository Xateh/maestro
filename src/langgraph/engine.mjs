/**
 * LangGraph execution engine for Maestro.
 *
 * Activated via MAESTRO_ENGINE=langgraph. Replaces the state-machine loop in
 * maestro.mjs with a LangGraph StateGraph while keeping every other concern
 * (herdr CLI execution, run-dir files, MCP tools) unchanged.
 *
 * Token-efficiency contract: only compact typed Handoff objects flow between
 * roles — never raw stdout. Raw logs stay on disk; DB stores their paths.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { HerdrAgentRunner } from "../herdr-agent-runner.mjs";
import { TerminalAgentRunner, directCommandExists } from "../agent-runner.mjs";
import { openStore } from "../db/store.mjs";
import { buildGraph } from "./graph.mjs";
import { resolveInitialState, isTerminalAfterState } from "../state-machine.mjs";
import { findCycles, validateWorkflow } from "../workflow-validate.mjs";
import { DEFAULT_LOCAL_STATE_DIR } from "../task-store.mjs";
import { REVIEW_MAX_CONTINUATIONS, skippedReview } from "../markers.mjs";
import { emitOtelStageEvent, getStageEvents } from "../stage-events.mjs";

// maestroRoot = taskStore.root = resolved .maestro/ directory
function _dbPath(maestroRoot) {
  return path.join(maestroRoot, "maestro.db");
}

// Cache the herdr PATH probe per process: one scan, not one per task run.
let _herdrProbe = null;
let _fallbackNoticeShown = false;

/**
 * Pick the agent runner backend. MAESTRO_BACKEND=terminal forces the terminal
 * runner; any other value (or none) auto-selects herdr when its binary exists
 * and falls back to the terminal runner (with a one-line notice) when it does
 * not. Exported for tests; passing commandExists bypasses the process cache.
 */
export async function resolveAgentRunner(timeoutMs, {
  db = null,
  env = process.env,
  stderr = process.stderr,
  commandExists = null,
} = {}) {
  if (env.MAESTRO_BACKEND === "terminal") {
    return new TerminalAgentRunner({ timeoutMs });
  }
  const herdrBin = env.HERDR_BIN ?? "herdr";
  let available;
  if (commandExists) {
    available = await commandExists(herdrBin, { cwd: process.cwd(), env });
  } else {
    if (_herdrProbe === null) _herdrProbe = directCommandExists(herdrBin, { cwd: process.cwd() });
    available = await _herdrProbe;
  }
  if (!available) {
    if (!_fallbackNoticeShown || commandExists) {
      _fallbackNoticeShown = true;
      try {
        stderr.write("herdr not found — using terminal backend (set MAESTRO_BACKEND=terminal to silence)\n");
      } catch { /* best effort */ }
    }
    return new TerminalAgentRunner({ timeoutMs });
  }
  // tabStore persists herdr tab ids across runner instances so resumed tasks
  // reuse their tab (conversation trail) instead of opening a new one.
  const tabStore = db ? {
    get: async (taskId) => (await db.getTask(taskId))?.herdr_tab_id ?? null,
    set: async (taskId, tabId) => { await db.updateTask(taskId, { herdr_tab_id: tabId }); },
  } : null;
  return new HerdrAgentRunner({ timeoutMs, tabStore });
}

// Close the task's herdr tab according to config policy. Tabs for tasks that
// still need the user (waiting_user, waiting_approval, needs_review) are never
// closed — the conversation stays visible as a trail until the task resumes.
async function _maybeCloseTab(runner, taskId, config, status) {
  const policy = config?.herdr?.close_tab_on ?? "success";
  if (policy === "never") return;
  const closable = policy === "terminal" ? ["succeeded", "failed"] : ["succeeded"];
  if (!closable.includes(status)) return;
  try {
    await runner.closeTab?.(taskId);
  } catch { /* best effort */ }
}

function _reviewStatusForCompletionState(review) {
  if (review.completion_state === "uncertain") return "waiting_user";
  if (review.status === "skipped") return "succeeded";
  if (review.status !== "reviewed") return "incomplete";
  if (review.completion_state === "complete") return "succeeded";
  if (review.completion_state === "failed_agent") return "waiting_user";
  if (["blocked_external", "blocked_repo_state", "blocked_safety"].includes(review.completion_state)) return "waiting_user";
  if (review.completion_state === "incomplete_needs_user") return "waiting_user";
  if (review.completion_state === "incomplete_needs_approval") return "waiting_approval";
  return "incomplete";
}

/**
 * Apply reviewer outcome — full parity with maestro.mjs applyReviewOutcome.
 * Operates on the SQLite DB; caller mirrors to legacy taskStore after.
 */
async function _applyReviewerOutcome(db, taskId, review, ops) {
  const {
    buildUnblockOptions = () => [],
    canonicalizeActionRequestsForTask = null,
    releasePathLeases = null,
    markProjectTaskStatus = null,
    finalizeProjectTask = null,
  } = ops ?? {};

  const basePatch = { review, active_step: null, active_question: null };

  // ── incomplete_continueable ───────────────────────────────────────────────
  if (
    review.status === "reviewed"
    && review.completion_state === "incomplete_continueable"
    && review.required_action === "continue"
  ) {
    const continuationPrompt = review.continuation?.prompt;
    const attempts = review.continuation_attempts ?? 0;
    const maxContinuations = review.max_continuations ?? REVIEW_MAX_CONTINUATIONS;
    if (continuationPrompt && attempts < maxContinuations) {
      const continuedReview = { ...review, continuation_attempts: attempts + 1, max_continuations: maxContinuations };
      const updated = await db.updateTask(taskId, {
        ...basePatch,
        status: "queued",
        review: continuedReview,
        continuation_prompt: continuationPrompt,
      });
      if (markProjectTaskStatus) await markProjectTaskStatus(updated, "queued", { review: continuedReview });
      return updated;
    }
    const exhausted = {
      ...review,
      summary: review.summary || "Continuation budget exhausted or reviewer did not provide a continuation prompt.",
    };
    const task = await db.getTask(taskId);
    const exhaustedBlockers = [{ code: "continuation_exhausted", summary: exhausted.summary }, ...(task.blockers ?? [])];
    const updated = await db.updateTask(taskId, {
      ...basePatch,
      status: "waiting_user",
      review: exhausted,
      continuation_prompt: null,
      blockers: exhaustedBlockers,
      unblock_options: buildUnblockOptions({
        task: { ...task, blockers: exhaustedBlockers },
        includeRetry: true,
        includeManualDone: true,
      }),
    });
    if (markProjectTaskStatus) await markProjectTaskStatus(updated, "waiting_user", { review: exhausted });
    return updated;
  }

  // ── incomplete_needs_user ─────────────────────────────────────────────────
  if (review.status === "reviewed" && review.completion_state === "incomplete_needs_user") {
    const task = await db.getTask(taskId);
    const question = review.required_user_input?.question || review.summary || "Reviewer needs user input.";
    const questionId = `q${(task.question_answers ?? []).length + 1}`;
    const reviewerProvider = (task.steps ?? []).findLast?.((s) => s.role === "reviewer")?.provider ?? null;
    const activeQuestion = { id: questionId, role: "reviewer", provider: reviewerProvider, question, reason: review.required_user_input?.reason ?? null };
    const updated = await db.updateTask(taskId, {
      ...basePatch,
      status: "waiting_user",
      active_question: activeQuestion,
      unblock_options: buildUnblockOptions({ task, includeAnswer: true, includeRetry: true }),
    });
    if (markProjectTaskStatus) await markProjectTaskStatus(updated, "waiting_user", { review });
    return updated;
  }

  // ── incomplete_needs_approval ─────────────────────────────────────────────
  if (review.status === "reviewed" && review.completion_state === "incomplete_needs_approval") {
    const task = await db.getTask(taskId);
    const reviewRequests = (review.action_requests ?? []).map((r, i) => ({
      ...r,
      id: r.id || `act-${i + 1}`,
      status: r.status || "pending",
      cwd: r.cwd || task.cwd || ".",
      continuation_generation: task.continuation_generation ?? 0,
    }));
    let actionPatch;
    if (canonicalizeActionRequestsForTask && reviewRequests.length > 0) {
      const canonical = canonicalizeActionRequestsForTask(task, reviewRequests);
      actionPatch = {
        action_requests: canonical.action_requests,
        blockers: canonical.blockers,
        unblock_options: canonical.unblock_options,
      };
    } else {
      actionPatch = {
        action_requests: [...(task.action_requests ?? []), ...reviewRequests],
        unblock_options: buildUnblockOptions({ task, includeManualDone: true }),
      };
    }
    // Mirror legacy: set active_approval when no action_requests (approval_request flow)
    const activeApproval = reviewRequests.length === 0 ? {
      id: `a${(task.approval_decisions ?? []).length + 1}`,
      role: "reviewer",
      provider: (task.steps ?? []).findLast?.((s) => s.role === "reviewer")?.provider ?? null,
      action: review.approval_request?.action || "Approval required before Maestro can continue.",
      reason: review.approval_request?.reason || review.summary || "",
      requested_at: new Date().toISOString(),
    } : null;
    const updated = await db.updateTask(taskId, {
      ...basePatch,
      status: "waiting_approval",
      active_approval: activeApproval,
      ...actionPatch,
    });
    if (markProjectTaskStatus) await markProjectTaskStatus(updated, "waiting_approval", { review });
    return updated;
  }

  // ── all other states ──────────────────────────────────────────────────────
  const status = _reviewStatusForCompletionState(review);
  const task = await db.getTask(taskId);
  let updated = await db.updateTask(taskId, {
    ...basePatch,
    status,
    continuation_prompt: null,
    blockers: review.blockers?.length ? review.blockers : task.blockers,
    unblock_options: status === "waiting_user"
      ? buildUnblockOptions({ task, includeRetry: true, includeManualDone: true })
      : [],
  });

  if (status === "succeeded") {
    if (finalizeProjectTask) {
      updated = await finalizeProjectTask(updated);
      if (updated.status === "waiting_user") return updated;
    }
    updated = await db.updateTask(taskId, { status: "succeeded", active_step: null, review });
    if (releasePathLeases) await releasePathLeases(updated);
  }

  if (markProjectTaskStatus) await markProjectTaskStatus(updated, status, { review });
  return updated;
}

// ── active-step live mirror ───────────────────────────────────────────────────
// Nodes call this via ops.markActiveStep so the legacy JSON store reflects the
// running step immediately (not just at the end of the graph).
function _makeMarkActiveStep(taskStore) {
  return async (taskId, activeStep) => {
    await taskStore.updateTask(taskId, { status: "running", active_step: activeStep });
  };
}

// Fields mirrored from SQLite DB back to the legacy JSON task store after each run.
function _mirrorPatch(dbTask) {
  return {
    status: dbTask.status,
    steps: dbTask.steps ?? [],
    active_step: dbTask.active_step ?? null,
    review: dbTask.review ?? null,
    active_question: dbTask.active_question ?? null,
    active_approval: dbTask.active_approval ?? null,
    action_requests: dbTask.action_requests ?? null,
    blockers: dbTask.blockers ?? null,
    unblock_options: dbTask.unblock_options ?? [],
    continuation_prompt: dbTask.continuation_prompt ?? null,
    observed_head: dbTask.observed_head ?? null,
    herdr_tab_id: dbTask.herdr_tab_id ?? null,
  };
}

// ── main entry point ──────────────────────────────────────────────────────────

/**
 * Run a task through the LangGraph orchestration engine.
 *
 * @param {string} taskId
 * @param {object} opts
 * @param {object} opts.taskStore       - LocalTaskStore (legacy JSON store; used for workflow + config reads, status mirror)
 * @param {string} opts.maestroRoot    - repo root (parent of .maestro/)
 * @param {object} [opts.runner]        - override agent runner (for tests)
 * @param {object} [opts.stdout]        - writable for progress lines
 * @param {object} [opts.stderr]        - writable for error lines
 * @param {object} [opts.ops]           - project-mode helpers bound by maestro.mjs
 * @returns {Promise<{task: object}>}
 */
export async function runLangGraphTask(taskId, {
  taskStore,
  maestroRoot = DEFAULT_LOCAL_STATE_DIR,
  runner = null,
  stdout = process.stdout,
  stderr = process.stderr,
  ops = {},
  availabilityProbe = null,
} = {}) {
  const write = (stream, msg) => { try { stream.write(`${msg}\n`); } catch {} };

  // ── open store (SQLite or PostgreSQL based on DATABASE_URL) ─────────────
  const db = await openStore(_dbPath(maestroRoot));

  // ── load or migrate task into DB ──────────────────────────────────────────
  // Re-read from legacy store so CLI-command updates (extend-timeout, message,
  // approve, etc.) that write JSON are visible in the DB before the graph runs.
  //
  // IMPORTANT: only sync *input* fields — never copy execution fields
  // (steps, review, active_step, blockers, …) from JSON into the DB on resume.
  // The DB is ahead of JSON for those fields (it's written every turn), so
  // overwriting them with the staler JSON would corrupt the resume state (A3/R5).
  const INPUT_SYNC_FIELDS = [
    "prompt", "question_answers", "approval_decisions", "continuation_prompt",
    "action_requests", "review_enabled", "timeout_ms", "role_skips",
    // Provider-availability recovery inputs (switch_provider / approve_substitution).
    "role_overrides", "auto_fallback_confirmed",
    "planner_policy", "cwd", "branch", "run_dir", "mode", "workflow", "worktree_path",
    "project_id", "start_head", "stream_tail_bytes",
    // User-visible audit trail — readable by prompts and callers via result.task.
    "interactions",
  ];
  const legacyTask = await taskStore.readTask(taskId);
  if (!legacyTask) throw new Error(`task_not_found: ${taskId}`);
  let task = await db.getTask(taskId);
  if (!task) {
    task = await db.createTask(legacyTask);
  } else {
    const inputPatch = Object.fromEntries(
      INPUT_SYNC_FIELDS.filter((k) => k in legacyTask).map((k) => [k, legacyTask[k]]),
    );
    task = await db.updateTask(taskId, inputPatch);
  }

  if (task.run_dir) {
    await fs.mkdir(task.run_dir, { recursive: true });
  }

  // ── load workflow (by task.workflow) + config ─────────────────────────────
  const workflowName = task.workflow ?? "default";
  const [workflow, config] = await Promise.all([
    taskStore.readWorkflow(workflowName),
    taskStore.readConfig(),
  ]);

  // Unknown non-default workflow → surface as a recoverable waiting_user blocker
  // (typed, not a throw) before the graph builds.
  if (!workflow) {
    await db.updateTask(taskId, {
      status: "waiting_user",
      active_step: null,
      blockers: [{ code: "unknown_workflow", workflow: workflowName }],
    });
    const blockedTask = await db.getTask(taskId);
    await taskStore.updateTask(taskId, _mirrorPatch(blockedTask));
    return { task: blockedTask };
  }

  // Surface workflow problems (e.g. unterminated cycles) without blocking the run.
  const validation = validateWorkflow(workflow, { config });
  for (const problem of [...validation.errors, ...validation.warnings]) {
    write(stderr, `workflow ${validation.errors.includes(problem) ? "error" : "warning"} [${problem.code}]: ${problem.message}`);
  }

  // ── build runner ──────────────────────────────────────────────────────────
  const agentRunner = runner ?? await resolveAgentRunner(task.timeout_ms, { db, stderr });

  // ── determine initial state for this run ─────────────────────────────────
  const initialState = task.current_state ?? resolveInitialState(workflow, { mode: task.mode });

  // ── continuation cycle: evict executor+reviewer handoffs so they re-run ──
  // When a task is resumed after approve/answer, continuation_prompt is set.
  // Executor needs to act on the approval; reviewer verifies the result.
  // Both handoffs must be removed so those nodes don't skip themselves
  // (priorHandoffs acts as a "completed" set).
  if (task.continuation_prompt) {
    await db.deleteHandoffsByRole(taskId, "executor");
    await db.deleteHandoffsByRole(taskId, "reviewer");
  }

  // ── loop-limit recovery: the capped cycle must re-run on resume ──────────
  // A role paused by max_visits/loop_limits already has a handoff from its
  // last visit; without eviction every cycle role would resume-skip and the
  // task would falsely complete with zero agent calls. Evict the whole cycle
  // (not just the capped role) so the fresh round is also re-checked. The
  // user's answer grants one fresh visit budget and reaches the roles via
  // question_answers in the prompt.
  const loopBlocked = (task.blockers ?? []).filter((b) => b.code === "loop_limit_exceeded");
  if (loopBlocked.length > 0) {
    const cycles = findCycles(workflow.transitions ?? {});
    for (const blocker of loopBlocked) {
      if (!blocker.role) continue;
      const cycleRoles = new Set([blocker.role]);
      for (const cycle of cycles) {
        if (cycle.includes(blocker.role)) for (const role of cycle) cycleRoles.add(role);
      }
      for (const role of cycleRoles) await db.deleteHandoffsByRole(taskId, role);
    }
    task = await db.updateTask(taskId, {
      blockers: (task.blockers ?? []).filter((b) => b.code !== "loop_limit_exceeded"),
    });
  }

  // ── load prior handoffs from DB (for resume) ─────────────────────────────
  const priorHandoffs = await db.getHandoffs(taskId);

  write(stdout, `task ${taskId} engine=langgraph state=${initialState} handoffs=${priorHandoffs.length}`);

  // ── build graph (fresh per call — ops are per-call closures) ─────────────
  // Inject markActiveStep so nodes can mirror active_step to legacy store in real-time.
  // resumeCompletedRoles: roles with a handoff from a previous run of this task
  // skip on first arrival but re-run on cycle revisits (loop support).
  const graphOps = { ...ops, markActiveStep: _makeMarkActiveStep(taskStore) };
  const graph = buildGraph(workflow, config, {
    db,
    runner: agentRunner,
    ops: graphOps,
    entry: resolveInitialState(workflow, { mode: task.mode }),
    resumeCompletedRoles: new Set(priorHandoffs.map((h) => h.role)),
    availabilityProbe,
  });

  // ── run the graph ─────────────────────────────────────────────────────────
  const threadConfig = {
    configurable: { thread_id: `${taskId}-${Date.now()}` },
    recursionLimit: (config.max_steps ?? 20) * 2,
  };

  let finalState = null;
  // ── OTel seam: one place, every return path ──────────────────────────────
  // Wrap the stream consumption through every final return in an OUTER try so
  // a finally can mirror the recorded steps as `maestro.stage` spans exactly
  // once per run. The emit is fully guarded (re-read + iterate in its own
  // try/catch); observability never breaks a run, and it is a no-op when no
  // OTel SDK is registered.
  try {
  try {
    const stream = await graph.stream(
      { task, priorHandoffs, currentState: initialState, event: null },
      { ...threadConfig, streamMode: "values" },
    );
    for await (const state of stream) {
      finalState = state;
      write(stdout, `task ${taskId} role=${state.currentState} event=${state.event}`);
    }
  } catch (err) {
    write(stderr, `task ${taskId} langgraph error: ${err.message}`);
    await db.updateTask(taskId, {
      status: "waiting_user",
      active_step: null,
      blockers: [{ code: "engine_error", message: err.message }],
    });
    const errTask = await db.getTask(taskId);
    await taskStore.updateTask(taskId, _mirrorPatch(errTask));
    return { task: errTask };
  }

  // ── interpret final graph state ───────────────────────────────────────────
  const endTask = await db.getTask(taskId);
  const endEvent = finalState?.event;
  const endRole = finalState?.currentState;

  // reviewer "done": apply full review outcome logic
  if (endEvent === "done" && endRole === "reviewer") {
    const review = endTask.review;
    if (review) {
      const updated = await _applyReviewerOutcome(db, taskId, review, ops);
      await _maybeCloseTab(agentRunner, taskId, config, updated.status);
      await taskStore.updateTask(taskId, _mirrorPatch(updated));
      write(stdout, `task ${taskId} ${updated.status}`);
      return { task: updated };
    }
  }

  // terminal-after state (e.g. plan-only mode ends after planner)
  if (endEvent === "done" && isTerminalAfterState(workflow, endTask.mode, endRole)) {
    // If review_enabled === false, attach synthetic skipped review
    const reviewSkipped = endTask.review_enabled === false ? skippedReview() : endTask.review;
    let updated = await db.updateTask(taskId, {
      status: "succeeded",
      active_step: null,
      review: reviewSkipped ?? null,
      continuation_prompt: null,
    });
    if (ops.finalizeProjectTask) {
      updated = await ops.finalizeProjectTask(updated);
      if (updated.status === "waiting_user") {
        await taskStore.updateTask(taskId, _mirrorPatch(updated));
        return { task: updated };
      }
      updated = await db.updateTask(taskId, { status: "succeeded", active_step: null });
    }
    if (ops.markProjectTaskStatus) await ops.markProjectTaskStatus(updated, "succeeded", { review: reviewSkipped });
    await _maybeCloseTab(agentRunner, taskId, config, "succeeded");
    await taskStore.updateTask(taskId, _mirrorPatch(await db.getTask(taskId)));
    write(stdout, `task ${taskId} succeeded`);
    return { task: await db.getTask(taskId) };
  }

  // interrupt events (node already updated DB)
  if (["question", "waiting", "error", "needs_review"].includes(endEvent)) {
    const current = await db.getTask(taskId);
    await taskStore.updateTask(taskId, _mirrorPatch(current));
    return { task: current };
  }

  // generic "done" without reviewer (shouldn't normally occur in task mode)
  if (endEvent === "done") {
    const reviewSkipped = endTask.review_enabled === false ? skippedReview() : endTask.review;
    let updated = await db.updateTask(taskId, {
      status: "succeeded",
      active_step: null,
      review: reviewSkipped ?? null,
      continuation_prompt: null,
    });
    if (ops.finalizeProjectTask) {
      updated = await ops.finalizeProjectTask(updated);
      if (updated.status === "waiting_user") {
        await taskStore.updateTask(taskId, _mirrorPatch(updated));
        return { task: updated };
      }
      updated = await db.updateTask(taskId, { status: "succeeded", active_step: null });
    }
    if (ops.markProjectTaskStatus) await ops.markProjectTaskStatus(updated, "succeeded");
    await _maybeCloseTab(agentRunner, taskId, config, "succeeded");
    await taskStore.updateTask(taskId, _mirrorPatch(await db.getTask(taskId)));
    write(stdout, `task ${taskId} succeeded`);
    return { task: await db.getTask(taskId) };
  }

  return { task: await db.getTask(taskId) };
  } finally {
    try {
      const endTaskForEvents = await db.getTask(taskId);
      for (const event of getStageEvents(endTaskForEvents)) emitOtelStageEvent(event);
    } catch { /* observability never breaks a run */ }
  }
}
