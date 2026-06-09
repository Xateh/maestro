#!/usr/bin/env bash
# headroom-setup.sh — provision headroom for Symphony
#
# Usage:
#   bash scripts/headroom-setup.sh [--mode light|heavy] [--swap-gb N] [--port P] [--user USERNAME]
#   sudo bash scripts/headroom-setup.sh --mode heavy --swap-gb 8 --user dump
#   # as root (no sudo): bash scripts/headroom-setup.sh --mode heavy --swap-gb 8 --user dump
#
# --user USERNAME  the account whose uv/headroom env to use (required when running
#                  as root without sudo, since $SUDO_USER is not set in that case)
#
# Without flags, reads .symphony/config.json headroom block for defaults.
# Safe to re-run (idempotent). Prints a summary at the end.
#
# IMPORTANT: --swap-gb requires root (modifies /swapfile-headroom + /etc/fstab).
#            Never run from inside a Symphony agent task.
#
# Upgrade / downgrade paths:
#   light → heavy: bash scripts/headroom-setup.sh --mode heavy --swap-gb 8 --user dump
#   heavy → light: bash scripts/headroom-setup.sh --mode light --user dump
#
# Rollback swap manually:
#   swapoff /swapfile-headroom
#   rm /swapfile-headroom
#   # then remove the guarded line from /etc/fstab (printed by this script)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYMPHONY_ROOT="$(dirname "$SCRIPT_DIR")"
STATE_DIR="$SYMPHONY_ROOT/.symphony"
CONFIG_FILE="$STATE_DIR/config.json"

# ── defaults (overridden by config.json then CLI flags) ────────────────────────
MODE="light"
EXTRAS_LIGHT="proxy,mcp,code"
EXTRAS_HEAVY="all"
PROXY_PORT=8787
SWAP_GB=0
SWAP_SKIPPED=0
TARGET_USER="${SUDO_USER:-$USER}"  # overridden by --user; falls back to $SUDO_USER then current user

# ── read .symphony/config.json if present ─────────────────────────────────────
if [[ -f "$CONFIG_FILE" ]]; then
  _read_cfg() {
    node -e "
      const fs = require('fs');
      const c = JSON.parse(fs.readFileSync('$CONFIG_FILE','utf8'));
      const h = c.headroom ?? {};
      process.stdout.write(JSON.stringify({
        mode: h.mode ?? 'light',
        extras_light: h.extras_light ?? 'proxy,mcp,code',
        extras_heavy: h.extras_heavy ?? 'all',
        proxy_port: h.proxy_port ?? 8787,
        swap_gb: h.swap_gb ?? 0,
      }));
    " 2>/dev/null || true
  }
  _cfg=$(_read_cfg)
  if [[ -n "$_cfg" ]]; then
    MODE=$(echo "$_cfg"       | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).mode)")
    EXTRAS_LIGHT=$(echo "$_cfg" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).extras_light)")
    EXTRAS_HEAVY=$(echo "$_cfg"  | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).extras_heavy)")
    PROXY_PORT=$(echo "$_cfg"  | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).proxy_port))")
    SWAP_GB=$(echo "$_cfg"    | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).swap_gb))")
  fi
fi

# ── parse CLI flags (override config) ─────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)    MODE="$2";        shift 2 ;;
    --swap-gb) SWAP_GB="$2";     shift 2 ;;
    --port)    PROXY_PORT="$2";  shift 2 ;;
    --user)    TARGET_USER="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

echo "headroom-setup: mode=$MODE proxy_port=$PROXY_PORT swap_gb=$SWAP_GB"

# ── helpers ───────────────────────────────────────────────────────────────────
die() { echo "ERROR: $*" >&2; exit 1; }

# resolve a binary for TARGET_USER by checking known install locations
find_user_bin() {
  local name="$1"
  local home="/home/${TARGET_USER:-}"
  for candidate in \
    "$home/.pixi/bin/$name" \
    "$home/.local/bin/$name" \
    "$home/.cargo/bin/$name" \
    "$(command -v "$name" 2>/dev/null || true)"
  do
    [[ -x "$candidate" ]] && echo "$candidate" && return 0
  done
  return 1
}

