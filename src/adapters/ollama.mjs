export const DEFAULT_OLLAMA_MODEL = "llama3.2";

// Ollama has no effort/permission concepts; `ollama run <model>` reads the
// prompt from stdin when not attached to a TTY. Argv stays minimal so any
// Ollama release works. Multimodal models receive images via absolute file
// paths embedded in the prompt text — the Ollama CLI detects and loads them.
export function buildOllamaCommand({
  prompt,
  cwd,
  alias = "ollama",
  model = null,
} = {}) {
  return {
    command: alias,
    args: ["run", model || DEFAULT_OLLAMA_MODEL],
    cwd,
    stdin: prompt,
  };
}
