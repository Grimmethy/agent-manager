#!/usr/bin/env bash
# Registers the candidates-doc merge driver (scripts/candidates-doc-merge-driver.js) in a
# repo's LOCAL git config. .gitattributes (versioned) says WHICH files use the driver;
# this script sets WHAT the driver command actually is, which git deliberately keeps out
# of .gitattributes (an executable driver command must not be something a cloned repo can
# silently inject). Idempotent -- safe to run every launch.sh, same as the rest of this
# pipeline's "consistency is baked into the process, not a one-off manual step" pattern.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
DRIVER="node ${SCRIPT_DIR}/candidates-doc-merge-driver.js %O %A %B"

git -C "$REPO_ROOT" config merge.candidates-doc.name "structural merge for Docs/*_CANDIDATES.md" 2>/dev/null || true
git -C "$REPO_ROOT" config merge.candidates-doc.driver "$DRIVER"

ATTRS_FILE="${REPO_ROOT}/.gitattributes"
LINE="Docs/*_CANDIDATES.md merge=candidates-doc"
if [[ ! -f "$ATTRS_FILE" ]] || ! grep -qxF "$LINE" "$ATTRS_FILE"; then
  printf '%s\n' "$LINE" >> "$ATTRS_FILE"
  printf '[setup-merge-drivers] added "%s" to %s\n' "$LINE" "$ATTRS_FILE"
fi
