// Export a Maestro workflow as a portable bundle another instance can import.
//
// Bundle contents: workflow.json (instruction_paths rewritten to bundled
// copies under prompts/), providers from config.json, WORKFLOW.md if present,
// credits from the import manifest, and sha256 hashes for every file.
//
// Never exported: config.local.json, secrets.local.json, tasks/runs/db.
// Provider definitions get a defensive redaction pass on secret-shaped keys.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_PROVIDERS } from "../task-store.mjs";
import { validateWorkflow, formatValidation } from "../workflow-validate.mjs";
import { readManifest, upsertManifest, manifestPath } from "./import.mjs";
import { backupWorkflowFile } from "./workflow-templates.mjs";

export const BUNDLE_VERSION = 1;
const BUNDLE_FILE_SUFFIX = ".maestro-bundle.json";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function expandHome(filePath) {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

const SENSITIVE = /(_key|_token|_secret|api_key|apikey|password|passwd)$/i;

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE.test(k) && typeof v === "string" && v.length > 0 && !v.startsWith("$")
          ? "[redacted]"
          : redactSensitive(v),
      ]),
    );
  }
  return value;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Bundle-relative paths come from bundle content (potentially untrusted) and
// are used in path.join — reject anything that could escape the target dir.
function assertSafeBundleRel(rel) {
  const value = String(rel);
  if (
    path.isAbsolute(value)
    || value.split(/[\\/]/).some((segment) => segment === ".." || segment === "")
    || value.includes("\0")
  ) {
    throw new Error(`unsafe_bundle_path: ${value}`);
  }
  return value;
}

function sanitizeBundleName(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64);
  return slug || "maestro-workflow";
}

/**
 * Build the in-memory bundle from a state dir.
 * `files` maps bundle-relative paths to string contents.
 */
export async function buildBundle({ stateDir, name = null, now = () => new Date() }) {
  const workflowOnDisk = await readJsonIfExists(path.join(stateDir, "workflow.json"));
  if (!workflowOnDisk) {
    throw new Error(`nothing_to_export: no readable workflow.json in ${stateDir}`);
  }
  const workflow = structuredClone(workflowOnDisk);
  const config = await readJsonIfExists(path.join(stateDir, "config.json"));
  const manifest = await readManifest(stateDir);

  const files = {};

  // Inline every instruction_paths doc — the target machine won't have our
  // local paths. Bundle path: prompts/<n>-<basename>.
  let promptIndex = 0;
  for (const [roleName, roleDef] of Object.entries(workflow.roles ?? {})) {
    if (!Array.isArray(roleDef.instruction_paths)) continue;
    const rewritten = [];
    for (const rawPath of roleDef.instruction_paths) {
      const sourcePath = path.resolve(expandHome(String(rawPath)));
      try {
        const text = await fs.readFile(sourcePath, "utf8");
        promptIndex += 1;
        // docs materialized from a previous bundle import already carry an
        // index prefix — strip it so round trips stay stable
        const fromBundle = sourcePath.startsWith(path.resolve(stateDir, "prompts") + path.sep);
        const baseName = fromBundle
          ? path.basename(sourcePath).replace(/^\d+-/, "")
          : path.basename(sourcePath);
        const bundleRel = path.posix.join("prompts", `${promptIndex}-${baseName}`);
        files[bundleRel] = text;
        rewritten.push(bundleRel);
      } catch {
        // unreadable doc — drop from the exported workflow, note in manifest credits
        manifest.credits.push(`note: instruction doc ${sourcePath} (role ${roleName}) was unreadable at export time and is not bundled`);
      }
    }
    roleDef.instruction_paths = rewritten;
  }

  const workflowMd = await fs.readFile(path.join(stateDir, "..", "WORKFLOW.md"), "utf8").catch(() => null);
  if (workflowMd) files["WORKFLOW.md"] = workflowMd;

  files["workflow.json"] = `${JSON.stringify(workflow, null, 2)}\n`;
  // No materialized config.json → export the built-in defaults so bundles
  // are deterministic regardless of whether the source dir wrote one.
  files["providers.json"] = `${JSON.stringify(redactSensitive(config?.providers ?? DEFAULT_PROVIDERS), null, 2)}\n`;

  const bundleName = sanitizeBundleName(
    name ?? path.basename(path.dirname(path.resolve(stateDir))),
  );

  const manifestOut = {
    bundle_version: BUNDLE_VERSION,
    name: bundleName,
    created_at: now().toISOString(),
    credits: manifest.credits,
    sources: manifest.sources.map((s) => ({
      id: s.id, kind: s.kind, name: s.name, attribution: s.attribution,
    })),
    files: Object.fromEntries(
      Object.entries(files).map(([rel, text]) => [rel, { sha256: sha256(text) }]),
    ),
  };

  return { manifest: manifestOut, files };
}

export async function writeBundleDir(bundle, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`);
  for (const [rel, text] of Object.entries(bundle.files)) {
    const target = path.join(outDir, assertSafeBundleRel(rel));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
  return outDir;
}

export async function writeBundleFile(bundle, outFile) {
  const target = outFile.endsWith(BUNDLE_FILE_SUFFIX) ? outFile : `${outFile}${BUNDLE_FILE_SUFFIX}`;
  await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({ manifest: bundle.manifest, files: bundle.files }, null, 2)}\n`);
  return target;
}

