import assert from "node:assert/strict";
import { test } from "node:test";

import { buildClaudeCommand } from "../src/adapters/claude.mjs";
import { buildCodexCommand } from "../src/adapters/codex.mjs";
import { buildGeminiCommand } from "../src/adapters/gemini.mjs";
import { buildCopilotCommand } from "../src/adapters/copilot.mjs";
import { buildAntigravityCommand } from "../src/adapters/antigravity.mjs";
import { buildOllamaCommand } from "../src/adapters/ollama.mjs";

const base = { prompt: "p", cwd: "/tmp" };

test("claude emits --allowedTools/--disallowedTools when tools present", () => {
  const cmd = buildClaudeCommand({ ...base, tools: ["Read", "Grep", "Bash(npm:*)"], deny_tools: ["Bash(rm:*)"] });
  const i = cmd.args.indexOf("--allowedTools");
  assert.ok(i >= 0);
  assert.equal(cmd.args[i + 1], "Read Grep Bash(npm:*)");
  const j = cmd.args.indexOf("--disallowedTools");
  assert.ok(j >= 0);
  assert.equal(cmd.args[j + 1], "Bash(rm:*)");
});

test("claude without tools → no tool flags (backward compat)", () => {
  const withTools = buildClaudeCommand({ ...base, tools: ["Read"] });
  const without = buildClaudeCommand({ ...base });
  assert.ok(!without.args.includes("--allowedTools"));
  assert.ok(!without.args.includes("--disallowedTools"));
  // the only difference between the two is the tool flags
  assert.ok(withTools.args.includes("--allowedTools"));
});

test("codex folds Bash tokens into sandbox; no per-tool flag", () => {
  const cmd = buildCodexCommand({ ...base, permission: "read", tools: ["Bash(npm:*)", "Read"] });
  assert.ok(!cmd.args.includes("--allowedTools"));
  // sandbox flag still present
  assert.ok(cmd.args.includes("--sandbox"));
});

test("codex without tools is unchanged", () => {
  const cmd = buildCodexCommand({ ...base, permission: "read" });
  const i = cmd.args.indexOf("--sandbox");
  assert.equal(cmd.args[i + 1], "read-only");
});

test("advisory adapters emit no enforcement flags even with tools", () => {
  const builders = [
    () => buildGeminiCommand({ ...base, tools: ["Read"], deny_tools: ["Bash(rm:*)"] }),
    () => buildCopilotCommand({ ...base, tools: ["Read"], deny_tools: ["Bash(rm:*)"] }),
    () => buildAntigravityCommand({ ...base, tools: ["Read"], deny_tools: ["Bash(rm:*)"] }),
    () => buildOllamaCommand({ ...base, tools: ["Read"], deny_tools: ["Bash(rm:*)"] }),
  ];
  for (const build of builders) {
    const cmd = build();
    assert.ok(!cmd.args.includes("--allowedTools"));
    assert.ok(!cmd.args.includes("--disallowedTools"));
  }
});

test("advisory adapters without tools are byte-for-byte unchanged", () => {
  assert.deepEqual(
    buildGeminiCommand({ ...base }),
    buildGeminiCommand({ ...base, tools: ["Read"] }),
  );
  assert.deepEqual(
    buildOllamaCommand({ ...base, model: "m" }),
    buildOllamaCommand({ ...base, model: "m", tools: ["Read"] }),
  );
});
