export function buildGeminiCommand({
  prompt,
  cwd,
  alias = "gemini",
  model = null,
  effort = null,
} = {}) {
  const args = ["-p", prompt, "--output-format", "json"];
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  return {
    command: alias,
    args,
    cwd,
    stdin: null,
  };
}
