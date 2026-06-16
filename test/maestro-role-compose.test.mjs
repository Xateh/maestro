import assert from "node:assert/strict";
import { test } from "node:test";

import { composeRole } from "../src/setup/role-loader.mjs";

test("inline keys win over unit keys", () => {
  const unit = { provider: "claude", permission: "read", instructions: "u" };
  const out = composeRole("review", { provider: "codex", prompt_template: "review" }, unit);
  assert.equal(out.provider, "codex");
  assert.equal(out.permission, "read");
  assert.equal(out.instructions, "u");
  assert.equal(out.prompt_template, "review");
});

test("tools/deny_tools inline REPLACE unit arrays (not merge)", () => {
  const unit = { tools: ["Read", "Grep"], deny_tools: ["Bash(rm:*)"] };
  const out = composeRole("x", { tools: ["Write"] }, unit);
  assert.deepEqual(out.tools, ["Write"]);
  // deny_tools not overridden inline → unit value retained
  assert.deepEqual(out.deny_tools, ["Bash(rm:*)"]);
});

test("prompt_template defaults to stage state name when neither sets it", () => {
  const out = composeRole("gather", {}, { provider: "gemini" });
  assert.equal(out.prompt_template, "gather");
});

test("source key itself is stripped from the result", () => {
  const out = composeRole("x", { source: ".maestro/roles/x.md", provider: "codex" }, { provider: "claude" });
  assert.ok(!("source" in out));
  assert.equal(out.provider, "codex");
});

test("provider override: inline provider over unit provider", () => {
  const out = composeRole("review", { provider: "codex", prompt_template: "review" }, { provider: "claude", instructions: "i" });
  assert.equal(out.provider, "codex");
});

test("no-source invariance: inline-only roles unchanged (deep-equal)", () => {
  // When there is no unit (empty base), composition is the inline role plus the
  // prompt_template default — but a role that already sets prompt_template is
  // byte-for-byte identical.
  const inline = { provider: "claude", permission: "plan", prompt_template: "planner", skip: "auto" };
  const out = composeRole("planner", inline, {});
  assert.deepEqual(out, inline);
});
