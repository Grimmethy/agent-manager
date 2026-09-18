#!/usr/bin/env bash
# check-doc-link.sh — drift guard for the agent docs.
#
# Fails (exit 1) if any of:
#   1. AGENTS.md is missing at the repo root.
#   2. CLAUDE.md is not a symlink, or its readlink target is not 'AGENTS.md'.
#   3. Any relative markdown link target in AGENTS.md does not resolve
#      to an existing path at the repo root.
#   4. Any src/*.js path referenced in AGENTS.md does not exist.
# Prints a PASS line and exits 0 otherwise.
#
# This script only READS AGENTS.md and CLAUDE.md; it never modifies them.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$ROOT/AGENTS.md"
CLAUDE="$ROOT/CLAUDE.md"
fail=0

# --- 1. AGENTS.md must exist as a regular file -------------------------------
if [[ ! -f "$AGENTS" ]]; then
  echo "FAIL: AGENTS.md is missing at the repo root"
  exit 1
fi

# --- 2. CLAUDE.md must be a symlink whose target is exactly 'AGENTS.md' ------
if [[ ! -L "$CLAUDE" ]]; then
  echo "FAIL: CLAUDE.md is not a symlink (expected CLAUDE.md -> AGENTS.md)"
  exit 1
fi
target="$(readlink "$CLAUDE")"
if [[ "$target" != "AGENTS.md" ]]; then
  echo "FAIL: CLAUDE.md -> $target (expected AGENTS.md)"
  exit 1
fi

# --- 3. Relative markdown links in AGENTS.md must resolve -------------------
# A link target is considered relative/local when it is non-empty, not a
# fragment, not an absolute path, and contains no colon (a colon always
# indicates a non-local reference, which we do not validate).
while IFS= read -r raw; do
  path="${raw#*[}"
  path="${path%]}"
  [[ -z "$path" ]] && continue
  [[ "$path" == \#* ]] && continue
  [[ "$path" == /* ]] && continue
  [[ "$path" == *:* ]] && continue
  path="${path%%#*}"      # strip trailing #fragment
  [[ -z "$path" ]] && continue
  if [[ ! -e "$ROOT/$path" ]]; then
    echo "FAIL: broken relative link in AGENTS.md: $path"
    fail=1
  fi
done < <(grep -oE '\[[^]]*\]\([^)]+\)' "$AGENTS" || true)

# --- 4. Every src/*.js path referenced in AGENTS.md must exist --------------
while IFS= read -r ref; do
  [[ -z "$ref" ]] && continue
  if [[ ! -f "$ROOT/$ref" ]]; then
    echo "FAIL: missing referenced file: $ref"
    fail=1
  fi
done < <(grep -oE 'src/[A-Za-z0-9_./-]+\.js' "$AGENTS" | sort -u || true)

# --- Verdict -----------------------------------------------------------------
if [[ $fail -ne 0 ]]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "PASS: AGENTS.md present, CLAUDE.md symlink valid, all referenced paths exist"
exit 0
