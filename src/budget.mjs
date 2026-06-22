// Per-run budget validators + ceiling clamp. Pure functions, no run core.
// The breach kill-switch (cancel-on-exceed → budget_exceeded) is SP12e: it
// needs the run-request object and the live cost stream (see cost-accounting).

const FIELDS = ["tokens", "usd", "wall_clock_ms"];

function issue(code, message) {
  return { code, message };
}

export function validateBudget(budget = {}, operator = {}) {
  const errors = [];
  for (const f of FIELDS) {
    if (budget[f] === undefined || budget[f] === null) continue;
    const v = Number(budget[f]);
    if (!Number.isFinite(v) || v <= 0) {
      errors.push(issue("bad_budget_spec", `budget.${f} must be a positive number, got ${budget[f]}`));
      continue;
    }
    const floor = operator?.floor?.[f];
    if (floor !== undefined && v < Number(floor)) {
      errors.push(issue("budget_below_floor", `budget.${f} (${v}) is below operator floor (${floor})`));
    }
  }
  return { ok: errors.length === 0, errors };
}

export function clampBudget(budget = {}, ceiling = {}) {
  const out = { ...budget };
  for (const f of FIELDS) {
    const cap = ceiling?.[f];
    if (cap !== undefined && out[f] !== undefined && Number(out[f]) > Number(cap)) {
      out[f] = Number(cap);
    }
  }
  return out;
}
