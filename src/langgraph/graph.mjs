/**
 * Builds a LangGraph StateGraph from a Maestro workflow.json definition.
 *
 * The workflow.json roles map 1:1 to graph nodes; transitions map to
 * conditional edges keyed on state.event. SINK_STATES ($complete, $halt,
 * $ask_user, $pause, $wait) all map to END — the engine inspects state.event
 * to distinguish them after the graph completes.
 *
 * No graph caching: ops functions are closures bound to per-call state
 * (taskStore, gitRunner, stdout), so the graph must be rebuilt each call.
 *
 * Checkpointer: MemorySaver is intentional — checkpoints are in-process and
 * scoped to one runLangGraphTask call. Cross-process resume is handled by
 * priorHandoffs (loaded from SQLite handoffs table), not by persisted
 * LangGraph checkpoints. The lg_checkpoints tables were removed from store.mjs.
 */

import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { MaestroState } from "./state.mjs";
import { makeRoleNode } from "./nodes.mjs";
import { isSink } from "../state-machine.mjs";

/**
 * Build and compile a StateGraph for the given workflow + config.
 *
 * @param {object} workflow  - parsed workflow.json
 * @param {object} config    - parsed config.json
 * @param {object} opts
 * @param {SqliteTaskStore} opts.db      - SQLite task store
 * @param {object}          opts.runner  - agent runner (HerdrAgentRunner | TerminalAgentRunner)
 * @param {object}          opts.ops     - injected project-mode helpers (bound per call)
 * @returns {CompiledStateGraph}
 */
export function buildGraph(workflow, config, { db, runner, ops = {}, entry = null, resumeCompletedRoles = null, availabilityProbe = null, advisoryEmitted = new Set() }) {
  const graph = new StateGraph(MaestroState);

  // ── add one node per workflow role ────────────────────────────────────────
  for (const [stateName, roleDef] of Object.entries(workflow.roles ?? {})) {
    const providerKey = roleDef.provider ?? config.default_role ?? "executor";
    const providerDef = config.providers?.[providerKey] ?? null;
    const node = makeRoleNode(roleDef, {
      db,
      runner,
      providerDef,
      config,
      availabilityProbe,
      contextRetryLimit: config.context_retry_limit ?? 1,
      workflow,
      stateName,
      resumeCompletedRoles,
      advisoryEmitted,
      ops,
    });
    graph.addNode(stateName, node);
  }

  // ── wire edges from transition table ─────────────────────────────────────
  // Interrupt events can arise from any node regardless of workflow.json entries.
  // Preload them as END so LangGraph never throws on an unmapped event.
  const ALWAYS_TERMINAL = ["error", "question", "waiting", "needs_review"];

  for (const [stateName, transitions] of Object.entries(workflow.transitions ?? {})) {
    const edgeMap = {};
    for (const ev of ALWAYS_TERMINAL) {
      edgeMap[ev] = END;
    }
    for (const [event, dest] of Object.entries(transitions)) {
      edgeMap[event] = isSink(dest) ? END : dest;
    }
    graph.addConditionalEdges(stateName, (s) => s.event ?? "done", edgeMap);
  }

  // ── entry edge: START → mode initial (custom modes) or workflow initial ──
  // A conditional entry listing every mode initial keeps all pipelines
  // reachable in LangGraph's validation even when this run enters elsewhere
  // (e.g. a standalone mode created by `setup import`).
  const fallback = workflow.initial ?? "planner";
  const entryState = entry && workflow.roles?.[entry] ? entry : fallback;
  const entryCandidates = new Set(
    [fallback, entryState, ...Object.values(workflow.modes ?? {}).map((m) => m?.initial)]
      .filter((state) => workflow.roles?.[state]),
  );
  if (entryCandidates.size <= 1) {
    graph.addEdge(START, entryState);
  } else {
    graph.addConditionalEdges(
      START,
      () => entryState,
      Object.fromEntries([...entryCandidates].map((state) => [state, state])),
    );
  }

  return graph.compile({ checkpointer: new MemorySaver() });
}
