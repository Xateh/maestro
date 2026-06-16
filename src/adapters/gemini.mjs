export function buildGeminiCommand({
  prompt,
  cwd,
  alias = "gemini",
  model = null,
  effort = null,
  // Advisory only: tool policy is injected upstream as a prompt block (D2).
  tools = null,
  deny_tools = null,
} = {}) {
  void tools;
  void deny_tools;
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
