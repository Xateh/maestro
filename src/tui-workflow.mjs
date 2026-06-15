import {
  PERMISSIONS,
  PROMPT_TEMPLATES,
  SKIP_VALUES,
  TRANSITION_EVENTS,
  TRANSITION_TARGETS_BUILTIN,
  addRolePatch,
} from "./tui/edit-core.mjs";
import { pickFromList, applyRecentUpdate } from "./tui-pickers.mjs";

// MVP picker: list available workflows and let the user choose which one to
// edit. Enter (empty input) keeps "default" so behavior is unchanged for the
// single-workflow case.
async function pickWorkflowName({ ask, output, store }) {
  const workflows = (await store.listWorkflows?.()) ?? [];
  if (workflows.length > 0) {
    output.write(`${[
      "\n== Workflows ==",
      ...workflows.map((w, i) => `${i + 1}. ${w.name} (${w.source})`),
      "Enter a number, or press Enter for \"default\".",
    ].join("\n")}\n`);
  }
  const raw = String(await ask("Workflow [default]: ") ?? "").trim();
  if (!raw) return "default";
  const index = Number(raw) - 1;
  if (Number.isInteger(index) && index >= 0 && index < workflows.length) {
    return workflows[index].name;
  }
  return raw;
}

function roleOneLiner(roleKey, role) {
  const alias = role.alias ? `/${role.alias}` : "";
  const model = role.model || "<default>";
  const effort = role.effort || "";
  const skip = role.skip && role.skip !== "auto" ? ` skip=${role.skip}` : "";
  return `${roleKey.padEnd(12)} ${role.provider ?? "?"}${alias} model=${model}${effort ? ` effort=${effort}` : ""}${skip}`;
}

async function runTransitionsEditor({ ask, output, workflow, roleKey }) {
  let localWorkflow = { ...workflow, transitions: { ...workflow.transitions } };
  while (true) {
    const trans = localWorkflow.transitions[roleKey] ?? {};
    const entries = Object.entries(trans);
    output.write(`${[
      `\n== Transitions: ${roleKey} ==`,
      ...entries.map(([event, target], i) => `${i + 1}. ${event.padEnd(10)} -> ${target}`),
      "+. Add transition",
      entries.length > 0 ? "d N. Delete transition" : "",
      "s. Save     b. Back (discard)",
    ].filter(Boolean).join("\n")}\n`);

    const choice = String(await ask("> ") ?? "").trim().toLowerCase();
    if (!choice || choice === "b" || choice === "q") return { workflow: null };
    if (choice === "s") return { workflow: localWorkflow };

    if (choice === "+") {
      output.write(`Events: ${TRANSITION_EVENTS.join(", ")}\n`);
      const event = String(await ask("Event: ") ?? "").trim();
      if (!event) continue;
      const allRoleKeys = Object.keys(localWorkflow.roles ?? {});
      const targets = [...TRANSITION_TARGETS_BUILTIN, ...allRoleKeys];
      output.write(`Targets: ${targets.join(", ")}\n`);
      const target = String(await ask("Target: ") ?? "").trim();
      if (!target) continue;
      localWorkflow = {
        ...localWorkflow,
        transitions: {
          ...localWorkflow.transitions,
          [roleKey]: { ...trans, [event]: target },
        },
      };
      continue;
    }

    if (choice.startsWith("d ")) {
      const idx = Number(choice.slice(2).trim()) - 1;
      if (idx >= 0 && idx < entries.length) {
        const [delEvent] = entries[idx];
        const newTrans = { ...trans };
        delete newTrans[delEvent];
        localWorkflow = {
          ...localWorkflow,
          transitions: { ...localWorkflow.transitions, [roleKey]: newTrans },
        };
      }
      continue;
    }

    const idx = Number(choice) - 1;
    if (idx >= 0 && idx < entries.length) {
      const [event] = entries[idx];
      const allRoleKeys = Object.keys(localWorkflow.roles ?? {});
      const targets = [...TRANSITION_TARGETS_BUILTIN, ...allRoleKeys];
      output.write(`Targets: ${targets.join(", ")}\n`);
      const target = String(await ask(`New target for "${event}" [${trans[event]}]: `) ?? "").trim();
      if (target) {
        localWorkflow = {
          ...localWorkflow,
          transitions: {
            ...localWorkflow.transitions,
            [roleKey]: { ...trans, [event]: target },
          },
        };
      }
      continue;
    }

    output.write("Unknown option.\n");
  }
}

