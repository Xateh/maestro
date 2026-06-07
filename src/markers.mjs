/**
 * Pure output-marker parsers shared between symphony.mjs and the LangGraph engine.
 * No I/O, no side effects. All parsers return null / [] on failure.
 */

// ─── prefixes ────────────────────────────────────────────────────────────────

export const HANDOFF_PREFIX = "SYMPHONY_HANDOFF:";
export const QUESTION_PREFIX = "SYMPHONY_QUESTION:";
export const REVIEW_PREFIX = "SYMPHONY_REVIEW:";
export const ACTION_REQUEST_PREFIX = "SYMPHONY_ACTION_REQUEST:";

// ─── context-window failure ───────────────────────────────────────────────────

const CONTEXT_WINDOW_PATTERNS = [
  /context window/i,
  /context length/i,
  /ran out of room/i,
  /too many tokens/i,
  /input is too long/i,
  /start a new (?:thread|text)/i,
  /clear earlier history/i,
];

export function isContextWindowFailure(error) {
  const text = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
  return CONTEXT_WINDOW_PATTERNS.some((p) => p.test(text));
}

// ─── SYMPHONY_QUESTION ───────────────────────────────────────────────────────

function _questionFromText(value = "") {
  for (const line of String(value).split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(QUESTION_PREFIX)) {
      const q = t.slice(QUESTION_PREFIX.length).trim();
      if (q) return q;
    }
  }
  return null;
}

function _questionFromValue(value) {
  if (typeof value === "string") return _questionFromText(value);
  if (Array.isArray(value)) {
    for (const item of value) { const q = _questionFromValue(item); if (q) return q; }
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) { const q = _questionFromValue(item); if (q) return q; }
  }
  return null;
}

export function parseAgentQuestion(output = "") {
  const direct = _questionFromText(output);
  if (direct) return direct;
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const q = _questionFromValue(JSON.parse(line)); if (q) return q; } catch {}
  }
  return null;
}

// ─── SYMPHONY_HANDOFF ────────────────────────────────────────────────────────

function _handoffFromText(value = "") {
  for (const line of String(value).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith(HANDOFF_PREFIX)) continue;
    const payload = t.slice(HANDOFF_PREFIX.length).trim();
    if (!payload) continue;
    try { return JSON.parse(payload); } catch { continue; }
  }
  return null;
}

function _handoffFromValue(value) {
  if (typeof value === "string") return _handoffFromText(value);
  if (Array.isArray(value)) {
    for (const item of value) { const h = _handoffFromValue(item); if (h) return h; }
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) { const h = _handoffFromValue(item); if (h) return h; }
  }
  return null;
}

export function parseAgentHandoff(output = "") {
  const direct = _handoffFromText(output);
  if (direct) return direct;
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const h = _handoffFromValue(JSON.parse(line)); if (h) return h; } catch {}
  }
  return null;
}

// ─── SYMPHONY_ACTION_REQUEST ─────────────────────────────────────────────────

function _actionRequestsFromText(value = "") {
  const payloads = [];
  for (const line of String(value).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith(ACTION_REQUEST_PREFIX)) continue;
    const payload = t.slice(ACTION_REQUEST_PREFIX.length).trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload);
      if (Array.isArray(parsed)) payloads.push(...parsed);
      else if (Array.isArray(parsed.action_requests)) payloads.push(...parsed.action_requests);
      else payloads.push(parsed);
    } catch {}
  }
  return payloads;
}

function _actionRequestsFromValue(value) {
  if (typeof value === "string") return _actionRequestsFromText(value);
  if (Array.isArray(value)) return value.flatMap(_actionRequestsFromValue);
  if (value && typeof value === "object") return Object.values(value).flatMap(_actionRequestsFromValue);
  return [];
}

export function parseAgentActionRequests(output = "") {
  const payloads = _actionRequestsFromText(output);
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { payloads.push(..._actionRequestsFromValue(JSON.parse(line))); } catch {}
  }
  return payloads;
}

// ─── SYMPHONY_REVIEW ─────────────────────────────────────────────────────────

const REVIEW_COMPLETION_STATES = new Set([
  "complete", "incomplete_continueable", "incomplete_needs_user",
  "incomplete_needs_approval", "blocked_external", "blocked_repo_state",
  "blocked_safety", "failed_agent", "uncertain",
]);
const REVIEW_REQUIRED_ACTIONS = new Set([
  "none", "continue", "ask_user", "request_approval", "manual_fix",
  "retry_after_environment_change", "mark_failed",
]);
const REVIEW_ACTIONS_BY_COMPLETION = new Map([
  ["complete", new Set(["none"])],
  ["incomplete_continueable", new Set(["continue"])],
  ["incomplete_needs_user", new Set(["ask_user"])],
  ["incomplete_needs_approval", new Set(["request_approval"])],
  ["blocked_external", new Set(["retry_after_environment_change", "manual_fix"])],
  ["blocked_repo_state", new Set(["manual_fix"])],
  ["blocked_safety", new Set(["manual_fix"])],
  ["failed_agent", new Set(["mark_failed"])],
  ["uncertain", new Set(["manual_fix", "mark_failed"])],
]);
const REVIEW_RISK_LEVELS = new Set(["none", "low", "medium", "high"]);
const REVIEW_CONFIDENCE_LEVELS = new Set(["low", "medium", "high"]);
export const REVIEW_MAX_CONTINUATIONS = 1;

function _trimStr(value, max = 2000) {
  const buf = Buffer.from(String(value ?? ""), "utf8");
  if (buf.length <= max) return buf.toString("utf8").trim();
  return buf.subarray(0, max).toString("utf8").replace(/�$/g, "").trim();
}

