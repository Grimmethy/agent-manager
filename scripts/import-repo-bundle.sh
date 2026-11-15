#!/usr/bin/env bash
# Imports a repo bundle (made by scripts/export-repo-bundle.sh) on a node that has no GitHub access (multi-node plan, piece 8b). Run it on the node.
# It never contacts a network: the only source it reads is the bundle file. The clone it makes has NO remote, so there is nothing to push to and no credential to hold.
#
# Usage: scripts/import-repo-bundle.sh <bundle-file> <dest-dir> [branch]      (branch defaults to master)
#
#   dest-dir missing or empty   git clone from the bundle, remove the remote 'origin', set the identity 'agent-manager-node' in that clone only.
#   dest-dir is a clone         on <branch> with a clean work tree: fetch the bundle and fast-forward (a bundle that is not newer changes nothing).
# Prints one line: head=<40 hex> dest=<absolute path>.
# Exit 2 (nothing changed) for a wrong argument count, an empty argument, an unreadable or invalid bundle, a bundle without the branch, or a dest-dir that is not empty and not a
# git work tree. Exit 3 (nothing changed) for an existing clone that is dirty, is on another branch, or has history the bundle's branch does not contain.
set -euo pipefail

refuse() { printf 'import-repo-bundle: %s\n' "$1" >&2; exit 2; }
hold() { printf 'import-repo-bundle: %s\n' "$1" >&2; exit 3; }

[[ $# -ge 2 && $# -le 3 ]] || refuse "usage: scripts/import-repo-bundle.sh <bundle-file> <dest-dir> [branch]"
BUNDLE="$1"; DEST="$2"; BRANCH="${3:-master}"
[[ -n "$BUNDLE" && -n "$DEST" && -n "$BRANCH" ]] || refuse "an argument is empty"
[[ -f "$BUNDLE" && -r "$BUNDLE" ]] || refuse "cannot read the bundle: $BUNDLE"
BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"

CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "$CHECK_DIR"' EXIT
git -C "$CHECK_DIR" init -q
git -C "$CHECK_DIR" bundle verify "$BUNDLE" >/dev/null 2>&1 || refuse "the bundle does not verify: $BUNDLE"
BUNDLE_SHA="$(git ls-remote "$BUNDLE" "refs/heads/$BRANCH" 2>/dev/null | cut -f1 | head -n 1)"
[[ -n "$BUNDLE_SHA" ]] || refuse "the bundle has no branch $BRANCH"

is_clone() { [[ -d "$DEST" && "$(git -C "$DEST" rev-parse --show-toplevel 2>/dev/null || true)" == "$(cd "$DEST" && pwd -P)" ]]; }

if [[ ! -e "$DEST" ]] || { [[ -d "$DEST" ]] && [[ -z "$(ls -A "$DEST")" ]]; }; then
  git clone -q --branch "$BRANCH" "$BUNDLE" "$DEST" >/dev/null 2>&1 || { printf 'import-repo-bundle: git clone failed\n' >&2; exit 1; }
  git -C "$DEST" remote remove origin
  git -C "$DEST" config user.name 'agent-manager-node'
  git -C "$DEST" config user.email 'agent-manager-node@localhost'
elif is_clone; then
  [[ -z "$(git -C "$DEST" status --porcelain)" ]] || hold "the clone has uncommitted changes: $DEST"
  [[ "$(git -C "$DEST" symbolic-ref --short -q HEAD || true)" == "$BRANCH" ]] || hold "the clone is not on branch $BRANCH: $DEST"
  git -C "$DEST" fetch -q "$BUNDLE" "refs/heads/$BRANCH" >/dev/null 2>&1 || { printf 'import-repo-bundle: git fetch failed\n' >&2; exit 1; }
  if git -C "$DEST" merge-base --is-ancestor FETCH_HEAD HEAD; then
    :
  elif git -C "$DEST" merge-base --is-ancestor HEAD FETCH_HEAD; then
    git -C "$DEST" merge -q --ff-only FETCH_HEAD >/dev/null
  else
    hold "the clone has history that the bundle's $BRANCH does not contain: $DEST"
  fi
else
  refuse "the destination is not empty and not a git work tree: $DEST"
fi
printf 'head=%s dest=%s\n' "$(git -C "$DEST" rev-parse HEAD)" "$(cd "$DEST" && pwd -P)"
