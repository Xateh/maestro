import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildOllamaCommand } from "../src/adapters/ollama.mjs";
import { resolveAdapter } from "../src/adapters/registry.mjs";
import { TerminalAgentRunner } from "../src/agent-runner.mjs";
import { deepMergeConfig } from "../src/config-local.mjs";
import { buildLocalProviderPatch } from "../src/setup/local.mjs";
import {
  buildBundle,
  canonicalizeBundle,
  importBundle,
  readBundle,
  writeBundleDir,
  writeBundleFile,
} from "../src/setup/export.mjs";
import {
  parseAttachSpec,
  parseWireSpec,
  planImport,
  runImport,
  runImportWizard,
} from "../src/setup/import.mjs";
import {
  parseSkill,
  parseSubagent,
  slugifyRoleName,
  subagentToRole,
} from "../src/setup/scanners/claude.mjs";
import { parseTomlSubset } from "../src/setup/scanners/codex.mjs";
import { parseFrontmatter } from "../src/setup/scanners/frontmatter.mjs";
import { parseOllamaList } from "../src/setup/scanners/local-agents.mjs";
import {
  loadLocalSecrets,
  readLocalSecrets,
  resolveProviderEnv,
  secretsPath,
  writeLocalSecrets,
} from "../src/setup/keys.mjs";
import { DEFAULT_PROVIDERS, DEFAULT_WORKFLOW, LocalTaskStore } from "../src/task-store.mjs";
import { resolveMaxVisits } from "../src/state-machine.mjs";
import {
  cycleHasTermination,
  findCycles,
  formatValidation,
  validateWorkflow,
} from "../src/workflow-validate.mjs";

async function tempDir(prefix = "maestro-setup-test-") {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function withTempDir(fn) {
  const dir = await tempDir();
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── deepMergeConfig ──────────────────────────────────────────────────────────

test("deepMergeConfig merges nested objects and replaces arrays/scalars", () => {
  const base = {
    timeout_ms: 1000,
    providers: { claude: { default_alias: "claude", aliases: ["claude"], models: ["opus"] } },
    recent: { providers_by_role: { planner: ["claude"] } },
  };
  const overlay = {
    timeout_ms: 2000,
    providers: { claude: { default_alias: "cld", aliases: ["cld", "claude"] } },
  };
  const merged = deepMergeConfig(base, overlay);
  assert.equal(merged.timeout_ms, 2000);
  assert.equal(merged.providers.claude.default_alias, "cld");
  assert.deepEqual(merged.providers.claude.aliases, ["cld", "claude"]);
  // untouched keys survive
  assert.deepEqual(merged.providers.claude.models, ["opus"]);
  assert.deepEqual(merged.recent.providers_by_role.planner, ["claude"]);
  // base not mutated
  assert.equal(base.timeout_ms, 1000);
  assert.equal(base.providers.claude.default_alias, "claude");
});

// ── config.local.json overlay ────────────────────────────────────────────────

test("readConfig applies config.local.json overlay over config.json", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.writeConfig({ timeout_ms: 1234 });
    await store.writeLocalConfig({
      timeout_ms: 9999,
      providers: { claude: { default_alias: "my-claude-alias" } },
    });

    const config = await store.readConfig();
    assert.equal(config.timeout_ms, 9999);
    assert.equal(config.providers.claude.default_alias, "my-claude-alias");
    // non-overridden provider fields come from defaults
    assert.deepEqual(config.providers.claude.models, DEFAULT_PROVIDERS.claude.models);
  });
});

test("writeConfig never persists local overlay values into config.json", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.writeConfig({ timeout_ms: 1234 });
    await store.writeLocalConfig({
      providers: { claude: { default_alias: "secret-alias" } },
    });

    // a later shared-config write must not leak the local alias
    await store.writeConfig({ review_enabled: false });

    const raw = JSON.parse(await readFile(store.configPath, "utf8"));
    assert.equal(JSON.stringify(raw).includes("secret-alias"), false);
    assert.equal(raw.review_enabled, false);
    assert.equal(raw.timeout_ms, 1234);

    // effective view still shows the overlay
    const config = await store.readConfig();
    assert.equal(config.providers.claude.default_alias, "secret-alias");
  });
});

test("readConfig works with local overlay and no config.json", async () => {
  await withTempDir(async (dir) => {
    const store = new LocalTaskStore({ root: path.join(dir, ".maestro") });
    await store.writeLocalConfig({ timeout_ms: 42 });
    const config = await store.readConfig();
    assert.equal(config.timeout_ms, 42);
    assert.equal(config.version, 2);
  });
});

