// src/cli/serve/store.mjs
import path from "node:path";

import { isValidWorkflowName, WORKFLOW_NAME_RE } from "../../task-store.mjs";

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
