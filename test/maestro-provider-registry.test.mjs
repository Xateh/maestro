import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_CAPS, resolveCapabilities } from "../src/adapters/capabilities.mjs";
import { listProviders } from "../src/provider-registry.mjs";

const ALL_TRUE = { plan: true, execute: true, review: true };

test("BUILTIN_CAPS mirrors the built-in provider adapter surface", () => {
  assert.deepEqual(Object.keys(BUILTIN_CAPS).sort(), [
    "antigravity",
    "claude",
    "codex",
    "copilot",
    "gemini",
    "ollama",
  ]);
  for (const caps of Object.values(BUILTIN_CAPS)) {
    assert.deepEqual(caps, ALL_TRUE);
  }
});

test("resolveCapabilities merges config overrides and defaults custom adapters all true", () => {
  assert.deepEqual(
    resolveCapabilities({ capabilities: { execute: false, image_gen: true } }, "built-in:gemini"),
    { plan: true, execute: false, review: true, image_gen: true },
  );
  assert.deepEqual(resolveCapabilities({}, "custom:local"), ALL_TRUE);
});

test("listProviders returns stable registry shape with distinct preflight statuses", async () => {
  const probed = [];
  const available = new Set(["claude", "codex", "copilot", "custom-bin"]);
  const config = {
    providers: {
      claude: {
        adapter: "built-in:claude",
        default_alias: "work",
        aliases: [{ name: "work", command: "claude", env: { CLAUDE_CONFIG_DIR: "~/.claude-work" } }],
        models: ["opus"],
        permission: "plan",
      },
      codex: {
        adapter: "built-in:codex",
        default_alias: "codex",
        aliases: ["codex"],
        models: ["gpt-5.5"],
      },
      copilot: {
        adapter: "built-in:copilot",
        default_alias: "copilot",
        aliases: ["copilot"],
        env: { GITHUB_TOKEN: "$GITHUB_TOKEN" },
        models: [],
      },
      gemini: {
        adapter: "built-in:gemini",
        default_alias: "gemini",
        aliases: ["gemini"],
        models: ["gemini-2.5-pro"],
        capabilities: { execute: false, image_gen: true },
        permission: "sudo",
      },
      ollama: {
        adapter: "built-in:ollama",
        default_alias: "ollama",
        aliases: ["ollama"],
        enabled: false,
        models: [],
      },
      local: {
        adapter: "custom:local",
        default_alias: "acct",
        aliases: [{ name: "acct", command: "custom-bin" }],
        models: ["local-model"],
      },
    },
  };

  const result = await listProviders({
    config,
    cwd: "/repo",
    env: { PATH: "", HOME: "/home/test" },
    probe: async (command) => {
      probed.push(command);
      return available.has(command);
    },
  });

  assert.deepEqual(probed, ["claude", "codex", "copilot", "gemini", "custom-bin"]);
  assert.deepEqual(result.providers, [
    {
      provider: "claude",
      adapter: "built-in:claude",
      default_alias: "work",
      models: ["opus"],
      capabilities: ALL_TRUE,
      permission: "plan",
      status: "ready",
    },
    {
      provider: "codex",
      adapter: "built-in:codex",
      default_alias: "codex",
      models: ["gpt-5.5"],
      capabilities: ALL_TRUE,
      permission: "read",
      status: "ready",
    },
    {
      provider: "copilot",
      adapter: "built-in:copilot",
      default_alias: "copilot",
      models: [],
      capabilities: ALL_TRUE,
      permission: "read",
      status: "missing_creds",
    },
    {
      provider: "gemini",
      adapter: "built-in:gemini",
      default_alias: "gemini",
      models: ["gemini-2.5-pro"],
      capabilities: { plan: true, execute: false, review: true, image_gen: true },
      permission: "read",
      status: "missing_cli",
    },
    {
      provider: "ollama",
      adapter: "built-in:ollama",
      default_alias: "ollama",
      models: [],
      capabilities: ALL_TRUE,
      permission: "read",
      status: "disabled",
    },
    {
      provider: "local",
      adapter: "custom:local",
      default_alias: "acct",
      models: ["local-model"],
      capabilities: ALL_TRUE,
      permission: "read",
      status: "ready",
    },
  ]);
});

test("listProviders degrades probe failures to unknown without rejecting", async () => {
  const result = await listProviders({
    config: {
      providers: {
        codex: {
          adapter: "built-in:codex",
          default_alias: "codex",
          aliases: ["codex"],
          models: [],
        },
      },
    },
    probe: async () => {
      throw new Error("offline probe unavailable");
    },
  });

  assert.equal(result.providers[0].status, "unknown");
});
