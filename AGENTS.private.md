# AGENTS.private.md — internal instructions (maestro-dev only)

This file lives only in the private repo (`Xateh/maestro-dev`, remote `origin`).
It matches the `*.private.md` strip rule, so it never reaches public
(`Xateh/maestro`). Do not link to it from any public doc.

## Keep dev-only files out of the public repo

Some files belong in `maestro-dev` but must never reach public `main`. There are
two classes:

1. **Never tracked anywhere** — local scratch. Already `.gitignore`d; if you find
   one tracked, untrack it (`git rm -r --cached <path>`):
   - `docs/superpowers/` — design/spec scratch
   - `docs/specs/` — design/spec scratch
   - `docs/internal/` — internal docs (audits, market analysis, roadmap)
   - `graphify-out/` — internal knowledge-graph data (also on the `graphify-data` branch)

2. **Tracked in dev, stripped before public** — dev/release tooling that the
   public repo never needs:
   - `scripts/strip-private.sh`
   - `scripts/graphify-sync.sh`
   - `scripts/install-hooks.sh`
   - `scripts/hooks/` (the `pre-push` hook)
   - `*.private.md` (including this file)

### Kept on public on purpose — do NOT strip these

- `scripts/secret-guard.mjs` — secret-protection hook, a documented product
  feature (`docs/configuration.md`).
- `scripts/local-agents.mjs`, `scripts/headroom-setup.sh` — wired to the
  `agent:*` / `headroom:setup` npm script targets in `package.json`.
- `.nvmrc` — contributor node-version convenience.
- `.maestro/roles/*.md` — Role Convention examples; `.gitignore`-whitelisted and
  documented in `docs/role-convention.md`.

## Enforcement — three gates, one list

The internal-file list is duplicated across three places. **When you add or
remove an internal file, update all three** (and this doc):

1. `scripts/strip-private.sh` — the `git ls-files` glob list. Run on a release
   branch after cutting it from a dev branch; commit the removal before opening
   the public PR.
2. `.github/workflows/ci.yml` — the `no-private-files` job. Self-contained inline
   `git ls-files`; fails any PR to public `main` that still carries an internal
   file. This is the backstop and does not depend on any stripped script.
3. `scripts/hooks/pre-push` — `grep -E` regex; blocks pushing internal files to
   any non-`origin` remote locally. Installed via `scripts/install-hooks.sh`.

## Release flow (dev -> public)

1. Cut a release branch from the dev branch.
2. Run `bash scripts/strip-private.sh`, commit the removal.
3. Open the PR to public `main`. The `no-private-files` CI job verifies nothing
   internal slipped through.
