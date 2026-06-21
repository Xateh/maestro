// Scanners for Claude Code-style artifacts: subagent .md files, skill
// directories (*/SKILL.md), instruction docs (AGENTS.md / CLAUDE.md),
// .mcp.json server configs, and settings.json hooks.
//
// Pure parse functions take strings; scan* wrappers do the filesystem walk.
// Secret values are never read into results — env maps record names only.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parseFrontmatter } from "./frontmatter.mjs";

export function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function slugifyRoleName(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|(?<!_)_+$/g, "")
    .slice(0, 48)
    .replace(/(?<!_)_+$/g, ""); // slice can re-expose a trailing underscore
  return slug || "imported_role";
}

// ── subagents (~/.claude/agents/*.md) ────────────────────────────────────────

export function parseSubagent(text, filePath = null) {
  const { frontmatter, body } = parseFrontmatter(text);
  const name = frontmatter?.name ?? (filePath ? path.basename(filePath, ".md") : null);
  if (!name) return null;
  return {
    name: String(name),
    description: String(frontmatter?.description ?? ""),
    tools: frontmatter?.tools ?? null,
    body,
    path: filePath,
    hash: sha256(text),
  };
}

export async function scanSubagents(dir) {
  const results = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries.filter((name) => name.endsWith(".md")).sort()) {
    const filePath = path.join(dir, entry);
    try {
      const parsed = parseSubagent(await fs.readFile(filePath, "utf8"), filePath);
      if (parsed) results.push(parsed);
    } catch {
      // unreadable file — skip
    }
  }
  return results;
}

// Map a parsed subagent onto a Maestro workflow role definition.
// Permission is inferred conservatively: evaluate/review/audit-style agents
// run read-only; everything else gets write.
export function subagentToRole(parsed, { provider = "claude", now = () => new Date() } = {}) {
  const roleName = slugifyRoleName(parsed.name);
  const readOnly = /\b(review|audit|evaluat|analyz|analys|inspect|read[- ]only|never modif)/i
    .test(`${parsed.description}\n${parsed.body.slice(0, 2000)}`);
  return {
    roleName,
    roleDef: {
      label: parsed.name,
      provider,
      alias: "",
      model: "",
      effort: "",
      permission: readOnly ? "read" : "write",
      prompt_template: roleName,
      skip: "never",
      instructions: parsed.body,
      source: {
        kind: "claude-subagent",
        path: parsed.path,
        hash: parsed.hash,
        imported_at: now().toISOString(),
      },
    },
  };
}

// ── skills (<root>/<name>/SKILL.md) ──────────────────────────────────────────

export function parseSkill(text, skillPath = null) {
  const { frontmatter, body } = parseFrontmatter(text);
  const dirName = skillPath ? path.basename(path.dirname(skillPath)) : null;
  const name = frontmatter?.name ?? dirName;
  if (!name) return null;
  return {
    name: String(name),
    description: String(frontmatter?.description ?? "").slice(0, 500),
    path: skillPath,
    hash: sha256(text),
    bodyPreview: body.slice(0, 200),
  };
}

export async function scanSkills(rootDir) {
  const results = [];
  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = path.join(rootDir, entry.name, "SKILL.md");
    try {
      const parsed = parseSkill(await fs.readFile(skillPath, "utf8"), skillPath);
      if (parsed) results.push(parsed);
    } catch {
      // not a skill dir — skip
    }
  }
  return results;
}

// ── instruction files (AGENTS.md / CLAUDE.md / arbitrary docs) ───────────────

export async function scanInstructionFiles(paths) {
  const results = [];
  for (const rawPath of paths) {
    const filePath = path.resolve(rawPath);
    try {
      const text = await fs.readFile(filePath, "utf8");
      results.push({
        path: filePath,
        hash: sha256(text),
        headings: [...text.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1]).slice(0, 20),
      });
    } catch {
      // unreadable — skip
    }
  }
  return results;
}

// ── .mcp.json ────────────────────────────────────────────────────────────────

export async function scanMcpJson(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
  const servers = {};
  for (const [name, def] of Object.entries(parsed?.mcpServers ?? {})) {
    servers[name] = {
      command: def?.command ?? null,
      args: def?.args ?? [],
      // env NAMES only — values must never enter scan results
      env_keys: Object.keys(def?.env ?? {}),
    };
  }
  return { path: path.resolve(filePath), servers };
}

// ── settings.json hooks ──────────────────────────────────────────────────────

export async function scanClaudeHooks(settingsPath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  } catch {
    return [];
  }
  const hooks = [];
  for (const [event, matchers] of Object.entries(parsed?.hooks ?? {})) {
    for (const matcher of Array.isArray(matchers) ? matchers : []) {
      for (const hook of matcher?.hooks ?? []) {
        hooks.push({
          event,
          matcher: matcher?.matcher ?? null,
          command: hook?.command ?? null,
        });
      }
    }
  }
  return hooks;
}
