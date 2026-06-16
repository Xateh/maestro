// src/cli/serve/store.mjs
import path from "node:path";
import fs from "node:fs/promises";
import fsConstants from "node:fs";

import { isValidWorkflowName, WORKFLOW_NAME_RE } from "../../task-store.mjs";
import { assertInsideDirReal } from "../../fs-safe.mjs";

// Reuse the workflow-name grammar verbatim: ^[a-z0-9][a-z0-9_-]{0,63}$.
// This forbids "..", "/", uppercase, leading "-"/".", control suffixes like
// "a.pid" (the "." is not in the class), and over-long names — closing the
// path-traversal / filename-collision vectors (spec H1).
export function assertValidServiceName(name) {
  if (!isValidWorkflowName(name)) {
    const error = new Error(`invalid_service_name: ${JSON.stringify(name)} (must match ${WORKFLOW_NAME_RE})`);
    error.code = "invalid_service_name";
    throw error;
  }
  return name;
}

export function servicesDir(stateRoot) {
  return path.join(stateRoot, "services");
}

export function servicePaths(stateRoot, name) {
  assertValidServiceName(name);
  const dir = servicesDir(stateRoot);
  return {
    dir,
    def: path.join(dir, `${name}.json`),
    pid: path.join(dir, `${name}.pid`),
    log: path.join(dir, `${name}.log`),
    stateDir: path.join(dir, name),
  };
}

export async function ensureServicesDir(stateRoot) {
  const dir = servicesDir(stateRoot);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir mode is masked by umask; force it.
  await fs.chmod(dir, 0o700).catch(() => {});
  return dir;
}

// Open a service-owned file without following symlinks and verify the opened
// fd is a regular file owned by us (spec C2/H2). Returns a FileHandle.
async function openOwned(filePath, flags) {
  let fh;
  try {
    fh = await fs.open(filePath, flags | fsConstants.constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === "ELOOP" || error.code === "ENOENT") throw error;
    // On some platforms O_NOFOLLOW on a symlink raises ELOOP; re-throw as-is.
    throw error;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      const e = new Error(`service_file_not_regular: ${filePath}`);
      e.code = "service_file_not_regular";
      throw e;
    }
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      const e = new Error(`service_file_foreign_owner: ${filePath}`);
      e.code = "service_file_foreign_owner";
      throw e;
    }
    return fh;
  } catch (error) {
    await fh.close().catch(() => {});
    if (error.code === "ELOOP") {
      const e = new Error(`service_file_symlink: ${filePath}`);
      e.code = "service_file_symlink";
      throw e;
    }
    throw error;
  }
}

async function writeOwnedJson(filePath, value) {
  await assertInsideDirReal(path.dirname(path.dirname(filePath)), filePath);
  // Replace atomically: write temp (excl), chmod, rename. Temp name is in-dir.
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fs.open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await fh.chmod(0o600);
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, filePath);
}

async function readOwnedJson(filePath) {
  let fh;
  try {
    fh = await openOwned(filePath, fsConstants.constants.O_RDONLY);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // Re-map ELOOP (symlink with O_NOFOLLOW) to our sentinel code.
    if (error.code === "ELOOP") {
      const e = new Error(`service_file_symlink: ${filePath}`);
      e.code = "service_file_symlink";
      throw e;
    }
    throw error;
  }
  try {
    const text = await fh.readFile("utf8");
    return JSON.parse(text);
  } finally {
    await fh.close();
  }
}

export function writeDefinition(stateRoot, name, def) {
  return writeOwnedJson(servicePaths(stateRoot, name).def, def);
}

export function readDefinition(stateRoot, name) {
  return readOwnedJson(servicePaths(stateRoot, name).def);
}

export function writePidRecord(stateRoot, name, rec) {
  return writeOwnedJson(servicePaths(stateRoot, name).pid, rec);
}

export function readPidRecord(stateRoot, name) {
  return readOwnedJson(servicePaths(stateRoot, name).pid);
}

export async function removeFile(filePath) {
  await fs.rm(filePath, { force: true });
}

export async function listDefinitions(stateRoot) {
  const dir = servicesDir(stateRoot);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const names = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const stem = entry.slice(0, -5);
    if (WORKFLOW_NAME_RE.test(stem)) names.push(stem);
  }
  return names.sort();
}
