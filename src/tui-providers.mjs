import { DEFAULT_PROVIDERS } from "./task-store.mjs";
import { BUILTIN_ADAPTERS, shareableDef } from "./tui/edit-core.mjs";
import { pickFromList, applyRecentUpdate } from "./tui-pickers.mjs";
import { ENV_KEY_DENYLIST } from "./agent-runner.mjs";
import { aliasNames, normalizeAlias, aliasToConfig } from "./providers.mjs";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Provider edits persist into the shareable config.json, so the write base
// must be the RAW config — writing the effective (overlay-merged) view would
// leak config.local.json values into config.json.
async function shareableProviders(store) {
  const raw = typeof store.readConfigRaw === "function" ? await store.readConfigRaw() : null;
  return structuredClone(raw?.providers ?? DEFAULT_PROVIDERS);
}

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

function accountSummary(acc) {
  const envKeys = Object.keys(acc.env ?? {});
  const envNote = envKeys.length ? ` (env: ${envKeys.join(", ")})` : "";
  return `${acc.name} → ${acc.command}${envNote}`;
}

// Persist the normalized account list back to config, collapsing fully-default
// accounts to bare strings (aliasToConfig) so configs stay tidy.
async function persistAccounts(store, providerKey, accounts) {
  const providers = await shareableProviders(store);
  const def = providers[providerKey];
  if (!def) return;
  const aliases = accounts.map((acc) => aliasToConfig(acc, providerKey));
  providers[providerKey] = { ...shareableDef(providers, providerKey, def), aliases };
  await store.writeConfig({ providers });
}

// KEY=value / -KEY loop. Returns the edited env map. Keys are validated against
// the env-name shape and the same denylist the spawn path enforces, so a
// denylisted key can never be stored.
async function editAccountEnv(ask, output, env) {
  const next = { ...env };
  while (true) {
    const entries = Object.entries(next);
    output.write(`${[
      "\n-- Env --",
      ...(entries.length ? entries.map(([k, v]) => `  ${k}=${v}`) : ["  (none)"]),
      "Enter KEY=value to set, -KEY to remove, blank to finish.",
    ].join("\n")}\n`);
    const raw = String(await ask("> ") ?? "").trim();
    if (!raw) return next;
    if (raw.startsWith("-")) {
      delete next[raw.slice(1).trim()];
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq < 1) { output.write("Format: KEY=value\n"); continue; }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!ENV_NAME_RE.test(key)) { output.write(`Invalid env key: ${key}\n`); continue; }
    if (ENV_KEY_DENYLIST.test(key)) { output.write(`Refused (denylisted): ${key}\n`); continue; }
    next[key] = value;
  }
}

async function runAccountMenu({ ask, output, store, providerKey, index }) {
  while (true) {
    const config = await store.readConfig();
    const def = config.providers?.[providerKey];
    if (!def) return;
    const accounts = (def.aliases ?? []).map((entry) => normalizeAlias(entry, providerKey));
    const acc = accounts[index];
    if (!acc) return;
    const envText = Object.keys(acc.env).length
      ? Object.entries(acc.env).map(([k, v]) => `${k}=${v}`).join(", ")
      : "(none)";
    output.write(`${[
      `\n-- Account: ${acc.name} --`,
      `1. Name:    ${acc.name}`,
      `2. Command: ${acc.command}`,
      `3. Env:     ${envText}`,
      "d. Delete account",
      "b. Back",
    ].join("\n")}\n`);
    const choice = String(await ask("> ") ?? "").trim().toLowerCase();
    if (!choice || choice === "b" || choice === "q") return;

    if (choice === "d") {
      accounts.splice(index, 1);
      await persistAccounts(store, providerKey, accounts);
      output.write("Deleted.\n");
      return;
    } else if (choice === "1") {
      const v = String(await ask(`Name [${acc.name}]: `) ?? "").trim();
      if (v && v !== acc.name) {
        if (accounts.some((a, i) => i !== index && a.name === v)) { output.write(`Name "${v}" already used.\n`); continue; }
        accounts[index] = { ...acc, name: v };
        await persistAccounts(store, providerKey, accounts);
        output.write("Saved.\n");
      }
    } else if (choice === "2") {
      const v = String(await ask(`Command [${acc.command}]: `) ?? "").trim();
      if (v) {
        accounts[index] = { ...acc, command: v };
        await persistAccounts(store, providerKey, accounts);
        output.write("Saved.\n");
      }
    } else if (choice === "3") {
      accounts[index] = { ...acc, env: await editAccountEnv(ask, output, acc.env) };
      await persistAccounts(store, providerKey, accounts);
      output.write("Saved.\n");
    } else {
      output.write("Unknown option.\n");
    }
  }
}

