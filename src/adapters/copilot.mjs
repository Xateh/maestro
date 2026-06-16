export function buildCopilotCommand({
  prompt,
  cwd,
  alias = "copilot",
  model = null,
  mode = "interactive",
  // Advisory only: tool policy is injected upstream as a prompt block (D2).
  tools = null,
  deny_tools = null,
} = {}) {
  void tools;
  void deny_tools;
  const args = ["-p", prompt, "--output-format", "json", "--mode", mode];
  if (model) {
    args.push("--model", model);
  }
  return {
    command: alias,
    args,
    cwd,
    stdin: null,
  };
}
