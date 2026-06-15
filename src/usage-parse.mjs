// Per-provider token-usage parsing.
//
// parseUsage(provider, stdout) → number  — total tokens for a stage, or 0.
//
// Pure and TOTAL: never throws. Returns 0 on any miss — unknown provider,
// missing/garbage usage, JSON.parse failure, or the 64KB ANSI-stripped tail
// truncation that can drop the trailing usage line (src/agent-runner.mjs).
//
// Each branch mirrors the structured output its adapter requests:
//   claude       — `--output-format stream-json --verbose`; final
//                  {type:"result", …, usage:{input_tokens,output_tokens}}.
//   codex        — `exec --json`; JSONL events carrying usage/token_usage.
//   copilot      — `--output-format json` single doc with a usage field.
//   antigravity  — `--output-format json` single doc with a usage field.
//   gemini       — `--output-format json`; response.usageMetadata
//                  {promptTokenCount,candidatesTokenCount,totalTokenCount}.
//   ollama / unknown ⇒ 0 (no structured usage emitted).
//
// New CLI formats are added ONLY here.

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Sum a usage-like object: prefer an explicit positive total, else add the
// input/prompt + output/completion components. 0 when nothing usable.
function sumTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const total = num(usage.total_tokens) || num(usage.totalTokenCount);
  if (total > 0) return total;
  const input = num(usage.input_tokens) || num(usage.prompt_tokens) || num(usage.promptTokenCount);
  const output =
    num(usage.output_tokens) || num(usage.completion_tokens) || num(usage.candidatesTokenCount);
  const sum = input + output;
  return sum > 0 ? sum : 0;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Find a usage-like object anywhere a provider commonly nests it. Includes
// codex's `token_count` event shape, which carries usage under `info`
// (e.g. {type:"token_count", info:{total_token_usage:{input_tokens,…}}}),
// sometimes wrapped once more under `msg`.
function extractUsage(obj) {
  if (!obj || typeof obj !== "object") return null;
  return (
    obj.usage
    ?? obj.token_usage
    ?? obj.stats?.usage
    ?? obj.metadata?.usage
    ?? obj.response?.usageMetadata
    ?? obj.usageMetadata
    ?? obj.info?.total_token_usage
    ?? obj.info?.token_usage
    ?? obj.info?.usage
    ?? obj.msg?.info?.total_token_usage
    ?? obj.msg?.info?.token_usage
    ?? null
  );
}

// Scan JSONL stdout last→first; return the first parseable line whose object
// (or a known nested field) yields a positive token sum.
function scanJsonl(stdout) {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const obj = safeJson(line);
    if (!obj) continue;
    const usage = extractUsage(obj);
    const sum = sumTokens(usage) || sumTokens(obj);
    if (sum > 0) return sum;
  }
  return 0;
}

// Whole-document JSON (copilot/antigravity/gemini), with a JSONL fallback.
function parseSingleDoc(stdout) {
  const obj = safeJson(stdout.trim());
  if (obj) {
    const usage = extractUsage(obj);
    const sum = sumTokens(usage) || sumTokens(obj);
    if (sum > 0) return sum;
  }
  return scanJsonl(stdout);
}

export function parseUsage(provider, stdout) {
  try {
    if (typeof stdout !== "string" || stdout.length === 0) return 0;
    const key = typeof provider === "string" ? provider.toLowerCase() : "";
    switch (key) {
      case "claude":
      case "codex":
        return scanJsonl(stdout);
      case "copilot":
      case "antigravity":
      case "gemini":
        return parseSingleDoc(stdout);
      default:
        return 0;
    }
  } catch {
    return 0;
  }
}