async function runAccountsEditor({ ask, output, store, providerKey }) {
  while (true) {
    const config = await store.readConfig();
    const def = config.providers?.[providerKey];
    if (!def) return;
    const accounts = (def.aliases ?? []).map((entry) => normalizeAlias(entry, providerKey));
    output.write(`${[
      `\n== Accounts: ${providerKey} ==`,
      ...accounts.map((acc, i) => `${i + 1}. ${accountSummary(acc)}`),
      "a. Add account",
      "b. Back",
    ].join("\n")}\n`);
    const choice = String(await ask("> ") ?? "").trim().toLowerCase();
    if (!choice || choice === "b" || choice === "q") return;

    if (choice === "a") {
      const name = String(await ask("Account name: ") ?? "").trim();
      if (!name) { output.write("Cancelled.\n"); continue; }
      if (accounts.some((a) => a.name === name)) { output.write(`Name "${name}" already used.\n`); continue; }
      const command = String(await ask(`Command [${providerKey}]: `) ?? "").trim() || providerKey;
      const env = await editAccountEnv(ask, output, {});
      accounts.push({ name, command, env });
      await persistAccounts(store, providerKey, accounts);
      output.write(`Account "${name}" added.\n`);
      continue;
    }

    const index = Number(choice);
    if (Number.isInteger(index) && index >= 1 && index <= accounts.length) {
      await runAccountMenu({ ask, output, store, providerKey, index: index - 1 });
      continue;
    }
    output.write("Unknown option.\n");
  }
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
      `4. Accounts:      ${aliasNames(def).join(", ")}`,
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
        const providers = await shareableProviders(store);
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
        const providers = await shareableProviders(store);
        providers[providerKey] = { ...shareableDef(providers, providerKey, def), label: v };
        await store.writeConfig({ providers });
        output.write("Saved.\n");
      }
    } else if (choice === "2") {
      output.write(`Built-in adapters: ${BUILTIN_ADAPTERS.join(", ")}\nOr "custom" for a custom template.\n`);
      const v = String(await ask(`Adapter [${def.adapter}]: `) ?? "").trim();
      if (v) {
        const providers = await shareableProviders(store);
        let patch = { ...shareableDef(providers, providerKey, def), adapter: v };
        if (v === "custom" || v.startsWith("custom")) {
          const tmpl = String(await ask(`Command template (e.g. {alias} --model {model}) [${def.custom?.command_template ?? ""}]: `) ?? "").trim();
          const via = String(await ask(`Prompt via stdin|arg [${def.custom?.prompt_via ?? "stdin"}]: `) ?? "").trim();
          // empty answers keep the existing template/mode shown in the prompt
          patch = {
            ...patch,
            custom: {
              command_template: tmpl || def.custom?.command_template || "{alias}",
              prompt_via: ["stdin", "arg"].includes(via) ? via : (def.custom?.prompt_via ?? "stdin"),
            },
          };
        }
        providers[providerKey] = patch;
        await store.writeConfig({ providers });
        output.write("Saved.\n");
      }
    } else if (choice === "3") {
      const v = await pickFromList({
        ask, output,
        label: "Default alias",
        options: aliasNames(def),
        current: def.default_alias,
        recent: config.recent?.aliases_by_provider?.[providerKey] ?? [],
        allowDefault: false,
      });
      if (v !== def.default_alias) {
        const providers = await shareableProviders(store);
        providers[providerKey] = { ...shareableDef(providers, providerKey, def), default_alias: v };
        // recent lists are persisted too — base them on the raw config so
        // overlay-only recents stay out of config.json
        const rawRecent = (await store.readConfigRaw())?.recent ?? {};
        const updated = applyRecentUpdate({ ...config, recent: rawRecent, providers }, { kind: "aliases_by_provider", key: providerKey, value: v });
        await store.writeConfig({ providers: updated.providers, recent: updated.recent });
        output.write("Saved.\n");
      }
    } else if (choice === "4") {
      await runAccountsEditor({ ask, output, store, providerKey });
    } else if (choice === "5") {
      const newList = await editStringList(ask, output, "Models", def.models ?? []);
      const providers = await shareableProviders(store);
      providers[providerKey] = { ...shareableDef(providers, providerKey, def), models: newList };
      await store.writeConfig({ providers });
      output.write("Saved.\n");
    } else if (choice === "6") {
      const newList = await editStringList(ask, output, "Efforts", def.efforts ?? []);
      const providers = await shareableProviders(store);
      providers[providerKey] = { ...shareableDef(providers, providerKey, def), efforts: newList };
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
  const providers = await shareableProviders(store);
  providers[key] = newDef;
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
