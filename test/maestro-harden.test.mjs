import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { applyHarden } from "../src/setup/harden.mjs";
import { evaluateGuard } from "../scripts/secret-guard.mjs";

// ── guard decision ───────────────────────────────────────────────────────────

test("denies direct reads of the secret store", () => {
  for (const cmd of [
    "cat .maestro/secrets.local.json",
    "gpg -d .maestro/secrets.local.enc.json",
    "grep KEY .maestro/secrets.local.enc.json",
    "python3 -c \"open('.maestro/secrets.local.json')\"",
  ]) {
    assert.equal(
      evaluateGuard({ tool_name: "Bash", tool_input: { command: cmd } }).decision,
      "deny",
      cmd,
    );
  }
});

test("allows maestro invocations that legitimately use secrets", () => {
  for (const cmd of ["maestro setup keys --encrypt", "maestro serve", "  maestro task 'x'"]) {
    assert.equal(
      evaluateGuard({ tool_name: "Bash", tool_input: { command: cmd } }).decision,
      "allow",
      cmd,
    );
  }
});

test("allows unrelated commands untouched", () => {
  for (const cmd of ["ls -la", "curl https://example.com", "git status"]) {
    assert.equal(
      evaluateGuard({ tool_name: "Bash", tool_input: { command: cmd } }).decision,
      "allow",
      cmd,
    );
  }
});

test("non-Bash tools are ignored", () => {
  assert.equal(
    evaluateGuard({ tool_name: "Read", tool_input: { file_path: ".maestro/secrets.local.json" } })
      .decision,
    "allow",
  );
});

// ── installer ────────────────────────────────────────────────────────────────

test("applyHarden merges hook+deny into settings.json idempotently", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "harden-"));
  const settingsPath = path.join(dir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
  const guardPath = "/opt/maestro/scripts/secret-guard.mjs";

  await applyHarden({ settingsPath, guardScriptPath: guardPath });
  await applyHarden({ settingsPath, guardScriptPath: guardPath }); // second run = no dupes

  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.ok(settings.permissions.allow.includes("Bash(ls:*)")); // preserved
  const denies = settings.permissions.deny;
  assert.ok(denies.some((d) => d.includes("secrets.local")));
  assert.equal(denies.length, new Set(denies).size); // no duplicate deny rules

  const guardHooks = settings.hooks.PreToolUse.flatMap((h) => h.hooks).filter((h) =>
    h.command.includes("secret-guard.mjs"),
  );
  assert.equal(guardHooks.length, 1); // exactly one guard hook after two applies
  assert.ok(guardHooks[0].command.includes(guardPath));
});

test("applyHarden creates settings.json when none exists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "harden-new-"));
  const settingsPath = path.join(dir, "nested", "settings.json");
  await applyHarden({ settingsPath, guardScriptPath: "/x/secret-guard.mjs" });
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.ok(settings.permissions.deny.some((d) => d.includes("secrets.local")));
});