# run a command as TARGET_USER when root; otherwise run directly
run_as_user() {
  if [[ -n "$TARGET_USER" && "$EUID" -eq 0 ]]; then
    su "$TARGET_USER" -s /bin/sh -c "$(printf '%q ' "$@")"
  else
    "$@"
  fi
}

UV_BIN=""
require_uv() {
  UV_BIN=$(find_user_bin uv) \
    || die "uv not found. Checked ~/.pixi/bin, ~/.local/bin, PATH. Install: pixi global install uv"
}

HEADROOM_BIN=""
require_headroom_bin() {
  HEADROOM_BIN=$(find_user_bin headroom) \
    || die "headroom not found after install. Checked ~/.pixi/bin, ~/.local/bin, PATH."
}

# ── swap growth (heavy only, sudo required) ───────────────────────────────────
maybe_grow_swap() {
  local target_gb="$1"
  [[ "$target_gb" -le 0 ]] && return 0

  # current total swap in GiB
  local current_gb
  current_gb=$(awk '{sum+=$3} END {printf "%d", sum/1024/1024/1024}' <(swapon --show --bytes --noheadings 2>/dev/null || true))
  current_gb=${current_gb:-0}

  if [[ "$target_gb" -le "$current_gb" ]]; then
    echo "  swap: already at ${current_gb}GiB (target ${target_gb}GiB) — nothing to do"
    return 0
  fi

  local delta_gb=$(( target_gb - current_gb ))
  echo "  swap: growing by ${delta_gb}GiB (${current_gb}GiB → ${target_gb}GiB)"

  # must be root — warn and skip swap (do not abort; heavy install still proceeds)
  if [[ "$EUID" -ne 0 ]]; then
    echo "  swap: WARNING: growing swap requires root — skipping swap step." >&2
    echo "  swap: To grow swap, re-run: sudo $0 $*" >&2
    SWAP_SKIPPED=1
    return 0
  fi

  # disk space check (need delta + 2 GiB buffer) — warn and skip, do not abort
  local needed_gb=$(( delta_gb + 2 ))
  local free_gb
  free_gb=$(df -BG / --output=avail | tail -1 | tr -d 'G ')
  if [[ "$free_gb" -lt "$needed_gb" ]]; then
    echo "  swap: WARNING: not enough disk space (need ${needed_gb}GiB free, have ${free_gb}GiB) — skipping swap step." >&2
    echo "  swap: Free up disk space and re-run to grow swap." >&2
    SWAP_SKIPPED=1
    return 0
  fi

  local SWAPFILE="/swapfile-headroom"

  if [[ -f "$SWAPFILE" ]]; then
    local existing_gb=$(( $(stat -c %s "$SWAPFILE" 2>/dev/null || echo 0) / 1024 / 1024 / 1024 ))
    if [[ "$existing_gb" -lt "$delta_gb" ]]; then
      echo "  swap: WARNING: $SWAPFILE exists but is only ${existing_gb}GiB (target ${delta_gb}GiB)." >&2
      echo "  swap: To resize: swapoff $SWAPFILE && rm $SWAPFILE, then re-run." >&2
      SWAP_SKIPPED=1
    else
      echo "  swap: $SWAPFILE already exists — skipping creation (idempotent)"
    fi
  else
    echo "  swap: creating $SWAPFILE (${delta_gb}GiB)"
    fallocate -l "${delta_gb}G" "$SWAPFILE" 2>/dev/null \
      || dd if=/dev/zero of="$SWAPFILE" bs=1G count="$delta_gb" status=progress
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE"
    swapon "$SWAPFILE"
    echo "  swap: enabled $SWAPFILE"
  fi

  # guard fstab entry (idempotent)
  local FSTAB_LINE="$SWAPFILE none swap sw 0 0  # headroom"
  if grep -qF "/swapfile-headroom" /etc/fstab 2>/dev/null; then
    echo "  fstab: entry already present — skipping"
  else
    echo "$FSTAB_LINE" >> /etc/fstab
    echo "  fstab: added → $FSTAB_LINE"
    echo "  fstab: to remove: sudo sed -i '/\\/swapfile-headroom/d' /etc/fstab"
  fi
}

