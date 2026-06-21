// SP12b ephemeral safety policy — pure validators. No run core: SP12e calls
// these at submit time and enforces the sandbox at run time.

function issue(code, message) {
  return { code, message };
}

const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ");

const BOOL_GATES = ["require_distinct_reviewer", "output_schema_conformance"];
const NUMERIC_FLOORS = ["min_coverage"];

export function matchCommand(candidate, allowlist = []) {
  const c = norm(candidate);
  return allowlist.some((entry) => {
    const e = String(entry ?? "");
    if (e.startsWith("re:")) {
      let re;
      try {
        re = new RegExp(e.slice(3));
      } catch {
        return false; // invalid pattern never matches; lint catches it at load
      }
      return re.test(c);
    }
    if (e.endsWith(" *")) {
      return c.startsWith(norm(e.slice(0, -2)) + " ") || c === norm(e.slice(0, -2));
    }
    return c === norm(e);
  });
}

export function gatesAreWeaker(ephemeral = {}, baseline = {}) {
  const reasons = [];
  for (const g of BOOL_GATES) {
    if (baseline[g] === true && ephemeral[g] === false) {
      reasons.push(`gate "${g}" may not be disabled (baseline requires it)`);
    }
  }
  for (const g of NUMERIC_FLOORS) {
    if (baseline[g] !== undefined && ephemeral[g] !== undefined
        && Number(ephemeral[g]) < Number(baseline[g])) {
      reasons.push(`gate "${g}" (${ephemeral[g]}) is below baseline floor (${baseline[g]})`);
    }
  }
  return reasons;
}

export function validateEphemeralPolicy(workflow = {}, policy = {}) {
  const allowlist = Array.isArray(policy.commandAllowlist) ? policy.commandAllowlist : [];
  const providerAllowlist = Array.isArray(policy.providerAllowlist) ? policy.providerAllowlist : [];

  if (policy.enabled !== true) {
    return {
      ok: false,
      errors: [issue("ephemeral_disabled", "ephemeral execution is disabled")],
    };
  }

  const errors = [];
  const roles = workflow?.roles ?? {};
  for (const [roleName, role] of Object.entries(roles)) {
    if (role?.provider !== undefined && role.provider !== null && role.provider.length > 0) {
      if (!providerAllowlist.includes(role.provider)) {
        errors.push(issue("provider_not_allowlisted", `${roleName}: provider ${role.provider} is not allowlisted`));
      }
    }
    // Gate every declared shell command, regardless of role kind — an agent
    // role may also declare commands[], and those must not bypass the allowlist.
    if (Array.isArray(role?.commands)) {
      for (const command of role.commands) {
        if (!matchCommand(command?.run, allowlist)) {
          errors.push(issue("command_not_allowlisted", `${roleName}.${command?.name ?? "command"} is not allowlisted`));
        }
      }
    }
  }

  const maxFanout = Number(policy.maxFanout);
  for (const group of workflow?.parallel_groups ?? []) {
    if (Array.isArray(group) && group.length > maxFanout) {
      errors.push(issue("fanout_exceeds_cap", `parallel group of size ${group.length} exceeds maxFanout ${maxFanout}`));
    }
  }

  if (policy.gateRelaxation === "forbid" && (workflow?.gates ?? null) && policy?.baselineGates) {
    for (const reason of gatesAreWeaker(workflow.gates, policy.baselineGates)) {
      errors.push(issue("gate_relaxation_forbidden", reason));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
