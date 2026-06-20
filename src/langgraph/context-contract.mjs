/**
 * Per-edge context contract — EXPERIMENTAL prototype (v0.3.0 item A).
 *
 * The default engine passes the WHOLE priorHandoffs history to every node
 * (prompt.mjs / nodes.mjs). This module lets a workflow declare, PER INBOUND
 * EDGE, which prior handoffs the destination node actually sees. It is gated
 * behind `workflow.experimental_per_edge_context` and is a pure no-op (returns
 * the full history) when the flag is off or no edge view is declared — so
 * default workflows are byte-identical and the feature is fully reversible.
 *
 * An edge is identified by (fromState, event): the node that just ran and the
 * event it emitted. The destination node already knows both at prompt-build
 * time — `state.currentState` is the predecessor that ran, `state.event` is the
 * event that routed control here — so the contract is resolved at the
 * destination with no change to the LangGraph state shape or the transition
 * table format.
 *
 * `context` spec values (workflow.edge_context["<from>:<event>"] or
 * workflow.edge_context["<from>"] as a per-source default):
 *   "full"        — all prior handoffs (default; identical to non-experimental)
 *   "scoped"      — only the handoff from the edge's source node (fromState)
 *   ["a","b",...] — only handoffs whose role is in the list
 *
 * WHY per-edge and not per-role (the falsification verdict): a node reachable
 * from MULTIPLE edges wants a DIFFERENT input view depending on which edge
 * delivered control. In the stock `full-audit-sweep`, `implementation` is
 * re-entered from review / threat_model / edge_cases (changes_requested) and
 * from regression (regressions_found); on each loop it should see only that
 * critic's feedback, not the whole audit history. Per-role static config cannot
 * express "depends on the inbound edge"; per-edge can. See the spec + verdict in
 * docs/internal/specs/per-edge-context-contract.md.
 */

const FULL = "full";

/** Canonical "<from>:<event>" edge key, or null when either part is missing. */
export function edgeKey(fromState, event) {
  if (!fromState || !event) return null;
  return `${fromState}:${event}`;
}

/**
 * Resolve the declared context spec for the inbound edge (fromState, event).
 * Precedence: exact "from:event" key → per-source "from" default → "full".
 * Returns "full" whenever the experimental flag is off (no-op guarantee).
 */
export function resolveEdgeContextSpec(workflow, fromState, event) {
  // SP10c: prefer stable key; accept old key as migration shim
  const perEdgeContextEnabled = workflow?.per_edge_context ?? workflow?.experimental_per_edge_context;
  if (!perEdgeContextEnabled) return FULL;
  const map = workflow.edge_context;
  if (!map || typeof map !== "object") return FULL;
  const key = edgeKey(fromState, event);
  if (key && Object.hasOwn(map, key)) return map[key];
  if (fromState && Object.hasOwn(map, fromState)) return map[fromState];
  return FULL;
}

/**
 * Filter prior handoffs to the view a context spec selects. Total and pure;
 * an unrecognized spec falls back to the full history (safe default).
 */
export function selectEdgeContext(priorHandoffs, spec, fromState) {
  const all = Array.isArray(priorHandoffs) ? priorHandoffs : [];
  if (spec === FULL || spec == null) return all;
  if (spec === "scoped") return all.filter((h) => h?.role === fromState);
  if (Array.isArray(spec)) {
    const want = new Set(spec);
    return all.filter((h) => want.has(h?.role));
  }
  return all;
}

/**
 * One-call convenience used by the role node: resolve the inbound edge's
 * context spec and apply it to the accumulated prior handoffs.
 */
export function contextForEdge(workflow, priorHandoffs, fromState, event) {
  const spec = resolveEdgeContextSpec(workflow, fromState, event);
  return selectEdgeContext(priorHandoffs, spec, fromState);
}
