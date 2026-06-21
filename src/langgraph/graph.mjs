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
import { makeRoleNode, makeRoleNodeFn } from "./nodes.mjs";
import { isSink } from "../state-machine.mjs";
import { runPool } from "../async-pool.mjs";

/**
 * Build a group node function that runs all group members concurrently via
 * Promise.allSettled and merges their handoffs into a single "done" result.
 *
 * @param {number}  gi          - group index (for consistent node naming)
 * @param {string[]} group      - ordered list of role names in this group
 * @param {object}  workflow    - parsed workflow.json
 * @param {object}  config      - parsed config.json
 * @param {object}  opts        - same opts passed to buildGraph
 * @returns {Function}          - async (state, lgConfig) => MaestroState patch
 */
function buildGroupNode(gi, group, workflow, config, opts) {
  // Pre-build the member role functions (closures, not LangGraph nodes)
  const memberFns = group.map((roleName) => {
    const roleDef = workflow.roles[roleName];
    const providerKey = roleDef.provider ?? config.default_role ?? "executor";
    const providerDef = config.providers?.[providerKey] ?? null;
    return {
      roleName,
      fn: makeRoleNodeFn(roleDef, {
        ...opts,
        providerDef,
        config,
        workflow,
        stateName: roleName,
      }),
    };
  });

  return async (state, lgConfig) => {
    const start = Date.now();

    // Run all members concurrently
    const settled = await runPool(
      memberFns,
      opts.maxConcurrentRoles ?? 0,
      ({ fn }) => fn(state, lgConfig),
    );

    // Merge results
    const allHandoffs = [];
    const parallelFailed = [];
    const allVisits = {};
    const memberEvents = [];

    for (let i = 0; i < settled.length; i++) {
      const { roleName } = memberFns[i];
      const result = settled[i];
      if (result.status === "fulfilled") {
        const value = result.value ?? {};
        allHandoffs.push(...(value.priorHandoffs ?? []));
        for (const [k, v] of Object.entries(value.visits ?? {})) {
          allVisits[k] = (allVisits[k] ?? 0) + v;
        }
        const memberEvent = value.event ?? "done";
        memberEvents.push(memberEvent);
        // Non-"done" events from members count as partial failures
        if (memberEvent !== "done") {
          parallelFailed.push(roleName);
        }
      } else {
        // A rejected member node is treated as an "error" event so it can
        // halt the run instead of being silently swallowed.
        memberEvents.push("error");
        parallelFailed.push(roleName);
      }
    }

    const durationMs = Date.now() - start;
    const status = parallelFailed.length === 0 ? "passed" : "partial_failure";

    // Determine the group's emitted event by precedence. Interrupt/terminal
    // events (same order as ALWAYS_TERMINAL) must propagate so the conditional
    // edge map routes them to END instead of marching past a hard error or a
    // human-in-the-loop pause. The highest-precedence (earliest in the array)
    // member event wins; otherwise the group emits "done". A member completing
    // with event "done" — even with a failing/missing score — keeps "done".
    const EVENT_PRECEDENCE = ["error", "question", "waiting", "needs_review"];
    const groupEvent =
      EVENT_PRECEDENCE.find((ev) => memberEvents.includes(ev)) ?? "done";

    // Record parallel_join stage event via DB (best-effort)
    try {
      const task = state.task;
      if (task?.id && opts.db) {
        const joinEvent = {
          kind: "parallel_join",
          group,
          duration_ms: durationMs,
          status,
          parallel_failed: parallelFailed,
          timestamp: new Date().toISOString(),
        };
        // Persist as a step on the task (evidence-only; not a handoff).
        // Use a function patch so updateTask reads current DB steps, not the
        // stale state.task.steps snapshot (which would silently drop any steps
        // recorded by member nodes or the implementation node before the join).
        await opts.db.updateTask(task.id, (current) => ({
          steps: [...(current.steps ?? []), { role: "__parallel_join__", event: joinEvent }],
        })).catch(() => {}); // best effort
      }
    } catch { /* observability never breaks a run */ }

    return {
      priorHandoffs: allHandoffs,
      // "done" when all members completed normally (scoring handles missing
      // evidence); otherwise the highest-precedence interrupt/terminal event so
      // the group's conditional edge map (ALWAYS_TERMINAL → END) halts the run.
      event: groupEvent,
      currentState: `pg_${gi}`,
      visits: allVisits,
    };
  };
}

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
export function buildGraph(
  workflow,
  config,
  {
    db,
    runner,
    ops = {},
    entry = null,
    resumeCompletedRoles = null,
    availabilityProbe = null,
    advisoryEmitted = new Set(),
    maxConcurrentRoles = 0,
  } = {},
) {
  const graph = new StateGraph(MaestroState);

  // ── resolve parallel groups ───────────────────────────────────────────────
  // Build a map: member roleName → groupNodeName (pg_N)
  const groups = Array.isArray(workflow.parallel_groups) ? workflow.parallel_groups : [];
  const memberToGroup = new Map(); // roleName → { gi, groupNodeName, group }
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (!Array.isArray(group) || group.length < 2) continue;
    const groupNodeName = `pg_${gi}`;
    for (const roleName of group) {
      memberToGroup.set(roleName, { gi, groupNodeName, group });
    }
  }
  const addedGroupNodes = new Set(); // track which group nodes have been added

  // ── add role nodes (skip group members; add group nodes instead) ──────────
  for (const [stateName, roleDef] of Object.entries(workflow.roles ?? {})) {
    if (memberToGroup.has(stateName)) {
      // This role is a group member — add the group node once, skip the member
      const { gi, groupNodeName, group } = memberToGroup.get(stateName);
      if (!addedGroupNodes.has(groupNodeName)) {
        addedGroupNodes.add(groupNodeName);
        const groupOpts = {
          db, runner, ops, availabilityProbe,
          contextRetryLimit: config.context_retry_limit ?? 1,
          resumeCompletedRoles, advisoryEmitted,
          maxConcurrentRoles:
            maxConcurrentRoles
            ?? config.server?.agent?.maxConcurrentRoles
            ?? config.server?.agent?.max_concurrent_roles
            ?? config.max_concurrent_roles
            ?? 0,
        };
        graph.addNode(groupNodeName, buildGroupNode(gi, group, workflow, config, groupOpts));
      }
      continue;
    }
    // Non-group role: add normally
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

  // ── wire edges (remap group member destinations to group node) ────────────
  // Interrupt events can arise from any node regardless of workflow.json entries.
  // Preload them as END so LangGraph never throws on an unmapped event.
  const ALWAYS_TERMINAL = ["error", "question", "waiting", "needs_review"];

  // Helper: remap a destination (if it's a group member, use group node name)
  const remap = (dest) => {
    const info = memberToGroup.get(dest);
    return info ? info.groupNodeName : dest;
  };

  // Add edges for non-member roles
  for (const [stateName, transitions] of Object.entries(workflow.transitions ?? {})) {
    // Group members' transitions are handled separately (group node emits "done")
    if (memberToGroup.has(stateName)) continue;

    const edgeMap = {};
    for (const ev of ALWAYS_TERMINAL) edgeMap[ev] = END;
    for (const [event, dest] of Object.entries(transitions)) {
      const resolved = isSink(dest) ? END : remap(dest);
      edgeMap[event] = resolved;
    }
    graph.addConditionalEdges(stateName, (s) => s.event ?? "done", edgeMap);
  }

  // Add edges for group nodes (each group node always emits "done" → shared successor)
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (!Array.isArray(group) || group.length < 2) continue;
    const groupNodeName = `pg_${gi}`;

    // Find the shared successor: the "done" destination of the first group member
    // (validation ensures all members share the same "done" target)
    const firstMember = group[0];
    const successorRaw = workflow.transitions?.[firstMember]?.done;
    const successor = successorRaw ? (isSink(successorRaw) ? END : remap(successorRaw)) : END;

    const groupEdgeMap = {};
    for (const ev of ALWAYS_TERMINAL) groupEdgeMap[ev] = END;
    groupEdgeMap["done"] = successor;
    graph.addConditionalEdges(groupNodeName, (s) => s.event ?? "done", groupEdgeMap);
  }

  // ── entry edge: START → mode initial (custom modes) or workflow initial ──
  // A conditional entry listing every mode initial keeps all pipelines
  // reachable in LangGraph's validation even when this run enters elsewhere
  // (e.g. a standalone mode created by `setup import`).
  const fallback = workflow.initial ?? "planner";
  const entryState = entry && workflow.roles?.[entry] ? entry : fallback;
  // Remap entry if it's a group member
  const remappedEntry = remap(entryState);
  const remappedFallback = remap(fallback);
  const entryCandidates = new Set(
    [remappedFallback, remappedEntry,
      ...Object.values(workflow.modes ?? {}).map((m) => remap(m?.initial)).filter(Boolean)]
      .filter((state) => {
        // Valid if it's a known role OR a group node
        return workflow.roles?.[state] || addedGroupNodes.has(state);
      }),
  );
  if (entryCandidates.size <= 1) {
    graph.addEdge(START, remappedEntry);
  } else {
    graph.addConditionalEdges(
      START,
      () => remappedEntry,
      Object.fromEntries([...entryCandidates].map((state) => [state, state])),
    );
  }

  return graph.compile({ checkpointer: new MemorySaver() });
}
