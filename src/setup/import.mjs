// Import external agent setups into the Maestro workflow ecosystem.
//
// Philosophy: wrap, don't replace. Local artifacts are referenced by path
// (mode: "reference") so users keep using their existing setup; --copy
// snapshots them under .maestro/imported/ instead. Every imported source is
// recorded in .maestro/import-manifest.json with attribution (credits).
//
// Mapping rules:
//   subagent .md      → workflow role + standalone mode (runnable via
//                       `maestro task --mode <role> "<prompt>"`)
//   SKILL.md / docs   → recorded; attach to roles as instruction_paths
//                       via --attach <role>=<path>
//   .mcp.json / hooks → recorded-only (Maestro doesn't own them) + credits
//   codex/gemini cfg  → recorded-only + model hints into config.local.json
//
// Workflow wiring from prose is NOT inferred; use --wire "state:event=dest"
// to splice imported roles into existing transitions explicitly.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { validateWorkflow, formatValidation } from "../workflow-validate.mjs";
import {
  scanSubagents,
  scanSkills,
  scanInstructionFiles,
  scanMcpJson,
  scanClaudeHooks,
  subagentToRole,
} from "./scanners/claude.mjs";
import { scanCodexConfig } from "./scanners/codex.mjs";
import { scanGeminiSettings } from "./scanners/gemini.mjs";

export const MANIFEST_FILE = "import-manifest.json";

function expandHome(filePath) {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

// ── manifest ─────────────────────────────────────────────────────────────────

export function manifestPath(stateDir) {
  return path.join(stateDir, MANIFEST_FILE);
}

export async function readManifest(stateDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath(stateDir), "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Loud, not lossy: a fresh manifest here would be written back over
      // the user's (merely malformed) credits/sources on the next import.
      throw new Error(`import_manifest_malformed: fix or remove ${manifestPath(stateDir)} (${error.message})`);
    }
    if (error.code !== "ENOENT") throw error;
  }
  return { version: 1, created_at: null, updated_at: null, sources: [], credits: [] };
}

export function upsertManifest(manifest, entries, { now = () => new Date() } = {}) {
  const byId = new Map(manifest.sources.map((s) => [s.id, s]));
  for (const entry of entries) byId.set(entry.id, entry);
  const sources = [...byId.values()];
  const credits = [...new Set(sources.map((s) => s.attribution?.credit).filter(Boolean))];
  return {
    ...manifest,
    version: 1,
    created_at: manifest.created_at ?? now().toISOString(),
    updated_at: now().toISOString(),
    sources,
    credits,
  };
}

// ── plan (pure) ──────────────────────────────────────────────────────────────

function makeEntry({ id, kind, sourcePath, name, hash = null, mode = "reference", importedAs, credit }) {
  return {
    id,
    kind,
    path: sourcePath,
    name,
    mode,
    hash,
    imported_as: importedAs,
    attribution: { origin: sourcePath, credit },
  };
}

export function parseWireSpec(spec) {
  const match = String(spec ?? "").match(/^([a-z0-9_-]+):([a-z0-9_-]+)=([a-z0-9_$-]+)$/i);
  if (!match) throw new Error(`invalid_wire_spec: ${spec} (expected "state:event=dest")`);
  return { from: match[1], event: match[2], dest: match[3] };
}

export function parseAttachSpec(spec) {
  const eq = String(spec ?? "").indexOf("=");
  if (eq <= 0) throw new Error(`invalid_attach_spec: ${spec} (expected "role=path")`);
  return { role: spec.slice(0, eq), docPath: path.resolve(expandHome(spec.slice(eq + 1))) };
}

/**
 * Build an import plan. Pure: takes scanned sources + the current workflow,
 * returns patches without touching the filesystem.
 */
