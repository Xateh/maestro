// Pure workflow validation: structural checks plus cycle detection with
// termination-clause analysis. No I/O — callers pass parsed workflow/config.

import { SINK_STATES, isSink } from "./state-machine.mjs";
import { resolveRoleSchema, validateInline } from "./schemas/index.mjs";
import { validateToolToken } from "./adapters/tool-flags.mjs";

// Role names that denote a verification stage. When a role with one of these
// names declares no resolvable output schema we emit a `missing_output_schema`
// warning (advisory only — these stages benefit from a structured contract).
const VERIFIER_ROLE_NAMES = new Set([
  "review",
  "threat_model",
  "edge_cases",
  "tests",
  "evaluation",
  "regression",
]);

// Allowed `gates` keys → validator predicate. Each returns true when the value
// is acceptable. Enforcement of the gate values themselves is SP5; SP1 only
// validates the manifest declaration.
const isUnit = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isPercent = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
const isBool = (v) => typeof v === "boolean";
const GATE_VALIDATORS = {
  min_coverage: isPercent,
  no_high_severity_findings: isBool,
  all_regressions_pass: isBool,
  min_overall_confidence: isUnit,
  output_schema_conformance: isBool,
};

// Known coverage format values for command role parser.coverage.format validation (SP8)
const KNOWN_COVERAGE_FORMATS = new Set(["c8-json", "lcov", "jest-json", "cobertura", "clover", "regex"]);

