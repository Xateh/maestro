import { nullLogger } from "./logger.mjs";
import { sendNotification } from "./notify.mjs";

function stateKey(value) {
  return String(value ?? "").toLowerCase();
}

function terminalSet(runtime) {
  return new Set(runtime.terminalStates.map(stateKey));
}

export function createRuntimeState({
  activeStates = [],
  terminalStates = [],
  maxConcurrentAgents = 1,
  maxConcurrentAgentsByState = {},
} = {}) {
  return {
    activeStates: activeStates.map(stateKey),
    terminalStates: terminalStates.map(stateKey),
    maxConcurrentAgents,
    maxConcurrentAgentsByState,
    running: new Map(),
    claimed: new Set(),
    retrying: new Map(),
    completed: new Map(),
    totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0,
    },
    rateLimits: null,
  };
}

export function sortIssuesForDispatch(issues) {
  return [...issues].sort((left, right) => {
    const leftPriority = left.priority ?? Number.POSITIVE_INFINITY;
    const rightPriority = right.priority ?? Number.POSITIVE_INFINITY;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftCreated = Date.parse(left.created_at ?? "") || Number.POSITIVE_INFINITY;
    const rightCreated = Date.parse(right.created_at ?? "") || Number.POSITIVE_INFINITY;
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return String(left.identifier).localeCompare(String(right.identifier));
  });
}

export function countRunningByState(runtime, state) {
  let count = 0;
  for (const entry of runtime.running.values()) {
    if (stateKey(entry.issue?.state) === stateKey(state)) count += 1;
  }
  return count;
}

export function isIssueEligible(issue, runtime) {
  if (!issue?.id || !issue?.identifier) return false;
  const issueState = stateKey(issue.state);
  if (!runtime.activeStates.includes(issueState)) return false;
  if (runtime.claimed.has(issue.id)) return false;
  if (runtime.running.size >= runtime.maxConcurrentAgents) return false;

  const stateLimit = runtime.maxConcurrentAgentsByState[issueState];
  if (stateLimit && countRunningByState(runtime, issueState) >= stateLimit) {
    return false;
  }

  const terminals = terminalSet(runtime);
  for (const blocker of issue.blocked_by ?? []) {
    if (!terminals.has(stateKey(blocker.state))) {
      return false;
    }
  }
  return true;
}

export function computeRetryDelay({
  continuation = false,
  continuationDelayMs = 30_000,
  attempt = 1,
  maxRetryBackoffMs = 300_000,
} = {}) {
  // Continuations use the poll interval (not a 1 s busy loop) so we don't hammer
  // fetchIssueStatesByIds on every tick while a healthy task runs.
  if (continuation) return Math.max(1_000, continuationDelayMs);
  const delay = 10_000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, maxRetryBackoffMs);
}

function nowIso() {
  return new Date().toISOString();
}

function coerceConfig(config) {
  return {
    activeStates: config.tracker.activeStates,
    terminalStates: config.tracker.terminalStates,
    maxConcurrentAgents: config.agent.maxConcurrentAgents,
    maxConcurrentAgentsByState: config.agent.maxConcurrentAgentsByState,
  };
}

export class MaestroOrchestrator {
  constructor({
    config,
    tracker,
    runner,
    workspaceManager,
    logger = nullLogger(),
    timers = { setTimeout, clearTimeout },
  }) {
    this.config = config;
    this.tracker = tracker;
    this.runner = runner;
    this.workspaceManager = workspaceManager;
    this.logger = logger;
    this.timers = timers;
    this.runtime = createRuntimeState(coerceConfig(config));
    this.lastError = null;
    this.lastTickAt = null;
    this.refreshing = null;
  }

  updateConfig(config) {
    this.config = config;
    this.runtime.activeStates = config.tracker.activeStates.map(stateKey);
    this.runtime.terminalStates = config.tracker.terminalStates.map(stateKey);
    this.runtime.maxConcurrentAgents = config.agent.maxConcurrentAgents;
    this.runtime.maxConcurrentAgentsByState = config.agent.maxConcurrentAgentsByState;
  }

  async tick() {
    this.lastTickAt = nowIso();
    await this.reconcileRunningIssues();
    const candidates = sortIssuesForDispatch(await this.tracker.fetchCandidateIssues(this.config.tracker.activeStates));
    for (const candidate of candidates) {
      if (!isIssueEligible(candidate, this.runtime)) continue;
      this.dispatch(candidate);
    }
  }

  dispatch(issue) {
    this.runtime.claimed.add(issue.id);
    this.runtime.running.set(issue.id, {
      issue,
      issue_identifier: issue.identifier,
      started_at: nowIso(),
      attempt: 0,
      last_event_at_ms: Date.now(),
    });
    this.logger.info("dispatch_issue", { issue_identifier: issue.identifier, state: issue.state });
    void this.runIssue(issue, 0, false);
  }

