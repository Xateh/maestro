/**
 * Tests for the full-screen TUI:
 *   src/tui/keys.mjs    — escape-sequence decoding
 *   src/tui/layout.mjs  — ANSI-aware layout math
 *   src/tui/graph.mjs   — workflow grid graph (responsive)
 *   src/tui/screens.mjs — pure screen renderers at multiple sizes
 *   src/tui/app.mjs     — navigation, actions, settings (fake store/terminal)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeKeys } from "../src/tui/keys.mjs";
import { stripAnsi, visibleWidth, truncateAnsi, padLine, computeColumns, ANSI } from "../src/tui/layout.mjs";
import { renderWorkflowGraph, buildWorkflowChain } from "../src/tui/graph.mjs";
import { renderScreen, clampScroll, formatAge, SETTINGS_FIELDS, settingsPatch } from "../src/tui/screens.mjs";
import { createTuiApp } from "../src/tui/app.mjs";
import { DEFAULT_WORKFLOW } from "../src/task-store.mjs";
import { filterTasksForView } from "../src/tui.mjs";

const ESC = "\u001b";

// ── keys ──────────────────────────────────────────────────────────────────────

test("decodeKeys: decodes arrows, paging, enter, chars in one chunk", () => {
  const { keys, rest } = decodeKeys(`${ESC}[A${ESC}[B${ESC}[5~${ESC}[6~\rqx`);
  assert.deepEqual(keys.map((k) => k.name), ["up", "down", "pageup", "pagedown", "enter", "char", "char"]);
  assert.equal(keys[5].ch, "q");
  assert.equal(rest, "");
});

test("decodeKeys: carries incomplete escape sequences across chunks", () => {
  const first = decodeKeys(`${ESC}[`);
  assert.deepEqual(first.keys, []);
  assert.equal(first.rest, `${ESC}[`);
  const second = decodeKeys(`${first.rest}C`);
  assert.deepEqual(second.keys.map((k) => k.name), ["right"]);
});

test("decodeKeys: lone escape, ctrl-c, backspace, shift-tab", () => {
  assert.deepEqual(decodeKeys(`${ESC}x`).keys.map((k) => k.name), ["escape", "char"]);
  assert.deepEqual(decodeKeys("\u0003").keys.map((k) => k.name), ["ctrl-c"]);
  assert.deepEqual(decodeKeys("\u007f").keys.map((k) => k.name), ["backspace"]);
  assert.deepEqual(decodeKeys(`${ESC}[Z`).keys.map((k) => k.name), ["shift-tab"]);
});

// ── layout ────────────────────────────────────────────────────────────────────

test("layout: visibleWidth ignores ANSI, padLine and truncateAnsi are exact", () => {
  const styled = `${ANSI.red}abcdef${ANSI.reset}`;
  assert.equal(visibleWidth(styled), 6);
  assert.equal(visibleWidth(padLine(styled, 10)), 10);
  const cut = truncateAnsi(styled, 4);
  assert.equal(visibleWidth(cut), 4);
  assert.ok(cut.endsWith(`…${ANSI.reset}`), "reset appended after cutting styled text");
  assert.equal(stripAnsi(cut), "abc…");
});

test("layout: computeColumns honors minimums and distributes flex", () => {
  const widths = computeColumns([{ min: 4 }, { min: 8, flex: 2 }, { min: 6, flex: 1 }], 40);
  assert.equal(widths.reduce((a, b) => a + b, 0), 40);
  assert.equal(widths[0], 4);
  assert.ok(widths[1] > widths[2], "higher flex gets more space");
  // Too-small total: fixed minimums survive, flex shrinks
  const tight = computeColumns([{ min: 4 }, { min: 8, flex: 1 }], 6);
  assert.equal(tight[0], 4);
  assert.ok(tight[1] >= 1);
});

// ── graph ─────────────────────────────────────────────────────────────────────

test("graph: buildWorkflowChain follows done-transitions and finds terminal", () => {
  const { chain, terminal } = buildWorkflowChain(DEFAULT_WORKFLOW);
  assert.deepEqual(chain, ["planner", "executor", "reviewer"]);
  assert.equal(terminal, "$complete");
});

test("graph: wide terminal renders grid with handoff arrows and branches", () => {
  const { lines, layout } = renderWorkflowGraph(DEFAULT_WORKFLOW, { width: 120 });
  assert.equal(layout, "grid");
  const text = lines.join("\n");
  assert.match(text, /Planner/);
  assert.match(text, /Executor/);
  assert.match(text, /Reviewer/);
  assert.match(text, /handoff/);
  assert.match(text, /\$complete/);
  assert.match(text, /question → \? \$ask_user/);
  assert.match(text, /error → ■ \$halt/);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 120, `line exceeds width: ${line}`);
  }
});

test("graph: narrow terminal falls back to vertical stack", () => {
  const { lines, layout } = renderWorkflowGraph(DEFAULT_WORKFLOW, { width: 48 });
  assert.equal(layout, "stack");
  const text = lines.join("\n");
  assert.match(text, /▼ done \(handoff\)/);
  assert.match(text, /\$complete/);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 48, `line exceeds width: ${line}`);
  }
});

test("graph: custom workflows with extra roles still render every role", () => {
  const workflow = {
    initial: "a",
    roles: {
      a: { label: "A", provider: "claude" },
      b: { label: "B", provider: "codex" },
      orphan: { label: "Orphan", provider: "gemini" },
    },
    transitions: { a: { done: "b" }, b: { done: "$complete" } },
  };
  const { lines } = renderWorkflowGraph(workflow, { width: 200 });
  const text = lines.join("\n");
  assert.match(text, /Orphan/);
});

// ── screens ───────────────────────────────────────────────────────────────────

function makeModel(overrides = {}) {
  return {
    screen: "tasks",
    color: false,
    stateLabel: "/tmp/.maestro",
    message: null,
    now: Date.parse("2026-06-10T12:00:00Z"),
    tasks: [],
    view: "active",
    sel: 0,
    scrollTop: 0,
    task: null,
    detailLines: [],
    detailScroll: 0,
    actionSel: 0,
    config: { planner_policy: "auto", review_enabled: true, timeout_ms: 60_000, herdr: { close_tab_on: "success" } },
    workflow: DEFAULT_WORKFLOW,
    graphSel: 0,
    graphScroll: 0,
    settingsSel: 0,
    input: null,
    ...overrides,
  };
}

const SIZES = [
  { cols: 80, rows: 24 },
  { cols: 120, rows: 40 },
  { cols: 40, rows: 10 },
];

test("screens: every screen renders exactly rows×cols at every size", () => {
  const tasks = Array.from({ length: 30 }, (_, i) => ({
    id: `20260610-00000${i}-task-${i}`,
    status: ["running", "waiting_user", "succeeded"][i % 3],
    prompt: `do thing number ${i} with a fairly long description that needs truncation`,
    created_at: "2026-06-10T11:00:00Z",
  }));
  for (const size of SIZES) {
    for (const screen of ["tasks", "graph", "settings", "detail"]) {
      const model = makeModel({
        screen,
        tasks,
        task: { ...tasks[0], action_requests: [{ id: "act-1", status: "pending", command: "make", args: ["build"] }] },
        detailLines: ["line one", "line two", "line three"],
      });
      const lines = renderScreen(model, size);
      assert.equal(lines.length, size.rows, `${screen}@${size.cols}x${size.rows} row count`);
      for (const line of lines) {
        assert.equal(visibleWidth(line), size.cols, `${screen}@${size.cols}x${size.rows} line width: ${JSON.stringify(stripAnsi(line))}`);
      }
    }
  }
});

test("screens: selected task row is highlighted and footer shows hints", () => {
  const model = makeModel({
    tasks: [{ id: "20260610-000001-alpha", status: "running", prompt: "alpha", created_at: "2026-06-10T11:59:00Z" }],
    color: true,
  });
  const lines = renderScreen(model, { cols: 80, rows: 24 });
  const text = lines.join("\n");
  assert.match(text, /▸/);
  assert.match(stripAnsi(text), /⏎ open/);
  assert.match(stripAnsi(text), /alpha/);
});

test("screens: clampScroll keeps selection visible", () => {
  assert.equal(clampScroll(0, 5, 10, 50), 0);
  assert.equal(clampScroll(25, 0, 10, 50), 16);
  assert.equal(clampScroll(49, 0, 10, 50), 40);
});

test("screens: formatAge buckets", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  assert.equal(formatAge("2026-06-10T11:59:30Z", now), "30s");
  assert.equal(formatAge("2026-06-10T11:30:00Z", now), "30m");
  assert.equal(formatAge("2026-06-10T01:00:00Z", now), "11h");
  assert.equal(formatAge("2026-06-01T12:00:00Z", now), "9d");
  assert.equal(formatAge(null, now), "-");
});

test("screens: settingsPatch builds flat and nested patches", () => {
  assert.deepEqual(settingsPatch(["planner_policy"], "on"), { planner_policy: "on" });
  assert.deepEqual(settingsPatch(["herdr", "close_tab_on"], "never"), { herdr: { close_tab_on: "never" } });
  assert.ok(SETTINGS_FIELDS.some((f) => f.path.join(".") === "herdr.close_tab_on"));
});

// ── app ───────────────────────────────────────────────────────────────────────

function makeFakeStore({ tasks = [], config = {}, workflow = DEFAULT_WORKFLOW } = {}) {
  const writes = [];
  return {
    root: "/tmp/.maestro",
    writes,
    listTasks: async () => tasks,
    readConfig: async () => ({ planner_policy: "auto", review_enabled: true, timeout_ms: 1000, herdr: { close_tab_on: "success" }, ...config }),
    readWorkflow: async () => workflow,
    readTask: async (id) => tasks.find((t) => t.id === id) ?? null,
    writeConfig: async (patch) => { writes.push(patch); },
  };
}

const key = (name, ch = null) => (ch ? { name: "char", ch } : { name });

test("app: loads tasks, navigates, opens detail, returns with escape", async () => {
  const tasks = [
    { id: "20260610-000001-one", status: "waiting_user", prompt: "one", created_at: "2026-06-10T11:00:00Z" },
    { id: "20260610-000002-two", status: "running", prompt: "two", created_at: "2026-06-10T11:30:00Z" },
  ];
  const app = createTuiApp({
    store: makeFakeStore({ tasks }),
    cwd: "/tmp",
    filterTasks: filterTasksForView,
    formatDetails: (task) => `Task: ${task.id}\nStatus: ${task.status}`,
  });
  await app.refresh();
  assert.equal(app.model.tasks.length, 2);

  await app.handleKey(key("down"));
  assert.equal(app.model.sel, 1);
  await app.handleKey(key("enter"));
  assert.equal(app.model.screen, "detail");
  assert.match(app.model.detailLines.join("\n"), /Status:/);

  await app.handleKey(key("escape"));
  assert.equal(app.model.screen, "tasks");
});

test("app: screen switching via number keys and tab", async () => {
  const app = createTuiApp({ store: makeFakeStore(), cwd: "/tmp" });
  await app.refresh();
  await app.handleKey(key("char", "2"));
  assert.equal(app.model.screen, "graph");
  await app.handleKey(key("char", "3"));
  assert.equal(app.model.screen, "settings");
  await app.handleKey(key("char", "4"));
  assert.equal(app.model.screen, "providers");
  await app.handleKey(key("tab"));
  assert.equal(app.model.screen, "tasks");
  const result = await app.handleKey(key("char", "q"));
  assert.equal(result, "quit");
});

test("app: graph screen role selection moves along the chain", async () => {
  const app = createTuiApp({ store: makeFakeStore(), cwd: "/tmp" });
  await app.refresh();
  await app.handleKey(key("char", "2"));
  await app.handleKey(key("right"));
  await app.handleKey(key("right"));
  assert.equal(app.model.graphSel, 2);
  await app.handleKey(key("right"));
  assert.equal(app.model.graphSel, 2, "selection clamps at last role");
  const lines = app.renderLines({ cols: 120, rows: 40 });
  assert.match(stripAnsi(lines.join("\n")), /Reviewer/);
});

test("app: settings toggle and cycle write config patches", async () => {
  const store = makeFakeStore();
  const app = createTuiApp({ store, cwd: "/tmp" });
  await app.refresh();
  await app.handleKey(key("char", "3"));
  // first field: planner_policy cycle auto → on
  await app.handleKey(key("enter"));
  assert.deepEqual(store.writes[0], { planner_policy: "on" });
  // second field: review_enabled toggle true → false
  await app.handleKey(key("down"));
  await app.handleKey(key("enter"));
  assert.deepEqual(store.writes[1], { review_enabled: false });
  // herdr.close_tab_on cycles success → terminal
  const herdrIndex = SETTINGS_FIELDS.findIndex((f) => f.path[0] === "herdr");
  app.model.settingsSel = herdrIndex;
  await app.handleKey(key("enter"));
  assert.deepEqual(store.writes[2], { herdr: { close_tab_on: "terminal" } });
});

test("app: detail action approve/deny route to callbacks with the selected action", async () => {
  const task = {
    id: "20260610-000001-act",
    status: "waiting_approval",
    prompt: "act",
    created_at: "2026-06-10T11:00:00Z",
    action_requests: [
      { id: "act-1", status: "pending", command: "make", args: [] },
      { id: "act-2", status: "pending", command: "npm", args: ["test"] },
    ],
  };
  const calls = [];
  const app = createTuiApp({
    store: makeFakeStore({ tasks: [task] }),
    cwd: "/tmp",
    formatDetails: (t) => `Task: ${t.id}`,
    callbacks: {
      approveAction: async (t, actionId) => calls.push(["approve", t.id, actionId]),
      denyAction: async (t, actionId, note) => calls.push(["deny", t.id, actionId, note]),
      messageTask: async (t, note) => calls.push(["message", t.id, note]),
    },
  });
  await app.refresh();
  await app.openDetail(task);

  await app.handleKey(key("char", "]"));            // select act-2
  await app.handleKey(key("char", "a"));            // approve it
  assert.deepEqual(calls[0], ["approve", task.id, "act-2"]);

  await app.openDetail(task);
  await app.handleKey(key("char", "d"));            // deny act-1 → input mode
  assert.ok(app.model.input, "deny opens reason input");
  for (const ch of "nope") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  assert.deepEqual(calls[1], ["deny", task.id, "act-1", "nope"]);

  await app.handleKey(key("char", "m"));            // message input
  for (const ch of "hi") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  assert.deepEqual(calls[2], ["message", task.id, "hi"]);
});

test("app: new-task input invokes runTask with prompt and defaults", async () => {
  const started = [];
  const app = createTuiApp({
    store: makeFakeStore({ config: { cwd: "/proj", timeout_ms: 5000 } }),
    cwd: "/tmp",
    callbacks: {
      runTask: async (form) => { started.push(form); return { task: { id: "t-new" }, detached: true }; },
    },
  });
  await app.refresh();
  await app.handleKey(key("char", "n"));
  assert.ok(app.model.input);
  for (const ch of "fix bug") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  assert.equal(started.length, 1);
  assert.equal(started[0].prompt, "fix bug");
  assert.equal(started[0].cwd, "/proj");
  assert.equal(started[0].timeout_ms, 5000);
  assert.match(app.model.message ?? "", /t-new/);
});

test("app: input escape cancels without side effects", async () => {
  const started = [];
  const app = createTuiApp({
    store: makeFakeStore(),
    cwd: "/tmp",
    callbacks: { runTask: async (form) => started.push(form) },
  });
  await app.refresh();
  await app.handleKey(key("char", "n"));
  for (const ch of "abc") await app.handleKey(key("char", ch));
  await app.handleKey(key("escape"));
  assert.equal(app.model.input, null);
  assert.equal(started.length, 0);
});

test("app: view cycling filters tasks", async () => {
  const tasks = [
    { id: "20260610-000001-run", status: "running", prompt: "r", created_at: "2026-06-10T11:00:00Z" },
    { id: "20260610-000002-done", status: "succeeded", prompt: "d", created_at: "2026-06-10T11:00:00Z" },
  ];
  const app = createTuiApp({ store: makeFakeStore({ tasks }), cwd: "/tmp", filterTasks: filterTasksForView });
  await app.refresh();
  assert.equal(app.model.tasks.length, 1, "active view hides succeeded");
  // cycle until "all"
  while (app.model.view !== "all") await app.handleKey(key("char", "v"));
  assert.equal(app.model.tasks.length, 2);
});

// ── edit-core + full-screen editors ──────────────────────────────────────────

test("edit-core: patch builders are pure and overlay-safe", async () => {
  const {
    providerFieldPatch, removeProviderPatch, rolePatch, addRolePatch,
    setTransitionPatch, deleteTransitionPatch, setInitialPatch, transitionTargets,
  } = await import("../src/tui/edit-core.mjs");

  // raw config lacks the overlay-only model list — patch must derive from raw
  const raw = { zed: { label: "Zed", adapter: "custom", aliases: ["zed"], default_alias: "zed", models: [] } };
  const effective = { ...raw.zed, models: ["overlay-model"] };
  const patched = providerFieldPatch(raw, "zed", ["label"], "Zed II", effective);
  assert.equal(patched.providers.zed.label, "Zed II");
  assert.deepEqual(patched.providers.zed.models, [], "overlay model leaked into shareable patch");
  assert.equal(raw.zed.label, "Zed", "input mutated");

  // nested custom path merges over the raw base
  const nested = providerFieldPatch(raw, "zed", ["custom", "prompt_via"], "arg", effective);
  assert.equal(nested.providers.zed.custom.prompt_via, "arg");

  // unknown key in raw falls back to DEFAULT_PROVIDERS / effective def
  const fromDefault = providerFieldPatch(raw, "claude", ["label"], "C", null);
  assert.equal(fromDefault.providers.claude.label, "C");
  assert.equal(fromDefault.providers.claude.adapter, "built-in:claude");

  const removed = removeProviderPatch(raw, "zed");
  assert.equal(removed.providers.zed, undefined);

  const wf = structuredClone(DEFAULT_WORKFLOW);
  assert.equal(rolePatch(wf, "planner", { permission: "read" }).roles.planner.permission, "read");
  const added = addRolePatch(wf, "tester", "codex", { default_alias: "codex" });
  assert.equal(added.roles.tester.alias, "codex");
  assert.deepEqual(added.transitions.tester, { done: "$complete", error: "$halt", question: "$ask_user" });
  assert.equal(setTransitionPatch(wf, "planner", "pause", "$pause").transitions.planner.pause, "$pause");
  assert.equal(deleteTransitionPatch(wf, "planner", "done").transitions.planner.done, undefined);
  assert.equal(setInitialPatch(wf, "executor").initial, "executor");
  assert.equal(setInitialPatch(wf, "nope"), null);
  assert.ok(transitionTargets(wf).includes("$halt"));
  assert.ok(transitionTargets(wf).includes("reviewer"));
});

test("edit-core: removeRolePatch drops role, scrubs transitions, reassigns initial", async () => {
  const { removeRolePatch } = await import("../src/tui/edit-core.mjs");
  const wf = {
    initial: "planner",
    roles: {
      planner: { label: "Planner" },
      executor: { label: "Executor" },
      reviewer: { label: "Reviewer" },
    },
    transitions: {
      planner: { done: "executor", error: "$halt" },
      executor: { done: "reviewer", question: "planner" },
      reviewer: { done: "$complete", error: "planner" },
    },
  };
  const patch = removeRolePatch(wf, "planner");
  // role removed
  assert.equal(patch.roles.planner, undefined);
  assert.ok(patch.roles.executor);
  // its transition entry removed
  assert.equal(patch.transitions.planner, undefined);
  // other roles' transitions targeting planner are scrubbed
  assert.equal(patch.transitions.executor.question, undefined);
  assert.equal(patch.transitions.executor.done, "reviewer");
  assert.equal(patch.transitions.reviewer.error, undefined);
  assert.equal(patch.transitions.reviewer.done, "$complete");
  // initial reassigned to first surviving role
  assert.equal(patch.initial, "executor");
  // input not mutated
  assert.equal(wf.initial, "planner");
  assert.ok(wf.roles.planner);

  // removing a non-initial role leaves initial untouched
  const patch2 = removeRolePatch(wf, "reviewer");
  assert.equal(patch2.initial, undefined);
  assert.equal(patch2.roles.reviewer, undefined);
});

function makeEditStore({
  rawProviders, effectiveProviders, workflow = structuredClone(DEFAULT_WORKFLOW),
  workflowNames = ["default"],
} = {}) {
  const configWrites = [];
  const workflowWrites = [];
  const workflowWriteNames = [];
  const templateCalls = [];
  const deleteCalls = [];
  let wf = workflow;
  return {
    root: "/tmp/.maestro",
    configWrites,
    workflowWrites,
    workflowWriteNames,
    templateCalls,
    deleteCalls,
    listTasks: async () => [],
    listWorkflows: async () => workflowNames.map((name) => ({
      name, path: `/tmp/.maestro/workflows/${name}.json`, source: "named",
    })),
    readConfig: async () => ({ providers: structuredClone(effectiveProviders), timeout_ms: 1000 }),
    readConfigRaw: async () => ({ providers: structuredClone(rawProviders) }),
    // App now reads by name; honor the two-arg signature but the mock keeps one wf.
    readWorkflow: async () => structuredClone(wf),
    readTask: async () => null,
    writeConfig: async (patch) => { configWrites.push(structuredClone(patch)); },
    // Two-arg form: writeWorkflow(name, patch). Capture both.
    writeWorkflow: async (nameOrPatch, maybePatch) => {
      const named = typeof nameOrPatch === "string";
      const patch = named ? maybePatch : nameOrPatch;
      workflowWriteNames.push(named ? nameOrPatch : "default");
      workflowWrites.push(structuredClone(patch));
      wf = { ...wf, ...patch };
    },
    applyWorkflowTemplate: async (args) => { templateCalls.push(structuredClone(args)); return { ...args }; },
    deleteWorkflow: async (name) => { deleteCalls.push(name); return { name, deleted: true }; },
  };
}

const EDIT_PROVIDERS = {
  raw: {
    zed: { label: "Zed", adapter: "custom", default_alias: "zed", aliases: ["zed"], models: [], efforts: [] },
  },
  effective: {
    zed: { label: "Zed", adapter: "custom", default_alias: "zed", aliases: ["zed", "zed-local"], models: ["m-overlay"], efforts: [] },
  },
};

test("app: providers screen lists, edits via raw base, deletes", async () => {
  const store = makeEditStore({ rawProviders: EDIT_PROVIDERS.raw, effectiveProviders: EDIT_PROVIDERS.effective });
  const app = createTuiApp({ store, cwd: "/tmp" });
  await app.refresh();

  await app.handleKey(key("char", "4"));
  assert.equal(app.model.screen, "providers");
  const listing = stripAnsi(app.renderLines({ cols: 80, rows: 24 }).join("\n"));
  assert.match(listing, /zed/);
  assert.match(listing, /custom/);

  // open editor, edit label through the input overlay
  await app.handleKey(key("enter"));
  assert.equal(app.model.screen, "provider-edit");
  assert.equal(app.model.providerKey, "zed");
  await app.handleKey(key("enter"));            // label field → input overlay
  assert.ok(app.model.input, "input overlay expected");
  for (const ch of " II") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  const write = store.configWrites.at(-1);
  assert.equal(write.providers.zed.label, "Zed II");
  assert.deepEqual(write.providers.zed.models, [], "overlay models leaked into config.json write");
  assert.deepEqual(write.providers.zed.aliases, ["zed"], "overlay aliases leaked into config.json write");

  // delete with confirmation
  await app.handleKey(key("char", "D"));
  for (const ch of "yes") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  assert.equal(store.configWrites.at(-1).providers.zed, undefined);
  assert.equal(app.model.screen, "providers");
});

test("app: add provider creates a custom def and opens the editor", async () => {
  const store = makeEditStore({ rawProviders: EDIT_PROVIDERS.raw, effectiveProviders: EDIT_PROVIDERS.effective });
  const app = createTuiApp({ store, cwd: "/tmp" });
  await app.refresh();
  await app.handleKey(key("char", "4"));
  await app.handleKey(key("char", "n"));
  for (const ch of "myllm") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  const write = store.configWrites.at(-1);
  assert.equal(write.providers.myllm.adapter, "custom");
  assert.equal(write.providers.myllm.custom.command_template, "{alias}");
  assert.deepEqual(write.providers.myllm.aliases, ["myllm"]);
  assert.equal(app.model.screen, "provider-edit");
  assert.equal(app.model.providerKey, "myllm");
});

test("app: role editor edits fields, transitions, and add role from graph", async () => {
  const store = makeEditStore({ rawProviders: EDIT_PROVIDERS.raw, effectiveProviders: EDIT_PROVIDERS.effective });
  const app = createTuiApp({ store, cwd: "/tmp" });
  await app.refresh();

  // graph → enter opens role editor on the first chain role (planner)
  await app.handleKey(key("char", "2"));
  await app.handleKey(key("enter"));
  assert.equal(app.model.screen, "role-edit");
  assert.equal(app.model.roleKey, "planner");
  const rendered = stripAnsi(app.renderLines({ cols: 80, rows: 24 }).join("\n"));
  assert.match(rendered, /Permission/);
  assert.match(rendered, /Transitions/);

  // cycle permission: plan → read (PERMISSIONS order: plan, read, write, default)
  const { ROLE_FIELDS } = await import("../src/tui/screens.mjs");
  const permIdx = ROLE_FIELDS.findIndex((f) => f.path[0] === "permission");
  for (let i = 0; i < permIdx; i += 1) await app.handleKey(key("down"));
  await app.handleKey(key("enter"));
  assert.equal(store.workflowWrites.at(-1).roles.planner.permission, "read");
  // SP0a: app model carries workflowName and writes target the selected name.
  assert.equal(app.model.workflowName, "default");
  assert.equal(store.workflowWriteNames.at(-1), "default");

  // add transition via chained inputs: pause → $pause
  await app.handleKey(key("char", "a"));
  for (const ch of "pause") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  assert.ok(app.model.input, "second (target) input expected");
  for (const ch of "$pause") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  assert.equal(store.workflowWrites.at(-1).transitions.planner.pause, "$pause");

  // delete the selected transition (move selection onto the first transition)
  const transStart = ROLE_FIELDS.length;
  while (app.model.roleFieldSel < transStart) await app.handleKey(key("down"));
  await app.handleKey(key("char", "D"));
  const afterDelete = store.workflowWrites.at(-1).transitions.planner;
  assert.equal(Object.keys(afterDelete).length, 3, "one transition removed (planner starts with 3 + 1 added)");

  // esc returns to graph; add a role via chained inputs
  await app.handleKey(key("escape"));
  assert.equal(app.model.screen, "graph");
  await app.handleKey(key("char", "a"));
  for (const ch of "tester") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  for (const ch of "zed") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  const addWrite = store.workflowWrites.at(-1);
  assert.equal(addWrite.roles.tester.provider, "zed");
  assert.equal(app.model.screen, "role-edit");
  assert.equal(app.model.roleKey, "tester");

  // initial-state change with validation
  await app.handleKey(key("escape"));
  await app.handleKey(key("char", "i"));
  for (const ch of "executor") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  assert.equal(store.workflowWrites.at(-1).initial, "executor");
});

test("app: graph D deletes the chain-selected role", async () => {
  const store = makeEditStore({ rawProviders: EDIT_PROVIDERS.raw, effectiveProviders: EDIT_PROVIDERS.effective });
  const app = createTuiApp({ store, cwd: "/tmp" });
  await app.refresh();
  await app.handleKey(key("char", "2"));        // graph screen, planner selected
  await app.handleKey(key("char", "D"));
  assert.ok(app.model.input, "delete role opens confirmation");
  for (const ch of "yes") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  const write = store.workflowWrites.at(-1);
  assert.equal(write.roles.planner, undefined, "selected role removed from patch");
  assert.equal(store.workflowWriteNames.at(-1), "default");
});

test("app: graph w cycles the active workflow name", async () => {
  const store = makeEditStore({
    rawProviders: EDIT_PROVIDERS.raw, effectiveProviders: EDIT_PROVIDERS.effective,
    workflowNames: ["default", "extended"],
  });
  const app = createTuiApp({ store, cwd: "/tmp" });
  await app.refresh();
  await app.handleKey(key("char", "2"));
  assert.equal(app.model.workflowName, "default");
  await app.handleKey(key("char", "w"));
  assert.equal(app.model.workflowName, "extended");
  await app.handleKey(key("char", "w"));
  assert.equal(app.model.workflowName, "default", "wraps around");
});

test("app: graph N creates a workflow via applyWorkflowTemplate", async () => {
  const store = makeEditStore({ rawProviders: EDIT_PROVIDERS.raw, effectiveProviders: EDIT_PROVIDERS.effective });
  const app = createTuiApp({ store, cwd: "/tmp" });
  await app.refresh();
  await app.handleKey(key("char", "2"));
  await app.handleKey(key("char", "N"));
  for (const ch of "myflow") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));            // name → template prompt
  for (const ch of "extended") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  assert.deepEqual(store.templateCalls.at(-1), { name: "extended", as: "myflow" });
  assert.equal(app.model.workflowName, "myflow");
});

test("app: graph X deletes the current workflow via deleteWorkflow", async () => {
  const store = makeEditStore({
    rawProviders: EDIT_PROVIDERS.raw, effectiveProviders: EDIT_PROVIDERS.effective,
    workflowNames: ["default", "doomed"],
  });
  const app = createTuiApp({ store, cwd: "/tmp" });
  await app.refresh();
  await app.handleKey(key("char", "2"));
  await app.handleKey(key("char", "w"));        // → doomed
  assert.equal(app.model.workflowName, "doomed");
  await app.handleKey(key("char", "X"));
  for (const ch of "yes") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  assert.equal(store.deleteCalls.at(-1), "doomed");
  assert.equal(app.model.workflowName, "default");
});

test("app: graph V flashes a validation summary", async () => {
  const store = makeEditStore({ rawProviders: EDIT_PROVIDERS.raw, effectiveProviders: EDIT_PROVIDERS.effective });
  const app = createTuiApp({ store, cwd: "/tmp" });
  await app.refresh();
  await app.handleKey(key("char", "2"));
  await app.handleKey(key("char", "V"));
  assert.match(app.model.message ?? "", /workflow OK|error \[|warning \[/);
});

test("app: detail g/s/S/p/E route to the new callbacks", async () => {
  const task = {
    id: "20260610-000001-act",
    status: "waiting_approval",
    prompt: "act",
    created_at: "2026-06-10T11:00:00Z",
    action_requests: [{ id: "act-1", status: "pending", command: "make", args: [] }],
  };
  const calls = [];
  const app = createTuiApp({
    store: makeFakeStore({ tasks: [task] }),
    cwd: "/tmp",
    formatDetails: (t) => `Task: ${t.id}`,
    callbacks: {
      runAction: async (t, id) => calls.push(["run", t.id, id]),
      editAction: async (t, id, patch) => calls.push(["edit", t.id, id, patch]),
      approveSubstitution: async (t) => calls.push(["subst", t.id]),
      skipRole: async (t) => calls.push(["skip", t.id]),
      switchProvider: async (t, provider) => calls.push(["provider", t.id, provider]),
    },
  });
  await app.refresh();
  await app.openDetail(task);

  await app.handleKey(key("char", "g"));
  assert.deepEqual(calls.at(-1), ["run", task.id, "act-1"]);

  await app.handleKey(key("char", "s"));
  assert.deepEqual(calls.at(-1), ["subst", task.id]);

  await app.handleKey(key("char", "S"));
  assert.deepEqual(calls.at(-1), ["skip", task.id]);

  await app.handleKey(key("char", "p"));
  for (const ch of "codex") await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  assert.deepEqual(calls.at(-1), ["provider", task.id, "codex"]);

  await app.handleKey(key("char", "E"));
  for (const ch of '{"x":1}') await app.handleKey(key("char", ch));
  await app.handleKey(key("enter"));
  assert.deepEqual(calls.at(-1), ["edit", task.id, "act-1", { x: 1 }]);
});

test("screens: new editor screens render exact row counts", async () => {
  const store = makeEditStore({ rawProviders: EDIT_PROVIDERS.raw, effectiveProviders: EDIT_PROVIDERS.effective });
  const app = createTuiApp({ store, cwd: "/tmp" });
  await app.refresh();
  for (const screen of ["providers", "provider-edit", "role-edit"]) {
    app.model.screen = screen;
    app.model.providerKey = "zed";
    app.model.roleKey = "planner";
    for (const size of [{ cols: 80, rows: 24 }, { cols: 40, rows: 12 }]) {
      const lines = app.renderLines(size);
      assert.equal(lines.length, size.rows, `${screen} at ${size.cols}x${size.rows}`);
      for (const line of lines) {
        assert.ok(stripAnsi(line).length <= size.cols, `${screen} line overflows ${size.cols} cols`);
      }
    }
  }
});