export function planImport({
  workflow,
  subagents = [],
  skills = [],
  instructions = [],
  mcpConfigs = [],
  hooks = [],
  codexConfig = null,
  geminiConfig = null,
  wires = [],
  attachments = [],
  copyMode = false,
  now = () => new Date(),
}) {
  const warnings = [];
  const manifestEntries = [];
  const roles = structuredClone(workflow.roles ?? {});
  const transitions = structuredClone(workflow.transitions ?? {});
  const modes = structuredClone(workflow.modes ?? {});
  const configLocalPatch = {};
  const sourceMode = copyMode ? "copy" : "reference";

  // subagents → roles + standalone modes
  for (const parsed of subagents) {
    const { roleName, roleDef } = subagentToRole(parsed, { now });
    if (workflow.roles?.[roleName]) {
      warnings.push(`role "${roleName}" already exists — overwriting its definition (transitions preserved)`);
    }
    roles[roleName] = roleDef;
    transitions[roleName] = transitions[roleName] ?? {
      done: "$complete",
      question: "$ask_user",
      error: "$halt",
    };
    modes[roleName] = modes[roleName] ?? { initial: roleName, terminal_after: [roleName] };
    manifestEntries.push(makeEntry({
      id: `claude-subagent:${parsed.name}`,
      kind: "claude-subagent",
      sourcePath: parsed.path,
      name: parsed.name,
      hash: parsed.hash,
      mode: sourceMode,
      importedAs: { type: "role", ref: roleName },
      credit: `${parsed.name} — imported from ${parsed.path} (Claude Code subagent)`,
    }));
  }

  // skills / instruction docs → recorded; attachments add instruction_paths
  for (const skill of skills) {
    manifestEntries.push(makeEntry({
      id: `claude-skill:${skill.name}`,
      kind: "claude-skill",
      sourcePath: skill.path,
      name: skill.name,
      hash: skill.hash,
      mode: sourceMode,
      importedAs: { type: "recorded_only", ref: null },
      credit: `${skill.name} — imported from ${skill.path} (agent skill)`,
    }));
  }
  for (const doc of instructions) {
    manifestEntries.push(makeEntry({
      id: `instructions:${doc.path}`,
      kind: "instructions",
      sourcePath: doc.path,
      name: path.basename(doc.path),
      hash: doc.hash,
      mode: sourceMode,
      importedAs: { type: "recorded_only", ref: null },
      credit: `${path.basename(doc.path)} — imported from ${doc.path} (instruction file)`,
    }));
  }

  for (const { role, docPath } of attachments) {
    if (!roles[role]) {
      warnings.push(`--attach ${role}=${docPath}: role "${role}" does not exist — skipped`);
      continue;
    }
    const existing = roles[role].instruction_paths ?? [];
    if (!existing.includes(docPath)) {
      roles[role] = { ...roles[role], instruction_paths: [...existing, docPath] };
    }
    const entryId = `instructions:${docPath}`;
    const entry = manifestEntries.find((e) => e.id === entryId)
      ?? manifestEntries.find((e) => e.path === docPath);
    if (entry) {
      entry.imported_as = { type: "prompt_context", ref: role };
    } else {
      manifestEntries.push(makeEntry({
        id: entryId,
        kind: "instructions",
        sourcePath: docPath,
        name: path.basename(docPath),
        mode: "reference",
        importedAs: { type: "prompt_context", ref: role },
        credit: `${path.basename(docPath)} — attached to role ${role}`,
      }));
    }
  }

  // MCP configs / hooks → recorded-only
  for (const mcp of mcpConfigs.filter(Boolean)) {
    manifestEntries.push(makeEntry({
      id: `mcp-config:${mcp.path}`,
      kind: "mcp-config",
      sourcePath: mcp.path,
      name: Object.keys(mcp.servers).join(", ") || "mcp.json",
      mode: "reference",
      importedAs: { type: "recorded_only", ref: null },
      credit: `MCP servers [${Object.keys(mcp.servers).join(", ")}] — from ${mcp.path}`,
    }));
  }
  if (hooks.length > 0) {
    manifestEntries.push(makeEntry({
      id: "hooks:claude-settings",
      kind: "hooks",
      sourcePath: hooks[0]?.settingsPath ?? null,
      name: `${hooks.length} hook(s)`,
      mode: "reference",
      importedAs: { type: "recorded_only", ref: null },
      credit: `${hooks.length} Claude Code hook(s) recorded (Maestro does not execute external hooks)`,
    }));
  }

  // codex / gemini configs → recorded-only + model hints in config.local.json
  if (codexConfig) {
    manifestEntries.push(makeEntry({
      id: `codex-config:${codexConfig.path}`,
      kind: "codex-config",
      sourcePath: codexConfig.path,
      name: codexConfig.model ?? "codex config",
      mode: "reference",
      importedAs: { type: "provider_hint", ref: "codex" },
      credit: `Codex CLI config — from ${codexConfig.path}`,
    }));
    if (codexConfig.model) {
      configLocalPatch.recent ??= { models_by_provider: {} };
      configLocalPatch.recent.models_by_provider.codex = [codexConfig.model];
    }
  }
  if (geminiConfig) {
    manifestEntries.push(makeEntry({
      id: `gemini-config:${geminiConfig.path}`,
      kind: "gemini-config",
      sourcePath: geminiConfig.path,
      name: geminiConfig.model ?? "gemini config",
      mode: "reference",
      importedAs: { type: "provider_hint", ref: "gemini" },
      credit: `Gemini CLI config — from ${geminiConfig.path}`,
    }));
    if (geminiConfig.model) {
      configLocalPatch.recent ??= { models_by_provider: {} };
      configLocalPatch.recent.models_by_provider.gemini = [geminiConfig.model];
    }
  }

  // explicit wiring
  for (const { from, event, dest } of wires) {
    if (!roles[from]) {
      warnings.push(`--wire ${from}:${event}=${dest}: state "${from}" does not exist — skipped`);
      continue;
    }
    transitions[from] = { ...(transitions[from] ?? {}), [event]: dest };
  }

  const workflowPatch = { roles, transitions, modes };
  return { workflowPatch, configLocalPatch, manifestEntries, warnings };
}