// ── secrets.local.json ───────────────────────────────────────────────────────

test("writeLocalSecrets writes 0600 and readLocalSecrets round-trips", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    await writeLocalSecrets(stateDir, { LINEAR_API_KEY: "lin_test_123" });
    const info = await stat(secretsPath(stateDir));
    assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(await readLocalSecrets(stateDir), { LINEAR_API_KEY: "lin_test_123" });
  });
});

test("loadLocalSecrets sets only unset env keys", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    await writeLocalSecrets(stateDir, { A_KEY: "from-secrets", B_KEY: "from-secrets" });
    const env = { A_KEY: "from-real-env" };
    const applied = await loadLocalSecrets(stateDir, env);
    assert.deepEqual(applied, ["B_KEY"]);
    assert.equal(env.A_KEY, "from-real-env");
    assert.equal(env.B_KEY, "from-secrets");
  });
});

test("loadLocalSecrets is a no-op without a secrets file", async () => {
  await withTempDir(async (dir) => {
    const env = {};
    const applied = await loadLocalSecrets(path.join(dir, ".maestro"), env);
    assert.deepEqual(applied, []);
    assert.deepEqual(env, {});
  });
});

test("resolveProviderEnv resolves $VAR refs and drops unresolvable ones", () => {
  const providerDef = {
    env: {
      OPENAI_API_KEY: "$MY_OPENAI_KEY",
      LITERAL: "literal-value",
      MISSING: "$NOT_SET_ANYWHERE",
    },
  };
  const resolved = resolveProviderEnv(providerDef, { MY_OPENAI_KEY: "sk-test" });
  assert.deepEqual(resolved, { OPENAI_API_KEY: "sk-test", LITERAL: "literal-value" });
  assert.deepEqual(resolveProviderEnv({}, {}), {});
});

// ── local providers ──────────────────────────────────────────────────────────

test("buildOllamaCommand: ollama run <model> with prompt on stdin", () => {
  const spec = buildOllamaCommand({ prompt: "do it", cwd: "/tmp", model: "qwen2.5-coder" });
  assert.equal(spec.command, "ollama");
  assert.deepEqual(spec.args, ["run", "qwen2.5-coder"]);
  assert.equal(spec.stdin, "do it");

  const aliased = buildOllamaCommand({ prompt: "x", cwd: "/tmp", alias: "my-ollama" });
  assert.equal(aliased.command, "my-ollama");
  assert.deepEqual(aliased.args, ["run", "llama3.2"]);
});

test("local provider defaults resolve through the adapter registry", () => {
  for (const provider of ["ollama", "pi", "hermes", "openclaw"]) {
    const providerDef = DEFAULT_PROVIDERS[provider];
    assert.ok(providerDef, `${provider} should be a default provider`);
    const adapterFn = resolveAdapter(providerDef);
    const spec = adapterFn({ prompt: "hello", cwd: "/tmp", alias: providerDef.default_alias, model: "" });
    assert.ok(spec.command, `${provider} adapter should produce a command`);
    // prompt must reach the agent either via stdin or as an argument
    const viaArg = spec.args.includes("hello");
    assert.ok(spec.stdin === "hello" || viaArg, `${provider} must deliver the prompt`);
  }
});

test("TerminalAgentRunner passes providerEnv to the spawned process", async () => {
  await withTempDir(async (dir) => {
    let spawnedEnv = null;
    const fakeSpawn = (_cmd, _args, opts) => {
      spawnedEnv = opts.env;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { on: () => {}, end: () => {} };
      child.kill = () => {};
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    };
    const runner = new TerminalAgentRunner({ spawnProcess: fakeSpawn, timeoutMs: -1 });
    await runner.runStep({
      provider: "claude",
      role: "executor",
      prompt: "x",
      cwd: dir,
      logDir: path.join(dir, "logs"),
      providerDef: DEFAULT_PROVIDERS.claude,
      env: { MAESTRO_TASK_ID: "t1", NOT_ALLOWED: "filtered" },
      providerEnv: { OPENAI_API_KEY: "sk-test-value" },
    });
    assert.equal(spawnedEnv.OPENAI_API_KEY, "sk-test-value");
    assert.equal(spawnedEnv.MAESTRO_TASK_ID, "t1");
    assert.equal(spawnedEnv.NOT_ALLOWED, undefined);
    // env_keys logged (names only)
    const commandJson = JSON.parse(await readFile(path.join(dir, "logs", "executor.command.json"), "utf8"));
    assert.ok(commandJson.env_keys.includes("OPENAI_API_KEY"));
  });
});

