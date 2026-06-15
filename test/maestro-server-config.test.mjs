import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  renderPrompt,
  resolveDollarValue,
  resolveServerConfig,
  validateServerConfig,
} from "../src/setup/server-config.mjs";
import { DEFAULT_INTAKE_TEMPLATE, DEFAULT_SERVER_CONFIG } from "../src/task-store.mjs";

const baseDir = "/tmp/maestro-server-config";

test("resolveServerConfig resolves the full server block to effective values", () => {
  const resolved = resolveServerConfig(
    {
      server: {
        workflow: "ops",
        port: 8080,
        tracker: {
          kind: "linear",
          api_key: "$LINEAR_TEST_KEY",
          project_slug: "twin-ops",
          active_states: ["Todo", "In Progress"],
        },
        polling: { interval_ms: 77 },
        workspace: { root: "./agent workspaces" },
        agent: {
          max_concurrent_agents: 3,
          stall_timeout_ms: 1234,
          max_concurrent_agents_by_state: { Todo: 1, Bad: 0 },
        },
        intake_template: "Issue {{ issue.identifier }} attempt {{ attempt }}.",
      },
    },
    { env: { LINEAR_TEST_KEY: "linear-token" }, baseDir },
  );

  assert.equal(resolved.workflow, "ops");
  assert.equal(resolved.port, 8080);
  assert.equal(resolved.tracker.kind, "linear");
  assert.equal(resolved.tracker.apiKey, "linear-token");
  assert.equal(resolved.tracker.projectSlug, "twin-ops");
  assert.equal(resolved.tracker.endpoint, "https://api.linear.app/graphql");
  assert.equal(resolved.polling.intervalMs, 77);
  assert.equal(resolved.workspace.root, path.join(baseDir, "agent workspaces"));
  assert.equal(resolved.agent.maxConcurrentAgents, 3);
  assert.equal(resolved.agent.maxTurns, 20);
  assert.equal(resolved.agent.maxRetryBackoffMs, 300_000);
  assert.equal(resolved.agent.stallTimeoutMs, 1234);
  assert.deepEqual(resolved.agent.maxConcurrentAgentsByState, { todo: 1 });
  assert.equal(resolved.intakeTemplate, "Issue {{ issue.identifier }} attempt {{ attempt }}.");
});

test("resolveServerConfig expands ~ and $VAR in workspace.root", () => {
  const home = os.homedir();
  const a = resolveServerConfig(
    { server: { workspace: { root: "~/ws" } } },
    { env: {}, baseDir },
  );
  assert.equal(a.workspace.root, path.join(home, "ws"));

  const b = resolveServerConfig(
    { server: { workspace: { root: "$WS_BASE/runs" } } },
    { env: { WS_BASE: "/srv/data" }, baseDir },
  );
  assert.equal(b.workspace.root, path.normalize("/srv/data/runs"));
});

test("resolveServerConfig falls back to defaults when the block is missing", () => {
  const resolved = resolveServerConfig({}, { env: {}, baseDir });
  assert.equal(resolved.workflow, DEFAULT_SERVER_CONFIG.workflow);
  assert.equal(resolved.port, null);
  assert.equal(resolved.tracker.kind, null);
  assert.equal(resolved.polling.intervalMs, 30_000);
  assert.equal(resolved.agent.maxConcurrentAgents, 10);
  assert.equal(resolved.agent.stallTimeoutMs, 300_000);
  assert.deepEqual(resolved.tracker.activeStates, DEFAULT_SERVER_CONFIG.tracker.active_states);
  assert.equal(resolved.intakeTemplate, DEFAULT_INTAKE_TEMPLATE);
});

test("validateServerConfig rejects bad tracker config (no codex check)", () => {
  const base = () => resolveServerConfig(
    {
      server: {
        tracker: { kind: "linear", api_key: "$K", project_slug: "p" },
      },
    },
    { env: { K: "tok" }, baseDir },
  );
  assert.equal(validateServerConfig(base()), true);

  const notLinear = resolveServerConfig(
    { server: { tracker: { kind: "github", api_key: "$K", project_slug: "p" } } },
    { env: { K: "tok" }, baseDir },
  );
  assert.throws(() => validateServerConfig(notLinear), /unsupported_tracker_kind/);

  const noKey = resolveServerConfig(
    { server: { tracker: { kind: "linear", project_slug: "p" } } },
    { env: {}, baseDir },
  );
  assert.throws(() => validateServerConfig(noKey), /missing_tracker_api_key/);

  const noSlug = resolveServerConfig(
    { server: { tracker: { kind: "linear", api_key: "$K" } } },
    { env: { K: "tok" }, baseDir },
  );
  assert.throws(() => validateServerConfig(noSlug), /missing_tracker_project_slug/);
});

test("renderPrompt renders strict liquid and rejects unknown variables", async () => {
  const out = await renderPrompt("Issue {{ issue.identifier }} attempt {{ attempt }}", {
    issue: { identifier: "OPS-1" },
    attempt: 2,
  });
  assert.equal(out, "Issue OPS-1 attempt 2");
  await assert.rejects(
    () => renderPrompt("Bad {{ issue.missing.deep }}", { issue: {}, attempt: 1 }),
    /template_render_error/,
  );
});

test("resolveDollarValue resolves env refs and plain strings", () => {
  assert.equal(resolveDollarValue("$TOK", { TOK: "v" }), "v");
  assert.equal(resolveDollarValue("$MISSING", {}), null);
  assert.equal(resolveDollarValue("literal", {}), "literal");
});
