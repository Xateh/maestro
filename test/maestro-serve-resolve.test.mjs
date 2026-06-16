import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildOverlay, validateOverlayFields } from "../src/cli/serve/resolve.mjs";

test("buildOverlay maps definition fields onto a server-block overlay with isolated state", () => {
  const ov = buildOverlay({ name: "web", def: { slug: "WEB", port: 4100 }, stateRoot: "/s" });
  assert.equal(ov.serverOverlay.tracker.project_slug, "WEB");
  assert.equal(ov.serverOverlay.port, 4100);
  assert.equal(ov.stateDir, path.join("/s", "services", "web"));
  assert.equal(ov.serverOverlay.workspace.root, path.join("/s", "services", "web", "work"));
});

test("buildOverlay honors shared_state and explicit workspace/var/workflow overrides", () => {
  const ov = buildOverlay({
    name: "infra",
    def: { slug: "INF", workflow: "review", var: "LINEAR_KEY_INFRA", workspace: "/w/infra", shared_state: true },
    stateRoot: "/s",
  });
  assert.equal(ov.stateDir, "/s");
  assert.equal(ov.serverOverlay.workflow, "review");
  assert.equal(ov.serverOverlay.tracker.api_key, "$LINEAR_KEY_INFRA");
  assert.equal(ov.serverOverlay.workspace.root, "/w/infra");
});

test("validateOverlayFields rejects bad var, bad port, literal api key, denylisted var", () => {
  assert.throws(() => validateOverlayFields({ slug: "X", port: 0 }), /invalid_service_port/);
  assert.throws(() => validateOverlayFields({ slug: "X", port: 70000 }), /invalid_service_port/);
  assert.throws(() => validateOverlayFields({ slug: "X", var: "PATH" }), /invalid_service_var/);
  assert.throws(() => validateOverlayFields({ slug: "X", var: "1bad" }), /invalid_service_var/);
  assert.throws(() => validateOverlayFields({ slug: "X", api_key: "lin_api_secretliteral" }), /literal_api_key/);
  assert.doesNotThrow(() => validateOverlayFields({ slug: "X", port: 4100, var: "LINEAR_API_KEY" }));
});

test("validateOverlayFields requires a slug", () => {
  assert.throws(() => validateOverlayFields({}), /missing_service_slug/);
});
