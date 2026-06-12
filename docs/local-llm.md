# Local LLMs in Maestro

Maestro can seat a fully local model at any role — planner, executor,
reviewer, or a custom role — with the same zero-API-key model it uses for
cloud CLIs. The built-in integration targets [Ollama](https://ollama.com);
any other local runtime works through the `custom` adapter.

## Quick start (Ollama)

```bash
# 1. Install Ollama (one-time)
curl -fsSL https://ollama.com/install.sh | sh     # Linux
# brew install ollama                             # macOS

# 2. Pull a model
ollama pull llama3.2            # small, fast text model
ollama pull llama3.2-vision     # for the OCR agent (multimodal)

# 3. Verify Maestro can dispatch it
npm run agent:eval
```

That's it. The `ollama` provider ships in the default config
(`adapter: "built-in:ollama"`), so it appears in the TUI provider picker and
can be assigned to any role immediately.

## How it works

The adapter builds `ollama run <model>` and pipes the prompt over stdin —
exactly how Maestro drives `claude` and `codex`. No HTTP client, no API key,
no daemon configuration. Stdout is captured and logged like any other
provider step. The argv is intentionally minimal so every Ollama release
works unmodified.

Multimodal models (vision) receive images by absolute file path embedded in
the prompt text; the Ollama CLI detects and loads them.

## Example agents

Two ready-made agents exercise the full dispatch path
(`scripts/local-agents.mjs`):

| Command | Agent | Default model |
|---|---|---|
| `npm run agent:ocr -- path/to/image.png` | OCR — transcribes all text in an image | `llama3.2-vision` |
| `npm run agent:eval` | System evaluator — assesses host readiness (disk, RAM, load) for local-LLM work | `llama3.2` |

Logs land in `.maestro/logs/local-agents/<timestamp>/`.

Environment overrides:

| Variable | Purpose | Default |
|---|---|---|
| `MAESTRO_OLLAMA_BIN` | Binary or alias to invoke | `ollama` |
| `MAESTRO_OLLAMA_MODEL` | Text model | `llama3.2` |
| `MAESTRO_OLLAMA_VISION_MODEL` | Vision model for OCR | `llama3.2-vision` |

## Assigning a local model to a workflow role

In `.maestro/workflow.json`, point a role at the provider:

```jsonc
"reviewer": {
  "provider": "ollama",
  "model": "qwen3",
  "permission": "read",
  "prompt_template": "reviewer"
}
```

Or pick `ollama` from the TUI's provider menu. Mixing is the point: e.g.
cloud `claude` plans, cloud `codex` executes, local `qwen3` reviews — code
never leaves the machine for the review step.

## Choosing models

| Need | Suggestion | RAM |
|---|---|---|
| Fast triage / drafting | `llama3.2` (3B) | ~4 GB |
| OCR / image input | `llama3.2-vision` (11B) | ~8 GB |
| Stronger reasoning | `qwen3` (8B+) | ~8 GB+ |

Rule of thumb: keep a few GB of headroom beyond the model size; the
`agent:eval` system evaluator will warn you when the host is tight.

## Other local runtimes (LM Studio, llama.cpp, …)

Anything with a non-interactive CLI works via the `custom` adapter — no code
changes needed:

```jsonc
// LM Studio
"lmstudio": {
  "label": "LM Studio",
  "adapter": "custom",
  "default_alias": "lms",
  "custom": {
    "command_template": "{alias} chat {model}",
    "prompt_via": "stdin"
  }
}

// llama.cpp
"llamacpp": {
  "label": "llama.cpp",
  "adapter": "custom",
  "default_alias": "llama-cli",
  "custom": {
    "command_template": "{alias} -m {model} -no-cnv",
    "prompt_via": "stdin"
  }
}
```

See [configuration.md](configuration.md#provider-adapters) for the full
template placeholder list.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Install Ollama (https://ollama.com/download)` | Binary not on PATH — install, or set `MAESTRO_OLLAMA_BIN` |
| `agent_failed … exited with 1` and stderr mentions the model name | Model not pulled — `ollama pull <model>` |
| Hangs then `agent_timeout` | Daemon not running — `ollama serve` (the desktop installs start it automatically) |
| Vision model answers without reading the image | Use an absolute image path; confirm the model is multimodal (`ollama show <model>`) |
