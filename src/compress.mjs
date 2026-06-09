/**
 * Headroom compression wrapper for Symphony prior-output compaction.
 *
 * Sends agent stdout to the headroom proxy's /v1/compress endpoint (OSS,
 * no license required). Start the proxy before use:
 *   headroom proxy --port 8787
 *
 * The text is wrapped as an assistant message (user messages are protected
 * from compression by the proxy). Compressed output uses CCR format — agents
 * can retrieve full content via the headroom_retrieve MCP tool if needed.
 *
 * First call for new content takes ~20s (cold RTK analysis); subsequent calls
 * for the same content hit the cache at ~0.1s. Falls back to null when the
 * proxy is not running, so byte-trim remains active.
 *
 * To enable: set prior_output_compression:"headroom" in .symphony/config.json.
 * Port is read from HEADROOM_PROXY_URL env var (default http://localhost:8787).
 * For transparent LLM-call compression (zero-code): set
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:8787 in Symphony's env — all spawned
 *   agents inherit it via agent-runner.mjs:203.
 *
 * Returns:
 *   { text, compressedBytes } on success
 *   null                      when compression offers no improvement (not an error)
 *   { error: true }           when the proxy is unavailable or the call failed
 */

let _client = null;

export async function headroomCompact(text) {
  try {
    const { compress, HeadroomClient } = await import("headroom-ai");
    const baseUrl = process.env.HEADROOM_PROXY_URL ?? "http://localhost:8787";
    if (!_client) _client = new HeadroomClient({ baseUrl });
    const result = await compress(
      [
        { role: "user", content: "task" },
        { role: "assistant", content: text },
      ],
      { client: _client, model: "claude-sonnet-4-6" },
    );
    const compressed = result.messages[1]?.content;
    if (typeof compressed !== "string") return null;
    const compressedBytes = Buffer.byteLength(compressed, "utf8");
    if (compressedBytes >= Buffer.byteLength(text, "utf8")) return null;
    return { text: compressed, compressedBytes };
  } catch {
    return { error: true };
  }
}
