#!/usr/bin/env bash
# Copies the crash-recovery systemd units into DEST_DIR and prints the commands the owner runs.
# This script enables nothing and starts nothing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/scripts/systemd"
UNITS=(agent-manager-crash-recover.service agent-manager-dashboard.service)

if [ "$#" -ne 1 ]; then
  echo "usage: $0 DEST_DIR   (absolute path; units are copied there, nothing is enabled)" >&2
  exit 2
fi
case "$1" in
  /*) ;;
  *) echo "DEST_DIR must be an absolute path" >&2; exit 2 ;;
esac
DEST_DIR="$1"
mkdir -p "$DEST_DIR"

copied=0
unchanged=0
differs=0
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

for unit in "${UNITS[@]}"; do
  sed "s|@REPO@|$REPO_ROOT|g" "$SRC_DIR/$unit" > "$tmp"
  dest="$DEST_DIR/$unit"
  if [ ! -e "$dest" ]; then
    cp "$tmp" "$dest"
    echo "copied $dest"
    copied=$((copied + 1))
  elif cmp -s "$tmp" "$dest"; then
    echo "unchanged $dest"
    unchanged=$((unchanged + 1))
  else
    echo "differs (not overwritten) $dest"
    differs=$((differs + 1))
  fi
done

echo ""
echo "copied: $copied  unchanged: $unchanged  differs: $differs"
echo ""
echo "Run these yourself (system unit, needs root):"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable $DEST_DIR/agent-manager-crash-recover.service"
echo "Run these yourself (dashboard user unit):"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable $DEST_DIR/agent-manager-dashboard.service"
echo "  loginctl enable-linger ${USER:-<your-login>}"
echo ""
echo "Nothing was enabled or started"

if [ "$differs" -gt 0 ]; then
  exit 3
fi
