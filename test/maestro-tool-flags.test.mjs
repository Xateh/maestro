import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateToolToken,
  validateToolList,
  splitTools,
  claudeToolArgs,
  codexSandboxHint,
  advisoryRemainder,
  buildAdvisoryBlock,
  buildToolPolicyRecord,
  ENFORCEMENT_BY_PROVIDER,
} from "../src/adapters/tool-flags.mjs";

test("validateToolToken accepts bare names", () => {
  for (const t of ["Read", "Grep", "Write"]) {
    assert.equal(validateToolToken(t).ok, true, t);
  }
});

test("validateToolToken accepts scoped Bash", () => {
  assert.equal(validateToolToken("Bash(npm:*)").ok, true);
  assert.equal(validateToolToken("Bash(git status:*)").ok, true);
});

test("validateToolToken accepts mcp tokens", () => {
  assert.equal(validateToolToken("mcp__lint__check").ok, true);
});

test("validateToolToken rejects malformed tokens", () => {
  for (const t of ["rm -rf", "Bash(", "mcp__x", "1tool"]) {
    const v = validateToolToken(t);
    assert.equal(v.ok, false, t);
    assert.equal(v.token, t);
  }
});

test("validateToolList returns first bad token", () => {
  const v = validateToolList(["Read", "rm -rf", "Grep"]);
  assert.equal(v.ok, false);
  assert.equal(v.token, "rm -rf");
  assert.equal(validateToolList(["Read", "Grep"]).ok, true);
});

test("splitTools classifies bash vs bare vs mcp", () => {
  const out = splitTools(["Read", "Bash(npm:*)", "mcp__lint__check"]);
  assert.deepEqual(out.bash, ["Bash(npm:*)"]);
  assert.deepEqual(out.bare, ["Read"]);
  assert.deepEqual(out.mcp, ["mcp__lint__check"]);
});

test("claudeToolArgs space-joins into single arg values", () => {
  const args = claudeToolArgs(["Read", "Grep", "Bash(npm:*)"], ["Bash(rm:*)"]);
  assert.deepEqual(args, [
    "--allowedTools", "Read Grep Bash(npm:*)",
    "--disallowedTools", "Bash(rm:*)",
  ]);
});

test("claudeToolArgs empty → no args", () => {
  assert.deepEqual(claudeToolArgs(null, null), []);
  assert.deepEqual(claudeToolArgs([], []), []);
});

test("buildAdvisoryBlock deterministic ordering + golden string", () => {
  const block = buildAdvisoryBlock(["Grep", "Read", "Bash(npm:*)"], ["Bash(rm:*)"]);
  const expected = [
    "## Tool Policy (advisory)",
    "This provider does not enforce tool allowlists. You MUST restrict yourself to:",
    "- Allowed: Bash(npm:*), Grep, Read",
    "- Denied: Bash(rm:*)",
    "Using any tool outside this list is a policy violation.",
  ].join("\n");
  assert.equal(block, expected);
  // identical policy in any order → identical text
  assert.equal(buildAdvisoryBlock(["Read", "Bash(npm:*)", "Grep"], ["Bash(rm:*)"]), expected);
});

test("buildAdvisoryBlock empty allow+deny → empty string", () => {
  assert.equal(buildAdvisoryBlock([], []), "");
  assert.equal(buildAdvisoryBlock(null, null), "");
});

test("codexSandboxHint: Bash tokens inform sandbox; default falls through", () => {
  // no bash tokens → null (no override)
  assert.equal(codexSandboxHint([]), null);
  assert.equal(codexSandboxHint(["Read", "Grep"]), null);
});

test("advisoryRemainder excludes bash tokens for codex", () => {
  const block = advisoryRemainder(["Read", "Grep", "Bash(npm:*)"], ["Bash(rm:*)"]);
  // bash allow token is folded into sandbox, not the advisory remainder
  assert.ok(block.includes("Read"));
  assert.ok(block.includes("Grep"));
  assert.ok(!block.includes("Bash(npm:*)"));
});

test("buildToolPolicyRecord per capability matrix", () => {
  const claude = buildToolPolicyRecord({ role: "review", provider: "claude", tools: ["Read"], deny_tools: ["Bash(rm:*)"] });
  assert.deepEqual(claude, { role: "review", allow: ["Read"], deny: ["Bash(rm:*)"], enforcement: "enforced" });

  const codex = buildToolPolicyRecord({ role: "impl", provider: "codex", tools: ["Bash(npm:*)"], deny_tools: [] });
  assert.equal(codex.enforcement, "partial");

  const gemini = buildToolPolicyRecord({ role: "gather", provider: "gemini", tools: ["Read"], deny_tools: [] });
  assert.equal(gemini.enforcement, "advisory");
});

test("ENFORCEMENT_BY_PROVIDER matrix", () => {
  assert.equal(ENFORCEMENT_BY_PROVIDER.claude, "enforced");
  assert.equal(ENFORCEMENT_BY_PROVIDER.codex, "partial");
  assert.equal(ENFORCEMENT_BY_PROVIDER.gemini, "advisory");
  assert.equal(ENFORCEMENT_BY_PROVIDER.copilot, "advisory");
  assert.equal(ENFORCEMENT_BY_PROVIDER.antigravity, "advisory");
  assert.equal(ENFORCEMENT_BY_PROVIDER.ollama, "advisory");
});
