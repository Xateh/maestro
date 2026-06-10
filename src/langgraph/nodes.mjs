/**
 * LangGraph role-node factory for Maestro.
 *
 * makeRoleNode(roleDef, opts) returns a LangGraph node function that:
 *  1. No-ops if this role already has a handoff in priorHandoffs (resume skip)
 *  2. Checks effectiveSkipForState("always") for workflow-configured skips
 *  3. Builds a compact prompt from typed handoffs (never raw stdout)
 *  4. Runs the agent via runner.runStep (CLI, no API key)
 *  5. Parses MAESTRO_* markers from stdout
 *  6. Persists step + handoff to SQLite DB
 *  7. Returns the state slice {priorHandoffs, event, currentState}
 */

import path from "node:path";
import fs from "node:fs/promises";
import { buildPromptFromHandoffs } from "./prompt.mjs";
import {
  parseAgentHandoff,
  parseAgentQuestion,
  parseAgentActionRequests,
  parseReviewerOutput,
  isContextWindowFailure,
  skippedReview,
} from "../markers.mjs";
import { effectiveSkipForState } from "../state-machine.mjs";
import { evaluatePlannerDecision } from "../router.mjs";

async function _gitStdout(gitRunner, cwd, args) {
  try {
    const result = await gitRunner({ args, cwd });
    return result.stdout?.trim() ?? null;
  } catch { return null; }
}

function _stepOptions(roleDef, task) {
  return {
    ...(roleDef.alias ? { alias: roleDef.alias } : {}),
    ...(roleDef.model ? { model: roleDef.model } : {}),
    ...(roleDef.effort ? { effort: roleDef.effort } : {}),
    ...(roleDef.permission ? { permission: roleDef.permission } : {}),
    ...(Number.isInteger(task.stream_tail_bytes) ? { streamTailBytes: task.stream_tail_bytes } : {}),
  };
}

function _maestroEnv(task, role) {
  return {
    ...(task.project_id ? { MAESTRO_PROJECT_ID: task.project_id } : {}),
    MAESTRO_TASK_ID: task.id,
    MAESTRO_ROLE: role,
    ...(task.worktree_path ? { MAESTRO_WORKTREE: task.worktree_path } : {}),
    ...(task.branch ? { MAESTRO_BRANCH: task.branch } : {}),
    MAESTRO_STATE_DIR: task.run_dir ? path.dirname(path.dirname(task.run_dir)) : "",
  };
}

