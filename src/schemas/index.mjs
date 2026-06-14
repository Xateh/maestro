// Schema registry — the Maestro stage I/O contract surface.
//
// Wraps the canonical named JSON Schemas (draft 2020-12) with an ajv 2020
// instance compiled once at module load. Public API:
//   getSchema(name)               → schema object | null
//   listSchemas()                 → string[] (stable order)
//   validatePayload(name, payload)→ {ok, errors:[{path,message}]}
//   validateInline(schema, body)  → {ok, errors} (compiles+caches inline)
//   resolveRoleSchema(roleDef)    → {name, schema, source}
//
// The validator (workflow-validate.mjs) and runtime (langgraph/nodes.mjs)
// both build on this; it performs NO file I/O.

import Ajv2020 from "ajv/dist/2020.js";

import { SCHEMA_DEFINITIONS, SCHEMA_NAMES } from "./definitions.mjs";

const ajv = new Ajv2020({ allErrors: true, strict: false });

// Compile the named schemas once into Map<name, validateFn>.
const compiledByName = new Map();
for (const name of SCHEMA_NAMES) {
  compiledByName.set(name, ajv.compile(SCHEMA_DEFINITIONS[name]));
}

// Inline schemas compiled on demand, keyed by JSON.stringify of the schema.
const compiledInline = new Map();

function mapErrors(ajvErrors) {
  return (ajvErrors ?? []).map((e) => ({
    path: e.instancePath ?? "",
    message: e.message ?? "validation failed",
  }));
}

export function getSchema(name) {
  return Object.hasOwn(SCHEMA_DEFINITIONS, name) ? SCHEMA_DEFINITIONS[name] : null;
}

export function listSchemas() {
  return [...SCHEMA_NAMES];
}

export function validatePayload(name, payload) {
  const validate = compiledByName.get(name);
  if (!validate) {
    return { ok: false, errors: [{ path: "", message: `unknown schema "${name}"` }] };
  }
  const ok = validate(payload);
  return { ok, errors: ok ? [] : mapErrors(validate.errors) };
}

// Validate a payload against an inline JSON Schema object. Compiles and caches
// by a stable JSON key. A schema that fails to compile yields ok:false with the
// compile error (callers that need compile-time errors use the validator path).
export function validateInline(schema, payload) {
  const key = JSON.stringify(schema);
  let validate = compiledInline.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      return { ok: false, errors: [{ path: "", message: `bad_schema: ${err.message}` }] };
    }
    compiledInline.set(key, validate);
  }
  const ok = validate(payload);
  return { ok, errors: ok ? [] : mapErrors(validate.errors) };
}

// Resolve the schema a role declares, in precedence order:
//   1. inline object  → source:"inline"
//   2. output_schema_ref (string path) → source:"ref" (NO file I/O here)
//   3. output_schema string name → source:"name" (unknown → source:"unknown")
// No declaration at all → source:"none". Never throws.
export function resolveRoleSchema(roleDef = {}) {
  const decl = roleDef?.output_schema;
  if (decl && typeof decl === "object" && !Array.isArray(decl)) {
    return { name: null, schema: decl, source: "inline" };
  }
  const ref = roleDef?.output_schema_ref;
  if (typeof ref === "string" && ref.length > 0) {
    return { name: null, schema: null, source: "ref" };
  }
  if (typeof decl === "string" && decl.length > 0) {
    const schema = getSchema(decl);
    if (schema) return { name: decl, schema, source: "name" };
    return { name: decl, schema: null, source: "unknown" };
  }
  return { name: null, schema: null, source: "none" };
}
