// Maestro Role Convention (MRC) loader.
//
// Detects the source kind of a role unit (Claude subagent / skill / native MRC
// unit), normalizes all three into the canonical RoleDef the engine already
// consumes, and composes a unit RoleDef with inline workflow-role overrides.
//
// PURE-of-engine: file I/O only, no DB, no adapters. The loader NEVER throws on
// a recognized source — malformed input degrades to a structured load error
// `{ code, source, message, token? }`.

import fsPromises from "node:fs/promises";
import path from "node:path";

import { validateToolList as defaultValidateToolList } from "../adapters/tool-flags.mjs";
import { parseFrontmatter } from "./scanners/frontmatter.mjs";

export const LOAD_ERROR_CODES = {
  NOT_FOUND: "role_source_not_found",
  PARSE_FAILED: "role_source_parse_failed",
  TOOL_TOKEN_INVALID: "role_tool_token_invalid",
};

// MRC-only frontmatter fields. Presence of any marks an ambiguous bare *.md as
// a native MRC unit rather than a Claude subagent (§4.1, OQ#4).
const MRC_ONLY_FIELDS = [
  "provider",
  "alias",
  "permission",
  "deny_tools",
  "output_schema",
  "kind",
  "verifies",
];

// Module-level cache: one parse/normalize per resolved absolute path per run.
const _cache = new Map();

export function _clearRoleCache() {
  _cache.clear();
}

function _splitSegments(ref) {
  return String(ref ?? "").split(/[\\/]/);
}

// Detect the source kind from the path + parsed frontmatter (§4.1).
export function detectSource(ref, frontmatter = null) {
  const segments = _splitSegments(ref);
  const base = segments[segments.length - 1] ?? "";

  // SKILL.md (file or directory entry) → skill.
  if (base === "SKILL.md") return "skill";

  // Path under .claude/agents/ → claude-subagent.
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i] === ".claude" && segments[i + 1] === "agents") return "claude-subagent";
  }

  // Path under .maestro/roles/ → native.
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i] === ".maestro" && segments[i + 1] === "roles") return "native";
  }

  // Ambiguous bare *.md: any MRC-only field → native; otherwise claude-subagent.
  const fm = frontmatter ?? {};
  if (MRC_ONLY_FIELDS.some((field) => Object.hasOwn(fm, field))) return "native";
  return "claude-subagent";
}

