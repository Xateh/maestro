// `maestro init` — scaffold a .maestro/ state directory with the default
// config and workflow, then optionally chain the setup wizards. Idempotent:
// existing files are never overwritten.

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import {
  DEFAULT_LOCAL_CONFIG_V2,
  DEFAULT_WORKFLOW,
  LocalTaskStore,
  writeJsonAtomic,
} from "../task-store.mjs";
import { ensureStateGitignore } from "./import.mjs";
import { runKeysWizard } from "./keys.mjs";
import { runLocalSetup } from "./local.mjs";

const SCAFFOLD_DIRS = ["tasks", "runs", "projects", "patches", "logs"];

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function buildInitPlan(stateDir) {
  const files = [
    { name: "config.json", path: path.join(stateDir, "config.json") },
    { name: "workflow.json", path: path.join(stateDir, "workflow.json") },
  ];
  for (const file of files) {
    file.exists = await fileExists(file.path);
  }
  return {
    stateDir,
    dirs: SCAFFOLD_DIRS.map((name) => path.join(stateDir, name)),
    files,
  };
}

function defaultAsk(stdin, stdout) {
  if (stdin.isTTY !== true) return null;
  return async (question) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    rl.close();
    return answer;
  };
}

function isYes(answer) {
  return /^y(es)?$/i.test(String(answer ?? "").trim());
}

export async function runInitWizard({
  stateDir,
  cwd = process.cwd(),
  args = [],
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  ask = null,
  store = null,
  detect = undefined,
} = {}) {
  const root = path.resolve(stateDir ?? path.join(cwd, ".maestro"));
  const yes = args.includes("--yes");
  const dryRun = args.includes("--dry-run");
  const plan = await buildInitPlan(root);

  stdout.write(`Initializing Maestro state in ${root}\n`);
  if (dryRun) {
    for (const file of plan.files) {
      stdout.write(`  ${file.exists ? "exists, skipping" : "would create"}: ${file.name}\n`);
    }
    stdout.write(`  would ensure: ${SCAFFOLD_DIRS.join("/ ")}/ and .gitignore\n`);
    stdout.write("dry run — nothing written\n");
    return { stateDir: root, dryRun: true, plan };
  }

  const created = [];
  const skipped = [];
  for (const dir of plan.dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
  for (const file of plan.files) {
    if (file.exists) {
      skipped.push(file.name);
      continue;
    }
    if (file.name === "config.json") {
      const config = structuredClone(DEFAULT_LOCAL_CONFIG_V2);
      // The module-level default freezes cwd at load time; point it at the
      // directory being initialized instead.
      config.cwd = path.dirname(root);
      await writeJsonAtomic(file.path, config);
    } else {
      await writeJsonAtomic(file.path, structuredClone(DEFAULT_WORKFLOW));
    }
    created.push(file.name);
  }
  await ensureStateGitignore(root);

  for (const name of created) stdout.write(`  created ${name}\n`);
  for (const name of skipped) stdout.write(`  exists, skipped ${name}\n`);
  stdout.write(`  ensured ${SCAFFOLD_DIRS.join("/ ")}/ and .gitignore\n`);

  const taskStore = store ?? new LocalTaskStore({ root });
  const wizards = { local: false, keys: false, import: false };
  const askFn = ask ?? (yes ? null : defaultAsk(stdin, stdout));

  if (yes) {
    const detectArgs = detect === undefined ? {} : { detect };
    await runLocalSetup({ store: taskStore, args: ["--yes"], stdin, stdout, ...detectArgs });
    wizards.local = true;
    stdout.write("skipped keys/import wizards (interactive) — run `maestro setup keys` / `maestro setup import`\n");
  } else if (askFn) {
    if (isYes(await askFn("Detect local agent runtimes (ollama/pi/hermes/openclaw)? [y/N]: "))) {
      const detectArgs = detect === undefined ? {} : { detect };
      await runLocalSetup({ store: taskStore, args: ["--yes"], stdin, stdout, ...detectArgs });
      wizards.local = true;
    }
    if (isYes(await askFn("Configure API keys now? [y/N]: "))) {
      await runKeysWizard({ stateDir: root, stdin, stdout });
      wizards.keys = true;
    }
    if (isYes(await askFn("Import existing skills/subagents/MCP configs? [y/N]: "))) {
      const { runImportWizard } = await import("./import.mjs");
      await runImportWizard({ store: taskStore, stateDir: root, args: [], stdin, stdout, stderr });
      wizards.import = true;
    }
  } else {
    stdout.write("non-interactive session — scaffold only (re-run with --yes, or run `maestro setup ...` later)\n");
  }

  stdout.write([
    "",
    "Maestro is ready. Next steps:",
    '  maestro task "<prompt>"      run a plan → execute → review task',
    "  maestro tui                  interactive terminal UI",
    "  maestro workflow validate    check the workflow definition",
    "",
  ].join("\n"));
  return { stateDir: root, dryRun: false, created, skipped, wizards };
}