  async runIssue(issue, attempt, continuation) {
    const startedAtMs = Date.now();
    // Callback threaded into the runner so each agent event refreshes the stall
    // timestamp. Without this, last_event_at_ms is set once at dispatch and
    // stall detection incorrectly kills long but actively-streaming tasks (R2).
    const onActivity = () => {
      const entry = this.runtime.running.get(issue.id);
      if (entry) entry.last_event_at_ms = Date.now();
    };
    try {
      const result = await this.runner.run({ issue, attempt, continuation, onActivity });
      this.addMetrics(result?.metrics, Date.now() - startedAtMs);
      const runStatus = result?.status ?? "succeeded";
      this.runtime.completed.set(issue.id, {
        issue,
        issue_identifier: issue.identifier,
        status: runStatus,
        completed_at: nowIso(),
      });
      await this.applyTransition(issue, runStatus);
      // Best-effort outbound notification — fire and forget, never throws.
      const notifyConfig = this.config.notify;
      if (notifyConfig) {
        const notifyEvent =
          runStatus === "succeeded" ? "completed"
          : runStatus === "waiting_approval" ? "approval_needed"
          : (runStatus === "failed" || runStatus === "waiting_user") ? "halted"
          : null;
        if (notifyEvent) {
          const task = {
            id: issue.id,
            status: runStatus,
            workflow: result?.workflow ?? null,
            review: result?.review ?? {},
          };
          sendNotification(notifyEvent, task, notifyConfig).catch(() => {});
        }
      }
      // Re-dispatch at the polling interval (not 1 s) so we don't hammer
      // fetchIssueStatesByIds on every active run. The timer fires even on
      // "succeeded" so the tracker can detect external state changes (R4).
      const continuationDelayMs = this.config.polling?.intervalMs ?? 30_000;
      this.scheduleRetry(issue, { attempt: attempt + 1, continuation: true, continuationDelayMs, reason: "continuation_check" });
    } catch (error) {
      this.lastError = error.message;
      this.logger.error("issue_run_failed", {
        issue_identifier: issue.identifier,
        error: error.message,
      });
      this.scheduleRetry(issue, { attempt: attempt + 1, continuation: false, reason: error.code ?? "worker_error" });
    } finally {
      this.runtime.running.delete(issue.id);
    }
  }

  // Opt-in Linear write-back. Best-effort: a tracker failure logs a warning and
  // never breaks dispatch. Default null done/blocked states = no-op (humans move
  // the card).
  async applyTransition(issue, status) {
    const tracker = this.config.tracker;
    let target = null;
    if (status === "succeeded" && tracker.doneState) target = tracker.doneState;
    else if ((status === "waiting_user" || status === "waiting_approval") && tracker.blockedState) target = tracker.blockedState;
    if (!target) return;
    try {
      await this.tracker.transitionIssue(issue.id, target);
      this.logger.info("dispatch_issue_transitioned", { issue_identifier: issue.identifier, state: target });
    } catch (error) {
      this.logger.warn("dispatch_transition_failed", { issue_identifier: issue.identifier, state: target, error: error.message });
    }
  }

  scheduleRetry(issue, { attempt, continuation, continuationDelayMs, reason }) {
    const delayMs = computeRetryDelay({
      attempt,
      continuation,
      continuationDelayMs,
      maxRetryBackoffMs: this.config.agent.maxRetryBackoffMs,
    });
    const retryEntry = {
      issue,
      issue_identifier: issue.identifier,
      attempt,
      continuation,
      reason,
      delay_ms: delayMs,
      due_at: new Date(Date.now() + delayMs).toISOString(),
      timer: null,
    };
    retryEntry.timer = this.timers.setTimeout(() => {
      this.runtime.retrying.delete(issue.id);
      this.runtime.claimed.delete(issue.id);
      if (!isIssueEligible(issue, this.runtime)) return;
      this.runtime.claimed.add(issue.id);
      this.runtime.running.set(issue.id, {
        issue,
        issue_identifier: issue.identifier,
        started_at: nowIso(),
        attempt,
        last_event_at_ms: Date.now(),
      });
      void this.runIssue(issue, attempt, continuation);
    }, delayMs);
    this.runtime.retrying.set(issue.id, retryEntry);
    this.runtime.claimed.add(issue.id);
    this.logger.info("issue_retry_scheduled", {
      issue_identifier: issue.identifier,
      attempt,
      continuation,
      delay_ms: delayMs,
      reason,
    });
  }

