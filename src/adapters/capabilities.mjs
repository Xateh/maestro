const DEFAULT_CAPS = { plan: true, execute: true, review: true };

export const BUILTIN_CAPS = {
  claude: { ...DEFAULT_CAPS },
  codex: { ...DEFAULT_CAPS },
  gemini: { ...DEFAULT_CAPS },
  copilot: { ...DEFAULT_CAPS },
  antigravity: { ...DEFAULT_CAPS },
  ollama: { ...DEFAULT_CAPS },
};

function adapterBase(adapterId) {
  return String(adapterId ?? "").replace(/^built-in:/, "");
}

export function resolveCapabilities(providerDef = {}, adapterId = providerDef?.adapter) {
  const defaults = BUILTIN_CAPS[adapterBase(adapterId)] ?? DEFAULT_CAPS;
  return {
    ...defaults,
    ...(providerDef?.capabilities ?? {}),
  };
}
