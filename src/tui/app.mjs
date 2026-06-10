/**
 * Full-screen TUI application: model, key handling, and the run loop.
 *
 * The app is a thin state machine over the pure renderers in screens.mjs.
 * All terminal I/O goes through a Terminal object (FullScreenTerminal in
 * production, a fake in tests), and all task actions go through the same
 * callback set the classic TUI receives — so behavior stays identical
 * between the two front-ends.
 */

import { FullScreenTerminal } from "./term.mjs";
import {
  renderScreen, clampScroll, SETTINGS_FIELDS, getConfigValue, settingsPatch, TASK_VIEWS,
} from "./screens.mjs";
import { buildWorkflowChain } from "./graph.mjs";

const POLL_MS = 2000;

export function createTuiApp({
  store,
  cwd,
  color = false,
  callbacks = {},
  formatDetails = null,   // (task, {color}) => string — injected to avoid a hard cycle
  filterTasks = null,     // (tasks, view) => tasks
} = {}) {
  const model = {
    screen: "tasks",
    color,
    stateLabel: store?.root ?? "",
    message: null,
    now: Date.now(),
    tasks: [],
    allTasks: [],
    view: "active",
    sel: 0,
    scrollTop: 0,
    task: null,
    detailLines: [],
    detailScroll: 0,
    actionSel: 0,
    config: null,
    workflow: null,
    graphSel: 0,
    graphScroll: 0,
    settingsSel: 0,
    input: null,
  };

  let quitRequested = false;

  const flash = (text) => { model.message = text ? String(text).slice(0, 120) : null; };

  const applyView = () => {
    model.tasks = filterTasks ? filterTasks(model.allTasks, model.view) : model.allTasks;
    model.sel = Math.max(0, Math.min(model.sel, model.tasks.length - 1));
  };

  async function refresh() {
    model.now = Date.now();
    try {
      const [tasks, config, workflow] = await Promise.all([
        store.listTasks(),
        store.readConfig(),
        store.readWorkflow(),
      ]);
      model.allTasks = tasks ?? [];
      model.config = config;
      model.workflow = workflow;
      applyView();
      if (model.screen === "detail" && model.task) {
        const fresh = await store.readTask(model.task.id).catch(() => null);
        if (fresh) {
          model.task = fresh;
          model.detailLines = formatDetails
            ? formatDetails(fresh, { color }).split("\n")
            : [JSON.stringify(fresh, null, 2)];
        }
      }
    } catch (error) {
      flash(`refresh failed: ${error.message}`);
    }
  }

  async function openDetail(task) {
    model.screen = "detail";
    model.task = task;
    model.detailScroll = 0;
    model.actionSel = 0;
    model.detailLines = formatDetails
      ? formatDetails(task, { color }).split("\n")
      : [JSON.stringify(task, null, 2)];
  }

  function pendingActions() {
    return (model.task?.action_requests ?? []).filter((r) => r.status === "pending");
  }

  // Run a task action with uniform feedback + refresh.
  async function act(label, fn) {
    if (!fn) { flash(`${label}: not available`); return; }
    const before = model.message;
    try {
      await fn();
      // keep a more specific message if the action set one (e.g. task id)
      if (model.message === before) flash(`${label}: ok`);
    } catch (error) {
      flash(`${label} failed: ${error.message}`);
    }
    await refresh();
  }

  function openInput(label, submit, initial = "") {
    model.input = { label, value: initial, submit };
  }

  async function handleInputKey(key) {
    const input = model.input;
    if (key.name === "escape") { model.input = null; return; }
    if (key.name === "enter") {
      model.input = null;
      await input.submit(input.value.trim());
      return;
    }
    if (key.name === "backspace") { input.value = input.value.slice(0, -1); return; }
    if (key.name === "char") input.value += key.ch;
  }

  // ── per-screen key handlers ────────────────────────────────────────────────

  async function handleTasksKey(key, size) {
    const listHeight = Math.max(1, size.rows - 6);
    const move = (delta) => {
      model.sel = Math.max(0, Math.min(model.tasks.length - 1, model.sel + delta));
      model.scrollTop = clampScroll(model.sel, model.scrollTop, listHeight, model.tasks.length);
    };
    if (key.name === "up") move(-1);
    else if (key.name === "down") move(1);
    else if (key.name === "pageup") move(-listHeight);
    else if (key.name === "pagedown") move(listHeight);
    else if (key.name === "home") move(-model.tasks.length);
    else if (key.name === "end") move(model.tasks.length);
    else if (key.name === "enter") {
      const task = model.tasks[model.sel];
      if (task) await openDetail(task);
    } else if (key.name === "char") {
      if (key.ch === "j") move(1);
      else if (key.ch === "k") move(-1);
      else if (key.ch === "v") {
        model.view = TASK_VIEWS[(TASK_VIEWS.indexOf(model.view) + 1) % TASK_VIEWS.length];
        model.sel = 0;
        model.scrollTop = 0;
        applyView();
      } else if (key.ch === "r") await refresh();
      else if (key.ch === "n") {
        openInput("New task prompt:", async (prompt) => {
          if (!prompt) { flash("task prompt required"); return; }
          await act("start task", async () => {
            const defaults = model.config ?? {};
            const form = {
              prompt,
              cwd: defaults.cwd ?? cwd,
              mode: "task",
              timeout_ms: defaults.timeout_ms,
            };
            const result = await callbacks.runTask?.(form, {
              onTaskCreated: (task) => flash(`task ${task.id} started`),
            });
            if (result?.task?.id) flash(`task ${result.task.id} started`);
          });
        });
      }
    }
  }

  async function handleDetailKey(key) {
    const task = model.task;
    const pending = pendingActions();
    const selected = pending[Math.min(model.actionSel, Math.max(0, pending.length - 1))] ?? null;
    if (key.name === "escape" || key.name === "left") {
      model.screen = "tasks";
      model.task = null;
      return;
    }
    if (key.name === "up") model.detailScroll = Math.max(0, model.detailScroll - 1);
    else if (key.name === "down") model.detailScroll += 1;
    else if (key.name === "pageup") model.detailScroll = Math.max(0, model.detailScroll - 10);
    else if (key.name === "pagedown") model.detailScroll += 10;
    else if (key.name === "char") {
      switch (key.ch) {
        case "k": model.detailScroll = Math.max(0, model.detailScroll - 1); break;
        case "j": model.detailScroll += 1; break;
        case "[": model.actionSel = Math.max(0, model.actionSel - 1); break;
        case "]": model.actionSel = Math.min(Math.max(0, pending.length - 1), model.actionSel + 1); break;
        case "a":
          if (selected) await act(`approve ${selected.id}`, () => callbacks.approveAction?.(task, selected.id, null));
          else flash("no pending action to approve");
          break;
        case "d":
          if (selected) {
            openInput(`Deny ${selected.id} — reason:`, (reason) => (
              act(`deny ${selected.id}`, () => callbacks.denyAction?.(task, selected.id, reason || "denied via TUI"))
            ));
          } else flash("no pending action to deny");
          break;
        case "m":
          openInput("Message:", (note) => {
            if (!note) { flash("empty message ignored"); return Promise.resolve(); }
            return act("message", () => callbacks.messageTask?.(task, note));
          });
          break;
        case "R": await act("retry", () => callbacks.retryTask?.(task, null)); break;
        case "c":
          openInput("Cancel task — note (enter to confirm):", (note) => (
            act("cancel", () => callbacks.cancelTask?.(task, note || null))
          ));
          break;
        case "x": await act("mark-done", () => callbacks.markDone?.(task, null, null)); break;
        case "o": await act("resume", () => callbacks.resumeTask?.(task)); break;
        case "e":
          openInput("Extend timeout — minutes:", (minutes) => {
            const ms = Math.round(Number(minutes) * 60_000);
            if (!Number.isFinite(ms) || ms <= 0) { flash("invalid minutes"); return Promise.resolve(); }
            return act("extend-timeout", () => callbacks.extendTimeout?.(task, ms, null));
          });
          break;
        case "r": await refresh(); break;
        default: break;
      }
    }
  }

  async function handleGraphKey(key) {
    const chain = buildWorkflowChain(model.workflow ?? {}).chain;
    if (key.name === "left") model.graphSel = Math.max(0, model.graphSel - 1);
    else if (key.name === "right") model.graphSel = Math.min(Math.max(0, chain.length - 1), model.graphSel + 1);
    else if (key.name === "up") model.graphScroll = Math.max(0, model.graphScroll - 1);
    else if (key.name === "down") model.graphScroll += 1;
    else if (key.name === "char") {
      if (key.ch === "h") model.graphSel = Math.max(0, model.graphSel - 1);
      else if (key.ch === "l") model.graphSel = Math.min(Math.max(0, chain.length - 1), model.graphSel + 1);
      else if (key.ch === "r") await refresh();
    }
  }

  async function handleSettingsKey(key) {
    if (key.name === "up") model.settingsSel = Math.max(0, model.settingsSel - 1);
    else if (key.name === "down") model.settingsSel = Math.min(SETTINGS_FIELDS.length - 1, model.settingsSel + 1);
    else if (key.name === "enter") {
      const field = SETTINGS_FIELDS[model.settingsSel];
      const current = getConfigValue(model.config ?? {}, field.path);
      const write = async (value) => {
        try {
          await store.writeConfig(settingsPatch(field.path, value));
          flash(`${field.label} → ${value}`);
        } catch (error) {
          flash(`save failed: ${error.message}`);
        }
        await refresh();
      };
      if (field.type === "toggle") await write(!(current === true));
      else if (field.type === "cycle") {
        const idx = field.options.indexOf(String(current));
        await write(field.options[(idx + 1) % field.options.length]);
      } else {
        openInput(`${field.label}:`, async (raw) => {
          if (raw === "") { flash("unchanged"); return; }
          if (field.type === "number") {
            const n = Number(raw);
            if (!Number.isFinite(n)) { flash("not a number"); return; }
            await write(n);
          } else {
            await write(raw);
          }
        }, String(current ?? ""));
      }
    } else if (key.name === "char" && key.ch === "r") await refresh();
  }

  // ── public surface ─────────────────────────────────────────────────────────

  async function handleKey(key, size = { cols: 80, rows: 24 }) {
    model.now = Date.now();
    if (key.name === "ctrl-c") { quitRequested = true; return "quit"; }
    if (model.input) { await handleInputKey(key); return undefined; }
    flash(null);

    // global navigation
    if (key.name === "char" && key.ch === "q") { quitRequested = true; return "quit"; }
    if (key.name === "char" && ["1", "2", "3"].includes(key.ch) && model.screen !== "detail") {
      model.screen = { 1: "tasks", 2: "graph", 3: "settings" }[key.ch];
      return undefined;
    }
    if (key.name === "tab" && model.screen !== "detail") {
      const order = ["tasks", "graph", "settings"];
      model.screen = order[(order.indexOf(model.screen) + 1) % order.length];
      return undefined;
    }

    switch (model.screen) {
      case "tasks": await handleTasksKey(key, size); break;
      case "detail": await handleDetailKey(key); break;
      case "graph": await handleGraphKey(key); break;
      case "settings": await handleSettingsKey(key); break;
      default: break;
    }
    return quitRequested ? "quit" : undefined;
  }

  function renderLines(size) {
    model.now = Date.now();
    return renderScreen(model, size);
  }

  return { model, refresh, handleKey, renderLines, openDetail };
}

