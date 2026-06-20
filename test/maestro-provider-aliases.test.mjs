import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { normalizeAlias, aliasNames, resolveAlias, aliasToConfig } from "../src/providers.mjs";
import { resolveAliasEnv, resolveProviderEnv } from "../src/setup/keys.mjs";
import { buildAgentCommand } from "../src/agent-runner.mjs";
import { resolveRoleProvider } from "../src/provider-availability.mjs";

// ── normalization ──────────────────────────────────────────────────────────

test("normalizeAlias: bare string is identity command with empty env", () => {
  assert.deepEqual(normalizeAlias("claude"), { name: "claude", command: "claude", env: {} });
});

test("normalizeAlias: object defaults command to provider base, keeps env", () => {
  assert.deepEqual(
    normalizeAlias({ name: "personal", env: { CLAUDE_CONFIG_DIR: "~/.claude-personal" } }, "claude"),
    { name: "personal", command: "claude", env: { CLAUDE_CONFIG_DIR: "~/.claude-personal" } },
  );
  assert.equal(normalizeAlias({ name: "work", command: "claude-canary" }, "claude").command, "claude-canary");
});

test("aliasNames: lists names across mixed string/object entries", () => {
  const def = { aliases: ["claude", { name: "work", command: "claude" }, { name: "personal", env: { X: "1" } }] };
  assert.deepEqual(aliasNames(def), ["claude", "work", "personal"]);
});

test("resolveAlias: found name returns its command+env; missing name synthesizes a bare alias", () => {
  const def = {
    default_alias: "work",
    aliases: ["claude", { name: "work", command: "claude", env: { CLAUDE_CONFIG_DIR: "~/.claude-work" } }],
  };
  assert.deepEqual(resolveAlias(def, "work", "claude"), {
    name: "work", command: "claude", env: { CLAUDE_CONFIG_DIR: "~/.claude-work" },
  });

});

test("aliasToConfig: collapses a fully-default account to a bare string, keeps distinct ones as objects", () => {
  assert.equal(aliasToConfig({ name: "claude", command: "claude", env: {} }, "claude"), "claude");
  // distinct command must NOT collapse (would lose the binary)
  assert.deepEqual(aliasToConfig({ name: "work", command: "claude", env: {} }, "claude"), { name: "work", command: "claude" });
  assert.deepEqual(
    aliasToConfig({ name: "p", command: "p", env: { CLAUDE_CONFIG_DIR: "~/x" } }, "claude"),
    { name: "p", command: "p", env: { CLAUDE_CONFIG_DIR: "~/x" } },
  );
});

// ── env resolution ─────────────────────────────────────────────────────────

test("resolveAliasEnv: alias env layers over provider env and wins on conflict", () => {
  const def = {
    env: { BASE: "from-provider", SHARED: "provider" },
    aliases: [{ name: "work", env: { CLAUDE_CONFIG_DIR: "~/.claude-work", SHARED: "alias" } }],
  };
  const resolved = resolveAliasEnv(def, "work", "claude", {});
  assert.equal(resolved.BASE, "from-provider");
  assert.equal(resolved.SHARED, "alias");
  assert.equal(resolved.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".claude-work"));
});

test("resolveAliasEnv: expands tilde, inline $VAR, and whole-string secret refs; drops unset", () => {
  const env = { HOME_OVERRIDE: "/data", SECRET: "s3cr3t" };
  const def = {
    aliases: [{
      name: "acc",
      env: {
        TILDE: "~/cfg",
        INLINE: "$HOME_OVERRIDE/sub",
        REF: "$SECRET",
        MISSING: "$NOPE",
      },
    }],
  };
  const resolved = resolveAliasEnv(def, "acc", "claude", env);
  assert.equal(resolved.TILDE, path.join(os.homedir(), "cfg"));
  assert.equal(resolved.INLINE, "/data/sub");
  assert.equal(resolved.REF, "s3cr3t");
  assert.ok(!("MISSING" in resolved), "unresolved $VAR ref must be dropped");
});

test("resolveAliasEnv: denylisted keys are dropped at resolution", () => {
  const def = { aliases: [{ name: "x", env: { PATH: "/evil", LD_PRELOAD: "/x.so", OK: "1" } }] };
  const resolved = resolveAliasEnv(def, "x", "claude", {});
  assert.deepEqual(resolved, { OK: "1" });
});

test("resolveProviderEnv still works and now expands tilde", () => {
  const def = { env: { CLAUDE_CONFIG_DIR: "~/.cfg" } };
  assert.equal(resolveProviderEnv(def, {}).CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".cfg"));
});

// ── spawn path ─────────────────────────────────────────────────────────────

test("buildAgentCommand: structured alias spawns the account command, not its name", () => {
  const providerDef = {
    adapter: "built-in:claude",
    default_alias: "work",
    aliases: [{ name: "work", command: "claude", env: { CLAUDE_CONFIG_DIR: "~/.claude-work" } }],
  };
  const spec = buildAgentCommand({
    provider: "claude",
    prompt: "hi",
    cwd: "/repo",
    role: "executor",
    options: { alias: "work" },
    providerDef,
  });
  assert.equal(spec.command, "claude", "must spawn the binary, not the account name 'work'");
});

test("buildAgentCommand: bare-string alias keeps name as command (back-compat)", () => {
  const providerDef = { adapter: "built-in:claude", default_alias: "alt-claude", aliases: ["alt-claude"] };
  const spec = buildAgentCommand({
    provider: "claude", prompt: "hi", cwd: "/repo", role: "executor",
    options: { alias: "alt-claude" }, providerDef,
  });
  assert.equal(spec.command, "alt-claude");
});

// ── availability probes the command ──────────────────────────────────────────

test("resolveRoleProvider: probes the account's command but returns the account name", async () => {
  const config = {
    providers: {
      claude: {
        adapter: "built-in:claude",
        default_alias: "work",
        models: [],
        aliases: [{ name: "work", command: "claude", env: { CLAUDE_CONFIG_DIR: "~/.claude-work" } }],
      },
    },
  };
  const probed = [];
  const res = await resolveRoleProvider({
    roleDef: { provider: "claude" },
    config,
    probe: async (cmd) => { probed.push(cmd); return cmd === "claude"; },
  });
  assert.equal(res.ok, true);
  assert.equal(res.alias, "work", "routing identity stays the account name");
  assert.deepEqual(probed, ["claude"], "availability is probed on the resolved binary");
});
