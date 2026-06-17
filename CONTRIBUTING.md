# Contributing to Maestro

Thanks for taking a seat in the orchestra. Here's how to keep rehearsals short.

## Repository layout & how changes ship

Maestro lives in two GitHub repositories that share one history:

- **`Xateh/maestro`** (public) — the canonical `main`. This is what ships.
- **`Xateh/maestro-dev`** (private) — where work-in-progress branches live.

**Rule:** open every pull request from a branch in the **private** repo
(`maestro-dev`) **against the public repo's `main`** (`Xateh/maestro`). Do not
merge feature branches into the private repo's `main` directly. After a PR lands
on public `main`, the private repo's `main` is fast-forwarded to match.

This keeps the `main` branch of both repositories identical at all times — the
public `main` is always the single source of truth, and the private `main` is a
mirror of it. Day-to-day development (branches, drafts, experiments) stays in
the private repo; only finished, reviewed work reaches public `main`.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating you agree to uphold it; report concerns to the contact listed
there.

## Setup

- Node.js **>= 22.13** (Maestro uses the built-in `node:sqlite` driver).
- `npm ci` to install dependencies.
- Optional: [herdr](https://github.com/herdr) on your `PATH` if you want agents
  to run in visible terminal panes; without it, set `MAESTRO_BACKEND=terminal`.

## Before you open a PR

```bash
npm test          # full suite (node --test, no API keys or agent CLIs needed)
npm run lint      # Biome, lint-only (no formatter)
```

Both must pass. Tests are hermetic — they use temp dirs, stub runners, and a
mocked tracker, so a red test is your change, not your environment.

## Commit style

Short imperative subjects ("Add X", "Fix Y"). Body only when the *why* isn't
obvious from the diff.

## Keep the docs in tune

If your change touches agent-facing behavior, update the matching docs in the
same PR:

- `docs/configuration.md` for new config keys
- `docs/cli.md` for CLI changes
- `src/mcp/SCHEMA.md` whenever `src/mcp/server.mjs` tool inputs/outputs change
- `CHANGELOG.md` for anything user-visible

## Scope

Surgical diffs win. Don't reformat neighboring code, don't refactor what isn't
broken, and don't add configurability nobody asked for.
