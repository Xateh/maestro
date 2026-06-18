#!/usr/bin/env bash
# Remove private/internal artifacts from a release branch before it opens a PR to
# the public repo (Xateh/maestro). Run this immediately after cutting a release
# branch from a dev branch, then commit the removal.
#
# Internal artifacts, never to reach public main:
#   - *.private.md          internal agent instructions
#   - graphify-out/         internal knowledge-graph data (also .gitignored, and
#                           kept on the origin-only `graphify-data` branch)
#
# The companion CI guard (the `no-private-files` job in
# .github/workflows/ci.yml) is the backstop: it fails any PR to public `main`
# that still carries one of these.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

mapfile -t private < <(git ls-files '*.private.md' 'graphify-out/')

if [ "${#private[@]}" -eq 0 ]; then
  echo "strip-private: no internal artifacts tracked — nothing to remove"
  exit 0
fi

git rm -r --quiet "${private[@]}"
printf 'strip-private: removed %s\n' "${private[*]}"
echo "strip-private: commit this removal, then open the release PR to public main"