async function runRoleEditor({ ask, output, store, roleKey, workflowName = "default" }) {
  while (true) {
    const config = await store.readConfig();
    const workflow = await store.readWorkflow(workflowName);
    const role = workflow.roles?.[roleKey];
    if (!role) {
      output.write(`Role "${roleKey}" not found.\n`);
      return;
    }
    const providerDef = config.providers?.[role.provider] ?? null;
    output.write(`${[
      `\n== Role: ${roleKey} ==`,
      `1. Label:       ${role.label ?? roleKey}`,
      `2. Provider:    ${role.provider ?? "?"}`,
      `3. Alias:       ${role.alias ?? (providerDef?.default_alias ?? "")}`,
      `4. Model:       ${role.model || "<cli default>"}`,
      `5. Effort:      ${role.effort || "<cli default>"}`,
      `6. Permission:  ${role.permission ?? "default"}`,
      `7. Prompt tpl:  ${role.prompt_template ?? "generic"}`,
      `8. Skip:        ${role.skip ?? "auto"}  (auto|always|never)`,
      "t. Edit transitions",
      "s. Save     b. Back",
    ].join("\n")}\n`);

    const choice = String(await ask("> ") ?? "").trim().toLowerCase();
    if (!choice || choice === "b" || choice === "q") return;

    if (choice === "t") {
      const result = await runTransitionsEditor({ ask, output, workflow, roleKey });
      if (result.workflow) {
        await store.writeWorkflow(workflowName, result.workflow);
        output.write("Transitions saved.\n");
      }
      continue;
    }

    if (choice === "s") return;

    if (choice === "1") {
      const v = String(await ask(`Label [${role.label ?? roleKey}]: `) ?? "").trim();
      if (v) {
        await store.writeWorkflow(workflowName, { roles: { ...workflow.roles, [roleKey]: { ...role, label: v } } });
        output.write("Saved.\n");
      }
    } else if (choice === "2") {
      const providerKeys = Object.keys(config.providers ?? {});
      const current = role.provider ?? "";
      const recent = config.recent?.providers_by_role?.[roleKey] ?? [];
      const v = await pickFromList({
        ask, output,
        label: "Provider",
        options: providerKeys,
        current,
        recent,
        allowDefault: false,
      });
      if (v && v !== current) {
        const updated = applyRecentUpdate(config, { kind: "providers_by_role", key: roleKey, value: v });
        await store.writeWorkflow(workflowName, { roles: { ...workflow.roles, [roleKey]: { ...role, provider: v } } });
        await store.writeConfig({ recent: updated.recent });
        output.write("Saved.\n");
      }
    } else if (choice === "3") {
      const aliases = providerDef?.aliases ?? [];
      const current = role.alias || providerDef?.default_alias || "";
      const recent = config.recent?.aliases_by_provider?.[role.provider ?? ""] ?? [];
      const v = await pickFromList({ ask, output, label: "Alias", options: aliases, current, recent, allowDefault: false });
      if (v && v !== current) {
        const updated = applyRecentUpdate(config, { kind: "aliases_by_provider", key: role.provider ?? roleKey, value: v });
        await store.writeWorkflow(workflowName, { roles: { ...workflow.roles, [roleKey]: { ...role, alias: v } } });
        await store.writeConfig({ recent: updated.recent });
        output.write("Saved.\n");
      }
    } else if (choice === "4") {
      const models = providerDef?.models ?? [];
      const current = role.model || "";
      const recent = config.recent?.models_by_provider?.[role.provider ?? ""] ?? [];
      const v = await pickFromList({ ask, output, label: "Model", options: models, current, recent });
      if (v !== current) {
        const updated = applyRecentUpdate(config, { kind: "models_by_provider", key: role.provider ?? roleKey, value: v });
        await store.writeWorkflow(workflowName, { roles: { ...workflow.roles, [roleKey]: { ...role, model: v } } });
        await store.writeConfig({ recent: updated.recent });
        output.write("Saved.\n");
      }
    } else if (choice === "5") {
      const efforts = providerDef?.efforts ?? [];
      const current = role.effort || "";
      const recent = config.recent?.efforts_by_provider?.[role.provider ?? ""] ?? [];
      const v = await pickFromList({ ask, output, label: "Effort", options: efforts, current, recent });
      if (v !== current) {
        const updated = applyRecentUpdate(config, { kind: "efforts_by_provider", key: role.provider ?? roleKey, value: v });
        await store.writeWorkflow(workflowName, { roles: { ...workflow.roles, [roleKey]: { ...role, effort: v } } });
        await store.writeConfig({ recent: updated.recent });
        output.write("Saved.\n");
      }
    } else if (choice === "6") {
      output.write(`Permissions: ${PERMISSIONS.join(", ")}\n`);
      const v = String(await ask(`Permission [${role.permission ?? "default"}]: `) ?? "").trim().toLowerCase();
      if (v && PERMISSIONS.includes(v)) {
        await store.writeWorkflow(workflowName, { roles: { ...workflow.roles, [roleKey]: { ...role, permission: v } } });
        output.write("Saved.\n");
      } else if (v) {
        output.write("Unknown permission.\n");
      }
    } else if (choice === "7") {
      output.write(`Templates: ${PROMPT_TEMPLATES.join(", ")}\n`);
      const v = String(await ask(`Prompt template [${role.prompt_template ?? "generic"}]: `) ?? "").trim().toLowerCase();
      if (v && PROMPT_TEMPLATES.includes(v)) {
        await store.writeWorkflow(workflowName, { roles: { ...workflow.roles, [roleKey]: { ...role, prompt_template: v } } });
        output.write("Saved.\n");
      } else if (v) {
        output.write("Unknown template.\n");
      }
    } else if (choice === "8") {
      output.write(`Skip values: ${SKIP_VALUES.join(", ")}\n`);
      output.write("  auto   = default behavior (planner: evaluate prompt; others: run)\n");
      output.write("  always = always skip this role\n");
      output.write("  never  = never skip this role\n");
      const v = String(await ask(`Skip [${role.skip ?? "auto"}]: `) ?? "").trim().toLowerCase();
      if (v && SKIP_VALUES.includes(v)) {
        await store.writeWorkflow(workflowName, { roles: { ...workflow.roles, [roleKey]: { ...role, skip: v } } });
        output.write("Saved.\n");
      } else if (v) {
        output.write("Unknown skip value.\n");
      }
    } else {
      output.write("Unknown option.\n");
    }
  }
}