// ── apply ────────────────────────────────────────────────────────────────────

const GITIGNORE_ENTRIES = ["config.local.json", "secrets.local.json", "imported/"];

export async function ensureStateGitignore(stateDir) {
  const gitignorePath = path.join(stateDir, ".gitignore");
  let current = "";
  try {
    current = await fs.readFile(gitignorePath, "utf8");
  } catch {
    // create fresh
  }
  const lines = new Set(current.split(/\r?\n/).filter(Boolean));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return false;
  const header = current ? "" : "# machine-local files — never share or commit\n";
  const joiner = current && !current.endsWith("\n") ? "\n" : "";
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(gitignorePath, `${current}${joiner}${header}${missing.join("\n")}\n`);
  return true;
}

// Copy referenced sources into .maestro/imported/ and rewrite manifest/workflow
// paths (only when --copy).
async function copySources({ stateDir, manifestEntries, workflowPatch }) {
  const importedDir = path.join(stateDir, "imported");
  await fs.mkdir(importedDir, { recursive: true });
  const rewrites = new Map();
  for (const entry of manifestEntries) {
    if (entry.mode !== "copy" || !entry.path) continue;
    // short path hash avoids silent overwrites when two sources share a
    // parent-dir + file name (e.g. a/src/agent.md and b/src/agent.md)
    const pathTag = createHash("sha256").update(entry.path).digest("hex").slice(0, 8);
    const destination = path.join(importedDir, `${entry.kind}-${pathTag}-${path.basename(entry.path)}`);
    try {
      await fs.copyFile(entry.path, destination);
      rewrites.set(entry.path, destination);
      entry.copied_to = destination;
    } catch {
      entry.mode = "reference"; // copy failed; fall back to referencing
    }
  }
  for (const roleDef of Object.values(workflowPatch.roles ?? {})) {
    if (Array.isArray(roleDef.instruction_paths)) {
      roleDef.instruction_paths = roleDef.instruction_paths.map((p) => rewrites.get(p) ?? p);
    }
  }
}

export async function runImport({ stateDir, store, plan, config = null, now = () => new Date() }) {
  const mergedWorkflow = { ...(await store.readWorkflow()), ...plan.workflowPatch };
  const validation = validateWorkflow(mergedWorkflow, { config });
  if (!validation.ok) {
    const error = new Error(`import_validation_failed:\n${formatValidation(validation)}`);
    error.validation = validation;
    throw error;
  }

  if (plan.manifestEntries.some((e) => e.mode === "copy")) {
    await copySources({ stateDir, manifestEntries: plan.manifestEntries, workflowPatch: plan.workflowPatch });
  }

  await store.writeWorkflow(plan.workflowPatch);
  if (Object.keys(plan.configLocalPatch).length > 0) {
    await store.writeLocalConfig(plan.configLocalPatch);
  }
  const manifest = upsertManifest(await readManifest(stateDir), plan.manifestEntries, { now });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(manifestPath(stateDir), `${JSON.stringify(manifest, null, 2)}\n`);
  await ensureStateGitignore(stateDir);

  return { manifest, validation };
}

// ── CLI wizard ───────────────────────────────────────────────────────────────

function collectFlag(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== flag) continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`missing_value_for_flag: ${flag}`);
    }
    values.push(value);
  }
  return values;
}

