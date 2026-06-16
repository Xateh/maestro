// test/maestro-serve-store.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { assertValidServiceName, servicePaths } from "../src/cli/serve/store.mjs";

test("assertValidServiceName accepts simple names, rejects traversal/control/empty", () => {
  assert.equal(assertValidServiceName("web"), "web");
  assert.equal(assertValidServiceName("infra-2"), "infra-2");
  for (const bad of ["", "../config", "a/b", "a.pid", "A", "-x", "..", ".", "a".repeat(65)]) {
    assert.throws(() => assertValidServiceName(bad), /invalid_service_name/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("servicePaths rejects an invalid name before building paths", () => {
  assert.throws(() => servicePaths("/tmp/state", "../evil"), /invalid_service_name/);
});

test("servicePaths derives def/pid/log/state under <state>/services and stays inside it", () => {
  const root = "/tmp/state";
  const p = servicePaths(root, "web");
  assert.equal(p.dir, path.join(root, "services"));
  assert.equal(p.def, path.join(root, "services", "web.json"));
  assert.equal(p.pid, path.join(root, "services", "web.pid"));
  assert.equal(p.log, path.join(root, "services", "web.log"));
  assert.equal(p.stateDir, path.join(root, "services", "web"));
});
