import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMAND_TREE,
  LOCAL_COMMAND_NAMES,
  formatHelp,
  levenshtein,
  resolveCommandPath,
  routeCli,
  suggest,
  usageError,
} from "../src/cli/registry.mjs";

test("levenshtein distances", () => {
  assert.equal(levenshtein("", ""), 0);
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("abc", ""), 3);
  assert.equal(levenshtein("", "abc"), 3);
  assert.equal(levenshtein("stauts", "status"), 2);
  assert.equal(levenshtein("creat", "create"), 1);
  assert.equal(levenshtein("kitten", "sitting"), 3);
});

test("suggest ranks by distance and drops far matches", () => {
  const projectSubs = ["create", "status", "inspect", "sync-target", "close", "cleanup"];
  assert.deepEqual(suggest("creat", projectSubs), ["create"]);
  assert.deepEqual(suggest("zzzzzz", projectSubs), []);
  assert.deepEqual(suggest("statsu", ["status", "setup"]), ["status"]);
});

test("resolveCommandPath walks the longest valid prefix", () => {
  const exact = resolveCommandPath(["project", "create"]);
  assert.equal(exact.unknown, null);
  assert.deepEqual(exact.matched.map((n) => n.name), ["maestro", "project", "create"]);

  const typo = resolveCommandPath(["project", "creat"]);
  assert.equal(typo.unknown, "creat");
  assert.deepEqual(typo.matched.map((n) => n.name), ["maestro", "project"]);
  assert.ok(typo.candidates.includes("create"));

  // positional args after a leaf command are not "unknown"
  const positional = resolveCommandPath(["task", "fix", "the", "bug"]);
  assert.equal(positional.unknown, null);
  assert.deepEqual(positional.matched.map((n) => n.name), ["maestro", "task"]);
});

test("formatHelp root covers every command incl. serve and init", () => {
  const text = formatHelp([COMMAND_TREE]);
  for (const name of [...LOCAL_COMMAND_NAMES, "serve"]) {
    assert.ok(text.includes(`maestro ${name}`), `root help missing ${name}`);
  }
  assert.ok(text.includes("--state-dir"));
});

test("formatHelp scoped node lists subcommands and flags", () => {
  const { matched } = resolveCommandPath(["project"]);
  const text = formatHelp(matched);
  for (const sub of ["create", "status", "inspect", "sync-target", "close", "cleanup"]) {
    assert.ok(text.includes(sub), `project help missing ${sub}`);
  }
  const leaf = resolveCommandPath(["setup", "keys"]);
  assert.ok(formatHelp(leaf.matched).includes("--var NAME"));
});

test("usageError carries cli_usage code and scoped help", () => {
  const typo = usageError(["project", "creat"]);
  assert.equal(typo.code, "cli_usage");
  assert.match(typo.cliHelp, /unknown command: maestro project creat/);
  assert.match(typo.cliHelp, /Did you mean: create\?/);
  assert.match(typo.cliHelp, /Usage: maestro project <subcommand>/);

  const missing = usageError(["setup", undefined]);
  assert.match(missing.cliHelp, /missing subcommand \(expected: keys \| harden \| local \| import\)/);
});

test("routeCli matrix", () => {
  assert.equal(routeCli([]).kind, "server");
  assert.equal(routeCli(["--port", "4100"]).kind, "server");
  assert.equal(routeCli(["status"]).kind, "local");
  assert.equal(routeCli(["init"]).kind, "local");

  const serve = routeCli(["serve", "--config", "ops/config.json", "--port", "4100"]);
  assert.equal(serve.kind, "serve");
  assert.deepEqual(serve.serverArgs, ["--config", "ops/config.json", "--port", "4100"]);

  // A bare positional (no longer a deprecated .md route) is a usage error.
  assert.equal(routeCli(["wf.md"]).kind, "error");

  const typo = routeCli(["stauts"]);
  assert.equal(typo.kind, "error");
  assert.equal(typo.exitCode, 1);
  assert.match(typo.text, /Did you mean: status\?/);

  const scopedHelp = routeCli(["project", "--help"]);
  assert.equal(scopedHelp.kind, "help");
  assert.equal(scopedHelp.exitCode, 0);
  assert.match(scopedHelp.text, /Usage: maestro project <subcommand>/);

  const helpCmd = routeCli(["help", "project", "create"]);
  assert.equal(helpCmd.kind, "help");
  assert.match(helpCmd.text, /Usage: maestro project create <id>/);

  // --help after "--" is literal prompt text, not a help request
  const literal = routeCli(["task", "--", "--help in prompt"]);
  assert.equal(literal.kind, "local");
});

test("registry local names stay in sync with known dispatch set", () => {
  // Drift guard: every name the registry says is local must be unique.
  assert.equal(new Set(LOCAL_COMMAND_NAMES).size, LOCAL_COMMAND_NAMES.length);
  for (const expected of ["project", "task", "run-task", "status", "inspect", "events", "artifacts", "rerun", "compare", "tui",
    "setup", "workflow", "export", "import", "init"]) {
    assert.ok(LOCAL_COMMAND_NAMES.includes(expected), `missing local command ${expected}`);
  }
  assert.ok(!LOCAL_COMMAND_NAMES.includes("serve"), "serve must not be a local command");
});
