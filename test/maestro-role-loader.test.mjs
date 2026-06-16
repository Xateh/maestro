import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  LOAD_ERROR_CODES,
  detectSource,
  loadRole,
  loadRoles,
  normalizeClaudeSubagent,
  normalizeNative,
  normalizeSkill,
  _clearRoleCache,
} from "../src/setup/role-loader.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "roles");
const fx = (...parts) => path.join(fixtures, ...parts);

test("detectSource: .claude/agents path → claude-subagent", () => {
  assert.equal(detectSource(".claude/agents/reviewer.md", { name: "x", description: "y" }), "claude-subagent");
});

test("detectSource: SKILL.md → skill", () => {
  assert.equal(detectSource("skills/demo/SKILL.md", { name: "demo" }), "skill");
});

test("detectSource: .maestro/roles path → native", () => {
  assert.equal(detectSource(".maestro/roles/triage.md", { name: "triage" }), "native");
});

test("detectSource: ambiguous bare md with MRC-only field → native", () => {
  assert.equal(detectSource("classifier.md", { name: "x", provider: "gemini" }), "native");
  assert.equal(detectSource("x.md", { name: "x", permission: "read" }), "native");
  assert.equal(detectSource("x.md", { name: "x", verifies: true }), "native");
});

test("detectSource: ambiguous bare md with only subagent fields → claude-subagent", () => {
  assert.equal(detectSource("helper.md", { name: "x", description: "y", tools: "Read, Grep", model: "z" }), "claude-subagent");
});

test("normalizeClaudeSubagent: CSV tools split, description→label, defaults", () => {
  const role = normalizeClaudeSubagent(
    { name: "reviewer", description: "Reviews diffs", tools: "Read, Grep, Bash(npm:*)", model: "opus" },
    "You are a reviewer.",
  );
  assert.deepEqual(role.tools, ["Read", "Grep", "Bash(npm:*)"]);
  assert.equal(role.label, "Reviews diffs");
  assert.equal(role.instructions, "You are a reviewer.");
  assert.equal(role.provider, "claude");
  assert.equal(role.permission, "read");
  assert.equal(role.model, "opus");
});

test("normalizeSkill: description→label, body→instructions, defaults", () => {
  const role = normalizeSkill({ name: "demo", description: "A demo skill" }, "Summarize input.");
  assert.equal(role.label, "A demo skill");
  assert.equal(role.instructions, "Summarize input.");
  assert.equal(role.provider, "claude");
  assert.equal(role.permission, "read");
});

test("normalizeNative: superset passes through with defaults", () => {
  const role = normalizeNative({ name: "x" }, "body");
  assert.equal(role.permission, "read");
  assert.equal(role.provider, "claude");
  assert.equal(role.model, "");
  assert.equal(role.effort, "");
  assert.equal(role.kind, "agent");
  assert.equal(role.verifies, false);
  assert.equal(role.instructions, "body");
});

test("normalizeNative: provider not defaulted to claude when alias is set", () => {
  const role = normalizeNative({ name: "x", alias: "myalias" }, "body");
  assert.equal(role.alias, "myalias");
  assert.equal(role.provider, undefined);
});

test("loadRole: golden claude subagent", async () => {
  _clearRoleCache();
  const out = await loadRole(fx("claude-agents", "reviewer.md"));
  assert.equal(out.ok, true);
  assert.deepEqual(out.roleDef.tools, ["Read", "Grep", "Bash(npm:*)"]);
  assert.equal(out.roleDef.label, "Reviews diffs for correctness regressions");
  assert.equal(out.roleDef.provider, "claude");
  assert.equal(out.roleDef.permission, "read");
  assert.equal(out.roleDef.model, "opus");
  assert.match(out.roleDef.instructions, /code reviewer/);
});

test("loadRole: golden skill", async () => {
  _clearRoleCache();
  const out = await loadRole(fx("skills", "demo", "SKILL.md"));
  assert.equal(out.ok, true);
  assert.equal(out.roleDef.label, "A demo skill that summarizes input");
  assert.equal(out.roleDef.provider, "claude");
  assert.equal(out.roleDef.permission, "read");
  assert.match(out.roleDef.instructions, /summarizer/);
});

test("loadRole: golden native superset", async () => {
  _clearRoleCache();
  const out = await loadRole(fx("maestro-roles", "security-reviewer.md"));
  assert.equal(out.ok, true);
  const r = out.roleDef;
  assert.equal(r.provider, "claude");
  assert.equal(r.alias, "claude");
  assert.equal(r.permission, "read");
  assert.deepEqual(r.tools, ["Read", "Grep", "Bash(npm:*)", "mcp__lint__check"]);
  assert.deepEqual(r.deny_tools, ["Bash(rm:*)"]);
  assert.equal(r.output_schema, "review");
  assert.equal(r.kind, "agent");
  assert.equal(r.verifies, true);
  assert.match(r.instructions, /security reviewer/);
});

test("loadRole: nonexistent source → role_source_not_found", async () => {
  _clearRoleCache();
  const out = await loadRole(fx("maestro-roles", "does-not-exist.md"));
  assert.equal(out.ok, false);
  assert.equal(out.error.code, LOAD_ERROR_CODES.NOT_FOUND);
  assert.equal(out.error.code, "role_source_not_found");
  assert.ok(typeof out.error.source === "string");
  assert.ok(typeof out.error.message === "string");
});

test("loadRole: malformed frontmatter → role_source_parse_failed", async () => {
  _clearRoleCache();
  const out = await loadRole(fx("malformed.md"));
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "role_source_parse_failed");
});

test("loadRole: invalid tool token → role_tool_token_invalid", async () => {
  _clearRoleCache();
  const out = await loadRole(fx("maestro-roles", "security-reviewer.md"), {
    validateToolList: (tokens) => {
      const bad = tokens.find((t) => t === "mcp__lint__check");
      return bad ? { ok: false, token: bad } : { ok: true };
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "role_tool_token_invalid");
  assert.equal(out.error.token, "mcp__lint__check");
});

test("loadRole: caches by resolved absolute path (reads once)", async () => {
  _clearRoleCache();
  let reads = 0;
  const readFile = async (p) => {
    reads += 1;
    const fs = await import("node:fs/promises");
    return fs.readFile(p, "utf8");
  };
  const ref = fx("maestro-roles", "security-reviewer.md");
  await loadRole(ref, { readFile });
  await loadRole(ref, { readFile });
  assert.equal(reads, 1);
});

test("loadRoles: batch returns map keyed by ref", async () => {
  _clearRoleCache();
  const refs = [fx("claude-agents", "reviewer.md"), fx("skills", "demo", "SKILL.md")];
  const out = await loadRoles(refs);
  assert.equal(out[refs[0]].ok, true);
  assert.equal(out[refs[1]].ok, true);
});
