/**
 * LangGraph state definition for the Maestro orchestration graph.
 *
 * priorHandoffs is the core token-efficiency mechanism: it accumulates ONLY
 * typed compact payloads ({role, provider, payload, log_path}) — never raw
 * stdout. Raw logs stay on disk; the log_path pointer is the access handle.
 */

import { Annotation } from "@langchain/langgraph";

export const MaestroState = Annotation.Root({
  /** Current task object (from DB). Last-write wins. */
  task: Annotation({
    reducer: (_, y) => y,
    default: () => null,
  }),

  /**
   * Compact typed handoffs accumulated across roles.
   * Shape: { role, provider, payload, log_path }
   * Reducer appends new entries; a revisited role's fresh handoff supersedes
   * its stale one (loops re-run roles, and prompts must not see both).
   */
  priorHandoffs: Annotation({
    reducer: (x, y) => {
      const next = y ?? [];
      const replacedRoles = new Set(next.map((h) => h.role));
      return [...(x ?? []).filter((h) => !replacedRoles.has(h.role)), ...next];
    },
    default: () => [],
  }),

  /**
   * Per-role visit counts for this graph run. Loops revisit roles; the count
   * feeds max_visits / loop_limits enforcement in the role nodes.
   */
  visits: Annotation({
    reducer: (x, y) => {
      const merged = { ...(x ?? {}) };
      for (const [role, count] of Object.entries(y ?? {})) {
        merged[role] = (merged[role] ?? 0) + count;
      }
      return merged;
    },
    default: () => ({}),
  }),

  /** Event emitted by the last role node: "done" | "question" | "error" | ... */
  event: Annotation({
    reducer: (_, y) => y,
    default: () => null,
  }),

  /** Name of the role state that last ran (matches workflow.json role key). */
  currentState: Annotation({
    reducer: (_, y) => y,
    default: () => null,
  }),
});
