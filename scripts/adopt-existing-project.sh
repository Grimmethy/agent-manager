#!/usr/bin/env bash
# Adopts an EXISTING repo (one this pipeline didn't create -- e.g. a third-party
# dependency we have contributor access to, like vendor/tokenfold's real upstream) as a
# project the pipeline can be pointed at for passive improvement. Sibling to
# provision-plugin-repo.sh, which builds a brand-new repo from scratch; this one clones
# instead of git-init+gh-create, then does the exact same pipeline-dir setup and
# registration via register-project.sh so both paths stay consistent -- "the manager
# exists to create consistency" (Grimmethy, 2026-08-20).
#
# Usage: scripts/adopt-existing-project.sh <name> <clone-url> [task-domains-workdir-kind]
#   <name>        lowercase-kebab-case, becomes the local dir name and the dashboard label.
#   <clone-url>   any URL `git clone` accepts (https://github.com/owner/repo.git, etc.).
#   [workdir-kind] task-domains.json's workDirKind -- default "repoRoot" (fine for a
#                  single-package repo like tokenfold; override for a monorepo).
#
# What this does (idempotent-safe except the clone step, which refuses to touch an
# already-existing local directory):
#   1. Clone the repo as-is (full history, real origin remote -- so a later `git push`
#      from this pipeline's apply step goes straight to the real upstream, same as any
#      other repo this pipeline targets).
#   2. Set up a DEDICATED pipeline dir (queue/, task-domains.json, .env), same split
#      agent-manager's own repoRoot/pipelineDir already uses.
#   3. Register in projects.json + Second Brain via register-project.sh.
set -euo pipefail

NAME="${1:-}"
CLONE_URL="${2:-}"
WORKDIR_KIND="${3:-repoRoot}"

if [[ -z "$NAME" || -z "$CLONE_URL" ]]; then
  echo "usage: $0 <name> <clone-url> [task-domains-workdir-kind]" >&2
  exit 1
fi
if ! [[ "$NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: <name> must be lowercase kebab-case (letters, digits, hyphens only) -- got: $NAME" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECTS_BASE="${AGENT_MANAGER_PLUGIN_PROJECTS_BASE:-/media/wok/model-cache}"
REPO_DIR="$PROJECTS_BASE/$NAME"
PIPELINE_DIR="$PROJECTS_BASE/${NAME}-pipeline"
LOCAL_MODEL_DEFAULT="${LOCAL_MODEL:-qwen3.8:27b-q4_K_M}"

if [[ -e "$REPO_DIR" ]]; then
  echo "error: $REPO_DIR already exists -- refusing to overwrite. Pick a different name, or remove it first if this was a failed attempt." >&2
  exit 1
fi

echo "[adopt] cloning $CLONE_URL -> $REPO_DIR"
git clone -q "$CLONE_URL" "$REPO_DIR"

echo "[adopt] setting up dedicated pipeline dir $PIPELINE_DIR"
mkdir -p "$PIPELINE_DIR/queue/product-spec-requests"
cat > "$PIPELINE_DIR/task-domains.json" <<JSONEOF
{
  "default": {
    "workDirKind": "$WORKDIR_KIND",
    "successCheck": "git-branch-diff"
  }
}
JSONEOF
cat > "$PIPELINE_DIR/.env" <<EOF
export AGENT_MANAGER_REPO_ROOT=$REPO_DIR
export AGENT_MANAGER_PIPELINE_DIR=$PIPELINE_DIR
export LOCAL_MODEL=$LOCAL_MODEL_DEFAULT
EOF

bash "$SCRIPT_DIR/register-project.sh" "$NAME" "$REPO_DIR" "$PIPELINE_DIR"

echo
echo "[adopt] done. $NAME is now:"
echo "  - a real local clone with its real origin remote: $REPO_DIR"
echo "  - selectable in the dashboard's Project tab dropdown"
echo "  - registered in projects.json with its own pipelineDir ($PIPELINE_DIR)"
echo
echo "Next: select $NAME in the Project tab and Start Pipeline, or file a task/request in"
echo "$PIPELINE_DIR/queue/ directly."
