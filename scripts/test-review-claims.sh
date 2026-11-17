#!/usr/bin/env bash
# Race tests for claim_review_item() in scripts/review-runner.sh.
# Each racer is a separate bash process (distinct $$), matching how separate daemons claim items.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/review-runner.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
FN="$T/fn.sh"
# Extract the real function body from the script so the test exercises the shipped code.
sed -n '/^claim_review_item() {/,/^}/p' "$SRC" > "$FN"
if ! grep -q '^claim_review_item() {' "$FN"; then echo 'FAIL: could not extract claim_review_item'; exit 1; fi
fail=0

# race <claim_dir> <item> <n_racers> -> prints number of winners
race() {
  local cdir="$1" item="$2" n="$3" i out="$T/out.$RANDOM"
  : > "$out"
  for i in $(seq 1 "$n"); do
    bash -c 'set -u; CLAIM_DIR="$1"; INSTANCE_ID="racer$2"; source "$3"; claim_review_item "$4" && { echo WIN; sleep 2; }' _ "$cdir" "$i" "$FN" "$item" >> "$out" 2>/dev/null &
  done
  wait
  grep -c '^WIN$' "$out" || true
}

# Case 1: fresh item, 8 racers -> exactly one winner, and the winning claim has a complete owner file.
C1="$T/c1"; mkdir -p "$C1"
w=$(race "$C1" item1 8)
if [[ "$w" == "1" ]]; then echo 'PASS: fresh claim race -> 1 winner'; else echo "FAIL: fresh claim race -> $w winners"; fail=1; fi
if [[ -s "$C1/item1.d/owner" ]] && grep -q '^[0-9]\+ racer[0-9]\+$' "$C1/item1.d/owner"; then
  echo 'PASS: winning claim has complete owner file'
else
  echo 'FAIL: owner file missing or incomplete'; fail=1
fi

# Case 2: stale claim (dead owner pid, old mtime) -> exactly one takeover among 8 racers.
C2="$T/c2"; mkdir -p "$C2/item2.d"
printf '2000000000 dead\n' > "$C2/item2.d/owner"
touch -d '5 hours ago' "$C2/item2.d"
w=$(race "$C2" item2 8)
if [[ "$w" == "1" ]]; then echo 'PASS: stale takeover race -> 1 winner'; else echo "FAIL: stale takeover race -> $w winners"; fail=1; fi

# Case 3: live claim (our own pid) is not taken over.
C3="$T/c3"; mkdir -p "$C3/item3.d"
printf '%s live\n' "$$" > "$C3/item3.d/owner"
w=$(race "$C3" item3 4)
if [[ "$w" == "0" ]]; then echo 'PASS: live claim not taken over'; else echo "FAIL: live claim taken over ($w)"; fail=1; fi

exit $fail
