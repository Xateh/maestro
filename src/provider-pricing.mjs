// Best-effort USD-per-token estimate. Static table keyed by (provider, model
// prefix). Unknown => undefined (caller omits usd). NOT a billing source.
// Blended $/token (input+output averaged) is good enough for a running estimate.

const TABLE = [
  // [provider, modelPrefix, usdPerToken]
  ["claude", "claude-opus", 30 / 1_000_000],
  ["claude", "claude-sonnet", 6 / 1_000_000],
  ["claude", "claude-haiku", 1 / 1_000_000],
  ["codex", "", 10 / 1_000_000],
];

export function priceFor(provider, model, tokens) {
  if (!provider) return undefined;
  const m = String(model ?? "");
  const row = TABLE.find(
    ([p, prefix]) => p === provider && m.startsWith(prefix),
  );
  if (!row) return undefined;
  return (Number(tokens) || 0) * row[2];
}
