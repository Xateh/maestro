// Pure evaluation math for the SP3 kind:"command" stage.
//
// Maps a list of per-command results into the SP1 `evaluation` schema payload
// `{pass_rate, failures, coverage}`. No I/O, no spawning — the command runner
// produces the raw results; this module only interprets them.
//
// A per-command `parser` may extract finer test counts; the sufficiency rule
// (never fabricate a pass-rate) is enforced in parseCommandCounts.

// Round to a stable 4-decimal precision so pass_rate values are deterministic.
function round4(x) {
  return Math.round(x * 1e4) / 1e4;
}

function matchCount(regexStr, text) {
  if (typeof regexStr !== "string" || regexStr.length === 0) return null;
  let re;
  try {
    re = new RegExp(regexStr);
  } catch {
    return null;
  }
  const m = re.exec(text);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract {total, passed} counts from a command's combined output.
 *
 * `parser` is `{passed?, failed?, total?}` of regex strings; the first capture
 * group of each is parsed as an integer against `stdout + "\n" + stderr`.
 *
 * Sufficiency rule (never fabricate a pass-rate): a total must be DERIVABLE —
 * either a `total` regex matched, OR both `passed` and `failed` matched (then
 * total = passed + failed). Only-passed / only-failed / no-match ⇒ null, which
 * makes the command fall back to exit-code granularity.
 *
 * @returns {{total:number, passed:number} | null}
 */
export function parseCommandCounts(parser, text) {
  if (!parser || typeof parser !== "object") return null;
  const combined = String(text ?? "");
  const total = matchCount(parser.total, combined);
  const passed = matchCount(parser.passed, combined);
  const failed = matchCount(parser.failed, combined);

  let resolvedTotal = null;
  let resolvedPassed = null;
  // `onlyTotal` marks the case where total is known but there is no explicit
  // passed/failed split; passed is then resolved by computeEvaluation from the
  // command's exit status rather than assumed to be a full pass.
  let onlyTotal = false;
  if (total !== null) {
    resolvedTotal = total;
    if (passed !== null) resolvedPassed = passed;
    else if (failed !== null) resolvedPassed = total - failed;
    else {
      resolvedPassed = total; // provisional; computeEvaluation gates on exit status
      onlyTotal = true;
    }
  } else if (passed !== null && failed !== null) {
    resolvedTotal = passed + failed;
    resolvedPassed = passed;
  } else {
    return null; // only-passed / only-failed / none → not derivable
  }

  if (resolvedTotal < 0) return null;
  const clamped = Math.max(0, Math.min(resolvedPassed, resolvedTotal));
  return { total: resolvedTotal, passed: clamped, onlyTotal };
}

// Per-command result shape (from the command node / commandRunner):
//   {name, run, category, exit_code, signal, timed_out, spawn_error,
//    output_tail, allow_failure, parser}
//
// Returns {pass_rate, failures}. `allow_failure` commands are run + recorded
// upstream but excluded from both pass_rate and failures here.
export function computeEvaluation(results = []) {
  let sumTotal = 0;
  let sumPassed = 0;
  const failures = [];

  for (const r of results) {
    if (r?.allow_failure === true) continue;
    const parsed = parseCommandCounts(r?.parser ?? null, r?.output_tail ?? "");
    let total;
    let passed;
    const succeeded = r?.exit_code === 0 && !r?.timed_out && !r?.spawn_error;
    if (parsed) {
      total = parsed.total;
      // only-total parser (no explicit passed/failed split): credit the total as
      // passing only when the command actually succeeded, otherwise 0 — keeps
      // pass_rate consistent with the failures list (which gates on exit status).
      passed = parsed.onlyTotal ? (succeeded ? parsed.total : 0) : parsed.passed;
    } else {
      total = 1;
      passed = succeeded ? 1 : 0;
    }
    sumTotal += total;
    sumPassed += passed;

    const fullyPassed = r?.exit_code === 0
      && !r?.timed_out
      && !r?.spawn_error
      && !(parsed && parsed.passed < parsed.total);
    if (!fullyPassed) {
      failures.push({
        name: r?.name ?? null,
        run: r?.run ?? null,
        category: r?.category ?? null,
        exit_code: r?.exit_code ?? null,
        signal: r?.signal ?? null,
        timed_out: r?.timed_out === true,
        output_tail: r?.output_tail ?? "",
        ...(parsed ? { parsed: { total: parsed.total, passed: parsed.passed } } : {}),
      });
    }
  }

  const pass_rate = sumTotal === 0 ? 1.0 : round4(sumPassed / sumTotal);
  return { pass_rate, failures };
}

// Build the full SP1 `evaluation` payload. `coverage` is always {} in SP3.
export function buildEvaluationPayload(results = []) {
  const { pass_rate, failures } = computeEvaluation(results);
  return { pass_rate, failures, coverage: {} };
}