test("parseOllamaList extracts model names from CLI output", () => {
  const stdout = [
    "NAME                ID            SIZE    MODIFIED",
    "llama3.2:latest     a80c4f17acd5  2.0 GB  3 weeks ago",
    "qwen2.5-coder:7b    2b0496514337  4.7 GB  2 days ago",
    "",
  ].join("\n");
  assert.deepEqual(parseOllamaList(stdout), ["llama3.2:latest", "qwen2.5-coder:7b"]);
  assert.deepEqual(parseOllamaList(""), []);
});

test("buildLocalProviderPatch records found providers' models only", () => {
  const results = [
    { provider: "ollama", found: true, alias: "ollama", models: ["llama3.2:latest"], notes: [] },
    { provider: "pi", found: false, alias: "pi", models: [], notes: [] },
    { provider: "claude", found: true, alias: "claude", models: [], notes: [] },
  ];
  assert.deepEqual(buildLocalProviderPatch(results), {
    providers: { ollama: { models: ["llama3.2:latest"] } },
  });
  assert.deepEqual(buildLocalProviderPatch([{ provider: "x", found: false, alias: "x", models: [], notes: [] }]), {});
});

// ── workflow validation ──────────────────────────────────────────────────────

function loopWorkflow(extra = {}, roleExtra = {}) {
  return {
    version: 1,
    initial: "executor",
    roles: {
      executor: { provider: "codex", ...roleExtra.executor },
      reviewer: { provider: "codex", ...roleExtra.reviewer },
    },
    transitions: {
      executor: { done: "reviewer", error: "$halt" },
      reviewer: { revise: "executor", error: "$halt" },
    },
    modes: { task: { initial: "executor" } },
    ...extra,
  };
}

test("findCycles detects 2-node and self-loop cycles, ignores sink edges", () => {
  const cycles = findCycles(loopWorkflow().transitions);
  assert.deepEqual(cycles, [["executor", "reviewer"]]);

  assert.deepEqual(findCycles({ a: { again: "a" } }), [["a"]]);
  assert.deepEqual(findCycles(DEFAULT_WORKFLOW.transitions), []);
});

test("findCycles detects 3-node cycle once (deduped, canonical)", () => {
  const transitions = {
    a: { done: "b" },
    b: { done: "c" },
    c: { done: "a" },
  };
  assert.deepEqual(findCycles(transitions), [["a", "b", "c"]]);
});

test("cycleHasTermination: sink edge, max_visits, or loop_limits terminate", () => {
  const bare = loopWorkflow();
  // reviewer has error → $halt, which counts as an exit from the cycle
  assert.equal(cycleHasTermination(["executor", "reviewer"], bare), true);

  const noSinks = loopWorkflow();
  noSinks.transitions = {
    executor: { done: "reviewer" },
    reviewer: { revise: "executor" },
  };
  assert.equal(cycleHasTermination(["executor", "reviewer"], noSinks), false);

  const withMaxVisits = { ...noSinks, roles: { executor: { max_visits: 3 }, reviewer: {} } };
  assert.equal(cycleHasTermination(["executor", "reviewer"], withMaxVisits), true);

  const withLimits = { ...noSinks, loop_limits: { default_max_visits: 5 } };
  assert.equal(cycleHasTermination(["executor", "reviewer"], withLimits), true);
});

test("validateWorkflow warns on unterminated cycle with recommendation", () => {
  const workflow = loopWorkflow();
  workflow.transitions = {
    executor: { done: "reviewer" },
    reviewer: { revise: "executor" },
  };
  const result = validateWorkflow(workflow);
  assert.equal(result.ok, true);
  const warning = result.warnings.find((w) => w.code === "unterminated_cycle");
  assert.ok(warning);
  assert.match(warning.message, /max_visits/);
  assert.match(warning.message, /loop_limits/);
});

test("validateWorkflow accepts the default workflow with zero issues", () => {
  const result = validateWorkflow(DEFAULT_WORKFLOW);
  assert.deepEqual(result, { ok: true, errors: [], warnings: [] });
});

