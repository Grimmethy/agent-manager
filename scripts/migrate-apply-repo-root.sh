#!/usr/bin/env bash
# Migrates an existing projects.json to give every pool:true project its own
# isolated apply worktree under /media/model-cache/github/<repoName>-apply.
#
# Problem this fixes (HUB0244): without per-project applyRepoRoot, apply-task.js
# falls back to the shared APPLY_REPO_ROOT_DEFAULT (/media/model-cache/github),
# which is the SAME directory every project's apply loop writes into. The result
# is dirty-tree contamination -- changes from one task's apply leak into the next
# task's branch, because there is only one worktree in the pool.
#
# Solution: each pool project gets its own <repoName>-apply clone. The apply loop
# (src/apply-task.js) reads applyRepoRoot from config.js, which reads it from
# AGENT_MANAGER_APPLY_REPO_ROOT, which pool-projects.js sets per-project based on
# the entry's applyRepoRoot field in projects.json. Once every pool entry has
# applyRepoRoot set, the contamination path is closed.
#
# Usage:
#   AGENT_MANAGER_PROJECTS_PATH=./projects.json bash scripts/migrate-apply-repo-root.sh
#
# Prerequisites:
#   - jq (for projects.json manipulation)
#   - git (for cloning)
#   - gh CLI (for auth to the source repos, if needed)
#   - Write access to /media/model-cache/github/
#
# Idempotent: rerunning against an already-migrated projects.json is a no-op.
# Safe defaults: the script refuses to overwrite an existing apply clone without
# --force, and refuses to run if jq or git is missing.

set -euo pipefail

PROJECTS_JSON="${AGENT_MANAGER_PROJECTS_PATH:-./projects.json}"
APPLY_BASE="${APPLY_REPO_ROOT_BASE:-/media/model-cache/github}"

if [[ ! -f "$PROJECTS_JSON" ]]; then
  echo "error: projects.json not found at $PROJECTS_JSON" >&2
  echo "       Set AGENT_MANAGER_PROJECTS_PATH to point at it." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required but not installed" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "error: git is required but not installed" >&2
  exit 1
fi

mkdir -p "$APPLY_BASE"

# Find pool:true projects missing applyRepoRoot. Output one line per project:
# <repoName> <repoRoot>
# repoName is derived from the repoRoot basename (strip trailing /).
readarray -t MISSING < <(
  jq -r '
    [.[] | select(.pool == true) | select(.applyRepoRoot == null or .applyRepoRoot == "")]
    | .[]
    | (.repoRoot // "" | split("/") | last) as $name
    | "\($name) \(.repoRoot // "")"
  ' "$PROJECTS_JSON" 2>/dev/null || true
)

if [[ ${#MISSING[@]} -eq 0 ]]; then
  echo "All pool:true projects already have applyRepoRoot set. Nothing to migrate."
  exit 0
fi

echo "Found ${#MISSING[@]} pool project(s) missing applyRepoRoot:"
printf '  - %s\n' "${MISSING[@]}"
echo

CLONE_FAILURES=0

for entry in "${MISSING[@]}"; do
  REPO_NAME="$(echo "$entry" | cut -d' ' -f1)"
  REPO_ROOT="$(echo "$entry" | cut -d' ' -f2-)"

  APPLY_DIR="$APPLY_BASE/${REPO_NAME}-apply"

  if [[ -d "$APPLY_DIR" ]]; then
    if [[ "${FORCE_MIGRATE:-}" == "1" || "${FORCE_MIGRATE:-}" == "true" ]]; then
      echo "[migrate] $APPLY_DIR already exists -- --force given, reusing"
    else
      echo "[migrate] $APPLY_DIR already exists -- skipping (use FORCE_MIGRATE=1 to override)"
      continue
    fi
  fi

  # Derive the source repo URL from the existing repoRoot. If repoRoot is a
  # relative path under /media/model-cache/github/, the source is the parent
  # of that path; otherwise fall back to a github.com clone of the name.
  SOURCE_URL=""
  if [[ "$REPO_ROOT" == /media/model-cache/github/* ]]; then
    # e.g. /media/model-cache/github/some-repo -> https://github.com/Grimmethy/some-repo.git
    ORIGIN_NAME="$(basename "$REPO_ROOT")"
    SOURCE_URL="https://github.com/Grimmethy/${ORIGIN_NAME}.git"
  elif [[ "$REPO_ROOT" == *.git ]]; then
    SOURCE_URL="$REPO_ROOT"
  else
    SOURCE_URL="https://github.com/Grimmethy/${REPO_NAME}.git"
  fi

  echo "[migrate] cloning $SOURCE_URL -> $APPLY_DIR"
  if git clone --quiet "$SOURCE_URL" "$APPLY_DIR" 2>/dev/null; then
    echo "[migrate]   cloned OK"
  else
    echo "[migrate]   clone failed -- skipping (check credentials / network)" >&2
    CLONE_FAILURES=$((CLONE_FAILURES + 1))
    continue
  fi

  # Update projects.json in place: add applyRepoRoot to the matching entry.
  # We match on repoRoot being set, which is the unique identifier we have.
  jq --arg repoRoot "$REPO_ROOT" --arg applyRepoRoot "$APPLY_DIR" '
    [.[] | if (.repoRoot == $repoRoot) and (.applyRepoRoot == null or .applyRepoRoot == "")
           then .applyRepoRoot = $applyRepoRoot
           else . end]
  ' "$PROJECTS_JSON" > "${PROJECTS_JSON}.tmp" && mv "${PROJECTS_JSON}.tmp" "$PROJECTS_JSON"
  echo "[migrate]   updated $PROJECTS_JSON"
done

if [[ $CLONE_FAILURES -gt 0 ]]; then
  echo
  echo "warning: $CLONE_FAILURES clone(s) failed. projects.json was updated for the"
  echo "         ones that succeeded; rerun after fixing credentials/network for the rest."
  exit 1
fi

echo
echo "[migrate] done. All pool:true projects now have applyRepoRoot set."