// Split a CSV tools string (Claude subagent format) into a trimmed array.
function splitCsvTools(value) {
  if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
  if (typeof value !== "string") return undefined;
  const parts = value.split(",").map((t) => t.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

// ── per-source normalizers → RoleDef ─────────────────────────────────────────

export function normalizeClaudeSubagent(frontmatter = {}, body = "") {
  const role = {
    provider: "claude",
    permission: "read",
    instructions: String(body ?? ""),
  };
  if (frontmatter.description) role.label = String(frontmatter.description);
  else if (frontmatter.name) role.label = String(frontmatter.name);
  const tools = splitCsvTools(frontmatter.tools);
  if (tools) role.tools = tools;
  if (frontmatter.model !== undefined) role.model = String(frontmatter.model);
  return role;
}

export function normalizeSkill(frontmatter = {}, body = "") {
  const role = {
    provider: "claude",
    permission: "read",
    instructions: String(body ?? ""),
  };
  if (frontmatter.description) role.label = String(frontmatter.description);
  else if (frontmatter.name) role.label = String(frontmatter.name);
  return role;
}

export function normalizeNative(frontmatter = {}, body = "") {
  const fm = frontmatter ?? {};
  const role = { ...fm };
  delete role.name;
  if (fm.description) role.label = String(fm.description);
  else if (fm.name && role.label === undefined) role.label = String(fm.name);
  delete role.description;
  role.instructions = String(body ?? "");

  // Defaults for absent fields (§3.2).
  if (role.permission === undefined) role.permission = "read";
  // provider defaults to claude only when neither provider nor alias is set.
  if (role.provider === undefined && role.alias === undefined) role.provider = "claude";
  if (role.model === undefined) role.model = "";
  if (role.effort === undefined) role.effort = "";
  if (role.kind === undefined) role.kind = "agent";
  if (role.verifies === undefined) role.verifies = false;
  return role;
}

function normalizeBySource(kind, frontmatter, body) {
  if (kind === "claude-subagent") return normalizeClaudeSubagent(frontmatter, body);
  if (kind === "skill") return normalizeSkill(frontmatter, body);
  return normalizeNative(frontmatter, body);
}

// Load + normalize a single unit. Returns { ok:true, roleDef } or
// { ok:false, error:{code,source,message,token?} }. Caches by resolved path.
//
// `validateToolList(tokens)` (default identity-ok) is injected so the loader can
// surface `role_tool_token_invalid` at load time. P2 wires the real validator.
export async function loadRole(ref, {
  readFile = (p) => fsPromises.readFile(p, "utf8"),
  cwd = process.cwd(),
  validateToolList = defaultValidateToolList,
} = {}) {
  const source = String(ref ?? "");
  const absolute = path.isAbsolute(source) ? source : path.resolve(cwd, source);
  if (_cache.has(absolute)) return _cache.get(absolute);

  let text;
  try {
    text = await readFile(absolute);
  } catch {
    const result = {
      ok: false,
      error: { code: LOAD_ERROR_CODES.NOT_FOUND, source, message: `role source not found: ${source}` },
    };
    _cache.set(absolute, result);
    return result;
  }

  const { frontmatter, body } = parseFrontmatter(text);
  // A recognized file whose frontmatter could not be parsed is a parse failure.
  // (parseFrontmatter degrades malformed YAML to frontmatter:null.)
  if (frontmatter === null) {
    const result = {
      ok: false,
      error: {
        code: LOAD_ERROR_CODES.PARSE_FAILED,
        source,
        message: `role source frontmatter could not be parsed: ${source}`,
      },
    };
    _cache.set(absolute, result);
    return result;
  }

  const kind = detectSource(source, frontmatter);
  const roleDef = normalizeBySource(kind, frontmatter, body);

  // Validate declared tool tokens at load time (§5.4/§9).
  const allTokens = [...(roleDef.tools ?? []), ...(roleDef.deny_tools ?? [])];
  if (allTokens.length > 0) {
    const verdict = validateToolList(allTokens);
    if (verdict && verdict.ok === false) {
      const result = {
        ok: false,
        error: {
          code: LOAD_ERROR_CODES.TOOL_TOKEN_INVALID,
          source,
          message: `invalid tool token in role source: ${verdict.token}`,
          token: verdict.token,
        },
      };
      _cache.set(absolute, result);
      return result;
    }
  }

  const result = { ok: true, roleDef };
  _cache.set(absolute, result);
  return result;
}

// Batch helper: returns a map keyed by the original ref string.
export async function loadRoles(refs = [], options = {}) {
  const out = {};
  for (const ref of refs) {
    out[ref] = await loadRole(ref, options);
  }
  return out;
}

// Compose a unit RoleDef with inline workflow-role overrides (§4.3).
//   - inline keys (except `source`) win over the unit;
//   - inline tools/deny_tools REPLACE the unit arrays (not merge) (OQ#2);
//   - prompt_template defaults to the stage state name when neither sets it (OQ#3).
export function composeRole(stateName, inlineRole = {}, unitRoleDef = {}) {
  const inline = { ...inlineRole };
  delete inline.source;

  const composed = { ...unitRoleDef };
  for (const [key, value] of Object.entries(inline)) {
    composed[key] = value; // last-writer-wins, replaces arrays wholesale
  }

  if (composed.prompt_template === undefined || composed.prompt_template === null
    || composed.prompt_template === "") {
    composed.prompt_template = stateName;
  }
  return composed;
}
