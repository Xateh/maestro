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

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { buildPromptFromHandoffs } from "./prompt.mjs";
import { contextForEdge } from "./context-contract.mjs";
import {
  parseAgentHandoff,
  parseAgentQuestion,
  parseAgentActionRequests,
  parseReviewerOutput,
  isContextWindowFailure,
  isUsageLimitFailure,
  skippedReview,
} from "../markers.mjs";
import { RESERVED_EVENTS, effectiveSkipForState, resolveMaxVisits } from "../state-machine.mjs";
import { resolveAliasEnv } from "../setup/keys.mjs";
import { evaluatePlannerDecision } from "../router.mjs";
import { resolveRoleProvider, describeAvailabilityFailure } from "../provider-availability.mjs";
import { accumulateCost } from "../cost-accounting.mjs";
import { resolveRoleSchema, validateRolePayload, emptyPayloadForSchema } from "../schemas/index.mjs";
import { buildEvaluationPayload } from "../evaluation.mjs";
import { deriveScores, enforceGates } from "../scoring.mjs";
import { parseUsage } from "../usage-parse.mjs";
import { boundedTail } from "../bounded-tail.mjs";
import { buildAdvisoryBlock, advisoryRemainder } from "../adapters/tool-flags.mjs";

// SP3 kind:"command" output-tail / timeout fallbacks (no new default config key).
const COMMAND_DEFAULT_TAIL_BYTES = 65_536;
const COMMAND_DEFAULT_TIMEOUT_MS = 120_000;

const INSTRUCTION_FILE_CAP = 16 * 1024;
const INSTRUCTION_TOTAL_CAP = 64 * 1024;
// Max times a single step may hop to a different provider after a usage/quota
// limit before giving up and asking the user.
const USAGE_RETRY_LIMIT = 2;

