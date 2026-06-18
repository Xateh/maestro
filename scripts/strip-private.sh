#!/usr/bin/env bash
# Remove private/internal files (*.private.md) from a release branch before it
# opens a PR to the public repo (Xateh/maestro). Run this immediately after
# cutting a release branch from a dev branch, then commit the removal.
#
# The companion CI guard (the `no-private-files` job in
# .github/workflows/ci.yml) is the backstop: it fails any PR to public `main`
# that still carries a *.private.md file.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

mapfile -t private < <(git ls-files '*.private.md')

if [ "${#private[@]}" -eq 0 ]; then
  echo "strip-private: no *.private.md files tracked — nothing to remove"
  exit 0
fi

git rm --quiet "${private[@]}"
printf 'strip-private: removed %s\n' "${private[*]}"
echo "strip-private: commit this removal, then open the release PR to public main"
