import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { TerminalAgentRunner, buildAgentCommand } from "../src/agent-runner.mjs";
import { buildOllamaCommand } from "../src/adapters/ollama.mjs";

const DEFAULT_OLLAMA_MODEL = "llama3.2";
import { resolveAdapter } from "../src/adapters/registry.mjs";
import { DEFAULT_PROVIDERS } from "../src/task-store.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const STUB_OLLAMA = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" != "run" ]; then
  echo "expected run subcommand, got: \${1:-}" >&2
  exit 2
fi
model="\${2:-}"
prompt="$(cat)"
echo "stub-model=\${model}"
echo "stub-prompt-bytes=\${#prompt}"
if printf '%s' "\${prompt}" | grep -q "Read the image below"; then
  echo "MAESTRO LOCAL LLM RECEIPT #042"
  echo "TOTAL: 13.37"
fi
if printf '%s' "\${prompt}" | grep -q "system evaluator agent"; then
  echo "Disk and memory look adequate for small models."
  echo "READY WITH WARNINGS"
fi
echo "STUB_OK"
`;

async function makeStubOllama(dir) {
  const stubPath = path.join(dir, "ollama");
  await writeFile(stubPath, STUB_OLLAMA);
  await chmod(stubPath, 0o755);
  return stubPath;
}

test("ollama adapter builds a minimal run command with the prompt on stdin", () => {
  const spec = buildOllamaCommand({ prompt: "Summarize the repo", cwd: "/repo" });
  assert.equal(spec.command, "ollama");
  assert.deepEqual(spec.args, ["run", DEFAULT_OLLAMA_MODEL]);
  assert.equal(spec.cwd, "/repo");
  assert.equal(spec.stdin, "Summarize the repo");
  assert.equal(spec.args.includes("Summarize the repo"), false);

  const custom = buildOllamaCommand({
    prompt: "p",
    cwd: "/repo",
    alias: "/opt/ollama/bin/ollama",
    model: "qwen3",
  });
  assert.equal(custom.command, "/opt/ollama/bin/ollama");
  assert.deepEqual(custom.args, ["run", "qwen3"]);
});

test("ollama is wired into the registry, defaults, and legacy provider path", () => {
  assert.equal(DEFAULT_PROVIDERS.ollama.adapter, "built-in:ollama");
  assert.equal(DEFAULT_PROVIDERS.ollama.default_alias, "ollama");

  const adapterFn = resolveAdapter(DEFAULT_PROVIDERS.ollama);
  const viaRegistry = adapterFn({ prompt: "hi", cwd: "/repo", alias: "ollama", model: "llama3.2-vision" });
  assert.deepEqual(viaRegistry.args, ["run", "llama3.2-vision"]);
  assert.equal(viaRegistry.stdin, "hi");

  const legacy = buildAgentCommand({
    provider: "ollama",
    prompt: "legacy prompt",
    cwd: "/repo",
    role: "executor",
    options: { model: "qwen3", ollamaCommand: "my-ollama" },
  });
  assert.equal(legacy.command, "my-ollama");
  assert.deepEqual(legacy.args, ["run", "qwen3"]);
  assert.equal(legacy.stdin, "legacy prompt");
});

test("TerminalAgentRunner dispatches an ollama provider def end to end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-ollama-"));
  try {
    const stubPath = await makeStubOllama(dir);
    const runner = new TerminalAgentRunner({ timeoutMs: 30_000 });
    const result = await runner.runStep({
      provider: "ollama",
      role: "executor",
      prompt: "Explain this diff",
      cwd: dir,
      logDir: path.join(dir, "logs"),
      options: { model: "llama3.2" },
      providerDef: { adapter: "built-in:ollama", default_alias: stubPath },
    });
    assert.equal(result.status, "succeeded");
    assert.match(result.stdout, /stub-model=llama3\.2/);
    assert.match(result.stdout, /stub-prompt-bytes=17/);
    assert.match(result.stdout, /STUB_OK/);

    const commandRecord = JSON.parse(await readFile(path.join(dir, "logs", "executor.command.json"), "utf8"));
    assert.equal(commandRecord.command, stubPath);
    assert.deepEqual(commandRecord.args, ["run", "llama3.2"]);
    assert.equal(commandRecord.stdin_bytes, 17);
    assert.match(await readFile(result.stdoutPath, "utf8"), /STUB_OK/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("local-agents script runs the OCR and system evaluator agents", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "maestro-local-agents-"));
  try {
    const stubPath = await makeStubOllama(dir);
    const imagePath = path.join(dir, "receipt.png");
    // Minimal PNG header — the stub never decodes it; the script only checks existence.
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    const env = {
      ...process.env,
      MAESTRO_OLLAMA_BIN: stubPath,
      MAESTRO_OLLAMA_MODEL: "llama3.2",
      MAESTRO_OLLAMA_VISION_MODEL: "llama3.2-vision",
    };
    const script = path.join(repoRoot, "scripts", "local-agents.mjs");

    const ocr = await execFileAsync(process.execPath, [script, "ocr", imagePath], { cwd: dir, env });
    assert.match(ocr.stdout, /stub-model=llama3\.2-vision/);
    assert.match(ocr.stdout, /RECEIPT #042/);
    assert.match(ocr.stderr, /logs: /);

    const evaluation = await execFileAsync(process.execPath, [script, "eval"], { cwd: dir, env });
    assert.match(evaluation.stdout, /stub-model=llama3\.2/);
    assert.match(evaluation.stdout, /READY WITH WARNINGS/);

    const missingImage = await execFileAsync(process.execPath, [script, "ocr", path.join(dir, "nope.png")], { cwd: dir, env })
      .then(() => null, (error) => error);
    assert.equal(missingImage.code, 1);
    assert.match(missingImage.stderr, /Image not found/);

    const missingBinary = await execFileAsync(process.execPath, [script, "eval"], {
      cwd: dir,
      env: { ...env, MAESTRO_OLLAMA_BIN: path.join(dir, "no-such-ollama") },
    }).then(() => null, (error) => error);
    assert.equal(missingBinary.code, 1);
    assert.match(missingBinary.stderr, /Install Ollama/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