function _sanitizeStr(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  return _trimStr(v) || fallback;
}

function _sanitizeStrList(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 10).map((v) => _sanitizeStr(v)).filter(Boolean);
}

function _sanitizeObj(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const next = {};
  for (const k of keys) {
    if (value[k] !== null && value[k] !== undefined) next[k] = _sanitizeStr(value[k]);
  }
  return Object.keys(next).length > 0 ? next : null;
}

function _invalidReview(summary) {
  return {
    status: "invalid",
    completion_state: "uncertain",
    required_action: "manual_fix",
    risk_level: "medium",
    confidence: "low",
    summary,
    evidence: [],
    blockers: [],
    required_user_input: null,
    approval_request: null,
    action_requests: [],
    unblock_options: [],
    continuation: null,
    continuation_attempts: 0,
    max_continuations: REVIEW_MAX_CONTINUATIONS,
    decided_at: new Date().toISOString(),
  };
}

function _normalizeReview(payload, previousReview = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return _invalidReview("Reviewer marker was not a JSON object.");
  }
  const completionState = _sanitizeStr(payload.completion_state);
  const requiredAction = _sanitizeStr(payload.required_action);
  if (!REVIEW_COMPLETION_STATES.has(completionState)) {
    return _invalidReview(`Reviewer marker used invalid completion_state: ${completionState || "<missing>"}.`);
  }
  if (!REVIEW_REQUIRED_ACTIONS.has(requiredAction)) {
    return _invalidReview(`Reviewer marker used invalid required_action: ${requiredAction || "<missing>"}.`);
  }
  const allowed = REVIEW_ACTIONS_BY_COMPLETION.get(completionState);
  if (allowed && !allowed.has(requiredAction)) {
    return _invalidReview(`Reviewer marker used required_action ${requiredAction} for ${completionState}.`);
  }
  const riskLevel = _sanitizeStr(payload.risk_level, "medium");
  const confidence = _sanitizeStr(payload.confidence, "low");
  return {
    status: "reviewed",
    completion_state: completionState,
    required_action: requiredAction,
    risk_level: REVIEW_RISK_LEVELS.has(riskLevel) ? riskLevel : "medium",
    confidence: REVIEW_CONFIDENCE_LEVELS.has(confidence) ? confidence : "low",
    summary: _sanitizeStr(payload.summary),
    evidence: _sanitizeStrList(payload.evidence),
    blockers: Array.isArray(payload.blockers)
      ? payload.blockers.slice(0, 10).map((v) => (typeof v === "string" ? { summary: _sanitizeStr(v) } : _sanitizeObj(v, ["code", "summary", "reason", "required_action", "evidence"]))).filter(Boolean)
      : [],
    required_user_input: _sanitizeObj(payload.required_user_input, ["question", "reason"]),
    approval_request: _sanitizeObj(payload.approval_request, ["action", "reason"]),
    action_requests: Array.isArray(payload.action_requests) ? payload.action_requests.slice(0, 10) : [],
    unblock_options: Array.isArray(payload.unblock_options) ? payload.unblock_options.slice(0, 10) : [],
    continuation: _sanitizeObj(payload.continuation, ["prompt", "reason"]),
    continuation_attempts: previousReview?.continuation_attempts ?? 0,
    max_continuations: previousReview?.max_continuations ?? REVIEW_MAX_CONTINUATIONS,
    decided_at: new Date().toISOString(),
  };
}

function _extractReviewPayloadsFromText(value = "") {
  const payloads = [];
  let inFence = false;
  for (const line of String(value).split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence || !t.startsWith(REVIEW_PREFIX)) continue;
    const payload = t.slice(REVIEW_PREFIX.length).trim();
    if (!payload) continue;
    try { payloads.push(JSON.parse(payload)); } catch {}
  }
  return payloads;
}

function _reviewCandidates(value) {
  if (Array.isArray(value)) return value.flatMap(_reviewCandidates);
  if (value && typeof value === "object") {
    const candidates = [];
    for (const key of ["text", "message", "output_text", "delta"]) {
      if (typeof value[key] === "string") candidates.push(value[key]);
    }
    if (typeof value.content === "string") candidates.push(value.content);
    else if (Array.isArray(value.content)) candidates.push(..._reviewCandidates(value.content));
    for (const key of ["item", "message", "response"]) {
      if (value[key] && typeof value[key] === "object") candidates.push(..._reviewCandidates(value[key]));
    }
    return candidates;
  }
  return [];
}

export function parseReviewerOutput(output = "", previousReview = null) {
  const payloads = _extractReviewPayloadsFromText(output);
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const fromJson = _reviewCandidates(JSON.parse(line)).flatMap(_extractReviewPayloadsFromText);
      payloads.push(...fromJson);
    } catch {}
  }
  if (payloads.length === 0) return _invalidReview("Reviewer did not emit a valid SYMPHONY_REVIEW marker.");
  return _normalizeReview(payloads.at(-1), previousReview);
}

// ─── synthetic skipped-review ─────────────────────────────────────────────────

/** Return a synthetic skipped-review object for when review_enabled === false. */
export function skippedReview() {
  return {
    status: "skipped",
    completion_state: "complete",
    required_action: "none",
    risk_level: "none",
    confidence: "high",
    summary: "Review disabled.",
    evidence: [],
    blockers: [],
    continuation_attempts: 0,
    max_continuations: REVIEW_MAX_CONTINUATIONS,
    decided_at: new Date().toISOString(),
  };
}