test("validateWorkflow flags structural errors", () => {
  const workflow = {
    initial: "nope",
    roles: { executor: { max_visits: -1 } },
    transitions: {
      executor: { done: "$complete", bad: "ghost" },
      phantom: { done: "$complete" },
    },
    modes: { custom: { initial: "ghost", terminal_after: ["ghost"] } },
    loop_limits: { default_max_visits: 0, on_exceeded: "explode" },
  };
  const result = validateWorkflow(workflow);
  assert.equal(result.ok, false);
  const codes = result.errors.map((e) => e.code);
  for (const expected of [
    "bad_initial", "unknown_transition_source", "unknown_transition_target",
    "bad_mode_initial", "bad_mode_terminal", "bad_loop_limits", "bad_max_visits",
  ]) {
    assert.ok(codes.includes(expected), `expected error code ${expected}, got ${codes.join(", ")}`);
  }
});

test("validateWorkflow warns on unreachable roles and unknown providers", () => {
  const workflow = {
    initial: "executor",
    roles: {
      executor: { provider: "no-such-provider" },
      orphan: { provider: "codex" },
    },
    transitions: { executor: { done: "$complete" } },
  };
  const result = validateWorkflow(workflow, { config: { providers: DEFAULT_PROVIDERS } });
  const codes = result.warnings.map((w) => w.code);
  assert.ok(codes.includes("unreachable_role"));
  assert.ok(codes.includes("unknown_provider"));
});

test("formatValidation renders OK and problem lines", () => {
  assert.equal(formatValidation({ ok: true, errors: [], warnings: [] }), "workflow OK — no errors, no warnings");
  const text = formatValidation({
    ok: false,
    errors: [{ code: "x", message: "boom" }],
    warnings: [{ code: "y", message: "careful" }],
  });
  assert.match(text, /error \[x\]: boom/);
  assert.match(text, /warning \[y\]: careful/);
});

test("resolveMaxVisits prefers role max_visits over loop_limits default", () => {
  const workflow = {
    roles: { executor: { max_visits: 2 }, reviewer: {} },
    loop_limits: { default_max_visits: 7 },
  };
  assert.equal(resolveMaxVisits(workflow, "executor"), 2);
  assert.equal(resolveMaxVisits(workflow, "reviewer"), 7);
  assert.equal(resolveMaxVisits({}, "anything"), null);
});

// ── scanners ─────────────────────────────────────────────────────────────────

const SUBAGENT_FIXTURE = `---
name: system-evaluator
description: Use this agent for a rigorous, evidence-backed evaluation of a target system. It verifies and plans but never modifies the system under evaluation.
tools: Read, Grep, Bash
---

You are a system evaluator. Score the target across verifiable traits and
produce a measurable fix plan. Never modify the system under evaluation.
`;

test("parseFrontmatter: valid, missing, and malformed frontmatter", () => {
  const ok = parseFrontmatter("---\nname: x\n---\nbody here");
  assert.equal(ok.frontmatter.name, "x");
  assert.equal(ok.body, "body here");

  const none = parseFrontmatter("just a body");
  assert.equal(none.frontmatter, null);
  assert.equal(none.body, "just a body");

  const unclosed = parseFrontmatter("---\nname: x\nbody");
  assert.equal(unclosed.frontmatter, null);

  const badYaml = parseFrontmatter("---\n{ not yaml ]\n---\nbody");
  assert.equal(badYaml.frontmatter, null);
  assert.equal(badYaml.body, "body");
});

test("parseSubagent + subagentToRole: read-only inference and role shape", () => {
  const parsed = parseSubagent(SUBAGENT_FIXTURE, "/home/u/.claude/agents/system-evaluator.md");
  assert.equal(parsed.name, "system-evaluator");
  assert.match(parsed.hash, /^sha256:[0-9a-f]{64}$/);

  const { roleName, roleDef } = subagentToRole(parsed);
  assert.equal(roleName, "system_evaluator");
  assert.equal(roleDef.permission, "read", "evaluator agents should infer read-only");
  assert.equal(roleDef.prompt_template, "system_evaluator");
  assert.match(roleDef.instructions, /system evaluator/);
  assert.equal(roleDef.source.kind, "claude-subagent");

  const writer = parseSubagent("---\nname: code-writer\ndescription: writes code\n---\nWrite code.", "/x/code-writer.md");
  assert.equal(subagentToRole(writer).roleDef.permission, "write");
});

test("parseSkill falls back to directory name", () => {
  const parsed = parseSkill("---\ndescription: does things\n---\ncontent", "/skills/my-skill/SKILL.md");
  assert.equal(parsed.name, "my-skill");
  assert.equal(parsed.description, "does things");
});

