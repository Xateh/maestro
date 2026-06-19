# docs/internal — Private docs

**Not for publication.** This directory holds private, internal-only material:
security audits, competitive/market analysis, and other docs that should never
ship in the public repo or npm package.

## Rules

- **Tracked on origin only — never public.** `docs/internal/` is versioned on
  the private remote (`origin` / maestro-dev) so the design record is durable and
  shareable across machines, but it is treated as a private artifact alongside
  `*.private.md` and `graphify-out/`: `scripts/strip-private.sh` removes it before
  a release branch opens a public PR, the `pre-push` hook blocks it from any
  non-`origin` remote, and the CI `no-private-files` job fails any public-`main`
  PR that still carries it. Do **not** rely on `.gitignore` here — these files
  are intentionally tracked.
- **Not packaged.** The npm `files` allowlist (`package.json`) only ships
  `bin/`, `src/`, `scripts/`, so nothing here is published — but never move
  internal docs into those paths.
- **No secrets in here either.** Internal ≠ encrypted. Keep real credentials in
  `.env*` / the secret store, not in markdown.

## What lives here

- `AUDIT-FINDINGS.md` — system/security audit findings (F1–Fn).
- `MARKET-ANALYSIS.md` — competitive landscape & market analysis.
- `ROADMAP.md` — strategic roadmap (harness thesis, pillars, horizons).

## Adding a doc

1. Drop the `.md` file in this directory.
2. Add a one-line entry under "What lives here" above.
3. Track it normally (`git add docs/internal/<file>`). The strip/pre-push/CI
   guards keep it off public `main`; do not push internal-doc branches to a
   non-`origin` remote without running `scripts/strip-private.sh` first.
