import { pickFromList, applyRecentUpdate } from "./tui-pickers.mjs";

const BUILTIN_ADAPTERS = [
  "built-in:claude",
  "built-in:codex",
  "built-in:copilot",
  "built-in:gemini",
  "built-in:antigravity",
];

function providerSummary(key, def) {
  const aliasCount = (def.aliases ?? []).length;
  const modelCount = (def.models ?? []).length;
  const aliasNote = aliasCount === 1 ? "1 alias" : `${aliasCount} aliases`;
  const modelNote = modelCount === 1 ? "1 model" : `${modelCount} models`;
  return `${key.padEnd(12)} ${def.adapter ?? "?"} (${aliasNote}, ${modelNote})`;
}

async function editStringList(ask, output, label, current = []) {
  output.write(`${label} (comma-separated, current: ${current.join(", ") || "none"})\n`);
  const raw = String(await ask("> ") ?? "").trim();
  if (!raw) return current;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function runProviderEditor({ ask, output, store, providerKey }) {
  while (true) {
    const config = await store.readConfig();
    const def = config.providers?.[providerKey];
    if (!def) {
      output.write(`Provider "${providerKey}" not found.\n`);
      return;
    }
    output.write(`${[
      `\n== Provider: ${providerKey} ==`,
      `1. Label:         ${def.label}`,
      `2. Adapter:       ${def.adapter}`,
      `3. Default alias: ${def.default_alias}`,
      `4. Aliases:       ${(def.aliases ?? []).join(", ")}`,
      `5. Models:        ${(def.models ?? []).join(", ") || "(none)"}`,
      `6. Efforts:       ${(def.efforts ?? []).join(", ") || "(none)"}`,
      "d. Delete provider",
      "b. Back",
    ].join("\n")}\n`);

    const choice = String(await ask("> ") ?? "").trim().toLowerCase();
    if (!choice || choice === "b" || choice === "q") return;

    if (choice === "d") {
      const confirm = String(await ask(`Delete provider "${providerKey}"? y/n [n]: `) ?? "").trim().toLowerCase();
      if (confirm === "y" || confirm === "yes") {
        const providers = { ...config.providers };
        delete providers[providerKey];
        await store.writeConfig({ providers });
        output.write(`Provider "${providerKey}" deleted.\n`);
        return;
      }
      continue;
    }

    if (choice === "1") {
      const v = String(await ask(`Label [${def.label}]: `) ?? "").trim();
      if (v) {
        const providers = { ...config.providers, [providerKey]: { ...def, label: v } };
        await store.writeConfig({ providers });
        output.write("Saved.\n");
      }
    } else if (choice === "2") {
      output.write(`Built-in adapters: ${BUILTIN_ADAPTERS.join(", ")}\nOr "custom" for a custom template.\n`);
      const v = String(await ask(`Adapter [${def.adapter}]: `) ?? "").trim();
      if (v) {
        let patch = { ...def, adapter: v };
        if (v === "custom" || v.startsWith("custom")) {
          const tmpl = String(await ask(`Command template (e.g. {alias} --model {model}) [${def.custom?.command_template ?? ""}]: `) ?? "").trim();
          const via = String(await ask(`Prompt via stdin|arg [${def.custom?.prompt_via ?? "stdin"}]: `) ?? "").trim();
          patch = { ...patch, custom: { command_template: tmpl || "{alias}", prompt_via: ["stdin", "arg"].includes(via) ? via : "stdin" } };
        }
        const providers = { ...config.providers, [providerKey]: patch };
        await store.writeConfig({ providers });
        output.write("Saved.\n");
      }
    } else if (choice === "3") {
      const v = await pickFromList({
        ask, output,
        label: "Default alias",
        options: def.aliases ?? [],
        current: def.default_alias,
        recent: config.recent?.aliases_by_provider?.[providerKey] ?? [],
        allowDefault: false,
      });
      if (v !== def.default_alias) {
        const providers = { ...config.providers, [providerKey]: { ...def, default_alias: v } };
        const updated = applyRecentUpdate({ ...config, providers }, { kind: "aliases_by_provider", key: providerKey, value: v });
        await store.writeConfig({ providers: updated.providers, recent: updated.recent });
        output.write("Saved.\n");
      }
    } else if (choice === "4") {
      const newList = await editStringList(ask, output, "Aliases", def.aliases ?? []);
      const providers = { ...config.providers, [providerKey]: { ...def, aliases: newList } };
      await store.writeConfig({ providers });
      output.write("Saved.\n");
    } else if (choice === "5") {
      const newList = await editStringList(ask, output, "Models", def.models ?? []);
      const providers = { ...config.providers, [providerKey]: { ...def, models: newList } };
      await store.writeConfig({ providers });
      output.write("Saved.\n");
    } else if (choice === "6") {
      const newList = await editStringList(ask, output, "Efforts", def.efforts ?? []);
      const providers = { ...config.providers, [providerKey]: { ...def, efforts: newList } };
      await store.writeConfig({ providers });
      output.write("Saved.\n");
    } else {
      output.write("Unknown option.\n");
    }
  }
}

async function runAddProviderWizard({ ask, output, store }) {
  output.write("\n== Add Provider ==\n");

  const key = String(await ask("Provider key (slug, e.g. myllm): ") ?? "").trim();
  if (!key) { output.write("Cancelled.\n"); return; }

  const config = await store.readConfig();
  if (config.providers?.[key]) {
    output.write(`Provider "${key}" already exists. Edit it from the providers list.\n`);
    return;
  }

  const label = String(await ask(`Label [${key}]: `) ?? "").trim() || key;
  output.write(`Adapter options: ${BUILTIN_ADAPTERS.join(", ")}, custom\n`);
  const adapter = String(await ask("Adapter: ") ?? "").trim();
  if (!adapter) { output.write("Cancelled.\n"); return; }

  let custom;
  if (adapter === "custom" || adapter.startsWith("custom")) {
    const tmpl = String(await ask("Command template (e.g. {alias} --model {model}): ") ?? "").trim();
    const via = String(await ask("Prompt via stdin|arg [stdin]: ") ?? "").trim();
    custom = { command_template: tmpl || "{alias}", prompt_via: ["arg"].includes(via) ? "arg" : "stdin" };
  }

  const defaultAlias = String(await ask(`Default alias [${key}]: `) ?? "").trim() || key;
  const aliasesRaw = String(await ask(`Aliases (comma-sep) [${defaultAlias}]: `) ?? "").trim();
  const aliases = aliasesRaw ? aliasesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [defaultAlias];
  const modelsRaw = String(await ask("Models (comma-sep, optional): ") ?? "").trim();
  const models = modelsRaw ? modelsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const effortsRaw = String(await ask("Efforts (comma-sep, optional): ") ?? "").trim();
  const efforts = effortsRaw ? effortsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const newDef = { label, adapter, default_alias: defaultAlias, aliases, models, efforts, ...(custom ? { custom } : {}) };
  const providers = { ...(config.providers ?? {}), [key]: newDef };
  await store.writeConfig({ providers });
  output.write(`Provider "${key}" added.\n`);
}

export async function runProvidersMenu({ ask, output, store }) {
  let done = false;
  while (!done) {
    const config = await store.readConfig();
    const providerEntries = Object.entries(config.providers ?? {});
    output.write(`${[
      "\n== Providers ==",
      ...providerEntries.map(([k, def], i) => `${i + 1}. ${providerSummary(k, def)}`),
      "+. Add provider (wizard)",
      "b. Back",
    ].join("\n")}\n`);

    const choice = String(await ask("> ") ?? "").trim().toLowerCase();
    if (!choice || choice === "b" || choice === "q") { done = true; continue; }

    if (choice === "+") {
      await runAddProviderWizard({ ask, output, store });
      continue;
    }

    const index = Number(choice);
    if (Number.isInteger(index) && index >= 1 && index <= providerEntries.length) {
      const [providerKey] = providerEntries[index - 1];
      await runProviderEditor({ ask, output, store, providerKey });
      continue;
    }

    output.write("Unknown option.\n");
  }
}
