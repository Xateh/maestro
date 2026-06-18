#!/usr/bin/env bash
# Remove private/internal artifacts from a release branch before it opens a PR to
# the public repo (Xateh/maestro). Run this immediately after cutting a release
# branch from a dev branch, then commit the removal.
#
# Internal artifacts, never to reach public main:
#   - *.private.md          internal agent instructions
#   - graphify-out/         internal knowledge-graph data (also .gitignored, and
#                           kept on the origin-only `graphify-data` branch)
#   - docs/superpowers/, docs/specs/, docs/internal/
#                           local design/spec scratch + internal docs (.gitignored)
#   - scripts/strip-private.sh, scripts/graphify-sync.sh,
#     scripts/install-hooks.sh, scripts/hooks/
#                           the dev->public release tooling itself (stays in
#                           maestro-dev; public never needs it)
#
# Kept on public on purpose (documented features / contributor convenience):
#   scripts/secret-guard.mjs (secret-protection hook, see docs/configuration.md),
#   scripts/local-agents.mjs + scripts/headroom-setup.sh (npm script targets),
#   .nvmrc, .maestro/roles/*.md (role-convention examples, .gitignore-whitelisted).
#
# To mark a NEW file internal: add its path/glob to the list below AND to the
# matching patterns in scripts/hooks/pre-push and the no-private-files job in
# .github/workflows/ci.yml. See AGENTS.private.md.
#
# The companion CI guard (the `no-private-files` job in
# .github/workflows/ci.yml) is the backstop: it fails any PR to public `main`
# that still carries one of these.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

mapfile -t private < <(git ls-files \
  '*.private.md' \
  'graphify-out/' \
  'docs/superpowers/' \
  'docs/specs/' \
  'docs/internal/' \
  'scripts/strip-private.sh' \
  'scripts/graphify-sync.sh' \
  'scripts/install-hooks.sh' \
  'scripts/hooks/')

if [ "${#private[@]}" -eq 0 ]; then
  echo "strip-private: no internal artifacts tracked — nothing to remove"
  exit 0
fi

git rm -r --quiet "${private[@]}"
printf 'strip-private: removed %s\n' "${private[*]}"
echo "strip-private: commit this removal, then open the release PR to public main"
