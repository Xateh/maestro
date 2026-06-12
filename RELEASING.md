# Releasing

How to publish `maestro-orchestrator` to npm. Manual process — there is no
publish CI on purpose.

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

7. **Tag and release:**

   ```bash
   git tag vX.Y.Z
   git push --tags
   ```

   Create the GitHub release from the new changelog section.