test("parseTomlSubset: sections, scalars, arrays, comments, garbage", () => {
  const parsed = parseTomlSubset(`
# comment
model = "gpt-5.5"
model_reasoning_effort = "xhigh"
count = 3
flag = true

[mcp_servers.symphony]
command = "node" # trailing comment
args = ["src/mcp/server.mjs", "--quiet"]

[projects."/home/u/code"]
trust_level = "trusted"

multiline_garbage = { inline = "table" }
`);
  assert.equal(parsed.model, "gpt-5.5");
  assert.equal(parsed.count, 3);
  assert.equal(parsed.flag, true);
  assert.equal(parsed.mcp_servers.symphony.command, "node");
  assert.deepEqual(parsed.mcp_servers.symphony.args, ["src/mcp/server.mjs", "--quiet"]);
  assert.equal(parsed.projects["/home/u/code"].trust_level, "trusted");
  assert.equal(parsed.multiline_garbage, undefined, "inline tables are skipped, not mangled");
  // total garbage degrades to empty object
  assert.deepEqual(parseTomlSubset("◊◊ not toml at all ◊◊"), {});
});

// ── import planning ──────────────────────────────────────────────────────────

test("planImport: subagent becomes role + standalone mode + transitions", () => {
  const parsed = parseSubagent(SUBAGENT_FIXTURE, "/home/u/.claude/agents/system-evaluator.md");
  const plan = planImport({ workflow: DEFAULT_WORKFLOW, subagents: [parsed] });

  const role = plan.workflowPatch.roles.system_evaluator;
  assert.ok(role, "role created");
  assert.equal(role.permission, "read");
  assert.deepEqual(plan.workflowPatch.transitions.system_evaluator, {
    done: "$complete",
    question: "$ask_user",
    error: "$halt",
  });
  assert.deepEqual(plan.workflowPatch.modes.system_evaluator, {
    initial: "system_evaluator",
    terminal_after: ["system_evaluator"],
  });
  // existing roles untouched
  assert.deepEqual(plan.workflowPatch.roles.planner, DEFAULT_WORKFLOW.roles.planner);

  const entry = plan.manifestEntries.find((e) => e.id === "claude-subagent:system-evaluator");
  assert.ok(entry);
  assert.equal(entry.mode, "reference");
  assert.match(entry.attribution.credit, /imported from/);
});

test("planImport: --attach adds instruction_paths; --wire splices transitions", () => {
  const plan = planImport({
    workflow: DEFAULT_WORKFLOW,
    attachments: [{ role: "planner", docPath: "/home/u/.agents/skills/maestro/SKILL.md" }],
    wires: [{ from: "reviewer", event: "revise", dest: "executor" }],
  });
  assert.deepEqual(plan.workflowPatch.roles.planner.instruction_paths, ["/home/u/.agents/skills/maestro/SKILL.md"]);
  assert.equal(plan.workflowPatch.transitions.reviewer.revise, "executor");
  // attach to unknown role warns instead of failing
  const bad = planImport({
    workflow: DEFAULT_WORKFLOW,
    attachments: [{ role: "ghost", docPath: "/x.md" }],
  });
  assert.ok(bad.warnings.some((w) => w.includes("ghost")));
});

test("parseWireSpec / parseAttachSpec validate input shape", () => {
  assert.deepEqual(parseWireSpec("reviewer:revise=executor"), { from: "reviewer", event: "revise", dest: "executor" });
  assert.deepEqual(parseWireSpec("checker:retry=$halt"), { from: "checker", event: "retry", dest: "$halt" });
  assert.throws(() => parseWireSpec("nonsense"), /invalid_wire_spec/);
  assert.equal(parseAttachSpec("planner=/a/b.md").role, "planner");
  assert.throws(() => parseAttachSpec("=x"), /invalid_attach_spec/);
});