  async reconcileRunningIssues() {
    const trackedIds = [...new Set([
      ...this.runtime.running.keys(),
      ...this.runtime.retrying.keys(),
    ])];
    if (trackedIds.length === 0) return;

    let latest;
    try {
      latest = await this.tracker.fetchIssueStatesByIds(trackedIds);
    } catch (error) {
      this.logger.warn("reconcile_failed", { error: error.message });
      return;
    }
    const byId = new Map(latest.map((item) => [item.id, item]));
    const terminals = terminalSet(this.runtime);

    for (const issueId of trackedIds) {
      const latestIssue = byId.get(issueId);
      if (!latestIssue) continue;
      if (!terminals.has(stateKey(latestIssue.state))) continue;

      const running = this.runtime.running.get(issueId);
      if (running) {
        this.runner.cancel?.(issueId);
        this.runtime.running.delete(issueId);
      }
      const retrying = this.runtime.retrying.get(issueId);
      if (retrying) {
        this.timers.clearTimeout(retrying.timer);
        this.runtime.retrying.delete(issueId);
      }
      this.runtime.claimed.delete(issueId);
      await this.workspaceManager.removeForIssue(latestIssue.identifier);
      this.runtime.completed.set(issueId, {
        issue: latestIssue,
        issue_identifier: latestIssue.identifier,
        status: "terminal",
        completed_at: nowIso(),
      });
      this.logger.info("issue_terminal_cleanup", {
        issue_identifier: latestIssue.identifier,
        state: latestIssue.state,
      });
    }

    const stallTimeoutMs = Number(this.config.agent.stallTimeoutMs);
    if (Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0) {
      for (const [issueId, running] of this.runtime.running.entries()) {
        if (Date.now() - running.last_event_at_ms <= stallTimeoutMs) continue;
        this.runner.cancel?.(issueId);
        this.runtime.running.delete(issueId);
        this.scheduleRetry(running.issue, {
          attempt: running.attempt + 1,
          continuation: false,
          reason: "stall_timeout",
        });
      }
    }
  }

  addMetrics(metrics = null, runtimeMs = 0) {
    if (metrics) {
      this.runtime.totals.input_tokens += Number(metrics.input_tokens ?? 0);
      this.runtime.totals.output_tokens += Number(metrics.output_tokens ?? 0);
      this.runtime.totals.total_tokens += Number(metrics.total_tokens ?? 0);
      this.runtime.totals.seconds_running += Number(metrics.seconds_running ?? runtimeMs / 1000);
    } else {
      this.runtime.totals.seconds_running += runtimeMs / 1000;
    }
  }

  snapshot() {
    return {
      generated_at: nowIso(),
      last_tick_at: this.lastTickAt,
      last_error: this.lastError,
      counts: {
        running: this.runtime.running.size,
        retrying: this.runtime.retrying.size,
        completed: this.runtime.completed.size,
      },
      running: [...this.runtime.running.values()].map((entry) => ({
        issue_identifier: entry.issue_identifier,
        state: entry.issue.state,
        attempt: entry.attempt,
        started_at: entry.started_at,
      })),
      retrying: [...this.runtime.retrying.values()].map((entry) => ({
        issue_identifier: entry.issue_identifier,
        attempt: entry.attempt,
        continuation: entry.continuation,
        reason: entry.reason,
        delay_ms: entry.delay_ms,
        due_at: entry.due_at,
      })),
      completed: [...this.runtime.completed.values()].map((entry) => ({
        issue_identifier: entry.issue_identifier,
        status: entry.status,
        completed_at: entry.completed_at,
      })),
      codex_totals: this.runtime.totals,
      rate_limits: this.runtime.rateLimits,
    };
  }

  issueDetails(identifier) {
    for (const entry of this.runtime.running.values()) {
      if (entry.issue_identifier === identifier) {
        return {
          issue_identifier: identifier,
          status: "running",
          issue: entry.issue,
          started_at: entry.started_at,
          attempt: entry.attempt,
        };
      }
    }
    for (const entry of this.runtime.retrying.values()) {
      if (entry.issue_identifier === identifier) {
        return {
          issue_identifier: identifier,
          status: "retrying",
          issue: entry.issue,
          attempt: entry.attempt,
          due_at: entry.due_at,
          reason: entry.reason,
        };
      }
    }
    for (const entry of this.runtime.completed.values()) {
      if (entry.issue_identifier === identifier) {
        return {
          issue_identifier: identifier,
          status: entry.status,
          issue: entry.issue,
          completed_at: entry.completed_at,
        };
      }
    }
    return null;
  }

  async refresh() {
    if (this.refreshing) {
      return { queued: true, coalesced: true, operations: ["poll", "reconcile"] };
    }
    this.refreshing = this.tick()
      .catch((error) => {
        this.lastError = error.message;
        this.logger.error("refresh_failed", { error: error.message });
      })
      .finally(() => {
        this.refreshing = null;
      });
    return { queued: true, coalesced: false, operations: ["poll", "reconcile"] };
  }

  async stop() {
    for (const entry of this.runtime.retrying.values()) {
      this.timers.clearTimeout(entry.timer);
    }
    for (const issueId of this.runtime.running.keys()) {
      this.runner.cancel?.(issueId);
    }
  }
}
