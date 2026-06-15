#!/usr/bin/env bash
# Install repo git hooks into .git/hooks. Run once after clone.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
src="$root/scripts/hooks"
dst="$(git rev-parse --git-path hooks)"
for hook in "$src"/*; do
  name="$(basename "$hook")"
  ln -sf "../../scripts/hooks/$name" "$dst/$name"
  chmod +x "$hook"
  echo "installed hook: $name"
done
