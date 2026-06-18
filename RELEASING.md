# Releasing

How to release `maestro-orchestrator`. GitHub Releases are automated from
tags; **npm publish stays manual on purpose** — there is no publish CI.

> **Tag the merge commit, never a pre-merge branch tip.** The version bump and
> changelog cut (steps 1–2) land through a normal PR to `main`. The release tag
> is cut **only after that PR merges**, on the resulting commit on `main` (step
> 7). Tagging a feature-branch tip before merge pins the release to a commit
> that may still gain follow-up commits (a CI fix, a review change) or never
> reach `main` at all — the tag then disagrees with `main`. If a release PR
> picks up extra commits after you opened it, that's fine: the tag waits for the
> final merged state, so it always names exactly what shipped.

> **⚠️ Read before every publish:** the GitHub repository is currently
> **private**. `npm publish` puts the full source (everything in `bin/` and
> `src/`) on the public npm registry, where it stays cached and mirrored even
> if unpublished later. Confirm that exposing the source is intended before
> running step 6.

1. **Bump the version** in `package.json` following semver. Breaking CLI or
   workflow-schema changes are a major bump; new commands/templates are minor;
   fixes are patch.

2. **Update the changelog.** Move the `## [Unreleased]` entries in
   `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD` heading.

3. **Verify the tree is green:**

   ```bash
   npm run lint && npm test
   ```

   (`prepublishOnly` runs both anyway, but fail fast here.)

4. **Review the tarball contents:**

   ```bash
   npm pack --dry-run
   ```

   Expect `bin/`, `src/` (including `src/setup/templates/`), `README.md`,
   `LICENSE`, `CHANGELOG.md`, `package.json` — roughly 60+ files. `docs/`,
   `test/`, and this file are intentionally not shipped; README links to
   `docs/` resolve on GitHub, not inside the tarball.

5. **Confirm the name and registry state.** The package publishes as
   `maestro-orchestrator` (`maestro` is taken on npm). First publish claims
   the name; later publishes must be a higher version.

6. **Publish:**

   ```bash
   npm publish --access public
   ```

7. **Merge the release PR, then tag the merge commit on `main`:**

   Steps 1–2 are committed on a release branch and reviewed as a PR. Once it is
   green and merged, tag the merged state — not the branch tip:

   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"   # on the merge commit, package.json == X.Y.Z
   git push origin vX.Y.Z
   ```

   Pushing a `v*` tag triggers `.github/workflows/release.yml`, which
   lints, tests, verifies the tag matches `package.json`'s version, packs
   the tarball, and creates a GitHub Release with the matching
   `## [x.y.z]` section of `CHANGELOG.md` as notes and the
   `maestro-orchestrator-x.y.z.tgz` tarball attached.

   The workflow never publishes to npm — step 6 remains a deliberate,
   manual decision because the repository is private and publishing
   exposes the source.
