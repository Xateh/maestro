// `maestro setup local` — detect installed agent runtimes and record
// machine-specific values (aliases, discovered models) in config.local.json,
// never in the shareable config.json.

import readline from "node:readline";

import { writeJsonAtomic } from "../task-store.mjs";
import { detectLocalAgents } from "./scanners/local-agents.mjs";

// For each workflow role whose primary provider is NOT installed and has no
// already-installed fallback, propose the installed providers as candidates.
export function planRoleFallbacks(workflow, results) {
  const found = new Set(results.filter((r) => r.found).map((r) => r.provider));
  const plans = [];
  for (const [role, def] of Object.entries(workflow?.roles ?? {})) {
    if (!def?.provider || found.has(def.provider)) continue;
    if ((def.fallback ?? []).some((key) => found.has(key))) continue; // already covered
    const candidates = [...found].filter((key) => key !== def.provider);
    if (candidates.length > 0) plans.push({ role, provider: def.provider, candidates });
  }
  return plans;
}

// Interactively offer a fallback provider for each role whose provider is
// missing, writing the choice into workflow.json roles.<role>.fallback.
export async function runFallbackSetup({ store, results, stdin = process.stdin, stdout = process.stdout, ask = null }) {
  const workflow = await store.readWorkflow();
  const plans = planRoleFallbacks(workflow, results);
  if (plans.length === 0) return { written: false, plans };
  const askFn = ask ?? (stdin.isTTY === true
    ? async (q) => {
      const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
      const answer = await new Promise((resolve) => rl.question(q, resolve));
      rl.close();
      return answer;
    }
    : null);
  if (!askFn) return { written: false, plans };

  let changed = false;
  for (const plan of plans) {
    const list = plan.candidates.map((c, i) => `${i + 1}) ${c}`).join("  ");
    const answer = String(await askFn(
      `\nRole "${plan.role}" uses "${plan.provider}" which isn't installed.\n  ${list}\n  Pick a fallback [1-${plan.candidates.length}, or Enter to skip]: `,
    )).trim();
    const pick = Number.parseInt(answer, 10);
    if (!Number.isInteger(pick) || pick < 1 || pick > plan.candidates.length) continue;
    const chosen = plan.candidates[pick - 1];
    const role = workflow.roles[plan.role];
    role.fallback = [...new Set([...(role.fallback ?? []), chosen])];
    changed = true;
    stdout.write(`  ${plan.role} → fallback ${chosen}\n`);
  }
  if (changed) {
    await writeJsonAtomic(store.workflowPath, workflow);
    stdout.write(`updated ${store.workflowPath} with role fallbacks\n`);
  }
  return { written: changed, plans };
}

export function formatDetection(results) {
  const lines = ["Detected agent runtimes:"];
  for (const entry of results) {
    const status = entry.found ? "found" : "not installed";
    const models = entry.models.length > 0 ? ` models: ${entry.models.join(", ")}` : "";
    const notes = entry.notes.length > 0 ? ` (${entry.notes.join("; ")})` : "";
    lines.push(`  ${entry.provider.padEnd(12)} ${status}${models}${notes}`);
  }
  return lines.join("\n");
}

// Build the config.local.json patch for confirmed providers.
export function buildLocalProviderPatch(results, { selected = null } = {}) {
  const providers = {};
  for (const entry of results) {
    if (!entry.found) continue;
    if (selected && !selected.includes(entry.provider)) continue;
    const patch = {};
    if (entry.models.length > 0) patch.models = entry.models;
    if (entry.alias && entry.alias !== entry.provider) patch.default_alias = entry.alias;
    if (Object.keys(patch).length > 0) providers[entry.provider] = patch;
  }
  return Object.keys(providers).length > 0 ? { providers } : {};
}

export async function runLocalSetup({
  store,
  args = [],
  stdin = process.stdin,
  stdout = process.stdout,
  detect = detectLocalAgents,
}) {
  const results = await detect();
  if (args.includes("--json")) {
    stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    stdout.write(`${formatDetection(results)}\n`);
  }

  const patch = buildLocalProviderPatch(results);
  if (Object.keys(patch).length === 0) {
    stdout.write("nothing new to record in config.local.json\n");
    return { results, written: false };
  }

  if (!args.includes("--yes")) {
    if (stdin.isTTY !== true) {
      stdout.write("non-interactive session — re-run with --yes to write (nothing written)\n");
      return { results, written: false };
    }
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    const answer = await new Promise((resolve) => {
      rl.question(
        `\nWrite discovered values to ${store.localConfigPath}?\n${JSON.stringify(patch, null, 2)}\n[y/N]: `,
        resolve,
      );
    });
    rl.close();
    if (!/^y(es)?$/i.test(String(answer).trim())) {
      stdout.write("skipped — nothing written\n");
      return { results, written: false };
    }
  }

  await store.writeLocalConfig(patch);
  stdout.write(`wrote ${store.localConfigPath} (machine-local; excluded from export bundles)\n`);
  return { results, written: true, patch };
}
