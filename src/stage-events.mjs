// Per-stage events — a PROJECTION over the steps maestro already records.
//
// There is no events table and no second write path: getStageEvents(task) =
// task.steps.map(buildStageEvent). The projection can never diverge from the
// record it describes. OTel emission mirrors each event as a span and is a
// no-op when no collector/tracer is registered.
//
// buildStageEvent / getStageEvents are PURE and TOTAL — they never throw on
// partial, garbage, or null input; missing fields yield schema defaults
// ("" / 0 / []). Output conforms to the SP1 `stage_event` schema
// (workflow_id, stage, model, tokens, duration_ms, status, artifacts) plus
// the additive role/provider cross-reference fields.

import { trace } from "@opentelemetry/api";

function durationMs(startedAt, completedAt) {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const ms = end - start;
  return Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

// Map a single step to a schema-shaped stage_event. Total: never throws.
export function buildStageEvent({ task, step } = {}) {
  const s = step ?? {};
  const artifacts = [s.handoff_path, s.stdout_path, s.stderr_path].filter(
    (p) => typeof p === "string" && p.length > 0,
  );
  return {
    workflow_id: typeof task?.workflow === "string" && task.workflow.length > 0
      ? task.workflow
      : "default",
    stage: typeof s.role === "string" ? s.role : "",
    model: typeof s.model === "string" ? s.model : "",
    tokens: typeof s.tokens === "number" && Number.isFinite(s.tokens) ? s.tokens : 0,
    duration_ms: durationMs(s.started_at, s.completed_at),
    status: typeof s.status === "string" ? s.status : "",
    artifacts,
    // additive (schema allows extras) — for cross-referencing the source step.
    role: typeof s.role === "string" ? s.role : "",
    provider: typeof s.provider === "string" ? s.provider : "",
  };
}

// Project every recorded step into a stage_event, in order. One event per
// step transition (a retry honestly shows as two events). Total.
export function getStageEvents(task) {
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  return steps.map((step) => buildStageEvent({ task, step }));
}

// Mirror an event as an OpenTelemetry span. Fully guarded: a no-op tracer is
// returned when no SDK is registered, and any failure is swallowed so
// observability never breaks a run.
export function emitOtelStageEvent(event) {
  try {
    const tracer = trace.getTracer("maestro");
    const span = tracer.startSpan("maestro.stage");
    span.setAttributes({
      "maestro.workflow_id": String(event?.workflow_id ?? ""),
      "maestro.stage": String(event?.stage ?? ""),
      "maestro.model": String(event?.model ?? ""),
      "maestro.tokens": Number.isFinite(event?.tokens) ? event.tokens : 0,
      "maestro.duration_ms": Number.isFinite(event?.duration_ms) ? event.duration_ms : 0,
      "maestro.status": String(event?.status ?? ""),
      "maestro.provider": String(event?.provider ?? ""),
      "maestro.artifacts": JSON.stringify(event?.artifacts ?? []),
    });
    span.end();
  } catch {
    /* observability never breaks a run */
  }
}
