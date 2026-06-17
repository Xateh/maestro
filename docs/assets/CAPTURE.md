# Asset capture guide

The images referenced by `README.md` currently ship as **authored SVG
placeholders** (`*.svg` in this directory). They render as intentional
"screenshot pending" cards so the README never shows a broken image.

When you capture the real thing, **replace each placeholder with a `.png` (or
`.gif` for the demo) of the same basename**, then update the `src=` extension in
`README.md`:

| Placeholder (now)        | Final asset (replace with) | README reference |
|--------------------------|----------------------------|------------------|
| `banner.svg`             | keep as-is (authored SVG)  | hero             |
| `tui-board.svg`          | `tui-board.png`            | Usage / TUI      |
| `tui-graph.svg`          | `tui-graph.png`            | Usage / TUI      |
| `dashboard.svg`          | `dashboard.png`            | Web Dashboard    |
| `doctor.svg`             | `doctor.png`               | Quick Start      |
| `demo.svg`               | `demo.gif`                 | Demo             |

> The banner is hand-authored vector art — leave it as SVG.

## Global setup

Capture against a **throwaway project**, never a real repo, so seeded demo data
and worktrees can't touch anything that matters.

```bash
# 1. Throwaway project with Maestro initialized
mkdir -p /tmp/maestro-demo && cd /tmp/maestro-demo
git init -q
maestro init            # scaffolds .maestro/ (config, workflow, db, dirs)

# 2. Seed one demo task so boards/graphs aren't empty
maestro task --plan-only "Add a /healthcheck endpoint"
```

**Terminal/recorder conventions (keep all assets consistent):**

- Terminal size: **120×40**.
- Theme: **dark** (background `#0d1117`-ish to match the placeholder cards).
- Font: any clean monospace at a legible size.
- Target width: **800 px** (matches the placeholder `viewBox`); 2× for retina
  PNGs is fine (1600 px) as long as the aspect ratio stays ~16:9.
- Trim surrounding desktop chrome; crop to the terminal/browser window.

## Deterministic GIFs with VHS (recommended)

[VHS](https://github.com/charmbracelet/vhs) scripts terminal recordings as
`.tape` files, so the demo GIF is reproducible byte-for-byte instead of a
one-off screen recording.

```bash
# Install: https://github.com/charmbracelet/vhs#installation
vhs docs/assets/demo.tape   # emits demo.gif
```

Sample `demo.tape` (run from the throwaway project, or `cd` into it inside the
tape):

```tape
# demo.tape — end-to-end Maestro run
Output demo.gif
Set FontSize 16
Set Width 1200
Set Height 675
Set Theme "Dracula"
Set Padding 20

Type "maestro task \"Add a /healthcheck endpoint\""
Enter
Sleep 8s

Type "maestro status"
Enter
Sleep 4s
```

Adjust the `Sleep` durations to however long the run actually takes on your
machine; the goal is to show the plan → execute → review handoff and then the
task landing in `maestro status`.

## Per-image commands

### `tui-board.png` — TUI task board

```bash
cd /tmp/maestro-demo
maestro tui
```

The TUI opens on the **task board** (screen `1`). Capture once the seeded task
row is visible. Filter views and the approve/deny keys are visible in the footer
hint line.

### `tui-graph.png` — TUI workflow graph

```bash
cd /tmp/maestro-demo
maestro tui
# press  2  to switch to the Workflow graph screen
```

> Keybinding verified in source: the workflow graph is screen **`2`**.
> See `src/tui/screens.mjs` (`["graph", "2 Workflow"]`) and `src/tui/app.mjs`
> (`{ 1: "tasks", 2: "graph", 3: "settings", 4: "providers" }`). Do not use any
> other key — `2` is the binding.

Capture the rendered roles, handoff arrows, and event transitions grid.

### `dashboard.png` — web dashboard

```bash
cd /tmp/maestro-demo
maestro serve            # default port comes from .maestro/config.json → server.port
# open http://localhost:<port>/ in a browser
```

Capture the task board with the **All / Running / Retrying / Completed** filter
tabs visible. The board live-polls `/api/v1/state` (every 5 s while tasks are
active, 30 s when idle), so the counts update without a reload.

### `doctor.png` — preflight

```bash
cd /tmp/maestro-demo
maestro doctor
```

Capture the full preflight output (Node version, provider CLIs, herdr, `.maestro`
state, workflow, db). A clean run with green checks reads best.

### `demo.gif` — end-to-end run

See the **VHS** section above. Prefer the scripted `.tape` over a manual
screen recording for reproducibility.