test("runImport: applies plan, writes manifest + .gitignore, validates first", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    const store = new LocalTaskStore({ root: stateDir });
    const parsed = parseSubagent(SUBAGENT_FIXTURE, "/home/u/.claude/agents/system-evaluator.md");
    const plan = planImport({ workflow: DEFAULT_WORKFLOW, subagents: [parsed] });

    const { manifest, validation } = await runImport({ stateDir, store, plan });
    assert.equal(validation.ok, true);
    assert.equal(manifest.sources.length, 1);
    assert.ok(manifest.credits[0].includes("system-evaluator"));

    const workflow = await store.readWorkflow();
    assert.ok(workflow.roles.system_evaluator);

    const gitignore = await readFile(path.join(stateDir, ".gitignore"), "utf8");
    for (const expected of ["config.local.json", "secrets.local.json", "imported/"]) {
      assert.ok(gitignore.includes(expected), `gitignore should include ${expected}`);
    }

    // re-import is idempotent in the manifest (upsert by id)
    const again = await runImport({ stateDir, store, plan });
    assert.equal(again.manifest.sources.length, 1);
  });
});

test("runImport: refuses a plan that fails validation", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    const store = new LocalTaskStore({ root: stateDir });
    const plan = planImport({
      workflow: DEFAULT_WORKFLOW,
      wires: [{ from: "reviewer", event: "revise", dest: "no_such_role" }],
    });
    await assert.rejects(() => runImport({ stateDir, store, plan }), /import_validation_failed/);
    // nothing written
    await assert.rejects(() => readFile(path.join(stateDir, "import-manifest.json"), "utf8"));
  });
});

// ── export / round-trip parity (acceptance gate) ──────────────────────────────

test("export round-trip: import → export → import → export produces identical bundles", async () => {
  await withTempDir(async (dir) => {
    // tmpdir A: seed via the import framework
    const stateA = path.join(dir, "a", ".maestro");
    const storeA = new LocalTaskStore({ root: stateA });
    await storeA.writeConfig({}); // materialize config.json
    const docPath = path.join(dir, "skill.md");
    await writeFile(docPath, "---\nname: demo-skill\n---\nAlways verify outputs.");
    const subagent = parseSubagent(SUBAGENT_FIXTURE, path.join(dir, "system-evaluator.md"));
    const plan = planImport({
      workflow: DEFAULT_WORKFLOW,
      subagents: [subagent],
      attachments: [{ role: "planner", docPath }],
      wires: [{ from: "reviewer", event: "revise", dest: "executor" }],
    });
    await runImport({ stateDir: stateA, store: storeA, plan });

    // local-only files that must NEVER reach a bundle
    await storeA.writeLocalConfig({ providers: { claude: { default_alias: "secret-alias" } } });
    await writeLocalSecrets(stateA, { SUPER_SECRET_KEY: "must-not-leak" });

    const bundleA = await buildBundle({ stateDir: stateA, name: "demo" });
    const serializedA = JSON.stringify(bundleA);
    assert.ok(!serializedA.includes("secret-alias"), "config.local.json values must not leak into bundles");
    assert.ok(!serializedA.includes("must-not-leak"), "secrets must not leak into bundles");
    assert.ok(bundleA.manifest.credits.some((c) => c.includes("system-evaluator")), "credits travel with the bundle");

    // write both forms; read both back
    const dirForm = await writeBundleDir(bundleA, path.join(dir, "bundle-dir"));
    const fileForm = await writeBundleFile(bundleA, path.join(dir, "bundle"));
    const fromDir = await readBundle(dirForm);
    const fromFile = await readBundle(fileForm);
    assert.deepEqual(canonicalizeBundle(fromDir), canonicalizeBundle(fromFile));

    // tmpdir B: import the bundle, re-export, compare canonicalized
    const stateB = path.join(dir, "b", ".maestro");
    const storeB = new LocalTaskStore({ root: stateB });
    await importBundle({ bundle: fromDir, stateDir: stateB, store: storeB });
    const workflowB = await storeB.readWorkflow();
    assert.ok(workflowB.roles.system_evaluator, "imported role survives the round trip");
    assert.equal(workflowB.transitions.reviewer.revise, "executor", "wiring survives");
    assert.ok(
      workflowB.roles.planner.instruction_paths[0].includes("prompts"),
      "instruction paths point at materialized bundle copies",
    );

    const bundleB = await buildBundle({ stateDir: stateB, name: "demo" });
    assert.deepEqual(
      canonicalizeBundle(bundleB).files["workflow.json"]
        .replaceAll(/"prompts\/\d+-/g, '"prompts/N-'),
      canonicalizeBundle(bundleA).files["workflow.json"]
        .replaceAll(/"prompts\/\d+-/g, '"prompts/N-'),
      "workflow round-trips identically (modulo prompt file numbering)",
    );
    assert.deepEqual(
      canonicalizeBundle(bundleB).files["providers.json"],
      canonicalizeBundle(bundleA).files["providers.json"],
      "providers round-trip identically",
    );
  });
});

test("readBundle rejects tampered bundles (hash mismatch)", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    const store = new LocalTaskStore({ root: stateDir });
    await store.writeWorkflow({});
    const bundle = await buildBundle({ stateDir, name: "t" });
    const outDir = await writeBundleDir(bundle, path.join(dir, "out"));
    await writeFile(path.join(outDir, "workflow.json"), "{\"tampered\":true}");
    await assert.rejects(() => readBundle(outDir), /bundle_hash_mismatch/);
  });
});

