// Ollama local-model adapter: `ollama run <model>` with the prompt on stdin.
// No auth needed — Ollama serves local models (https://ollama.com).
export function buildOllamaCommand({
  prompt,
  cwd,
  alias = null,
  model = null,
} = {}) {
  return {
    command: alias ?? "ollama",
    args: ["run", model || "llama3.2"],
    cwd,
    stdin: prompt,
  };
}
