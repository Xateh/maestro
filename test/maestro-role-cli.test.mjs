import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runLocalMaestroCommand } from "../src/cli/local-command.mjs";
import { subagentToNativeUnit } from "../src/setup/role-convert.mjs";
import { parseSubagent } from "../src/setup/scanners/claude.mjs";

function capture() {
  const lines = [];
  return { stream: { write: (s) => lines.push(s) }, text: () => lines.join("") };
}

async function scaffold() {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-rolecli-"));
  const stateDir = path.join(dir, ".maestro");
  await mkdir(path.join(stateDir, "roles"), { recursive: true });
  await mkdir(path.join(dir, ".claude", "agents"), { recursive: true });
  await writeFile(path.join(stateDir, "roles", "triage.md"), `---
name: triage
description: Classifier
provider: claude
permission: read
tools: [Read, Grep]
output_schema: classification
---

Body.
`);
  await writeFile(path.join(dir, ".claude", "agents", "reviewer.md"), `---
name: reviewer
description: Reviews diffs
tools: Read, Grep
---

You review.
`);
  return { dir, stateDir };
}

test("role list enumerates units across .maestro/roles and .claude/agents", async () => {
  const { dir, stateDir } = await scaffold();
  try {
    const out = capture();
    const result = await runLocalMaestroCommand({
      args: ["role", "list", "--json", "--state-dir", stateDir],
      cwd: dir,
      stdout: out.stream,
      stderr: { write: () => {} },
    });
    const roles = result.roles ?? JSON.parse(out.text());
    const names = roles.map((r) => r.name);
    assert.ok(names.includes("triage"));
    assert.ok(names.includes("reviewer"));
    const triage = roles.find((r) => r.name === "triage");
    assert.equal(triage.kind, "native");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("role show prints the normalized RoleDef", async () => {
  const { dir, stateDir } = await scaffold();
  try {
    const out = capture();
    await runLocalMaestroCommand({
      args: ["role", "show", path.join(stateDir, "roles", "triage.md"), "--state-dir", stateDir],
      cwd: dir,
      stdout: out.stream,
      stderr: { write: () => {} },
    });
    const def = JSON.parse(out.text());
    assert.equal(def.provider, "claude");
    assert.deepEqual(def.tools, ["Read", "Grep"]);
    assert.equal(def.output_schema, "classification");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("role lint clean → exit 0; bad token → non-zero", async () => {
  const { dir, stateDir } = await scaffold();
  try {
    process.exitCode = 0;
    await runLocalMaestroCommand({
      args: ["role", "lint", path.join(stateDir, "roles", "triage.md"), "--state-dir", stateDir],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    assert.notEqual(process.exitCode, 1);

    await writeFile(path.join(stateDir, "roles", "bad.md"), `---
name: bad
provider: claude
tools: ["rm -rf"]
---

Body.
`);
    await runLocalMaestroCommand({
      args: ["role", "lint", path.join(stateDir, "roles", "bad.md"), "--state-dir", stateDir],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("import-agent converts a subagent to a native unit + manifest entry", async () => {
  const { dir, stateDir } = await scaffold();
  try {
    await runLocalMaestroCommand({
      args: ["import-agent", path.join(dir, ".claude", "agents", "reviewer.md"), "--state-dir", stateDir],
      cwd: dir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    const written = await readFile(path.join(stateDir, "roles", "reviewer.md"), "utf8");
    assert.match(written, /name: reviewer/);
    assert.match(written, /permission:/);
    const manifest = JSON.parse(await readFile(path.join(stateDir, "import-manifest.json"), "utf8"));
    assert.ok(JSON.stringify(manifest).includes("reviewer"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subagentToNativeUnit produces MRC superset markdown", () => {
  const parsed = parseSubagent(`---
name: reviewer
description: Reviews diffs
tools: Read, Grep, Bash(npm:*)
model: opus
---

You review.
`, "/x/.claude/agents/reviewer.md");
  const md = subagentToNativeUnit(parsed);
  assert.match(md, /^---/);
  assert.match(md, /name: reviewer/);
  assert.match(md, /provider: claude/);
  assert.match(md, /permission: read/);
  assert.match(md, /tools:/);
  assert.match(md, /You review\./);
});