export async function runWorkflowMenu({ ask, output, store, workflowName = null }) {
  // MVP picker: choose which named workflow to edit; default to "default" so the
  // existing single-workflow flow is unchanged when no selection is made.
  let selected = workflowName;
  if (!selected) {
    selected = await pickWorkflowName({ ask, output, store });
  }
  let done = false;
  while (!done) {
    const workflow = await store.readWorkflow(selected);
    if (!workflow) {
      output.write(`Workflow "${selected}" not found.\n`);
      return;
    }
    const roleEntries = Object.entries(workflow.roles ?? {});
    output.write(`${[
      "\n== Workflow ==",
      `Initial: ${workflow.initial ?? "planner"}`,
      ...roleEntries.map(([k, r], i) => `${i + 1}. ${roleOneLiner(k, r)}`),
      "+. Add role",
      "t. Edit all transitions",
      "i. Change initial state",
      "b. Back",
    ].join("\n")}\n`);

    const choice = String(await ask("> ") ?? "").trim().toLowerCase();
    if (!choice || choice === "b" || choice === "q") { done = true; continue; }

    if (choice === "i") {
      const roleKeys = roleEntries.map(([k]) => k);
      const v = String(await ask(`Initial state [${workflow.initial ?? "planner"}]: `) ?? "").trim();
      if (v && roleKeys.includes(v)) {
        await store.writeWorkflow(selected, { initial: v });
        output.write("Saved.\n");
      } else if (v) {
        output.write(`Unknown state "${v}". Available: ${roleKeys.join(", ")}\n`);
      }
      continue;
    }

    if (choice === "+") {
      const key = String(await ask("New role key: ") ?? "").trim();
      if (!key) continue;
      const config = await store.readConfig();
      const providerKeys = Object.keys(config.providers ?? {});
      output.write(`Providers: ${providerKeys.join(", ")}\n`);
      const provider = String(await ask("Provider: ") ?? "").trim();
      if (!provider) continue;
      const providerDef = config.providers?.[provider];
      await store.writeWorkflow(selected, addRolePatch(workflow, key, provider, providerDef));
      output.write(`Role "${key}" added.\n`);
      continue;
    }

    if (choice === "t") {
      // Show all roles for transition editing
      output.write(`Which role? ${roleEntries.map(([k], i) => `${i + 1}) ${k}`).join("  ")}\n`);
      const ridx = Number(await ask("> ") ?? "") - 1;
      if (ridx >= 0 && ridx < roleEntries.length) {
        const [roleKey] = roleEntries[ridx];
        const result = await runTransitionsEditor({ ask, output, workflow, roleKey });
        if (result.workflow) {
          await store.writeWorkflow(selected, result.workflow);
          output.write("Transitions saved.\n");
        }
      }
      continue;
    }

    const index = Number(choice) - 1;
    if (index >= 0 && index < roleEntries.length) {
      const [roleKey] = roleEntries[index];
      await runRoleEditor({ ask, output, store, roleKey, workflowName: selected });
      continue;
    }

    output.write("Unknown option.\n");
  }
}
