// Shared tool-policy helpers for the adapter seam (MRC §5).
//
// Owns: tool-token grammar validation, the bash/bare/mcp classifier, per-provider
// flag mapping (claude hard-enforce; codex sandbox fold), the deterministic
// advisory "Tool Policy" block builder, and the run-manifest tool-policy record.
// Pure — no I/O.

// §5.4 token grammar.
const BARE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const BASH_RE = /^Bash\([^)]+\)$/;
const MCP_RE = /^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+$/;

export const ENFORCEMENT_BY_PROVIDER = {
  claude: "enforced",
  codex: "partial",
  gemini: "advisory",
  copilot: "advisory",
  antigravity: "advisory",
  ollama: "advisory",
};

export function validateToolToken(token) {
  const t = String(token ?? "");
  // An mcp-prefixed token must match the full mcp__server__tool form — a bare
  // "mcp__x" is a malformed mcp token, not a valid bare tool name.
  if (t.startsWith("mcp__")) return MCP_RE.test(t) ? { ok: true } : { ok: false, token };
  if (BARE_RE.test(t) || BASH_RE.test(t)) return { ok: true };
  return { ok: false, token };
}

export function validateToolList(tokens = []) {
  for (const token of tokens) {
    const verdict = validateToolToken(token);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

// Classify tokens into bash-shaped / mcp / bare buckets.
export function splitTools(tokens = []) {
  const out = { bash: [], mcp: [], bare: [] };
  for (const token of tokens ?? []) {
    if (BASH_RE.test(token)) out.bash.push(token);
    else if (MCP_RE.test(token)) out.mcp.push(token);
    else out.bare.push(token);
  }
  return out;
}

// §5.1 claude hard enforcement: space-join tokens into a single arg value.
export function claudeToolArgs(tools = null, deny = null) {
  const args = [];
  const allow = (tools ?? []).filter(Boolean);
  const denied = (deny ?? []).filter(Boolean);
  if (allow.length > 0) args.push("--allowedTools", allow.join(" "));
  if (denied.length > 0) args.push("--disallowedTools", denied.join(" "));
  return args;
}

// §5.2 codex: Bash tokens may inform the sandbox profile selection. We do not
// loosen the permission→sandbox mapping; absent a reason to override, return
// null (no change). Returns a sandbox profile name or null.
export function codexSandboxHint(_tools = []) {
  // Conservative: Bash scope is advisory-only on codex in this cut — the
  // permission→sandbox mapping already governs the real sandbox. No override.
  return null;
}

// Advisory remainder string for codex: the non-Bash policy, expressed as the
// §5.5 block (Bash allow tokens are folded into the sandbox, so excluded).
export function advisoryRemainder(tools = null, deny = null) {
  const allow = (tools ?? []).filter((t) => !BASH_RE.test(t));
  return buildAdvisoryBlock(allow, deny);
}

// §5.5 deterministic advisory block. allow sorted, then deny sorted → identical
// policy yields byte-identical text (enables dedupe). Empty allow+deny → "".
export function buildAdvisoryBlock(tools = null, deny = null) {
  const allow = [...new Set((tools ?? []).filter(Boolean))].sort();
  const denied = [...new Set((deny ?? []).filter(Boolean))].sort();
  if (allow.length === 0 && denied.length === 0) return "";
  const lines = [
    "## Tool Policy (advisory)",
    "This provider does not enforce tool allowlists. You MUST restrict yourself to:",
  ];
  if (allow.length > 0) lines.push(`- Allowed: ${allow.join(", ")}`);
  if (denied.length > 0) lines.push(`- Denied: ${denied.join(", ")}`);
  lines.push("Using any tool outside this list is a policy violation.");
  return lines.join("\n");
}

// §5.6 run-manifest record. Pure/total; degrades missing fields to [].
export function buildToolPolicyRecord({ role, provider, tools, deny_tools } = {}) {
  return {
    role: role ?? null,
    allow: Array.isArray(tools) ? tools : [],
    deny: Array.isArray(deny_tools) ? deny_tools : [],
    enforcement: ENFORCEMENT_BY_PROVIDER[provider] ?? "advisory",
  };
}
