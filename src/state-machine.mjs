export const SINK_STATES = new Set(["$complete", "$halt", "$ask_user", "$pause", "$wait"]);

// Events with engine-defined semantics; handoff payloads may not redefine them.
export const RESERVED_EVENTS = new Set([
  "done", "error", "question", "waiting", "needs_review", "pause",
]);

export function isSink(state) {
  return SINK_STATES.has(state);
}

// Effective visit cap for a role: per-role max_visits, else the workflow-wide
// loop_limits default, else null (unbounded).
export function resolveMaxVisits(workflow, role) {
  const roleMax = workflow?.roles?.[role]?.max_visits;
  if (Number.isInteger(roleMax) && roleMax > 0) return roleMax;
  const defaultMax = workflow?.loop_limits?.default_max_visits;
  if (Number.isInteger(defaultMax) && defaultMax > 0) return defaultMax;
  return null;
}

// Resolve the next state given the current state, event, and workflow transitions.
// Returns a sink string or a role name. Never throws — missing transitions default to "$halt".
export function transition(workflow, currentState, event) {
  const stateTransitions = workflow?.transitions?.[currentState];
  if (!stateTransitions) return "$halt";
  const next = stateTransitions[event];
  return next ?? "$halt";
}

// Build the initial state for a task given its mode.
// Skip logic is handled in the state machine loop via effectiveSkipForState.
export function resolveInitialState(workflow, { mode = "task" } = {}) {
  const modeConfig = workflow?.modes?.[mode];
  return modeConfig?.initial ?? workflow?.initial ?? "planner";
}

// Resolve the effective skip value for a state.
// Task-level role_skips override the workflow role's skip field.
// Returns "auto" | "always" | "never".
export function effectiveSkipForState(workflow, state, taskRoleSkips = null) {
  if (taskRoleSkips && Object.hasOwn(taskRoleSkips, state)) {
    return taskRoleSkips[state];
  }
  return workflow?.roles?.[state]?.skip ?? "auto";
}

// Check if the current state should terminate the run immediately (terminal_after mode).
export function isTerminalAfterState(workflow, mode, state) {
  const modeConfig = workflow?.modes?.[mode];
  const terminalAfter = modeConfig?.terminal_after;
  if (!Array.isArray(terminalAfter)) return false;
  return terminalAfter.includes(state);
}