// ── evaluator-finding regressions ─────────────────────────────────────────────

test("importBundle never persists local overlay values into config.json", async () => {
  await withTempDir(async (dir) => {
    // source bundle
    const stateA = path.join(dir, "a", ".maestro");
    const storeA = new LocalTaskStore({ root: stateA });
    await storeA.writeConfig({});
    await storeA.writeWorkflow({});
    const bundle = await buildBundle({ stateDir: stateA, name: "t" });

    // target with a local-only alias
    const stateB = path.join(dir, "b", ".maestro");
    const storeB = new LocalTaskStore({ root: stateB });
    await storeB.writeConfig({});
    await storeB.writeLocalConfig({ providers: { claude: { default_alias: "secret-alias" } } });

    await importBundle({ bundle, stateDir: stateB, store: storeB });

    const raw = await readFile(path.join(stateB, "config.json"), "utf8");
    assert.ok(!raw.includes("secret-alias"), "local alias must not be persisted by bundle import");
    const nextBundle = await buildBundle({ stateDir: stateB, name: "t" });
    assert.ok(!JSON.stringify(nextBundle).includes("secret-alias"), "local alias must not reach the next export");
    // effective view still overlaid
    const config = await storeB.readConfig();
    assert.equal(config.providers.claude.default_alias, "secret-alias");
  });
});

test("resolveProviderEnv drops execution-subverting keys (denylist)", () => {
  const resolved = resolveProviderEnv(
    { env: { PATH: "/evil", LD_PRELOAD: "/x.so", NODE_OPTIONS: "--inspect", GIT_SSH_COMMAND: "evil", OPENAI_API_KEY: "$K", "BAD KEY": "x" } },
    { K: "v" },
  );
  assert.deepEqual(resolved, { OPENAI_API_KEY: "v" });
});

test("ensureStateGitignore appends cleanly to files without trailing newline", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    const store = new LocalTaskStore({ root: stateDir });
    await store.init();
    await writeFile(path.join(stateDir, ".gitignore"), "existing-entry"); // no newline
    const parsed = parseSubagent(SUBAGENT_FIXTURE, "/x/system-evaluator.md");
    const plan = planImport({ workflow: DEFAULT_WORKFLOW, subagents: [parsed] });
    await runImport({ stateDir, store, plan });
    const lines = (await readFile(path.join(stateDir, ".gitignore"), "utf8")).split("\n").filter(Boolean);
    assert.deepEqual(lines, ["existing-entry", "config.local.json", "secrets.local.json", "imported/"]);
  });
});

test("runImportWizard: wires-only invocation does not trigger the default bulk scan", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    const store = new LocalTaskStore({ root: stateDir });
    let output = "";
    const stdout = { write: (s) => { output += s; } };
    await runImportWizard({
      stateDir,
      store,
      args: ["--wire", "reviewer:revise=executor", "--dry-run"],
      stdout,
      stderr: stdout,
    });
    assert.ok(!output.includes("no sources given"), "wires-only must not scan default locations");
  });
});

// ── OCR-finding regressions ───────────────────────────────────────────────────

test("readBundle rejects path traversal, unlisted files, and wrong versions", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    const store = new LocalTaskStore({ root: stateDir });
    await store.writeWorkflow({});
    const bundle = await buildBundle({ stateDir, name: "t" });

    // zip-slip: traversal rel path in single-file form
    const evil = structuredClone({ manifest: bundle.manifest, files: bundle.files });
    evil.files["../escape.txt"] = "pwn";
    evil.manifest.files["../escape.txt"] = { sha256: "0".repeat(64) };
    const evilPath = path.join(dir, "evil.maestro-bundle.json");
    await writeFile(evilPath, JSON.stringify(evil));
    await assert.rejects(() => readBundle(evilPath), /unsafe_bundle_path/);

    // unlisted file (hash-bypass attempt: drop the manifest entry)
    const unlisted = structuredClone({ manifest: bundle.manifest, files: bundle.files });
    unlisted.files["extra.txt"] = "sneaky";
    const unlistedPath = path.join(dir, "unlisted.maestro-bundle.json");
    await writeFile(unlistedPath, JSON.stringify(unlisted));
    await assert.rejects(() => readBundle(unlistedPath), /bundle_file_unlisted/);

    // future version
    const future = structuredClone({ manifest: bundle.manifest, files: bundle.files });
    future.manifest.bundle_version = 99;
    const futurePath = path.join(dir, "future.maestro-bundle.json");
    await writeFile(futurePath, JSON.stringify(future));
    await assert.rejects(() => readBundle(futurePath), /unsupported_bundle_version/);
  });
});

