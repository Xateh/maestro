# Local LLM Integration (Ollama) — Design

Date: 2026-06-12
Status: Approved for implementation (autonomous run; user requested
"implement and test local llm integration, fix all issues, run OCR and
system evaluator agent, ensure compatibility and simple integrations for
all users").

## Goal

Let Maestro dispatch a fully local LLM with zero API keys, the same way it
dispatches `claude`/`codex`/`gemini`: as a CLI already installed on the
machine. Ship two runnable example agents (OCR, system evaluator) that
demonstrate the integration end to end.

## Approach chosen

**Built-in Ollama adapter** (`built-in:ollama`). Ollama is the de facto
standard local-LLM runtime, ships a CLI (`ollama run <model>`), reads the
prompt from stdin non-interactively, and supports multimodal models by
detecting image paths embedded in the prompt. This matches Maestro's
"CLI agents, no API keys" architecture exactly — no HTTP client code, no
new dependency.

Alternatives considered:

1. *HTTP client against `localhost:11434` (OpenAI-compatible API)* —
   rejected: breaks the "Maestro wraps CLIs, not APIs" architecture and
   adds bespoke client code to maintain.
2. *Custom-adapter docs only, no built-in* — rejected as the primary path:
   works today but isn't "simple integration for all users". Kept as the
   documented escape hatch for other runtimes (LM Studio `lms`,
   llama.cpp `llama-cli`), which the existing `custom` adapter template
   already covers.

## Components

### 1. Adapter — `src/adapters/ollama.mjs`

`buildOllamaCommand({ prompt, cwd, alias = "ollama", model = null })` →
`{ command: alias, args: ["run", model || "llama3.2"], cwd, stdin: prompt }`.

- Prompt via **stdin** (long prompts never hit argv limits; matches the
  claude/codex adapters).
- No effort flag (Ollama has none); `effort` is accepted and ignored, like
  the copilot adapter.
- Minimal argv — no version-fragile flags (`--hidethinking` etc.) so any
  Ollama release works ("ensure compatibility").

### 2. Wiring

- `src/adapters/registry.mjs`: register `"built-in:ollama"`.
- `src/agent-runner.mjs`: legacy v1 branch `provider === "ollama"`
  (parity with the other built-ins).
- `src/task-store.mjs` `DEFAULT_PROVIDERS`: `ollama` entry
  (label "Ollama (local)", alias `ollama`, models
  `llama3.2`, `qwen3`, `llama3.2-vision`). The v1→v2 config migration
  spreads `DEFAULT_PROVIDERS`, so migrated configs pick it up for free.
- `src/tui-providers.mjs` `BUILTIN_ADAPTERS`: add `built-in:ollama` so the
  TUI provider editor offers it.

### 3. Example agents — `scripts/local-agents.mjs`

One small script, two subcommands, run through the real
`TerminalAgentRunner` + `built-in:ollama` provider def (so it exercises
the actual dispatch path, not a shortcut):

- `ocr <image>` — OCR agent. Resolves the image to an absolute path,
  verifies it exists, prompts a local **vision** model
  (default `llama3.2-vision`) to transcribe all text. Ollama's CLI feeds
  the image to the model when its path appears in the prompt.
- `eval` — system evaluator agent. Gathers host facts with `node:os` /
  `fs.statfs` (platform, kernel, CPU, RAM, free disk, Node version) and
  asks a local text model (default `llama3.2`) to assess readiness for
  running local models and flag issues.

Env overrides: `MAESTRO_OLLAMA_BIN`, `MAESTRO_OLLAMA_MODEL`,
`MAESTRO_OLLAMA_VISION_MODEL`. Logs land in `.maestro/logs/local-agents/`.
Missing-binary failures print install instructions instead of a stack
trace.

npm scripts: `agent:ocr`, `agent:eval`.

### 4. Tests — `test/maestro-ollama.test.mjs`

- Unit: command shape, default model, alias/model overrides, prompt kept
  out of argv, effort ignored.
- Wiring: registry resolves `built-in:ollama`; `DEFAULT_PROVIDERS.ollama`
  uses it; legacy `buildAgentCommand({ provider: "ollama" })` works.
- Integration: a stub `ollama` executable (shell script) is dropped in a
  temp dir; `TerminalAgentRunner.runStep` dispatches it via the provider
  def; assertions cover argv (`run <model>`), stdin delivery, stdout
  capture, and on-disk logs.
- End-to-end: both `scripts/local-agents.mjs` subcommands run as child
  processes against the stub binary.

A real Ollama install (plus a multi-GB vision model) is deliberately not
required by CI or this machine (disk ~95% full, 5 GB RAM); the stub
verifies every Maestro-side seam. Real-model usage is documented.

### 5. Docs

- New `docs/local-llm.md`: install Ollama, pull models, select the
  provider per role, run the example agents, and custom-adapter templates
  for LM Studio / llama.cpp.
- `docs/configuration.md`: ollama provider example.
- `README.md`: add `ollama` to the supported-CLI list and a local-LLM
  feature bullet.

## Error handling

- Unknown model / daemon not running → Ollama exits non-zero; the runner
  already surfaces `agent_failed` with stderr tails and log paths.
- Binary missing → runner's bash-alias fallback exits 127; the agent
  script catches it and prints install guidance.
- OCR image path missing → script exits 1 with a clear message before any
  model call.

## Out of scope (YAGNI)

- No streaming/JSON output parsing for Ollama (plain text is the contract).
- No automatic model pulling (`ollama pull`) — surfaced in docs instead;
  Maestro never installs software on the host.
- No first-class adapters for LM Studio/llama.cpp — `custom` adapter
  covers them; promote later if demand shows.
