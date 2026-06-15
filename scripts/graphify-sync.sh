#!/usr/bin/env bash
# Snapshot graphify-out/ onto the orphan branch `graphify-data` and push to origin.
# graphify-out/ is .gitignored on normal branches (must never reach the public remote),
# so this lives on a dedicated branch pushed ONLY to origin (maestro-dev).
#
# Uses git plumbing: builds the commit via a temp index so the working tree and the
# currently checked-out branch are never touched.
set -euo pipefail

BRANCH="graphify-data"
DIR="graphify-out"
REMOTE="origin"

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [ ! -d "$DIR" ]; then
  echo "graphify-sync: no $DIR/ — nothing to snapshot" >&2
  exit 0
fi

# Build a tree containing only graphify-out/ in an isolated index.
tmp_index="$(mktemp)"
trap 'rm -f "$tmp_index"' EXIT
export GIT_INDEX_FILE="$tmp_index"
git read-tree --empty
git add -f "$DIR"
tree="$(git write-tree)"
unset GIT_INDEX_FILE

parent="$(git rev-parse -q --verify "refs/heads/$BRANCH" || true)"

# Skip if nothing changed since last snapshot.
if [ -n "$parent" ]; then
  parent_tree="$(git rev-parse "$parent^{tree}")"
  if [ "$tree" = "$parent_tree" ]; then
    echo "graphify-sync: $DIR/ unchanged — skipping" >&2
    exit 0
  fi
fi

msg="graphify-out snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -n "$parent" ]; then
  commit="$(git commit-tree "$tree" -p "$parent" -m "$msg")"
else
  commit="$(git commit-tree "$tree" -m "$msg")"
fi
git update-ref "refs/heads/$BRANCH" "$commit"

# Guard against pre-push recursion when this push re-enters the hook.
GRAPHIFY_SYNC=1 git push "$REMOTE" "$BRANCH:$BRANCH"
echo "graphify-sync: pushed $BRANCH to $REMOTE" >&2