export function formatPlanSummary(plan, { scanned }) {
  const lines = ["Import plan:"];
  const roleEntries = plan.manifestEntries.filter((e) => e.imported_as.type === "role");
  const attached = plan.manifestEntries.filter((e) => e.imported_as.type === "prompt_context");
  const recorded = plan.manifestEntries.filter((e) => ["recorded_only", "provider_hint"].includes(e.imported_as.type));
  if (roleEntries.length > 0) {
    lines.push(`  roles (+ standalone modes): ${roleEntries.map((e) => e.imported_as.ref).join(", ")}`);
  }
  for (const entry of attached) {
    lines.push(`  instruction_paths → ${entry.imported_as.ref}: ${entry.path}`);
  }
  lines.push(`  recorded only (credits in ${MANIFEST_FILE}): ${recorded.length} source(s)`);
  if (scanned.skills.length > 0) lines.push(`    skills scanned: ${scanned.skills.length}`);
  if (scanned.mcpConfigs.filter(Boolean).length > 0) {
    lines.push(`    mcp configs: ${scanned.mcpConfigs.filter(Boolean).map((m) => m.path).join(", ")}`);
  }
  if (scanned.codexConfig) lines.push(`    codex config: ${scanned.codexConfig.path}`);
  if (scanned.geminiConfig) lines.push(`    gemini config: ${scanned.geminiConfig.path}`);
  for (const warning of plan.warnings) lines.push(`  warning: ${warning}`);
  return lines.join("\n");
}

export async function runImportWizard({
  stateDir,
  store,
  args = [],
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  const agentDirs = collectFlag(args, "--agents").map((p) => path.resolve(expandHome(p)));
  const skillDirs = collectFlag(args, "--skills").map((p) => path.resolve(expandHome(p)));
  const instructionFiles = collectFlag(args, "--instructions").map((p) => path.resolve(expandHome(p)));
  const mcpFiles = collectFlag(args, "--mcp").map((p) => path.resolve(expandHome(p)));
  const codexFiles = collectFlag(args, "--codex").map((p) => path.resolve(expandHome(p)));
  const geminiFiles = collectFlag(args, "--gemini").map((p) => path.resolve(expandHome(p)));
  const hooksFiles = collectFlag(args, "--hooks").map((p) => path.resolve(expandHome(p)));
  const wires = collectFlag(args, "--wire").map(parseWireSpec);
  const attachments = collectFlag(args, "--attach").map(parseAttachSpec);
  const copyMode = args.includes("--copy");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");

  if (agentDirs.length + skillDirs.length + instructionFiles.length + mcpFiles.length
      + codexFiles.length + geminiFiles.length + hooksFiles.length + attachments.length
      + wires.length === 0) {
    // sensible defaults: well-known locations that exist on this machine
    const home = os.homedir();
    agentDirs.push(path.join(home, ".claude", "agents"));
    skillDirs.push(path.join(home, ".agents", "skills"));
    codexFiles.push(path.join(home, ".codex", "config.toml"));
    geminiFiles.push(path.join(home, ".gemini", "settings.json"));
    mcpFiles.push(path.resolve(".mcp.json"));
    stdout.write("no sources given — scanning default locations (~/.claude/agents, ~/.agents/skills, ~/.codex, ~/.gemini, ./.mcp.json)\n");
  }

  const scanned = {
    subagents: (await Promise.all(agentDirs.map(scanSubagents))).flat(),
    skills: (await Promise.all(skillDirs.map(scanSkills))).flat(),
    instructions: await scanInstructionFiles(instructionFiles),
    mcpConfigs: await Promise.all(mcpFiles.map(scanMcpJson)),
    hooks: (await Promise.all(hooksFiles.map(scanClaudeHooks))).flat(),
    codexConfig: codexFiles.length > 0 ? await scanCodexConfig(codexFiles[0]) : null,
    geminiConfig: geminiFiles.length > 0 ? await scanGeminiSettings(geminiFiles[0]) : null,
  };

  const workflow = await store.readWorkflow();
  const plan = planImport({ workflow, ...scanned, wires, attachments, copyMode });
  stdout.write(`${formatPlanSummary(plan, { scanned })}\n`);

  if (dryRun) {
    stdout.write("dry run — nothing written\n");
    return { plan, applied: false };
  }
  if (!yes) {
    if (stdin.isTTY !== true) {
      stdout.write("non-interactive session — re-run with --yes to apply (nothing written)\n");
      return { plan, applied: false };
    }
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    const answer = await new Promise((resolve) => rl.question("\napply this import? [y/N]: ", resolve));
    rl.close();
    if (!/^y(es)?$/i.test(String(answer).trim())) {
      stdout.write("aborted — nothing written\n");
      return { plan, applied: false };
    }
  }

  const config = await store.readConfig();
  const result = await runImport({ stateDir, store, plan, config });
  for (const warning of result.validation.warnings) {
    stderr.write(`workflow warning [${warning.code}]: ${warning.message}\n`);
  }
  stdout.write(`imported ${plan.manifestEntries.length} source(s); manifest: ${manifestPath(stateDir)}\n`);
  return { plan, applied: true, manifest: result.manifest };
}
