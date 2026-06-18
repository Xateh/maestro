# Agent instructions — INTERNAL, private repo only

> **This file must never reach public `main`.** It documents the internal
> release-engineering flow and is stripped from every release branch by
> `scripts/strip-private.sh`. The `no-private-files` CI job is the backstop: it
> fails any pull request to public `main` that still carries a `*.private.md`
> file. Do not move this content into `CONTRIBUTING.md`, `RELEASING.md`,
> `README.md`, or any other tracked file that ships to public `main`.
>
> **Internal artifacts get the same treatment.** Both `*.private.md` (these
> agent instructions) and `graphify-out/` (internal knowledge-graph data) are
> private. `graphify-out/` is `.gitignored` on normal branches and snapshotted
> only to the origin-only `graphify-data` branch (see `scripts/graphify-sync.sh`,
> never pushed to `public`); the strip script and CI guard cover it too as a
> backstop. Never push the `graphify-data` branch to `public`.

## Remotes

- `origin` → `Xateh/maestro-dev` — the **private** repo. All work lives here.
- `public` → `Xateh/maestro` — the **public** repo. Only release branches PR here.

## Branch model

```
topic/feature branches ──(internal PRs)──► dev (integration) branches   [private]
                                                   │
                                                   ▼
                                            release branches             [private]
                                                   │
                                                   ▼  (the ONLY allowed PR to public)
                                            public main                  [public]
                                                   │
                              private main is fast-forwarded to match,
                              never ahead — the changelog / consistency reference
```

## Rules (do not violate)

1. **All development happens in the private repo (`origin`).** Topic and feature
   branches live in `maestro-dev`. Never push feature work to `public`.
2. **Internal/development PRs target dev (integration) branches**, not `main` —
   neither private `main` nor public `main`.
3. **Only release branches may open a PR to public `main`** (`public`). No topic,
   feature, or dev branch ever PRs directly to public `main`.
4. **Private `main` must never be ahead of public `main`.** It mirrors public
   `main` and is fast-forwarded to it after a release lands. It is the
   changelog / update reference: when a release branch opens its PR to public
   `main`, verify the diff for consistency against private `main` (which reflects
   exactly what is already shipped). `CHANGELOG.md` on private `main` is the
   source of truth for "what shipped".
5. **Cut a release without leaking private files.** On the freshly cut release
   branch, before opening the PR to public `main`:

   ```bash
   scripts/strip-private.sh   # removes every tracked *.private.md
   git commit -m "chore(release): strip private files"
   ```

   Then open the release branch → public `main` PR. If you forget, the
   `no-private-files` CI job fails the PR.
