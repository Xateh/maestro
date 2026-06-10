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
   * Reducer appends new entries — never replaces.
   */
  priorHandoffs: Annotation({
    reducer: (x, y) => [...(x ?? []), ...(y ?? [])],
    default: () => [],
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