async function _writeHandoffFile(runDir, role, { role: r, provider, payload, stdoutPath, stderrPath }) {
  const handoff = {
    role: r,
    provider,
    payload,
    stdout_path: stdoutPath ?? null,
    stderr_path: stderrPath ?? null,
    created_at: new Date().toISOString(),
  };
  const handoffPath = path.join(runDir, `handoff.${role}.json`);
  await fs.writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`);
  return handoffPath;
}

/**
 * Create a LangGraph node function for the given role definition.
 *
 * @param {object} roleDef  - workflow.json roles[state] object
 * @param {object} opts
 * @param {SqliteTaskStore} opts.db                  - SQLite store instance
 * @param {object}          opts.runner              - HerdrAgentRunner or TerminalAgentRunner
 * @param {object}          opts.providerDef         - provider config from config.json
 * @param {number}          opts.contextRetryLimit   - max context-window retries (default 1)
 * @param {object}          opts.workflow            - parsed workflow.json (for skip logic)
 * @param {object}          opts.ops                 - injected project-mode helpers
 * @param {Function}        opts.ops.buildUnblockOptions
 * @param {Function}        opts.ops.canonicalizeActionRequestsForTask
 * @param {Function}        opts.ops.releasePathLeases    - bound: (task) => ...
 * @param {Function}        opts.ops.markProjectTaskStatus - bound: (task, status, patch?) => ...
 * @param {Function}        opts.ops.recordProjectBlocker  - bound: (projectId, blocker) => ...
 * @param {Function}        opts.ops.gitRunner        - raw gitRunner fn: ({args, cwd}) => {stdout,...}
 */
export function makeRoleNode(roleDef, {
  db,
  runner,
  providerDef,
  contextRetryLimit = 1,
  workflow = null,
  ops = {},
}) {
  const roleKey = roleDef.prompt_template ?? roleDef.label?.toLowerCase() ?? "executor";
  const {
    buildUnblockOptions = () => [],
    canonicalizeActionRequestsForTask = null,
    releasePathLeases = null,
    markProjectTaskStatus = null,
    recordProjectBlocker = null,
    gitRunner = null,
    markActiveStep = null,
  } = ops;

  return async function roleNode(state) {
    const task = state.task;
    const priorHandoffs = state.priorHandoffs ?? [];

    // ── resume skip: role already completed ──────────────────────────────────
    if (priorHandoffs.some((h) => h.role === roleKey)) {
      return { event: "done", currentState: roleKey };
    }

    // ── load fresh task from DB (captures any resume-time updates) ────────────
    let currentTask = db.getTask(task.id);

    // ── reviewer: synthetic skip when review_enabled === false ───────────────
    if (roleKey === "reviewer" && currentTask.review_enabled === false) {
      const reviewSkipped = skippedReview();
      db.updateTask(task.id, { review: reviewSkipped });
      return {
        priorHandoffs: [{ role: roleKey, provider: roleDef.provider, payload: reviewSkipped, log_path: null }],
        event: "done",
        currentState: roleKey,
      };
    }

    // ── planner: apply task-level planner_policy (mirrors legacy resolveAgentFlow) ─
    if (roleKey === "planner") {
      const { decision } = evaluatePlannerDecision({
        plannerPolicy: currentTask.planner_policy ?? "auto",
        prompt: currentTask.prompt ?? "",
        mode: currentTask.mode ?? "task",
      });
      if (decision === "skipped") {
        return { event: "done", currentState: roleKey };
      }
    }

    // ── workflow skip: "always" = skip without running ────────────────────────
    if (workflow) {
      const skipValue = effectiveSkipForState(workflow, roleKey, currentTask.role_skips ?? null);
      if (skipValue === "always") {
        return { event: "done", currentState: roleKey };
      }
    }

    // ── update DB: mark this role as running ─────────────────────────────────
    const activeStep = { role: roleKey, provider: roleDef.provider, status: "running" };
    db.updateTask(task.id, { status: "running", current_state: roleKey, active_step: activeStep });
    if (markActiveStep) await markActiveStep(task.id, activeStep);

    let handoffMode = "normal";
    let contextRetryUsed = 0;

    while (true) {
      currentTask = db.getTask(task.id);
      const taskCwd = currentTask.cwd ? path.resolve(currentTask.cwd) : process.cwd();

      // ── capture start_head before agent runs (branch-tracked tasks) ──────────
      let startHead = null;
      if (currentTask.branch && gitRunner) {
        startHead = await _gitStdout(gitRunner, taskCwd, ["rev-parse", "HEAD"]);
        if (startHead && !currentTask.start_head) {
          db.updateTask(task.id, { start_head: startHead });
          currentTask = db.getTask(task.id);
        }
      }

      const prompt = buildPromptFromHandoffs({
        role: roleKey,
        task: currentTask,
        priorHandoffs,
        handoffMode,
      });

      let result;
      try {
        result = await runner.runStep({
          role: roleKey,
          provider: roleDef.provider,
          prompt,
          cwd: taskCwd,
          logDir: currentTask.run_dir,
          options: _stepOptions(roleDef, currentTask),
          providerDef,
          env: _maestroEnv(currentTask, roleKey),
        });
      } catch (err) {
        // ── context-window retry ──────────────────────────────────────────────
        if (isContextWindowFailure(err) && contextRetryUsed < contextRetryLimit) {
          contextRetryUsed += 1;
          handoffMode = "strict";
          db.appendStep(task.id, {
            role: roleKey,
            provider: roleDef.provider,
            status: "retried",
            error: err.message,
            recovery: "auto_compact_retry",
            stdout_path: err.stdoutPath ?? null,
            stderr_path: err.stderrPath ?? null,
          });
          continue;
        }
        // ── hard failure ──────────────────────────────────────────────────────
        const failureCode = err.code === "ETIMEDOUT" || /timeout|timed out/i.test(err.message ?? "")
          ? "agent_timeout"
          : "failed_agent";
        const failureBlockers = [
          { code: failureCode, role: roleKey, provider: roleDef.provider, error: err.message },
          ...(currentTask.blockers ?? []),
        ];
        db.appendStep(task.id, {
          role: roleKey,
          provider: roleDef.provider,
          status: "failed",
          error: err.message,
          stdout_path: err.stdoutPath ?? null,
          stderr_path: err.stderrPath ?? null,
        });
        db.updateTask(task.id, {
          status: "waiting_user",
          active_step: null,
          current_state: roleKey,
          blockers: failureBlockers,
          unblock_options: buildUnblockOptions({
            task: { ...currentTask, blockers: failureBlockers },
            includeRetry: true,
          }),
        });
        if (releasePathLeases) await releasePathLeases(currentTask);
        if (markProjectTaskStatus) await markProjectTaskStatus(currentTask, "waiting_user");
        return { event: "error", currentState: roleKey };
      }

      const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

      // ── MAESTRO_ACTION_REQUEST (checked before QUESTION, mirrors legacy order)
      const rawActionRequests = parseAgentActionRequests(combined);
      if (rawActionRequests.length > 0) {
        const actionRequests = rawActionRequests.map((r, i) => ({
          ...r,
          id: r.id || `act-${i + 1}`,
          status: "pending",
          continuation_generation: currentTask.continuation_generation ?? 0,
        }));
        db.appendStep(task.id, {
          role: roleKey,
          provider: roleDef.provider,
          status: "waiting",
          stdout_path: result.stdoutPath,
          stderr_path: result.stderrPath,
        });
        let actionPatch;
        if (canonicalizeActionRequestsForTask) {
          const canonical = canonicalizeActionRequestsForTask(currentTask, actionRequests);
          actionPatch = {
            action_requests: canonical.action_requests,
            blockers: canonical.blockers,
            unblock_options: canonical.unblock_options,
          };
        } else {
          actionPatch = {
            action_requests: [...(currentTask.action_requests ?? []), ...actionRequests],
          };
        }
        db.updateTask(task.id, {
          status: "waiting_approval",
          active_step: null,
          current_state: roleKey,
          ...actionPatch,
        });
        if (markProjectTaskStatus) {
          await markProjectTaskStatus(currentTask, "waiting_approval", {
            action_requests: actionPatch.action_requests,
          });
        }
        return { event: "waiting", currentState: roleKey };
      }

      // ── MAESTRO_QUESTION ─────────────────────────────────────────────────
      const question = parseAgentQuestion(combined);
      if (question) {
        const questionId = `q${(currentTask.question_answers ?? []).length + 1}`;
        db.appendStep(task.id, {
          role: roleKey,
          provider: roleDef.provider,
          status: "waiting",
          stdout_path: result.stdoutPath,
          stderr_path: result.stderrPath,
        });
        db.updateTask(task.id, {
          status: "waiting_user",
          active_step: null,
          current_state: roleKey,
          active_question: { id: questionId, role: roleKey, provider: roleDef.provider, question },
        });
        if (markProjectTaskStatus) await markProjectTaskStatus(currentTask, "waiting_user");
        return { event: "question", currentState: roleKey };
      }

      // ── parse handoff payload ─────────────────────────────────────────────
      let payload;
      if (roleKey === "reviewer") {
        const review = parseReviewerOutput(combined, currentTask.review ?? null);
        payload = {
          completion_state: review.completion_state,
          required_action: review.required_action,
          summary: review.summary,
          blockers: review.blockers,
          continuation: review.continuation,
          risk_level: review.risk_level,
          confidence: review.confidence,
        };
        db.updateTask(task.id, { review });
      } else {
        payload = parseAgentHandoff(combined) ?? {};
      }

      // ── write handoff to disk (run-dir compat) ────────────────────────────
      let handoffPath = null;
      if (task.run_dir) {
        try {
          handoffPath = await _writeHandoffFile(task.run_dir, roleKey, {
            role: roleKey,
            provider: roleDef.provider,
            payload,
            stdoutPath: result.stdoutPath,
            stderrPath: result.stderrPath,
          });
        } catch (err) {
          process.stderr.write(`[maestro] handoff_write_failed role=${roleKey} task=${task.id} err=${err?.message}\n`);
        }
      }

      // ── persist step + handoff to DB ─────────────────────────────────────
      db.appendStep(task.id, {
        role: roleKey,
        provider: roleDef.provider,
        status: "succeeded",
        stdout_path: result.stdoutPath,
        stderr_path: result.stderrPath,
        handoff_path: handoffPath,
        command: result.command,
        args: result.args,
      });
      db.addHandoff(task.id, {
        role: roleKey,
        provider: roleDef.provider,
        payload,
        logPath: result.stdoutPath,
      });

      // ── git HEAD guard: non-reviewer roles with branch tracking ──────────
      if (roleKey !== "reviewer" && startHead && gitRunner) {
        const endHead = await _gitStdout(gitRunner, taskCwd, ["rev-parse", "HEAD"]);
        if (endHead && endHead !== startHead) {
          const movedTask = db.getTask(task.id);
          db.updateTask(task.id, {
            status: "needs_review",
            active_step: null,
            current_state: roleKey,
            start_head: startHead,
            observed_head: endHead,
            blockers: [
              ...(movedTask.blockers ?? []),
              { code: "agent_head_moved", branch: movedTask.branch, start_head: startHead, observed_head: endHead },
            ],
          });
          if (releasePathLeases) await releasePathLeases(movedTask);
          if (markProjectTaskStatus) {
            await markProjectTaskStatus(movedTask, "needs_review", { start_head: startHead, observed_head: endHead });
          }
          if (recordProjectBlocker && movedTask.project_id) {
            await recordProjectBlocker(movedTask.project_id, {
              code: "agent_head_moved",
              task_id: movedTask.id,
              branch: movedTask.branch,
              start_head: startHead,
              observed_head: endHead,
            });
          }
          return { event: "needs_review", currentState: roleKey };
        }
      }

      return {
        priorHandoffs: [{ role: roleKey, provider: roleDef.provider, payload, log_path: result.stdoutPath ?? null }],
        event: "done",
        currentState: roleKey,
      };
    }
  };
}