# ── proxy management ──────────────────────────────────────────────────────────
stop_proxy() {
  if pkill -f "headroom proxy --port ${PROXY_PORT}" 2>/dev/null; then
    echo "  proxy: stopped existing instance on port ${PROXY_PORT}"
  fi
  # give it a moment to release the port
  local n=0
  while curl -sf "http://localhost:${PROXY_PORT}/livez" > /dev/null 2>&1; do
    n=$(( n + 1 )); [[ $n -ge 10 ]] && die "Port ${PROXY_PORT} still occupied after 10s"
    sleep 1
  done
}

start_proxy() {
  local user_home
  user_home=$(run_as_user sh -c 'echo $HOME')
  local log_file="$user_home/.headroom/logs/proxy.log"
  run_as_user mkdir -p "$(dirname "$log_file")"
  echo "  proxy: starting on port ${PROXY_PORT} (log: $log_file)"
  # fully detach so it survives shell exit; redirection runs inside su so log is owned by TARGET_USER
  run_as_user sh -c "setsid nohup \"$HEADROOM_BIN\" proxy --port \"$PROXY_PORT\" >> \"$log_file\" 2>&1 &"

  # wait for /livez (up to 30s)
  local n=0
  while ! curl -sf "http://localhost:${PROXY_PORT}/livez" > /dev/null 2>&1; do
    n=$(( n + 1 ))
    [[ $n -ge 30 ]] && die "Proxy did not become ready within 30s. Check $log_file"
    sleep 1
  done
  echo "  proxy: ready (${n}s)"
}

# ── main ──────────────────────────────────────────────────────────────────────
require_uv

SWAP_BEFORE=$(awk '{sum+=$3} END {printf "%.1fGiB", sum/1024/1024/1024}' <(swapon --show --bytes --noheadings 2>/dev/null || echo "0 0 0"))

case "$MODE" in
  light)
    echo "=== installing headroom-ai[$EXTRAS_LIGHT] ==="
    run_as_user "$UV_BIN" tool install --force "headroom-ai[$EXTRAS_LIGHT]"
    require_headroom_bin
    stop_proxy
    start_proxy
    ;;
  heavy)
    echo "=== growing swap (if needed) ==="
    maybe_grow_swap "$SWAP_GB"

    echo "=== installing headroom-ai[$EXTRAS_HEAVY] ==="
    run_as_user "$UV_BIN" tool install --force "headroom-ai[$EXTRAS_HEAVY]"
    require_headroom_bin
    stop_proxy
    start_proxy
    ;;
  *)
    die "Unknown mode '$MODE'. Use light or heavy."
    ;;
esac

# ── summary ───────────────────────────────────────────────────────────────────
SWAP_AFTER=$(awk '{sum+=$3} END {printf "%.1fGiB", sum/1024/1024/1024}' <(swapon --show --bytes --noheadings 2>/dev/null || echo "0 0 0"))
PROXY_HEALTH=$(curl -sf "http://localhost:${PROXY_PORT}/health" 2>/dev/null | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write(d.status + ' v' + d.version);
" 2>/dev/null || echo "unknown")

echo ""
echo "=== headroom-setup done ==="
echo "  mode:    $MODE"
echo "  extras:  $(headroom --version 2>&1 | head -1)"
echo "  proxy:   http://localhost:${PROXY_PORT}  ($PROXY_HEALTH)"
echo "  swap:    $SWAP_BEFORE → $SWAP_AFTER"
if [[ "$SWAP_SKIPPED" -eq 1 ]]; then
  echo ""
  echo "  *** WARNING: swap growth was skipped (no root or insufficient disk). ***"
  echo "  *** Heavy mode may OOM without additional swap.                       ***"
  echo "  *** To grow swap: sudo bash scripts/headroom-setup.sh --mode heavy --swap-gb ${SWAP_GB} ***"
fi
echo ""
echo "To use headroom proxy with Symphony agents:"
echo "  export ANTHROPIC_BASE_URL=http://localhost:${PROXY_PORT}"
echo "  export OPENAI_BASE_URL=http://localhost:${PROXY_PORT}/v1"
echo "  export HEADROOM_PROXY_URL=http://localhost:${PROXY_PORT}"
echo ""
echo "To enable prior-output compression in Symphony:"
echo "  set \"headroom\": { \"mode\": \"$MODE\", \"proxy_port\": $PROXY_PORT } in .symphony/config.json"
echo "  and set prior_output_compression: \"headroom\" in your task config"
