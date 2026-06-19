/**
 * Per-edge context contract — prototype tests (v0.3.0 item A).
 *
 * Covers the pure selector (src/langgraph/context-contract.mjs) and the
 * falsification demonstration: on the stock full-audit-sweep workflow, the
 * `implementation` node re-entered via different edges resolves DIFFERENT input
 * views — something per-role static config cannot express. Also pins the
 * no-op guarantee: with the experimental flag off, every edge resolves "full".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  edgeKey,
  resolveEdgeContextSpec,
  selectEdgeContext,
  contextForEdge,
} from "../src/langgraph/context-contract.mjs";
import { FULL_AUDIT_SWEEP_WORKFLOW } from "../src/setup/workflow-templates.mjs";

const HANDOFFS = [
  { role: "implementation", payload: { changed_files: ["a.js"] } },
  { role: "static_analysis", payload: { findings: [] } },
  { role: "review", payload: { severity: "high", findings: ["bug"] } },
  { role: "regression", payload: { new_failures: ["t1"] } },
];

// ── edgeKey ───────────────────────────────────────────────────────────────

test("edgeKey joins from:event, null when a part is missing", () => {
  assert.equal(edgeKey("review", "changes_requested"), "review:changes_requested");
  assert.equal(edgeKey(null, "done"), null);
  assert.equal(edgeKey("review", null), null);
});

// ── selectEdgeContext (pure filter) ─────────────────────────────────────────

test("selectEdgeContext: full / null returns all handoffs", () => {
  assert.deepEqual(selectEdgeContext(HANDOFFS, "full", "review"), HANDOFFS);
  assert.deepEqual(selectEdgeContext(HANDOFFS, null, "review"), HANDOFFS);
});

test("selectEdgeContext: scoped returns only the source node's handoff", () => {
  const view = selectEdgeContext(HANDOFFS, "scoped", "review");
  assert.deepEqual(view.map((h) => h.role), ["review"]);
});

test("selectEdgeContext: array selects named roles only, preserving order", () => {
  const view = selectEdgeContext(HANDOFFS, ["regression", "review"], "regression");
  assert.deepEqual(view.map((h) => h.role), ["review", "regression"]);
});

test("selectEdgeContext: unknown spec falls back to full (safe default)", () => {
  assert.deepEqual(selectEdgeContext(HANDOFFS, { weird: true }, "review"), HANDOFFS);
  assert.deepEqual(selectEdgeContext(undefined, "scoped", "review"), []);
});

// ── resolveEdgeContextSpec (no-op guarantee + precedence) ────────────────────

test("resolveEdgeContextSpec: flag off → full regardless of edge_context", () => {
  const wf = { edge_context: { "review:changes_requested": ["review"] } };
  assert.equal(resolveEdgeContextSpec(wf, "review", "changes_requested"), "full");
});

test("resolveEdgeContextSpec: exact from:event key wins", () => {
  const wf = {
    experimental_per_edge_context: true,
    edge_context: { "review:changes_requested": ["review"], implementation: "scoped" },
  };
  assert.deepEqual(resolveEdgeContextSpec(wf, "review", "changes_requested"), ["review"]);
});

test("resolveEdgeContextSpec: per-source default applies when no exact key", () => {
  const wf = {
    experimental_per_edge_context: true,
    edge_context: { implementation: "scoped" },
  };
  assert.equal(resolveEdgeContextSpec(wf, "implementation", "done"), "scoped");
});

test("resolveEdgeContextSpec: undeclared edge → full", () => {
  const wf = { experimental_per_edge_context: true, edge_context: {} };
  assert.equal(resolveEdgeContextSpec(wf, "review", "done"), "full");
});

// ── falsification: per-edge expresses what per-role cannot ───────────────────

test("per-edge: implementation sees DIFFERENT views by inbound edge", () => {
  // A genuine per-edge contract layered over the stock full-audit-sweep graph,
  // where `implementation` is re-entered from several critics.
  const wf = {
    ...FULL_AUDIT_SWEEP_WORKFLOW,
    experimental_per_edge_context: true,
    edge_context: {
      "review:changes_requested": ["review"],
      "regression:regressions_found": ["regression"],
    },
  };

  const viaReview = contextForEdge(wf, HANDOFFS, "review", "changes_requested");
  const viaRegression = contextForEdge(wf, HANDOFFS, "regression", "regressions_found");

  // Same destination node (implementation), two inbound edges, two views.
  assert.deepEqual(viaReview.map((h) => h.role), ["review"]);
  assert.deepEqual(viaRegression.map((h) => h.role), ["regression"]);
  assert.notDeepEqual(viaReview, viaRegression);
});

test("no-op: stock workflow without the flag passes the whole history through", () => {
  const view = contextForEdge(FULL_AUDIT_SWEEP_WORKFLOW, HANDOFFS, "review", "changes_requested");
  assert.deepEqual(view, HANDOFFS);
});

test("entry node (no inbound edge) gets the full history", () => {
  const wf = { experimental_per_edge_context: true, edge_context: { implementation: "scoped" } };
  // currentState/event are null on first arrival → no edge → full.
  assert.deepEqual(contextForEdge(wf, HANDOFFS, null, null), HANDOFFS);
});
