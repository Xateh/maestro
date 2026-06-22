// Pure per-run cost aggregation. The authoritative per-step tokens already
// persist in step rows (parseUsage → appendStep); this derives a running total
// for the stage-event stream. No new persistence.

import { priceFor } from "./provider-pricing.mjs";

export function accumulateCost(prev, step) {
  const tokens = (prev?.tokens ?? 0) + (Number(step?.tokens) || 0);
  const stepUsd = priceFor(step?.provider, step?.model, Number(step?.tokens) || 0);
  const usd = stepUsd === undefined
    ? prev?.usd
    : (prev?.usd ?? 0) + stepUsd;
  return usd === undefined ? { tokens } : { tokens, usd };
}
