import path from "node:path";

import { ENV_KEY_DENYLIST } from "../../agent-runner.mjs";

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function typedError(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  return e;
}

// Refuse a value that looks like a literal secret being stored in a definition
// (spec L3). $VAR references and short tokens are fine.
function looksLikeLiteralKey(value) {
  return typeof value === "string" && !value.startsWith("$") && value.length >= 12 && /[A-Za-z0-9_-]{12,}/.test(value);
}

export function validateOverlayFields(def) {
  if (!def || typeof def.slug !== "string" || def.slug.trim() === "") {
    throw typedError("missing_service_slug", "a service needs --slug <SLUG>");
  }
  if (def.port !== undefined && def.port !== null) {
    const p = def.port;
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw typedError("invalid_service_port", `${p} (expected 1-65535)`);
    }
  }
  if (def.var !== undefined && def.var !== null) {
    if (!VAR_RE.test(def.var) || ENV_KEY_DENYLIST.test(def.var)) {
      throw typedError("invalid_service_var", `${def.var} (must be a plain env-var name, not denylisted)`);
    }
  }
  if (def.api_key !== undefined && looksLikeLiteralKey(def.api_key)) {
    throw typedError("literal_api_key", "store only a $VAR reference, never the literal key");
  }
  return true;
}

// Translate a stored definition into { serverOverlay, stateDir }. serverOverlay
// is deep-merged onto config.server by startMaestro's overlay seam (Task 5).
export function buildOverlay({ name, def, stateRoot }) {
  validateOverlayFields(def);
  const isolated = def.shared_state !== true;
  const stateDir = isolated ? path.join(stateRoot, "services", name) : stateRoot;
  const varName = def.var ?? "LINEAR_API_KEY";

  const serverOverlay = {
    tracker: {
      project_slug: def.slug,
      api_key: `$${varName}`,
    },
  };
  if (def.port !== undefined && def.port !== null) serverOverlay.port = def.port;
  if (def.workflow) serverOverlay.workflow = def.workflow;

  const workspaceRoot = def.workspace ?? (isolated ? path.join(stateDir, "work") : undefined);
  if (workspaceRoot !== undefined) serverOverlay.workspace = { root: workspaceRoot };

  return { serverOverlay, stateDir };
}