// Syntactic check for output_schema_ref / MRC source: a relative path that does
// not escape the state dir. No file I/O — existence is checked at load, not here.
// Exported (D3) so the loader/CLI lint reuse the same predicate.
export function isSafeRelativeRef(ref) {
  if (typeof ref !== "string" || ref.length === 0) return false;
  if (ref.startsWith("/")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(ref)) return false; // windows absolute
  const segments = ref.split(/[\\/]/);
  if (segments.includes("..")) return false;
  return true;
}

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

    // ── MRC source / tools / deny_tools (structural only; existence at load) ──
    // `source` is an MRC unit ref ONLY when it is a STRING (D5). A legacy import
    // provenance OBJECT source is ignored here so existing imported roles do not
    // break.
    if (typeof role?.source === "string") {
      if (!isSafeRelativeRef(role.source)) {
        errors.push(issue(
          "bad_role_source",
          `role "${roleName}" source must be a relative path inside the state dir, got ${JSON.stringify(role.source)}`,
        ));
      }
    }
    for (const field of ["tools", "deny_tools"]) {
      const value = role?.[field];
      if (value === undefined) continue;
      if (!Array.isArray(value)) {
        errors.push(issue("bad_tool_token", `role "${roleName}" ${field} must be an array of tool tokens, got ${JSON.stringify(value)}`));
        continue;
      }
      for (const token of value) {
        const verdict = validateToolToken(token);
        if (!verdict.ok) {
          errors.push(issue("bad_tool_token", `role "${roleName}" ${field} has an invalid tool token ${JSON.stringify(token)}`));
        }
      }
    }
    if (role?.fallback !== undefined && !Array.isArray(role.fallback)) {
      errors.push(issue("bad_fallback", `role "${roleName}" fallback must be an array of provider keys, got ${JSON.stringify(role.fallback)}`));
    } else if (Array.isArray(role?.fallback) && config?.providers) {
      for (const key of role.fallback) {
        if (!config.providers[key]) {
          warnings.push(issue("unknown_fallback", `role "${roleName}" fallback provider "${key}" is not configured`));
        }
      }
    }

    // ── command role spec (SP3 kind:"command") ─────────────────────────────
    // Each command needs a non-empty name + run; names must be unique within
    // the role. An empty commands:[] is valid (opt-in no-op). `category` is
    // permissive (any string / absent) — unknown categories are not rejected.
    if (role?.kind === "command") {
      if (role.commands !== undefined && !Array.isArray(role.commands)) {
        errors.push(issue("bad_command_spec", `role "${roleName}" commands must be an array, got ${JSON.stringify(role.commands)}`));
      } else if (Array.isArray(role.commands)) {
        const seen = new Set();
        for (const [i, command] of role.commands.entries()) {
          const name = command?.name;
          const run = command?.run;
          if (typeof name !== "string" || name.length === 0) {
            errors.push(issue("bad_command_spec", `role "${roleName}" command[${i}] is missing a non-empty "name"`));
          } else if (seen.has(name)) {
            errors.push(issue("bad_command_spec", `role "${roleName}" command name "${name}" is duplicated`));
          } else {
            seen.add(name);
          }
          if (typeof run !== "string" || run.length === 0) {
            errors.push(issue("bad_command_spec", `role "${roleName}" command "${name ?? i}" is missing a non-empty "run"`));
          }
          // ── SP8: validate coverage.format in command parser ──
          const cov = command?.parser?.coverage;
          if (cov !== undefined) {
            if (!cov || typeof cov !== "object") {
              errors.push(issue("bad_command_spec",
                `role "${roleName}" command "${name ?? i}" parser.coverage must be an object`));
            } else {
              const fmt = cov.format;
              if (typeof fmt !== "string" || !KNOWN_COVERAGE_FORMATS.has(fmt)) {
                errors.push(issue("bad_command_spec",
                  `role "${roleName}" command "${name ?? i}" coverage.format must be one of: ${[...KNOWN_COVERAGE_FORMATS].join(", ")}, got ${JSON.stringify(fmt)}`));
              } else if (fmt === "regex" && (typeof cov.pct !== "string" || cov.pct.length === 0)) {
                errors.push(issue("bad_command_spec",
                  `role "${roleName}" command "${name ?? i}" coverage.format "regex" requires a non-empty "pct" regex string`));
              }
            }
          }
        }
      }
    }

    // ── regression role spec (SP4 kind:"regression") ───────────────────────
    // A regression role must declare both a "done" and its effective fail_event
    // transition (default "regressions_found") so an unmapped event cannot throw
    // inside LangGraph at runtime; attempts/fail_threshold, if present, must be
    // positive integers.
    if (role?.kind === "regression") {
      const failEvent = role.fail_event ?? "regressions_found";
      const t = transitions[roleName] ?? {};
      if (!("done" in t)) {
        errors.push(issue("bad_regression_spec",
          `role "${roleName}" (kind:"regression") must declare a "done" transition`));
      }
      if (!(failEvent in t)) {
        errors.push(issue("bad_regression_spec",
          `role "${roleName}" (kind:"regression") must declare its fail_event "${failEvent}" transition`));
      }
      if (role.attempts !== undefined && (!Number.isInteger(role.attempts) || role.attempts <= 0)) {
        errors.push(issue("bad_regression_spec",
          `role "${roleName}" attempts must be a positive integer, got ${JSON.stringify(role.attempts)}`));
      }
      if (role.fail_threshold !== undefined && (!Number.isInteger(role.fail_threshold) || role.fail_threshold <= 0)) {
        errors.push(issue("bad_regression_spec",
          `role "${roleName}" fail_threshold must be a positive integer, got ${JSON.stringify(role.fail_threshold)}`));
      }
    }

    // ── scoring role spec (SP5 kind:"scoring") ─────────────────────────────
    // A scoring role must declare both its effective pass_event (default
    // "passed") and block_event (default "blocked") transitions so an unmapped
    // event cannot throw inside LangGraph at runtime.
    if (role?.kind === "scoring") {
      const passEvent = role.pass_event ?? "passed";
      const blockEvent = role.block_event ?? "blocked";
      const t = transitions[roleName] ?? {};
      if (!(passEvent in t)) {
        errors.push(issue("bad_scoring_spec",
          `role "${roleName}" (kind:"scoring") must declare its pass_event "${passEvent}" transition`));
      }
      if (!(blockEvent in t)) {
        errors.push(issue("bad_scoring_spec",
          `role "${roleName}" (kind:"scoring") must declare its block_event "${blockEvent}" transition`));
      }
    }

    // ── output schema declaration (manifest v2) ─────────────────────────────
    const resolved = resolveRoleSchema(role ?? {});
    if (resolved.source === "unknown") {
      errors.push(issue(
        "unknown_output_schema",
        `role "${roleName}" output_schema "${resolved.name}" is not a known registry schema`,
      ));
    } else if (resolved.source === "inline") {
      // Compile the inline schema in-memory (no file I/O); report failures.
      const compiled = validateInline(resolved.schema, {});
      const compileError = compiled.errors.find((e) => e.message?.startsWith("bad_schema"));
      if (compileError) {
        errors.push(issue(
          "bad_output_schema",
          `role "${roleName}" inline output_schema does not compile: ${compileError.message}`,
        ));
      }
    } else if (resolved.source === "ref") {
      if (!isSafeRelativeRef(role.output_schema_ref)) {
        errors.push(issue(
          "bad_output_schema",
          `role "${roleName}" output_schema_ref must be a relative path inside the state dir, got ${JSON.stringify(role.output_schema_ref)}`,
        ));
      }
    }

    // `output_schema_ref` given as a non-string never reaches source:"ref"
    // (resolveRoleSchema ignores it); flag it explicitly.
    if (role?.output_schema_ref !== undefined && typeof role.output_schema_ref !== "string") {
      errors.push(issue(
        "bad_output_schema",
        `role "${roleName}" output_schema_ref must be a string path, got ${JSON.stringify(role.output_schema_ref)}`,
      ));
    }

    // ── opt-in strict enforcement flag (U2) ─────────────────────────────────
    // `enforce_output_schema: true` promotes soft validation to a hard halt at
    // runtime. Must be boolean; declaring it without a resolvable schema is a
    // no-op (advisory), since there is nothing to enforce.
    if (role?.enforce_output_schema !== undefined && !isBool(role.enforce_output_schema)) {
      errors.push(issue(
        "bad_enforce_output_schema",
        `role "${roleName}" enforce_output_schema must be a boolean, got ${JSON.stringify(role.enforce_output_schema)}`,
      ));
    } else if (role?.enforce_output_schema === true
      && (resolved.source === "none" || resolved.source === "unknown")) {
      warnings.push(issue(
        "enforce_without_schema",
        `role "${roleName}" sets enforce_output_schema but declares no resolvable output_schema — nothing to enforce`,
      ));
    }

    // Verifier-named role lacking any resolvable schema → advisory warning.
    if (VERIFIER_ROLE_NAMES.has(roleName)
      && (resolved.source === "none" || resolved.source === "unknown")) {
      warnings.push(issue(
        "missing_output_schema",
        `role "${roleName}" matches a known verifier stage but declares no output_schema`,
      ));
    }
  }

  // ── session-level independence (SP2) ───────────────────────────────────────
  // A role that is an implementation entry role (workflow.initial or any
  // modes.<mode>.initial) MUST NOT also be a verifier — that would let one
  // session both implement and verify its own work. Distinct roles ⇒ distinct
  // sessions ⇒ independent by construction. Pure check, no runtime cost.
  const entryRoles = new Set(
    [workflow.initial, ...Object.values(workflow.modes ?? {}).map((m) => m?.initial)]
      .filter((s) => roleNames.has(s)),
  );
  for (const roleName of entryRoles) {
    if (roles[roleName]?.verifies === true) {
      errors.push(issue(
        "non_independent_role",
        `role "${roleName}" is both an implementation entry role and a verifier`,
      ));
    }
  }

  // ── cross-provider enforcement (v0.3.0 item C → v0.4.0 default-on) ──────────
  // SP10a: absent ⇒ default-on (warning for one release); true ⇒ error; false ⇒ opt-out
  if (workflow.require_distinct_reviewer !== undefined
    && !isBool(workflow.require_distinct_reviewer)) {
    errors.push(issue("bad_require_distinct_reviewer",
      `require_distinct_reviewer must be a boolean, got ${JSON.stringify(workflow.require_distinct_reviewer)}`));
  } else if (workflow.require_distinct_reviewer === false) {
    warnings.push(issue("deprecated_distinct_reviewer_opt_out",
      `require_distinct_reviewer: false is deprecated; the check defaults to true in v0.4.0 and will be required in v0.5.0`));
  } else {
    // true (explicit) or absent (default-on)
    const isDefaultOn = workflow.require_distinct_reviewer === undefined;
    const entryProviders = new Set(
      [...entryRoles].map((name) => roles[name]?.provider).filter(Boolean),
    );
    for (const [roleName, role] of Object.entries(roles)) {
      if (role?.verifies === true && role?.provider && entryProviders.has(role.provider)) {
        const msg = `verifier role "${roleName}" shares provider "${role.provider}" with an implementation entry role`
          + (isDefaultOn
            ? ` — require_distinct_reviewer defaults to true in v0.4.0 (will be an error in v0.5.0)`
            : ` — require_distinct_reviewer demands a different reviewer model`);
        if (isDefaultOn) {
          warnings.push(issue("non_distinct_reviewer", msg));
        } else {
          errors.push(issue("non_distinct_reviewer", msg));
        }
      }
    }
  }

  // ── parallel groups (SP7) ──────────────────────────────────────────────────────
  if (workflow.parallel_groups !== undefined) {
    if (!Array.isArray(workflow.parallel_groups)) {
      errors.push(issue("bad_parallel_group", `parallel_groups must be an array of role-name arrays`));
    } else {
      for (const [gi, group] of workflow.parallel_groups.entries()) {
        if (!Array.isArray(group) || group.length < 2) {
          errors.push(issue("bad_parallel_group",
            `parallel_groups[${gi}] must contain at least 2 role names — fewer than 2 members is not a valid parallel group`));
          continue;
        }
        const groupSet = new Set(group);
        for (const [ri, roleName] of group.entries()) {
          if (!roleNames.has(roleName)) {
            errors.push(issue("bad_parallel_group",
              `parallel_groups[${gi}][${ri}]: role "${roleName}" is not defined`));
            continue;
          }
          const role = roles[roleName];
          // No scoring roles in a parallel group
          if (role?.kind === "scoring") {
            errors.push(issue("bad_parallel_group",
              `parallel_groups[${gi}]: role "${roleName}" is kind:"scoring" — scoring roles read all prior handoffs and cannot run concurrently`));
          }
          // No inbound edges from siblings
          const outbound = Object.values(transitions[roleName] ?? {});
          for (const dest of outbound) {
            if (groupSet.has(dest)) {
              errors.push(issue("bad_parallel_group",
                `parallel_groups[${gi}]: role "${roleName}" has a sibling edge to "${dest}" — group members must not depend on each other`));
            }
          }
        }
        // All members must share the same "done" transition target. Routing
        // uses group[0]'s done edge for the whole group, so divergent targets
        // are a silent correctness bug. Normalize a missing "done" transition
        // to a sentinel so "all missing" matches but "some missing" does not.
        const MISSING_DONE = Symbol("missing-done");
        const doneTargets = group.map((roleName) =>
          (transitions[roleName] ?? {}).done ?? MISSING_DONE);
        const distinct = new Set(doneTargets);
        if (distinct.size > 1) {
          const shown = doneTargets
            .map((t) => (t === MISSING_DONE ? "(none)" : JSON.stringify(t)))
            .join(", ");
          errors.push(issue("bad_parallel_group",
            `parallel_groups[${gi}]: members have differing "done" targets [${shown}] — all members must share the same "done" target since routing uses the first member's done edge`));
        }
      }
    }
  }

  // ── top-level gates block (manifest v2) ────────────────────────────────────
  if (workflow.gates !== undefined) {
    const gates = workflow.gates;
    if (gates === null || typeof gates !== "object" || Array.isArray(gates)) {
      errors.push(issue("bad_gates", `gates must be an object, got ${JSON.stringify(gates)}`));
    } else {
      for (const [key, value] of Object.entries(gates)) {
        const validator = GATE_VALIDATORS[key];
        if (!validator) {
          errors.push(issue("bad_gates", `unknown gate "${key}" (allowed: ${Object.keys(GATE_VALIDATORS).join(", ")})`));
        } else if (!validator(value)) {
          errors.push(issue("bad_gates", `gate "${key}" has an invalid value ${JSON.stringify(value)}`));
        }
      }
    }
  }

  // ── per-edge context contract (stable in v0.4.0, SP10c) ──────────────────────
  // Canonical key: `per_edge_context`. Old key `experimental_per_edge_context`
  // accepted with a deprecation warning for one release (v0.4.0).
  if (workflow.experimental_per_edge_context !== undefined) {
    warnings.push(issue("deprecated_experimental_flag",
      `"experimental_per_edge_context" is deprecated; rename to "per_edge_context" (feature is stable in v0.4.0)`));
  }
  const edgeContextEnabled = workflow.per_edge_context ?? workflow.experimental_per_edge_context;
  if (edgeContextEnabled !== undefined && !isBool(edgeContextEnabled)) {
    errors.push(issue("bad_edge_context",
      `per_edge_context must be a boolean, got ${JSON.stringify(edgeContextEnabled)}`));
  }
  if (workflow.edge_context !== undefined) {
    const ec = workflow.edge_context;
    if (ec === null || typeof ec !== "object" || Array.isArray(ec)) {
      errors.push(issue("bad_edge_context", `edge_context must be an object, got ${JSON.stringify(ec)}`));
    } else {
      for (const [edge, spec] of Object.entries(ec)) {
        const validSpec = spec === "full" || spec === "scoped"
          || (Array.isArray(spec) && spec.every((s) => typeof s === "string"));
        if (!validSpec) {
          errors.push(issue("bad_edge_context",
            `edge_context "${edge}" spec must be "full", "scoped", or an array of role names, got ${JSON.stringify(spec)}`));
        }
        // The key's source state ("<from>" before any ":") must be a known role.
        const from = String(edge).split(":")[0];
        if (!roleNames.has(from)) {
          warnings.push(issue("bad_edge_context",
            `edge_context key "${edge}" references unknown source role "${from}"`));
        }
      }
    }
  }

  // Reachability from initial + every mode initial.
  // Parallel group members are co-reachable: reaching any member reaches all.
  const memberToGroup = new Map();
  for (const group of (Array.isArray(workflow.parallel_groups) ? workflow.parallel_groups : [])) {
    if (Array.isArray(group)) {
      for (const name of group) memberToGroup.set(name, group);
    }
  }
  const reachable = new Set();
  const queue = [workflow.initial, ...Object.values(workflow.modes ?? {}).map((m) => m?.initial)]
    .filter((s) => roleNames.has(s));
  while (queue.length > 0) {
    const state = queue.shift();
    if (reachable.has(state)) continue;
    reachable.add(state);
    for (const sibling of (memberToGroup.get(state) ?? [])) {
      if (roleNames.has(sibling) && !reachable.has(sibling)) queue.push(sibling);
    }
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
