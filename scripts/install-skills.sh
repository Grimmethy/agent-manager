#!/usr/bin/env bash
# Symlinks the Claude Code skills shipped in docs/agents/skills/ into ~/.claude/skills so
# they are available in every session (.claude/ is gitignored in this repo, so they can't
# live there). Re-run after pulling; existing links are refreshed, real directories are left alone.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$SCRIPT_DIR/../docs/agents/skills" && pwd)"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
mkdir -p "$DEST"
for dir in "$SRC"/*/; do
  name="$(basename "$dir")"
  target="$DEST/$name"
  if [[ -e "$target" && ! -L "$target" ]]; then
    echo "[install-skills] $target exists and is not a symlink -- skipping (move it aside to use the repo copy)"
    continue
  fi
  ln -sfn "${dir%/}" "$target"
  echo "[install-skills] $name -> ${dir%/}"
done