/**
 * Production entry point: wires the app to a real terminal with a poll loop.
 * Resolves when the user quits.
 */
export async function runFullScreenTui({
  stdin = process.stdin,
  stdout = process.stdout,
  store,
  cwd,
  callbacks = {},
  formatDetails,
  filterTasks,
  terminal = null,
  pollMs = POLL_MS,
} = {}) {
  const color = stdout.isTTY === true && !process.env.NO_COLOR;
  const app = createTuiApp({ store, cwd, color, callbacks, formatDetails, filterTasks });
  const term = terminal ?? new FullScreenTerminal({ stdin, stdout });

  let drawing = false;
  const draw = () => {
    if (drawing) return;
    drawing = true;
    try { term.draw(app.renderLines(term.size())); } finally { drawing = false; }
  };

  await app.refresh();

  return new Promise((resolve) => {
    let pollTimer = null;
    const finish = () => {
      clearInterval(pollTimer);
      term.stop();
      resolve();
    };
    term.start({
      onKey: (key) => {
        Promise.resolve(app.handleKey(key, term.size()))
          .then((result) => {
            if (result === "quit") finish();
            else draw();
          })
          .catch((error) => {
            app.model.message = `error: ${error.message}`;
            draw();
          });
      },
      onResize: () => draw(),
    });
    pollTimer = setInterval(() => {
      app.refresh().then(draw).catch(() => {});
    }, pollMs);
    draw();
  });
}
