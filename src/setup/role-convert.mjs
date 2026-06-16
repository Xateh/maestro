// MRC role conversion — turn a parsed Claude subagent into a native MRC unit
// (`.maestro/roles/<name>.md`), the format produced by `maestro import-agent`.
//
// The native unit is a YAML-frontmatter superset of the subagent format with a
// markdown body as `instructions` (see docs/role-convention.md). Permission is
// inferred conservatively (review/audit/analysis agents run read-only).

// Split a CSV-or-array tools field into a trimmed token array.
function toToolArray(value) {
  if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value.split(",").map((t) => t.trim()).filter(Boolean);
}

// Infer read-only vs write from the subagent's description + body, matching the
// heuristic used by subagentToRole in scanners/claude.mjs.
function inferPermission(parsed) {
  const haystack = `${parsed.description ?? ""}\n${(parsed.body ?? "").slice(0, 2000)}`;
  const readOnly = /\b(review|audit|evaluat|analyz|analys|inspect|read[- ]only|never modif)/i.test(haystack);
  return readOnly ? "read" : "write";
}

// Render a tools array as a YAML flow sequence: [Read, Grep, "Bash(npm:*)"].
// Tokens with YAML-significant characters are double-quoted.
function renderToolsSeq(tools) {
  const items = tools.map((token) => (/^[A-Za-z0-9_]+$/.test(token) ? token : JSON.stringify(token)));
  return `[${items.join(", ")}]`;
}

// Convert a parsed subagent ({ name, description, tools, body, ... }) into a
// native MRC unit markdown string.
export function subagentToNativeUnit(parsed, { provider = "claude" } = {}) {
  if (!parsed?.name) {
    throw new Error("subagentToNativeUnit: parsed subagent must have a name");
  }
  const tools = toToolArray(parsed.tools);
  const lines = ["---", `name: ${parsed.name}`];
  if (parsed.description) lines.push(`description: ${parsed.description}`);
  lines.push(`provider: ${provider}`);
  lines.push(`permission: ${inferPermission(parsed)}`);
  if (tools.length > 0) lines.push(`tools: ${renderToolsSeq(tools)}`);
  if (parsed.model) lines.push(`model: ${parsed.model}`);
  lines.push("---", "");
  lines.push((parsed.body ?? "").trim());
  lines.push("");
  return lines.join("\n");
}
