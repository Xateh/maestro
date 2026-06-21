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
