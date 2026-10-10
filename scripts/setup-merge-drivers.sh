#!/usr/bin/env bash
# Registers the candidates-doc merge driver (scripts/candidates-doc-merge-driver.js) in a
# repo's LOCAL git config, and tells git WHICH files use it. The driver COMMAND lives in local config
# (an executable driver command must not be something a cloned repo can silently inject). The attribute
# line goes in $GIT_DIR/info/attributes -- also local, never versioned -- and NOT in the working-tree
# .gitattributes (2026-10-09): appending to a consumer repo's tracked .gitattributes left a permanent
# uncommitted change (PF-Client-Portal) that made the apply clone read "dirty" forever, and in a repo
# with no .gitattributes (TaxHarvest) it created an untracked file the apply resets swept away, so the
# driver was never active. A repo that COMMITS the line itself (this one) needs nothing added.
# Idempotent -- safe to run every launch.sh, same as the rest of this pipeline's "consistency is baked
# into the process, not a one-off manual step" pattern.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
DRIVER="node ${SCRIPT_DIR}/candidates-doc-merge-driver.js %O %A %B"

git -C "$REPO_ROOT" config merge.candidates-doc.name "structural merge for Docs/*_CANDIDATES.md" 2>/dev/null || true
git -C "$REPO_ROOT" config merge.candidates-doc.driver "$DRIVER"

LINE="Docs/*_CANDIDATES.md merge=candidates-doc"
ATTRS_FILE="${REPO_ROOT}/.gitattributes"

# 1. Undo what earlier versions of this script did to the working-tree .gitattributes -- but ONLY when the
#    exact line is the sole difference (anything else in the file is someone's work and is left alone).
if [[ -f "$ATTRS_FILE" ]] && grep -qxF "$LINE" "$ATTRS_FILE"; then
  if git -C "$REPO_ROOT" ls-files --error-unmatch .gitattributes >/dev/null 2>&1; then
    if git -C "$REPO_ROOT" cat-file -e HEAD:.gitattributes 2>/dev/null \
       && ! git -C "$REPO_ROOT" show HEAD:.gitattributes | grep -qxF "$LINE" \
       && [[ "$(grep -vxF "$LINE" "$ATTRS_FILE")" == "$(git -C "$REPO_ROOT" show HEAD:.gitattributes)" ]]; then
      git -C "$REPO_ROOT" checkout -- .gitattributes
      printf '[setup-merge-drivers] restored %s (removed the line an earlier version appended)\n' "$ATTRS_FILE"
    fi
  elif [[ "$(grep -cvE '^[[:space:]]*$' "$ATTRS_FILE")" == "1" ]]; then
    rm -f "$ATTRS_FILE"                       # untracked file this script created: only the line, nothing else
    printf '[setup-merge-drivers] removed untracked %s created by an earlier version\n' "$ATTRS_FILE"
  fi
fi

# 2. Activate the attribute locally unless the repo already commits it.
if git -C "$REPO_ROOT" cat-file -e HEAD:.gitattributes 2>/dev/null && git -C "$REPO_ROOT" show HEAD:.gitattributes | grep -qxF "$LINE"; then
  exit 0
fi
INFO_ATTRS="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-path info/attributes)"
mkdir -p "$(dirname "$INFO_ATTRS")"
if [[ ! -f "$INFO_ATTRS" ]] || ! grep -qxF "$LINE" "$INFO_ATTRS"; then
  printf '%s\n' "$LINE" >> "$INFO_ATTRS"
  printf '[setup-merge-drivers] added "%s" to %s\n' "$LINE" "$INFO_ATTRS"
fi
