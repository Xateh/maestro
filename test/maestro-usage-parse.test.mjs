import assert from "node:assert/strict";
import { test } from "node:test";

import { parseUsage } from "../src/usage-parse.mjs";

test("claude stream-json: sums result usage input+output", () => {
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: "hi" } }),
    JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 120, output_tokens: 30 } }),
  ].join("\n");
  assert.equal(parseUsage("claude", stdout), 150);
});

test("claude stream-json: prefers explicit total_tokens", () => {
  const stdout = JSON.stringify({
    type: "result",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 999 },
  });
  assert.equal(parseUsage("claude", stdout), 999);
});

test("claude: scans last→first, ignores leading noise lines", () => {
  const stdout = [
    "warning: some ansi-stripped noise",
    "{ not json",
    JSON.stringify({ type: "result", usage: { input_tokens: 7, output_tokens: 8 } }),
  ].join("\n");
  assert.equal(parseUsage("claude", stdout), 15);
});

test("codex --json JSONL: parses usage event", () => {
  const stdout = [
    JSON.stringify({ type: "task_started" }),
    JSON.stringify({ type: "token_count", usage: { input_tokens: 200, output_tokens: 50 } }),
  ].join("\n");
  assert.equal(parseUsage("codex", stdout), 250);
});

test("codex token_count: usage nested under info.total_token_usage", () => {
  const stdout = [
    JSON.stringify({ type: "task_started" }),
    JSON.stringify({
      type: "token_count",
      info: { total_token_usage: { input_tokens: 300, output_tokens: 75, total_tokens: 375 } },
    }),
  ].join("\n");
  assert.equal(parseUsage("codex", stdout), 375);
});

test("codex token_count: usage under msg.info.token_usage", () => {
  const stdout = JSON.stringify({
    msg: { info: { token_usage: { input_tokens: 10, output_tokens: 5 } } },
  });
  assert.equal(parseUsage("codex", stdout), 15);
});

test("codex: totals-shape object on a bare line", () => {
  const stdout = [
    JSON.stringify({ type: "agent_message" }),
    JSON.stringify({ input_tokens: 4, output_tokens: 6, total_tokens: 10 }),
  ].join("\n");
  assert.equal(parseUsage("codex", stdout), 10);
});

test("copilot single-doc JSON usage", () => {
  const stdout = JSON.stringify({ output: "done", usage: { input_tokens: 11, output_tokens: 9 } });
  assert.equal(parseUsage("copilot", stdout), 20);
});

test("antigravity single-doc nested stats.usage", () => {
  const stdout = JSON.stringify({ stats: { usage: { prompt_tokens: 3, completion_tokens: 7 } } });
  assert.equal(parseUsage("antigravity", stdout), 10);
});

test("gemini usageMetadata via response", () => {
  const stdout = JSON.stringify({
    response: {
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 60, totalTokenCount: 100 },
    },
  });
  assert.equal(parseUsage("gemini", stdout), 100);
});

test("gemini usageMetadata without total falls back to component sum", () => {
  const stdout = JSON.stringify({
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 },
  });
  assert.equal(parseUsage("gemini", stdout), 20);
});

test("ollama / unknown providers ⇒ 0", () => {
  assert.equal(parseUsage("ollama", "any text here"), 0);
  assert.equal(parseUsage("totally-unknown", JSON.stringify({ usage: { input_tokens: 5 } })), 0);
});

test("truncated tail (usage line dropped) ⇒ 0, no throw", () => {
  const stdout = [
    JSON.stringify({ type: "assistant", message: { content: "partial" } }),
    '{"type":"result","usage":{"input_tok', // cut off mid-line
  ].join("\n");
  assert.equal(parseUsage("claude", stdout), 0);
});

test("empty / non-string / garbage ⇒ 0, never throws", () => {
  assert.equal(parseUsage("claude", ""), 0);
  assert.equal(parseUsage("claude", null), 0);
  assert.equal(parseUsage("claude", undefined), 0);
  assert.equal(parseUsage("claude", 12345), 0);
  assert.equal(parseUsage("claude", "not json at all\nstill not json"), 0);
  assert.equal(parseUsage(null, "x"), 0);
  assert.equal(parseUsage("gemini", "{bad json"), 0);
});

test("zero/negative token components ⇒ 0", () => {
  assert.equal(parseUsage("claude", JSON.stringify({ type: "result", usage: { input_tokens: 0, output_tokens: 0 } })), 0);
});