function _expandHome(filePath) {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

// Inline role instructions plus referenced docs (instruction_paths), capped so
// imported skill docs cannot blow out the prompt.
async function _roleInstructions(roleDef) {
  const parts = [];
  let total = 0;
  const inline = String(roleDef.instructions ?? "").trim();
  if (inline) {
    parts.push(inline.slice(0, INSTRUCTION_FILE_CAP));
    total += parts[0].length;
  }
  for (const rawPath of roleDef.instruction_paths ?? []) {
    if (total >= INSTRUCTION_TOTAL_CAP) break;
    const filePath = path.resolve(_expandHome(String(rawPath)));
    try {
      const text = (await fs.readFile(filePath, "utf8")).trim().slice(0, INSTRUCTION_FILE_CAP);
      const chunk = `--- From ${filePath} ---\n${text}`.slice(0, INSTRUCTION_TOTAL_CAP - total);
      parts.push(chunk);
      total += chunk.length;
    } catch (err) {
      process.stderr.write(`[maestro] instruction_path_unreadable path=${filePath} err=${err?.message}\n`);
    }
  }
  return parts.join("\n\n");
}

async function _gitStdout(gitRunner, cwd, args) {
  try {
    const result = await gitRunner({ args, cwd });
    return result.stdout?.trim() ?? null;
  } catch { return null; }
}

// Apply a per-task role override (from "switch provider"). A new provider
// invalidates the role's configured alias/model unless the override restates
// them — otherwise the old provider's alias would bind to the new command.
function applyRoleOverride(roleDef, override) {
  if (!override) return roleDef;
  const next = { ...roleDef };
  if (override.provider) {
    next.provider = override.provider;
    next.alias = override.alias;
    next.model = override.model;
  }
  if (override.alias !== undefined) next.alias = override.alias;
  if (override.model !== undefined) next.model = override.model;
  return next;
}

function _stepOptions(roleDef, task) {
  return {
    ...(roleDef.alias ? { alias: roleDef.alias } : {}),
    ...(roleDef.model ? { model: roleDef.model } : {}),
    ...(roleDef.effort ? { effort: roleDef.effort } : {}),
    ...(roleDef.permission ? { permission: roleDef.permission } : {}),
    ...(roleDef.tools ? { tools: roleDef.tools } : {}),
    ...(roleDef.deny_tools ? { deny_tools: roleDef.deny_tools } : {}),
    ...(Number.isInteger(task.stream_tail_bytes) ? { streamTailBytes: task.stream_tail_bytes } : {}),
  };
}

// Provider classes whose tool policy is advisory-only — the deterministic Tool
// Policy block is prepended to the prompt (adapters never see instructions, D2).
const ADVISORY_PROVIDERS = new Set(["gemini", "copilot", "antigravity", "ollama"]);

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

async function _writeHandoffFile(runDir, role, { role: r, provider, payload, schemaValidation, stdoutPath, stderrPath }) {
  const handoff = {
    role: r,
    provider,
    payload,
    ...(schemaValidation ? { schema_validation: schemaValidation } : {}),
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
export function makeRoleNodeFn(roleDef, {
  db,
  runner,
  providerDef,
  config = null,
  availabilityProbe = null,
  contextRetryLimit = 1,
  workflow = null,
  stateName = null,
  resumeCompletedRoles = null,
  advisoryEmitted = new Set(),
  ops = {},
}) {
  const roleKey = roleDef.prompt_template ?? roleDef.label?.toLowerCase() ?? "executor";
  // Graph state name (transitions key); equals roleKey for default workflows.
  const transitionKey = stateName ?? roleKey;
  const {
    buildUnblockOptions = () => [],
    canonicalizeActionRequestsForTask = null,
    releasePathLeases = null,
    markProjectTaskStatus = null,
    recordProjectBlocker = null,
    gitRunner = null,
    markActiveStep = null,
    commandRunner = null,
    regressionStore = null,
  } = ops;

  return async function roleNode(state) {
    const task = state.task;
    const priorHandoffs = state.priorHandoffs ?? [];
    const visitCount = state.visits?.[roleKey] ?? 0;
    const isRevisit = visitCount > 0;

    // Provider actually executed this step. Defaults to the role's configured
    // provider; availability resolution (below) may substitute a fallback.
    let runProvider = roleDef.provider;
    let runProviderDef = providerDef;
    let runAlias = roleDef.alias || null;
    let runModel = roleDef.model ?? "";

    // ── resume skip: role completed in a PREVIOUS run of this task ───────────
    // Only first arrivals skip; cycle revisits (visits > 0) must re-run.
    const completedBefore = resumeCompletedRoles
      ? resumeCompletedRoles.has(roleKey)
      : priorHandoffs.some((h) => h.role === roleKey);
    if (!isRevisit && completedBefore) {
      return { event: "done", currentState: roleKey, visits: { [roleKey]: 1 } };
    }

    // ── load fresh task from DB (captures any resume-time updates) ────────────
    let currentTask = await db.getTask(task.id);

    // ── opt-in strict schema enforcement (U2) ────────────────────────────────
    // Soft validation is the default everywhere (additive evidence, never alters
    // routing). A role may opt in with `enforce_output_schema: true`; when it does
    // and the validated payload does not conform, halt the run with a typed
    // `output_schema_violation` blocker instead of recording soft evidence and
    // continuing. Returns a halt result (caller returns it) or null to proceed.
    const haltOnSchemaViolation = async (schemaValidation) => {
      if (!roleDef.enforce_output_schema || !schemaValidation || schemaValidation.ok) return null;
      const blocker = {
        code: "output_schema_violation",
        role: roleKey,
        schema: schemaValidation.schema,
        errors: schemaValidation.errors,
      };
      await db.updateTask(task.id, {
        status: "waiting_user",
        active_step: null,
        current_state: roleKey,
        blockers: [blocker, ...(currentTask.blockers ?? [])],
      });
      if (markProjectTaskStatus) await markProjectTaskStatus(currentTask, "waiting_user");
      return { event: "error", currentState: roleKey };
    };

    // ── loop limit: bound cycle revisits (max_visits / loop_limits) ──────────
    const maxVisits = resolveMaxVisits(workflow, transitionKey) ?? resolveMaxVisits(workflow, roleKey);
    if (maxVisits !== null && visitCount >= maxVisits) {
      const onExceeded = workflow?.loop_limits?.on_exceeded ?? "ask_user";
      const blocker = { code: "loop_limit_exceeded", role: roleKey, visits: visitCount, max_visits: maxVisits };
      if (onExceeded === "halt") {
        await db.updateTask(task.id, {
          status: "waiting_user",
          active_step: null,
          current_state: roleKey,
          blockers: [blocker, ...(currentTask.blockers ?? [])],
        });
        if (markProjectTaskStatus) await markProjectTaskStatus(currentTask, "waiting_user");
        return { event: "error", currentState: roleKey };
      }
      const questionId = `q${(currentTask.question_answers ?? []).length + 1}`;
      await db.updateTask(task.id, {
        status: "waiting_user",
        active_step: null,
        current_state: roleKey,
        blockers: [blocker, ...(currentTask.blockers ?? [])],
        active_question: {
          id: questionId,
          role: roleKey,
          provider: runProvider,
          question: `Loop limit reached: role "${roleKey}" has run ${visitCount} times (max_visits: ${maxVisits}). Reply with guidance to continue another round, or cancel the task.`,
        },
      });
      if (markProjectTaskStatus) await markProjectTaskStatus(currentTask, "waiting_user");
      return { event: "question", currentState: roleKey };
    }

    // ── cycle revisit: stale handoff in the DB must not mask the new run ─────
    if (isRevisit) {
      await db.deleteHandoffsByRole(task.id, roleKey);
    }

    // ── non-LLM role-kind handlers ───────────────────────────────────────────
    // stub / command / regression / scoring: inner async closures that share
    // roleNode's bound variables (db, task, roleKey, currentTask, config, …).
    // Each returns the same result object the inline branch produced. The LLM
    // path (below the dispatch) is unchanged.

    // stub: no provider, no agent — emit a schema-conforming payload.
    // Honors resume-skip + loop bounding above. SP3 seam for kind:"command".
    async function runStubRole() {
      const stageStartedAt = new Date().toISOString();
      const resolved = resolveRoleSchema(roleDef);
      const payload = resolved.schema ? emptyPayloadForSchema(resolved.schema) : {};
      const schemaValidation = validateRolePayload(roleDef, payload);
      const schemaHalt = await haltOnSchemaViolation(schemaValidation);
      if (schemaHalt) return schemaHalt;
      let handoffPath = null;
      if (task.run_dir) {
        try {
          handoffPath = await _writeHandoffFile(task.run_dir, roleKey, {
            role: roleKey,
            provider: null,
            payload,
            schemaValidation,
            stdoutPath: null,
            stderrPath: null,
          });
        } catch (err) {
          process.stderr.write(`[maestro] handoff_write_failed role=${roleKey} task=${task.id} err=${err?.message}\n`);
        }
      }
      // The handoffs.provider column is NOT NULL, so the DB row carries the
      // "stub" sentinel; the engine-visible handoff (state slice + on-disk file)
      // keeps provider:null since a stub has no real LLM provider.
      await db.appendStep(task.id, {
        role: roleKey,
        provider: "stub",
        status: "succeeded",
        started_at: stageStartedAt,
        handoff_path: handoffPath,
      });
      await db.addHandoff(task.id, {
        role: roleKey,
        provider: "stub",
        payload,
        logPath: null,
        schemaValidation,
      });
      return {
        priorHandoffs: [{
          role: roleKey,
          provider: null,
          payload,
          log_path: null,
          ...(schemaValidation ? { schema_validation: schemaValidation } : {}),
        }],
        event: "done",
        currentState: roleKey,
        visits: { [roleKey]: 1 },
      };
    }

    // command: non-LLM stage that runs declared shell commands.
    // Honors resume-skip + loop bounding. Failing command = data, not a halt.
    // Builds the SP1 `evaluation` payload.
    async function runCommandRole() {
      const stageStartedAt = new Date().toISOString();
      const commands = Array.isArray(roleDef.commands) ? roleDef.commands : [];
      const cwd = currentTask.worktree_path
        ?? (currentTask.cwd ? path.resolve(currentTask.cwd) : process.cwd());
      const maxTailBytes = config?.stream_tail_bytes ?? COMMAND_DEFAULT_TAIL_BYTES;
      const env = _maestroEnv(currentTask, roleKey);

      const records = [];
      for (const command of commands) {
        const run = command?.run;
        const timeoutMs = command?.timeout_ms ?? config?.command_timeout_ms ?? COMMAND_DEFAULT_TIMEOUT_MS;
        // Never let a thrown/absent runner abort the stage — synthesize a
        // spawn-error result (exit_code 127, matching the engine's convention).
        let result;
        try {
          if (!commandRunner) throw new Error("commandRunner not provided");
          result = await commandRunner({ run, cwd, timeoutMs, env, maxTailBytes });
        } catch (err) {
          result = {
            exit_code: 127,
            signal: null,
            stdout: "",
            stderr: err?.message ?? String(err),
            timed_out: false,
            spawn_error: true,
          };
        }
        const outputTail = boundedTail(
          `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
          maxTailBytes,
        );
        records.push({
          name: command?.name ?? null,
          run: run ?? null,
          category: command?.category ?? null,
          exit_code: result.exit_code ?? null,
          signal: result.signal ?? null,
          timed_out: result.timed_out === true,
          spawn_error: result.spawn_error === true,
          output_tail: outputTail,
          allow_failure: command?.allow_failure === true,
          parser: command?.parser ?? null,
        });
      }

      const payload = buildEvaluationPayload(records);
      const schemaValidation = validateRolePayload(roleDef, payload);
      const schemaHalt = await haltOnSchemaViolation(schemaValidation);
      if (schemaHalt) return schemaHalt;

      let handoffPath = null;
      if (task.run_dir) {
        try {
          handoffPath = await _writeHandoffFile(task.run_dir, roleKey, {
            role: roleKey,
            provider: null,
            payload,
            schemaValidation,
            stdoutPath: null,
            stderrPath: null,
          });
        } catch (err) {
          process.stderr.write(`[maestro] handoff_write_failed role=${roleKey} task=${task.id} err=${err?.message}\n`);
        }
      }
      // The handoffs.provider column is NOT NULL, so the DB row carries the
      // "command" sentinel; the engine-visible handoff (state slice + on-disk
      // file) keeps provider:null since a command stage has no LLM provider.
      await db.appendStep(task.id, {
        role: roleKey,
        provider: "command",
        status: "succeeded",
        started_at: stageStartedAt,
        handoff_path: handoffPath,
      });
      await db.addHandoff(task.id, {
        role: roleKey,
        provider: "command",
        payload,
        logPath: null,
        schemaValidation,
      });
      return {
        priorHandoffs: [{
          role: roleKey,
          provider: null,
          payload,
          log_path: null,
          ...(schemaValidation ? { schema_validation: schemaValidation } : {}),
        }],
        event: "done",
        currentState: roleKey,
        visits: { [roleKey]: 1 },
      };
    }

    // regression: non-LLM corpus runner (SP4). Honors resume-skip + loop
    // bounding. Loads corpus, re-runs cases with retries, promotes evaluation
    // failures, emits outcome-dependent event (done / fail_event).
    async function runRegressionRole() {
      const stageStartedAt = new Date().toISOString();
      const cwd = currentTask.worktree_path
        ?? (currentTask.cwd ? path.resolve(currentTask.cwd) : process.cwd());
      const corpusDir = roleDef.corpus_dir
        ? path.resolve(cwd, roleDef.corpus_dir)
        : path.join(cwd, ".maestro", "regression");
      const maxTailBytes = config?.stream_tail_bytes ?? COMMAND_DEFAULT_TAIL_BYTES;
      const env = _maestroEnv(currentTask, roleKey);

      // effective attempts (>=1): case.attempts ?? roleDef.attempts ??
      // config.regression_attempts ?? 1
      const roleAttempts = Number.isInteger(roleDef.attempts) && roleDef.attempts > 0
        ? roleDef.attempts : null;
      const cfgAttempts = Number.isInteger(config?.regression_attempts) && config.regression_attempts > 0
        ? config.regression_attempts : null;

      // ── load corpus (tolerant; absent store ⇒ empty) ──────────────────────
      let cases = [];
      let loadErrors = [];
      if (regressionStore) {
        try {
          const loaded = await regressionStore.loadCorpus(corpusDir);
          cases = loaded?.cases ?? [];
          loadErrors = loaded?.loadErrors ?? [];
        } catch (err) {
          loadErrors = [{ file: corpusDir, error: err?.message ?? String(err) }];
        }
      }

      // ── re-run each case with retries (stop early on first pass) ───────────
      const regressionsRun = [];
      const newFailures = [];
      for (const c of cases) {
        const run = c?.command?.run;
        const timeoutMs = c?.command?.timeout_ms
          ?? config?.command_timeout_ms ?? COMMAND_DEFAULT_TIMEOUT_MS;
        const caseAttempts = Number.isInteger(c?.attempts) && c.attempts > 0 ? c.attempts : null;
        const attemptsCap = caseAttempts ?? roleAttempts ?? cfgAttempts ?? 1;

        let lastResult = null;
        let passed = false;
        let attemptsMade = 0;
        for (let a = 0; a < attemptsCap; a++) {
          attemptsMade = a + 1;
          let result;
          try {
            if (!commandRunner) throw new Error("commandRunner not provided");
            result = await commandRunner({ run, cwd, timeoutMs, env, maxTailBytes });
          } catch (err) {
            result = {
              exit_code: 127,
              signal: null,
              stdout: "",
              stderr: err?.message ?? String(err),
              timed_out: false,
              spawn_error: true,
            };
          }
          lastResult = result;
          // pass iff exit 0 AND not timed_out AND not spawn_error
          if (result.exit_code === 0 && !result.timed_out && result.spawn_error !== true) {
            passed = true;
            break; // stop early on first pass
          }
        }
        const outputTail = boundedTail(
          `${lastResult?.stdout ?? ""}\n${lastResult?.stderr ?? ""}`,
          maxTailBytes,
        );
        const entry = {
          id: c.id,
          run: run ?? null,
          category: c?.category ?? null,
          exit_code: lastResult?.exit_code ?? null,
          signal: lastResult?.signal ?? null,
          timed_out: lastResult?.timed_out === true,
          passed,
          attempts: attemptsMade,
          output_tail: outputTail,
        };
        regressionsRun.push(entry);
        if (!passed) {
          // new_failures entry — same fields minus `passed`
          const { passed: _omit, ...failEntry } = entry;
          newFailures.push(failEntry);
        }
      }

      // ── promote from the most recent prior evaluation handoff ──────────────
      const evalHandoff = [...priorHandoffs].reverse().find((h) => h.role === "evaluation");
      const failuresToPromote = Array.isArray(evalHandoff?.payload?.failures)
        ? evalHandoff.payload.failures : [];
      const existingIds = new Set(cases.map((c) => c.id));
      let promotedTests = [];
      if (regressionStore && failuresToPromote.length > 0) {
        try {
          const res = await regressionStore.promoteFailures({
            dir: corpusDir,
            failures: failuresToPromote,
            existingIds,
            date: new Date().toISOString().slice(0, 10),
            taskId: currentTask.id ?? null,
          });
          promotedTests = res?.promoted ?? [];
          // res.writeErrors are intentionally swallowed (read-only tree etc.);
          // affected ids simply do not appear in promoted_tests.
        } catch {
          promotedTests = [];
        }
      }

      // ── build payload + soft schema validation ────────────────────────────
      const failThreshold = Number.isInteger(roleDef.fail_threshold) && roleDef.fail_threshold > 0
        ? roleDef.fail_threshold : 1;
      const failEvent = roleDef.fail_event ?? "regressions_found";
      const outcome = newFailures.length >= failThreshold ? failEvent : "done";
      const payload = {
        regressions_run: regressionsRun,
        new_failures: newFailures,
        promoted_tests: promotedTests,
        corpus_load_errors: loadErrors,
        outcome: outcome === "done" ? "clean" : outcome, // "clean" | fail_event name
      };

      const schemaValidation = validateRolePayload(roleDef, payload);
      const schemaHalt = await haltOnSchemaViolation(schemaValidation);
      if (schemaHalt) return schemaHalt;

      // ── persist (DB sentinel "regression"; engine-visible provider null) ──
      let handoffPath = null;
      if (task.run_dir) {
        try {
          handoffPath = await _writeHandoffFile(task.run_dir, roleKey, {
            role: roleKey,
            provider: null,
            payload,
            schemaValidation,
            stdoutPath: null,
            stderrPath: null,
          });
        } catch (err) {
          process.stderr.write(`[maestro] handoff_write_failed role=${roleKey} task=${task.id} err=${err?.message}\n`);
        }
      }
      // The handoffs.provider column is NOT NULL, so the DB row carries the
      // "regression" sentinel; the engine-visible handoff keeps provider:null.
      await db.appendStep(task.id, {
        role: roleKey,
        provider: "regression",
        status: "succeeded",
        started_at: stageStartedAt,
        handoff_path: handoffPath,
      });
      await db.addHandoff(task.id, {
        role: roleKey,
        provider: "regression",
        payload,
        logPath: null,
        schemaValidation,
      });
      return {
        priorHandoffs: [{
          role: roleKey,
          provider: null,
          payload,
          log_path: null,
          ...(schemaValidation ? { schema_validation: schemaValidation } : {}),
        }],
        event: outcome, // done | fail_event
        currentState: roleKey,
        visits: { [roleKey]: 1 },
      };
    }

    // scoring: non-LLM reliability scoring + gate engine (SP5). Honors resume-
    // skip + loop bounding. Derives scores from upstream handoffs, enforces
    // declared gates, emits pass_event / block_event.
    async function runScoringRole() {
      const stageStartedAt = new Date().toISOString();
      // last-write-wins handoffs-by-role map from the accumulated priorHandoffs.
      const handoffsByRole = {};
      for (const h of priorHandoffs) {
        if (h?.role) handoffsByRole[h.role] = h.payload;
      }

      // Per-handoff schema_validation evidence for the output_schema_conformance
      // gate (B): every prior handoff that carried a schema verdict, by role.
      const handoffMeta = priorHandoffs.map((h) => ({
        role: h?.role,
        schema_validation: h?.schema_validation ?? null,
      }));

      const { scores, score_inputs, missing_evidence } = deriveScores(handoffsByRole);
      const gateResult = enforceGates(
        workflow?.gates ?? roleDef.gates ?? {},
        scores,
        handoffsByRole,
        handoffMeta,
      );
      const payload = {
        ...scores,
        score_inputs,
        missing_evidence,
        gates: gateResult.evaluated,
        blocked_reasons: gateResult.blocked_reasons,
      };

      const schemaValidation = validateRolePayload(roleDef, payload);
      const schemaHalt = await haltOnSchemaViolation(schemaValidation);
      if (schemaHalt) return schemaHalt;

      // ── persist (DB sentinel "scoring"; engine-visible provider null) ──────
      let handoffPath = null;
      if (task.run_dir) {
        try {
          handoffPath = await _writeHandoffFile(task.run_dir, roleKey, {
            role: roleKey,
            provider: null,
            payload,
            schemaValidation,
            stdoutPath: null,
            stderrPath: null,
          });
        } catch (err) {
          process.stderr.write(`[maestro] handoff_write_failed role=${roleKey} task=${task.id} err=${err?.message}\n`);
        }
      }
      // The handoffs.provider column is NOT NULL, so the DB row carries the
      // "scoring" sentinel; the engine-visible handoff keeps provider:null.
      await db.appendStep(task.id, {
        role: roleKey,
        provider: "scoring",
        status: "succeeded",
        started_at: stageStartedAt,
        handoff_path: handoffPath,
      });
      await db.addHandoff(task.id, {
        role: roleKey,
        provider: "scoring",
        payload,
        logPath: null,
        schemaValidation,
      });
      const event = gateResult.passed
        ? (roleDef.pass_event ?? "passed")
        : (roleDef.block_event ?? "blocked");
      return {
        priorHandoffs: [{
          role: roleKey,
          provider: null,
          payload,
          log_path: null,
          ...(schemaValidation ? { schema_validation: schemaValidation } : {}),
        }],
        event, // passed | blocked (or custom pass_event/block_event)
        currentState: roleKey,
        visits: { [roleKey]: 1 },
      };
    }

    if (roleDef.kind === "stub") return runStubRole();
    if (roleDef.kind === "command") return runCommandRole();
    if (roleDef.kind === "regression") return runRegressionRole();
    if (roleDef.kind === "scoring") return runScoringRole();

    // ── reviewer: synthetic skip when review_enabled === false ───────────────
    if (roleKey === "reviewer" && currentTask.review_enabled === false) {
      const reviewSkipped = skippedReview();
      await db.updateTask(task.id, { review: reviewSkipped });
      return {
        priorHandoffs: [{ role: roleKey, provider: runProvider, payload: reviewSkipped, log_path: null }],
        event: "done",
        currentState: roleKey,
        visits: { [roleKey]: 1 },
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
        return { event: "done", currentState: roleKey, visits: { [roleKey]: 1 } };
      }
    }

    // ── workflow skip: "always" = skip without running ────────────────────────
    if (workflow) {
      const skipValue = effectiveSkipForState(workflow, roleKey, currentTask.role_skips ?? null);
      if (skipValue === "always") {
        return { event: "done", currentState: roleKey, visits: { [roleKey]: 1 } };
      }
    }

    // ── provider availability: substitute a fallback, opt-out, or block ───────
    // Probes live availability and walks roleDef.fallback. A per-task
    // role_override (from a "switch provider" unblock) takes precedence.
    if (config) {
      const override = currentTask.role_overrides?.[roleKey] ?? null;
      const effectiveRoleDef = applyRoleOverride(roleDef, override);
      const probeCwd = currentTask.cwd ? path.resolve(currentTask.cwd) : process.cwd();
      const resolution = await resolveRoleProvider({
        roleDef: effectiveRoleDef,
        config,
        cwd: probeCwd,
        ...(availabilityProbe ? { probe: availabilityProbe } : {}),
      });

      if (!resolution.ok) {
        const reason = resolution.reasons[0] ?? { provider: effectiveRoleDef.provider, code: "provider_missing" };
        const message = describeAvailabilityFailure(reason, { role: roleKey });
        const blocker = { ...reason, role: roleKey, message };
        const blockers = [blocker, ...(currentTask.blockers ?? [])];
        await db.updateTask(task.id, {
          status: "waiting_user",
          active_step: null,
          current_state: roleKey,
          blockers,
          unblock_options: buildUnblockOptions({ task: { ...currentTask, blockers }, includeRetry: true }),
        });
        if (releasePathLeases) await releasePathLeases(currentTask);
        if (markProjectTaskStatus) await markProjectTaskStatus(currentTask, "waiting_user");
        return { event: "error", currentState: roleKey };
      }

      // First substitution in a task pauses for confirmation; once approved
      // (auto_fallback_confirmed), all later substitutions proceed-with-notice.
      if (resolution.substituted && !override && currentTask.auto_fallback_confirmed !== true) {
        const message = `Provider "${effectiveRoleDef.provider}" is unavailable for role "${roleKey}". `
          + `Substitute "${resolution.provider}" and continue (applies to the rest of this run)?`;
        const blocker = {
          code: "provider_substitution_pending",
          role: roleKey,
          from: effectiveRoleDef.provider,
          to: resolution.provider,
          message,
        };
        const blockers = [blocker, ...(currentTask.blockers ?? [])];
        await db.updateTask(task.id, {
          status: "waiting_user",
          active_step: null,
          current_state: roleKey,
          blockers,
          pending_substitution: { role: roleKey, from: effectiveRoleDef.provider, to: resolution.provider },
          unblock_options: buildUnblockOptions({ task: { ...currentTask, blockers } }),
        });
        if (markProjectTaskStatus) await markProjectTaskStatus(currentTask, "waiting_user");
        return { event: "error", currentState: roleKey };
      }

      runProvider = resolution.provider;
      runProviderDef = resolution.providerDef;
      runAlias = resolution.alias;
      runModel = resolution.model;

      if (resolution.substituted) {
        await db.appendStep(task.id, {
          role: roleKey,
          provider: runProvider,
          status: "substituted",
          note: `provider substituted from "${effectiveRoleDef.provider}" to "${runProvider}" (unavailable)`,
        });
      } else if (resolution.modelDefaulted) {
        await db.appendStep(task.id, {
          role: roleKey,
          provider: runProvider,
          status: "model_defaulted",
          note: `model "${effectiveRoleDef.model}" unavailable for "${runProvider}"; using provider default`,
        });
      }
    }

    // ── update DB: mark this role as running ─────────────────────────────────
    const activeStep = { role: roleKey, provider: runProvider, status: "running" };
    await db.updateTask(task.id, { status: "running", current_state: roleKey, active_step: activeStep });
    if (markActiveStep) await markActiveStep(task.id, activeStep);

    let handoffMode = "normal";
    let contextRetryUsed = 0;
    let usageRetryUsed = 0;
    const usageExhausted = new Set();

    while (true) {
      currentTask = await db.getTask(task.id);
      const taskCwd = currentTask.cwd ? path.resolve(currentTask.cwd) : process.cwd();

      // ── capture start_head before agent runs (branch-tracked tasks) ──────────
      let startHead = null;
      if (currentTask.branch && gitRunner) {
        startHead = await _gitStdout(gitRunner, taskCwd, ["rev-parse", "HEAD"]);
        if (startHead && !currentTask.start_head) {
          await db.updateTask(task.id, { start_head: startHead });
          currentTask = await db.getTask(task.id);
        }
      }

      // Advisory Tool Policy block (D2): adapters never see role instructions,
      // only the assembled prompt — so for advisory providers (and the codex
      // advisory remainder) the block MUST be prepended here. Deduped per run.
      let roleInstructions = await _roleInstructions(roleDef);
      if (roleDef.tools || roleDef.deny_tools) {
        let block = "";
        if (ADVISORY_PROVIDERS.has(runProvider)) {
          block = buildAdvisoryBlock(roleDef.tools, roleDef.deny_tools);
        } else if (runProvider === "codex") {
          block = advisoryRemainder(roleDef.tools, roleDef.deny_tools);
        }
        // Each role's own prompt is assembled fresh, so the block is prepended
        // once per role (no in-prompt duplication). The per-run set records
        // emitted policy texts for audit/perf bookkeeping (§8).
        if (block) {
          advisoryEmitted.add(block);
          roleInstructions = roleInstructions ? `${block}\n\n${roleInstructions}` : block;
        }
      }

      // Per-edge context contract (experimental, v0.3.0 item A): when the
      // workflow opts in, narrow the prompt's view of prior handoffs to what the
      // inbound edge (state.currentState → state.event) declares. A no-op (full
      // history) when the flag is off or the edge declares nothing.
      const promptHandoffs = contextForEdge(workflow, priorHandoffs, state.currentState, state.event);

      const prompt = buildPromptFromHandoffs({
        role: roleKey,
        task: currentTask,
        priorHandoffs: promptHandoffs,
        handoffMode,
        roleInstructions,
        outputSchema: resolveRoleSchema(roleDef).schema ?? null,
      });

      // Apply the resolved alias/model over the role defaults so a substituted
      // provider (or a defaulted model) is what actually runs.
      const stepOptions = _stepOptions(roleDef, currentTask);
      delete stepOptions.alias;
      delete stepOptions.model;
      if (runAlias) stepOptions.alias = runAlias;
      if (runModel) stepOptions.model = runModel;

      const stepStartedAt = new Date().toISOString();
      let result;
      try {
        result = await runner.runStep({
          role: roleKey,
          provider: runProvider,
          prompt,
          cwd: taskCwd,
          logDir: currentTask.run_dir,
          options: stepOptions,
          providerDef: runProviderDef,
          env: _maestroEnv(currentTask, roleKey),
          providerEnv: resolveAliasEnv(runProviderDef, runAlias, runProvider),
        });
      } catch (err) {
        // ── context-window retry ──────────────────────────────────────────────
        if (isContextWindowFailure(err) && contextRetryUsed < contextRetryLimit) {
          contextRetryUsed += 1;
          handoffMode = "strict";
          await db.appendStep(task.id, {
            role: roleKey,
            provider: runProvider,
            status: "retried",
            started_at: stepStartedAt,
            error: err.message,
            recovery: "auto_compact_retry",
            stdout_path: err.stdoutPath ?? null,
            stderr_path: err.stderrPath ?? null,
          });
          continue;
        }
        // ── usage / quota limit: switch to an available fallback provider ──────
        if (isUsageLimitFailure(err) && config && usageRetryUsed < USAGE_RETRY_LIMIT) {
          usageExhausted.add(runProvider);
          const override = currentTask.role_overrides?.[roleKey] ?? null;
          const effectiveRoleDef = applyRoleOverride(roleDef, override);
          const resolution = await resolveRoleProvider({
            roleDef: effectiveRoleDef,
            config,
            cwd: taskCwd,
            exclude: usageExhausted,
            ...(availabilityProbe ? { probe: availabilityProbe } : {}),
          });
          if (resolution.ok) {
            usageRetryUsed += 1;
            await db.appendStep(task.id, {
              role: roleKey,
              provider: runProvider,
              status: "retried",
              started_at: stepStartedAt,
              error: err.message,
              recovery: "usage_limit_fallback",
              note: `provider "${runProvider}" usage-limited; switching to "${resolution.provider}"`,
              stdout_path: err.stdoutPath ?? null,
              stderr_path: err.stderrPath ?? null,
            });
            runProvider = resolution.provider;
            runProviderDef = resolution.providerDef;
            runAlias = resolution.alias;
            runModel = resolution.model;
            continue;
          }
        }
        // ── hard failure ──────────────────────────────────────────────────────
        const usageLimited = isUsageLimitFailure(err);
        const failureCode = err.code === "ETIMEDOUT" || /timeout|timed out/i.test(err.message ?? "")
          ? "agent_timeout"
          : usageLimited
            ? "usage_limited"
            : err.exitCode === 127
              ? "provider_missing"
              : "failed_agent";
        const failureBlocker = { code: failureCode, role: roleKey, provider: runProvider, error: err.message };
        if (failureCode === "provider_missing" || failureCode === "usage_limited") {
          failureBlocker.message = describeAvailabilityFailure({ provider: runProvider, code: failureCode }, { role: roleKey });
        }
        const failureBlockers = [failureBlocker, ...(currentTask.blockers ?? [])];
        await db.appendStep(task.id, {
          role: roleKey,
          provider: runProvider,
          status: "failed",
          started_at: stepStartedAt,
          error: err.message,
          stdout_path: err.stdoutPath ?? null,
          stderr_path: err.stderrPath ?? null,
        });
        await db.updateTask(task.id, {
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
        await db.appendStep(task.id, {
          role: roleKey,
          provider: runProvider,
          status: "waiting",
          started_at: stepStartedAt,
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
        await db.updateTask(task.id, {
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
        await db.appendStep(task.id, {
          role: roleKey,
          provider: runProvider,
          status: "waiting",
          started_at: stepStartedAt,
          stdout_path: result.stdoutPath,
          stderr_path: result.stderrPath,
        });
        await db.updateTask(task.id, {
          status: "waiting_user",
          active_step: null,
          current_state: roleKey,
          active_question: { id: questionId, role: roleKey, provider: runProvider, question },
        });
        if (markProjectTaskStatus) await markProjectTaskStatus(currentTask, "waiting_user");
        return { event: "question", currentState: roleKey };
      }

      // ── parse handoff payload ─────────────────────────────────────────────
      // rawHandoff is the parsed MAESTRO_HANDOFF marker (null when none emitted).
      // Soft schema validation only runs when a marker was actually emitted —
      // an absent marker leaves nothing to validate (schema_validation omitted).
      const rawHandoff = parseAgentHandoff(combined);
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
        await db.updateTask(task.id, { review });
      } else {
        payload = rawHandoff ?? {};
      }

      // ── soft schema validation (additive evidence; never alters routing) ────
      const schemaValidation = rawHandoff != null ? validateRolePayload(roleDef, payload) : null;
      const schemaHalt = await haltOnSchemaViolation(schemaValidation);
      if (schemaHalt) return schemaHalt;

      // ── custom event passthrough: handoff may route a declared transition ──
      // Only events explicitly declared in workflow.transitions[state] and not
      // reserved by the engine are honored; everything else stays "done".
      let event = "done";
      const requestedEvent = roleKey === "reviewer"
        ? parseAgentHandoff(combined)?.event
        : payload?.event;
      if (
        typeof requestedEvent === "string"
        && !RESERVED_EVENTS.has(requestedEvent)
        && workflow?.transitions?.[transitionKey]?.[requestedEvent] !== undefined
      ) {
        event = requestedEvent;
      }

      // ── write handoff to disk (run-dir compat) ────────────────────────────
      let handoffPath = null;
      if (task.run_dir) {
        try {
          handoffPath = await _writeHandoffFile(task.run_dir, roleKey, {
            role: roleKey,
            provider: runProvider,
            payload,
            schemaValidation,
            stdoutPath: result.stdoutPath,
            stderrPath: result.stderrPath,
          });
        } catch (err) {
          process.stderr.write(`[maestro] handoff_write_failed role=${roleKey} task=${task.id} err=${err?.message}\n`);
        }
      }

      // ── persist step + handoff to DB ─────────────────────────────────────
      const stepTokens = parseUsage(runProvider, result.stdout);
      await db.appendStep(task.id, {
        role: roleKey,
        provider: runProvider,
        model: runModel,
        tokens: stepTokens,
        status: "succeeded",
        started_at: stepStartedAt,
        stdout_path: result.stdoutPath,
        stderr_path: result.stderrPath,
        handoff_path: handoffPath,
        command: result.command,
        args: result.args,
      });
      // ── live cost accounting (SP12c): emit a cost_update stage event ──────
      try {
        await db.updateTask(task.id, (current) => {
          const prior = (current.steps ?? [])
            .filter((s) => s.role === "__cost_update__")
            .at(-1)?.event?.cumulative ?? { tokens: 0 };
          const cumulative = accumulateCost(prior, {
            provider: runProvider,
            model: runModel,
            tokens: stepTokens,
          });
          const timestamp = new Date().toISOString();
          return {
            steps: [...(current.steps ?? []), {
              role: "__cost_update__",
              event: {
                kind: "cost_update",
                cumulative,
                last_step: { role: roleKey, provider: runProvider, tokens: stepTokens },
                timestamp,
              },
              started_at: timestamp,
              completed_at: timestamp,
              status: "succeeded",
            }],
          };
        }).catch(() => {});
      } catch { /* observability never breaks a run */ }
      await db.addHandoff(task.id, {
        role: roleKey,
        provider: runProvider,
        payload,
        logPath: result.stdoutPath,
        schemaValidation,
      });

      // ── git HEAD guard: non-reviewer roles with branch tracking ──────────
      if (roleKey !== "reviewer" && startHead && gitRunner) {
        const endHead = await _gitStdout(gitRunner, taskCwd, ["rev-parse", "HEAD"]);
        if (endHead && endHead !== startHead) {
          const movedTask = await db.getTask(task.id);
          await db.updateTask(task.id, {
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
        priorHandoffs: [{
          role: roleKey,
          provider: runProvider,
          payload,
          log_path: result.stdoutPath ?? null,
          ...(schemaValidation ? { schema_validation: schemaValidation } : {}),
        }],
        event,
        currentState: roleKey,
        visits: { [roleKey]: 1 },
      };
    }
  };
}

export function makeRoleNode(roleDef, opts) {
  return makeRoleNodeFn(roleDef, opts);
}