test("importBundle drops non-bundled instruction_paths (no local-file laundering)", async () => {
  await withTempDir(async (dir) => {
    const stateA = path.join(dir, "a", ".maestro");
    const storeA = new LocalTaskStore({ root: stateA });
    const workflow = structuredClone(DEFAULT_WORKFLOW);
    workflow.roles.planner.instruction_paths = ["/etc/passwd", "prompts/1-ok.md"];
    await storeA.writeWorkflow(workflow);
    const bundle = {
      manifest: { bundle_version: 1, name: "evil", credits: [], sources: [], files: {} },
      files: {
        "workflow.json": JSON.stringify(workflow),
        "prompts/1-ok.md": "legit doc",
      },
    };
    const stateB = path.join(dir, "b", ".maestro");
    const storeB = new LocalTaskStore({ root: stateB });
    const result = await importBundle({ bundle, stateDir: stateB, store: storeB });
    const paths = result.workflow.roles.planner.instruction_paths;
    assert.equal(paths.length, 1);
    assert.ok(paths[0].includes("prompts"), "only the bundled doc survives");
    assert.ok(!paths.some((p) => p.includes("passwd")), "arbitrary local paths dropped");
  });
});

test("writeLocalConfig refuses to clobber a malformed config.local.json", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    const store = new LocalTaskStore({ root: stateDir });
    await store.init();
    await writeFile(path.join(stateDir, "config.local.json"), "{ not json");
    await assert.rejects(() => store.writeLocalConfig({ timeout_ms: 1 }), /config_local_malformed/);
    // still readable leniently
    assert.deepEqual(await store.readLocalConfig(), {});
  });
});

test("readLocalSecrets throws loudly on malformed file instead of returning {}", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    await writeLocalSecrets(stateDir, { A_KEY: "v" });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(secretsPath(stateDir), "{ broken");
    await assert.rejects(() => readLocalSecrets(stateDir), /secrets_local_malformed/);
  });
});

test("loadLocalSecrets respects explicit empty-string env overrides", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    await writeLocalSecrets(stateDir, { A_KEY: "stored" });
    const env = { A_KEY: "" };
    const applied = await loadLocalSecrets(stateDir, env);
    assert.deepEqual(applied, []);
    assert.equal(env.A_KEY, "", "explicit empty string wins over stored secret");
  });
});

test("parseTomlSubset is immune to prototype pollution", () => {
  parseTomlSubset('[__proto__]\npolluted = "yes"\n__proto__ = "no"\n[constructor.prototype]\nx = 1');
  assert.equal({}.polluted, undefined);
  assert.equal({}.x, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("parseFrontmatter requires a bare --- opening line", () => {
  const sneaky = parseFrontmatter("---title: x\nbody line");
  assert.equal(sneaky.frontmatter, null);
  assert.ok(sneaky.body.includes("---title: x"), "first line kept as body, not dropped");
});

test("slugifyRoleName never ends with an underscore after truncation", () => {
  const name = `${"a".repeat(47)}-b`; // char 48 becomes "_" after slug
  assert.ok(!slugifyRoleName(name).endsWith("_"));
  assert.equal(slugifyRoleName("system-evaluator"), "system_evaluator");
});

test("readManifest throws loudly on malformed manifest", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".maestro");
    const store = new LocalTaskStore({ root: stateDir });
    await store.init();
    await writeFile(path.join(stateDir, "import-manifest.json"), "{ nope");
    const parsed = parseSubagent(SUBAGENT_FIXTURE, "/x/system-evaluator.md");
    const plan = planImport({ workflow: DEFAULT_WORKFLOW, subagents: [parsed] });
    await assert.rejects(() => runImport({ stateDir, store, plan }), /import_manifest_malformed/);
  });
});
