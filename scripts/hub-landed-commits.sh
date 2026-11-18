#!/usr/bin/env bash
# Writes the commits reachable from origin/master to a file as a JSON array of commit ids, for the Node modules to read.
# Read-only: it runs only `git rev-parse --verify` and `git rev-list origin/master`. It does not fetch, change any ref, or touch the work tree.
#
# Usage: scripts/hub-landed-commits.sh <out-file>
#
# Writes <out-file> atomically (temp file, then mv) and prints exactly one line: landed=<count> out=<path>.
# Exit 2 (nothing written) for a missing or extra argument, or when origin/master does not resolve.
set -euo pipefail

refuse() { printf 'hub-landed-commits: %s\n' "$1" >&2; exit 2; }

[[ $# -eq 1 ]] || refuse 'usage: scripts/hub-landed-commits.sh <out-file>'
[[ -n "$1" ]] || refuse 'output path is empty'
mkdir -p "$(dirname "$1")"
OUT="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
TMP="${OUT}.part.$$"
trap 'rm -f "$TMP"' EXIT

git rev-parse --verify --quiet origin/master >/dev/null || refuse 'origin/master does not resolve'
LIST="$(git rev-list origin/master)"

ids=()
n=0
while IFS= read -r id; do
  [[ -n "$id" ]] || continue
  [[ "$id" =~ ^[0-9a-f]{40}$ ]] || refuse "unexpected commit id: $id"
  ids+=("\"$id\"")
  n=$((n + 1))
done <<< "$LIST"

joined=''
if (( n > 0 )); then
  joined="$(IFS=,; printf '%s' "${ids[*]}")"
fi
printf '[%s]\n' "$joined" > "$TMP"
mv -f "$TMP" "$OUT"
trap - EXIT
printf 'landed=%s out=%s\n' "$n" "$OUT"
