// Pure workflow validation: structural checks plus cycle detection with
// termination-clause analysis. No I/O — callers pass parsed workflow/config.

import { SINK_STATES, isSink } from "./state-machine.mjs";

// Enumerate simple cycles among role→role transitions (sink destinations are
// not edges). Workflows are tiny, so a DFS from every node is fine. Cycles are
// canonicalized (rotated to start at the smallest node) and deduped.
export function findCycles(transitions = {}) {
  const edges = {};
  for (const [from, byEvent] of Object.entries(transitions)) {
    edges[from] = [...new Set(Object.values(byEvent ?? {}).filter((to) => !isSink(to)))];
  }

  const cycles = new Map();
  const addCycle = (stack, node) => {
    const start = stack.indexOf(node);
    const cycle = stack.slice(start);
    let smallest = 0;
    for (let i = 1; i < cycle.length; i += 1) {
      if (cycle[i] < cycle[smallest]) smallest = i;
    }
    const canonical = [...cycle.slice(smallest), ...cycle.slice(0, smallest)];
    cycles.set(canonical.join("→"), canonical);
  };

  const walk = (node, stack) => {
    if (stack.includes(node)) {
      addCycle(stack, node);
      return;
    }
    const nextStack = [...stack, node];
    for (const next of edges[node] ?? []) walk(next, nextStack);
  };
  for (const node of Object.keys(edges)) walk(node, []);
  return [...cycles.values()];
}

// A cycle has a termination clause when some state in it can exit to a sink,
// or a visit cap bounds it (per-role max_visits or workflow loop_limits).
export function cycleHasTermination(cycle, workflow = {}) {
  const limits = workflow.loop_limits ?? {};
  if (Number.isInteger(limits.default_max_visits) && limits.default_max_visits > 0) return true;
  for (const state of cycle) {
    const role = workflow.roles?.[state] ?? {};
    if (Number.isInteger(role.max_visits) && role.max_visits > 0) return true;
    if (Object.values(workflow.transitions?.[state] ?? {}).some((to) => isSink(to))) return true;
  }
  return false;
}

function issue(code, message) {
  return { code, message };
}

export function validateWorkflow(workflow = {}, { config = null } = {}) {
  const errors = [];
  const warnings = [];
  const roles = workflow.roles ?? {};
  const transitions = workflow.transitions ?? {};
  const roleNames = new Set(Object.keys(roles));
  const isKnownState = (state) => roleNames.has(state) || isSink(state);

  if (!workflow.initial || !roleNames.has(workflow.initial)) {
    errors.push(issue("bad_initial", `initial state "${workflow.initial}" is not a defined role`));
  }

  for (const [from, byEvent] of Object.entries(transitions)) {
    if (!roleNames.has(from)) {
      errors.push(issue("unknown_transition_source", `transitions defined for unknown role "${from}"`));
    }
    for (const [event, to] of Object.entries(byEvent ?? {})) {
      if (!isKnownState(to)) {
        errors.push(issue(
          "unknown_transition_target",
          `transition ${from}:${event} → "${to}" targets neither a role nor a sink (${[...SINK_STATES].join(", ")})`,
        ));
      }
    }
  }

  for (const [modeName, mode] of Object.entries(workflow.modes ?? {})) {
    if (mode?.initial && !roleNames.has(mode.initial)) {
      errors.push(issue("bad_mode_initial", `mode "${modeName}" initial "${mode.initial}" is not a defined role`));
    }
    for (const state of mode?.terminal_after ?? []) {
      if (!roleNames.has(state)) {
        errors.push(issue("bad_mode_terminal", `mode "${modeName}" terminal_after "${state}" is not a defined role`));
      }
    }
  }

  const limits = workflow.loop_limits;
  if (limits !== undefined) {
    const max = limits?.default_max_visits;
    if (max !== undefined && (!Number.isInteger(max) || max <= 0)) {
      errors.push(issue("bad_loop_limits", `loop_limits.default_max_visits must be a positive integer, got ${JSON.stringify(max)}`));
    }
    const onExceeded = limits?.on_exceeded;
    if (onExceeded !== undefined && !["ask_user", "halt"].includes(onExceeded)) {
      errors.push(issue("bad_loop_limits", `loop_limits.on_exceeded must be "ask_user" or "halt", got ${JSON.stringify(onExceeded)}`));
    }
  }

  for (const [roleName, role] of Object.entries(roles)) {
    const max = role?.max_visits;
    if (max !== undefined && (!Number.isInteger(max) || max <= 0)) {
      errors.push(issue("bad_max_visits", `role "${roleName}" max_visits must be a positive integer, got ${JSON.stringify(max)}`));
    }
    if (config?.providers && role?.provider && !config.providers[role.provider]) {
      warnings.push(issue("unknown_provider", `role "${roleName}" uses provider "${role.provider}" which is not configured`));
    }
  }

  // Reachability from initial + every mode initial.
  const reachable = new Set();
  const queue = [workflow.initial, ...Object.values(workflow.modes ?? {}).map((m) => m?.initial)]
    .filter((s) => roleNames.has(s));
  while (queue.length > 0) {
    const state = queue.shift();
    if (reachable.has(state)) continue;
    reachable.add(state);
    for (const to of Object.values(transitions[state] ?? {})) {
      if (roleNames.has(to) && !reachable.has(to)) queue.push(to);
    }
  }
  for (const roleName of roleNames) {
    if (!reachable.has(roleName)) {
      warnings.push(issue("unreachable_role", `role "${roleName}" is not reachable from any initial state`));
    }
  }

  for (const cycle of findCycles(transitions)) {
    if (!cycleHasTermination(cycle, workflow)) {
      const loop = [...cycle, cycle[0]].join(" → ");
      warnings.push(issue(
        "unterminated_cycle",
        `cycle ${loop} has no termination clause — add "max_visits" to one of these roles, `
        + `set workflow "loop_limits": {"default_max_visits": N}, or add a transition from a state in the cycle to a sink`,
      ));
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function formatValidation(result) {
  const lines = [];
  for (const error of result.errors) lines.push(`error [${error.code}]: ${error.message}`);
  for (const warning of result.warnings) lines.push(`warning [${warning.code}]: ${warning.message}`);
  if (lines.length === 0) lines.push("workflow OK — no errors, no warnings");
  return lines.join("\n");
}
