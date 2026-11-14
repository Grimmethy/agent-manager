#!/usr/bin/env bash
# Exports one branch of a git repository as a single bundle file (multi-node plan, piece 8a): the way a node with no GitHub access gets a copy of a repo.
# Run it on the machine that has the repo (wok). It only READS the repo: no fetch, no remote contact, no change to the repo. Copying the file to the node is the owner's step.
#
# Usage: scripts/export-repo-bundle.sh <repo-dir> <out-dir> [branch]      (branch defaults to master)
#
# Writes <out-dir>/<repo-basename>-<first 8 characters of the branch sha>.bundle, checks it with `git bundle verify`, and prints exactly one line:
#   bundle=<path> sha=<40 hex> branch=<name>
# A second run for the same sha leaves the same file name in place. Exit 2 (nothing written) for a missing or extra argument, a repo-dir that is not a git work tree,
# or a branch that does not exist.
set -euo pipefail

refuse() { printf 'export-repo-bundle: %s\n' "$1" >&2; exit 2; }

[[ $# -ge 2 && $# -le 3 ]] || refuse "usage: scripts/export-repo-bundle.sh <repo-dir> <out-dir> [branch]"
REPO_DIR="$1"; OUT_DIR="$2"; BRANCH="${3:-master}"
[[ -n "$REPO_DIR" && -n "$OUT_DIR" && -n "$BRANCH" ]] || refuse "an argument is empty"
[[ "$(git -C "$REPO_DIR" rev-parse --is-inside-work-tree 2>/dev/null || true)" == "true" ]] || refuse "not a git work tree: $REPO_DIR"
SHA="$(git -C "$REPO_DIR" rev-parse --verify --quiet "refs/heads/$BRANCH" || true)"
[[ -n "$SHA" ]] || refuse "no such branch: $BRANCH"

NAME="$(basename "$(git -C "$REPO_DIR" rev-parse --show-toplevel)")"
mkdir -p "$OUT_DIR"
BUNDLE="$(cd "$OUT_DIR" && pwd)/${NAME}-${SHA:0:8}.bundle"
TMP="${BUNDLE}.part.$$"
trap 'rm -f "$TMP"' EXIT
git -C "$REPO_DIR" bundle create "$TMP" "refs/heads/$BRANCH" >/dev/null 2>&1 || { printf 'export-repo-bundle: git bundle create failed\n' >&2; exit 1; }
git -C "$REPO_DIR" bundle verify "$TMP" >/dev/null 2>&1 || { printf 'export-repo-bundle: the new bundle does not verify\n' >&2; exit 1; }
mv -f "$TMP" "$BUNDLE"
trap - EXIT
printf 'bundle=%s sha=%s branch=%s\n' "$BUNDLE" "$SHA" "$BRANCH"