export async function readBundle(bundlePath) {
  const resolved = path.resolve(bundlePath);
  const info = await fs.stat(resolved);
  let bundle;
  if (info.isDirectory()) {
    const manifest = await readJsonIfExists(path.join(resolved, "manifest.json"));
    if (!manifest?.bundle_version) throw new Error(`not_a_bundle: ${resolved} has no manifest.json with bundle_version`);
    const files = {};
    for (const rel of Object.keys(manifest.files ?? {})) {
      files[rel] = await fs.readFile(path.join(resolved, assertSafeBundleRel(rel)), "utf8");
    }
    bundle = { manifest, files };
  } else {
    const parsed = await readJsonIfExists(resolved);
    if (!parsed?.manifest?.bundle_version) throw new Error(`not_a_bundle: ${resolved}`);
    bundle = { manifest: parsed.manifest, files: parsed.files ?? {} };
  }

  if (bundle.manifest.bundle_version !== BUNDLE_VERSION) {
    throw new Error(`unsupported_bundle_version: ${bundle.manifest.bundle_version} (this maestro supports ${BUNDLE_VERSION})`);
  }

  // Every file must be listed in the manifest WITH a hash, and every listed
  // file must verify — otherwise tampering could simply drop the sha256
  // attribute (or add unlisted files) to bypass integrity checking.
  for (const rel of Object.keys(bundle.files)) {
    assertSafeBundleRel(rel);
    if (!bundle.manifest.files?.[rel]?.sha256) {
      throw new Error(`bundle_file_unlisted: ${rel} has no sha256 entry in manifest.json`);
    }
  }
  for (const [rel, meta] of Object.entries(bundle.manifest.files ?? {})) {
    const text = bundle.files[rel];
    if (text === undefined) throw new Error(`bundle_file_missing: ${rel}`);
    if (sha256(text) !== meta.sha256) {
      throw new Error(`bundle_hash_mismatch: ${rel}`);
    }
  }
  return bundle;
}

/**
 * Import a bundle into a state dir: backs up workflow.json, validates the
 * incoming workflow, merges providers (existing keys win unless force),
 * copies bundled prompts to .maestro/prompts/<bundle-name>/ and rewrites
 * instruction_paths, and merges credits into the import manifest.
 */
export async function importBundle({ bundle, stateDir, store, force = false, now = () => new Date() }) {
  const workflow = JSON.parse(bundle.files["workflow.json"] ?? "null");
  if (!workflow) throw new Error("bundle_missing_workflow");

  // materialize bundled prompt docs
  const promptsDir = path.join(stateDir, "prompts", sanitizeBundleName(bundle.manifest.name));
  for (const [rel, text] of Object.entries(bundle.files)) {
    if (!rel.startsWith("prompts/")) continue;
    const target = path.join(promptsDir, path.basename(assertSafeBundleRel(rel)));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
  // Only bundled docs are honored. A bundle workflow referencing arbitrary
  // local paths would otherwise read those files into prompts — and a later
  // export would embed them into a new bundle (local-file exfiltration).
  for (const [roleName, roleDef] of Object.entries(workflow.roles ?? {})) {
    if (!Array.isArray(roleDef.instruction_paths)) continue;
    const kept = [];
    for (const rel of roleDef.instruction_paths) {
      if (typeof rel === "string" && rel.startsWith("prompts/")) {
        kept.push(path.join(promptsDir, path.basename(assertSafeBundleRel(rel))));
      } else {
        process.stderr.write(`[maestro] bundle_instruction_path_dropped role=${roleName} path=${rel} (bundles may only reference bundled prompts/)\n`);
      }
    }
    roleDef.instruction_paths = kept;
  }

  const validation = validateWorkflow(workflow);
  if (!validation.ok) {
    throw new Error(`bundle_validation_failed:\n${formatValidation(validation)}`);
  }

  // backup + write workflow
  await backupWorkflowFile(stateDir);
  await store.writeWorkflow(workflow);

  // merge providers into config.json (existing keys preserved unless force).
  // Merge base is the RAW config.json — the effective view includes the
  // config.local.json overlay, and persisting that would leak local values
  // into the shareable config (and from there into future bundles).
  const incomingProviders = JSON.parse(bundle.files["providers.json"] ?? "{}");
  const currentProviders = (await readJsonIfExists(path.join(stateDir, "config.json")))?.providers ?? {};
  const mergedProviders = force
    ? { ...currentProviders, ...incomingProviders }
    : { ...incomingProviders, ...currentProviders };
  await store.writeConfig({ providers: mergedProviders });

  // merge credits/sources into the local import manifest
  const manifest = upsertManifest(
    await readManifest(stateDir),
    (bundle.manifest.sources ?? []).map((s) => ({
      ...s,
      path: null,
      mode: "bundled",
      hash: null,
      imported_as: s.imported_as ?? { type: "bundled", ref: bundle.manifest.name },
    })),
    { now },
  );
  manifest.credits = [...new Set([...manifest.credits, ...(bundle.manifest.credits ?? [])])];
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(manifestPath(stateDir), `${JSON.stringify(manifest, null, 2)}\n`);

  if (bundle.files["WORKFLOW.md"]) {
    await fs.writeFile(path.join(stateDir, "..", "WORKFLOW.md"), bundle.files["WORKFLOW.md"]).catch(() => {});
  }

  return { workflow, validation, manifest };
}

// Strip timestamps and machine-specific paths so two bundles can be compared
// for round-trip parity.
export function canonicalizeBundle(bundle) {
  const manifest = structuredClone(bundle.manifest);
  delete manifest.created_at;
  manifest.name = "<name>";
  manifest.sources = (manifest.sources ?? []).map((s) => ({ ...s, path: undefined }));
  const files = { ...bundle.files };
  return { manifest, files };
}
