#!/usr/bin/env bash
# Provisions a brand-new plugin repo the way agent-manager itself now knows how to build
# one -- turns the manual sequence this session repeated three times by hand (crm-plugin,
# romance-plugin, credit-manager-plugin), and got wrong once (the Second Brain
# registration step was missed until a human noticed the Project tab dropdown was
# incomplete), into one canonical, versioned path.
#
# Grimmethy, 2026-08-20: "When we build new projects like this they should be stored in
# .../SecondBrain/Projects. This is something that needs to be baked into the process
# when we start generating projects directly through the manager. The manager exists to
# create consistency."
#
# Usage: scripts/provision-plugin-repo.sh <name> "<description>" [seed-request-file]
#   <name>              lowercase-kebab-case, becomes the repo name, the GitHub repo name,
#                        and the dashboard label.
#   <description>        short repo description (GitHub + README).
#   [seed-request-file]  optional path to a JSON file shaped like
#                        {"id": "bootstrap-1", "title": "...", "requestText": "..."} --
#                        copied into queue/product-spec-requests/bootstrap-1.json so the
#                        first product_spec draft has something to work from immediately.
#                        Omit to provision the repo/pipeline without seeding a request yet.
#
# What this does, in order (every step idempotent-safe to re-run except repo creation,
# which refuses to touch an already-existing local directory):
#   1. Create the local repo dir, git init, README, initial commit.
#   2. gh repo create (private) + push.
#   3. Set up a DEDICATED pipeline dir (queue/, task-domains.json, .env) -- kept separate
#      from the repo itself so pipeline internals never land inside the tracked git repo,
#      same split agent-manager's own repoRoot/pipelineDir already uses.
#   4. Optionally seed the first product-spec-request.
#   5-6. Register in projects.json + Second Brain, via register-project.sh (shared with
#      adopt-existing-project.sh -- the equivalent path for a repo that already exists
#      rather than one this provisions from scratch, e.g. a third-party dependency we
#      have contributor access to).
set -euo pipefail

NAME="${1:-}"
DESC="${2:-}"
SEED_REQUEST_FILE="${3:-}"

if [[ -z "$NAME" ]]; then
  echo "usage: $0 <name> \"<description>\" [seed-request-file]" >&2
  exit 1
fi
if ! [[ "$NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: <name> must be lowercase kebab-case (letters, digits, hyphens only) -- got: $NAME" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Same base directory every plugin repo provisioned this session already lives under --
# not derived from PACKAGE_ROOT (GITHUB_PROJECTS_ROOT in app.py, one level up from
# agent-manager itself) since these are deliberately NOT siblings of agent-manager's own
# dev repo; they're consumer projects the pipeline builds, same conceptual role as
# agent-manager-apply-target but for a brand-new product instead of a clone of this one.
PROJECTS_BASE="${AGENT_MANAGER_PLUGIN_PROJECTS_BASE:-/media/wok/model-cache}"
REPO_DIR="$PROJECTS_BASE/$NAME"
PIPELINE_DIR="$PROJECTS_BASE/${NAME}-pipeline"
GH_OWNER="${AGENT_MANAGER_GH_OWNER:-Grimmethy}"
ORNITH_MODEL_DEFAULT="${ORNITH_MODEL:-qwen3.8:27b-q4_K_M}"

if [[ -e "$REPO_DIR" ]]; then
  echo "error: $REPO_DIR already exists -- refusing to overwrite. Pick a different name, or remove it first if this was a failed attempt." >&2
  exit 1
fi

echo "[provision] creating $REPO_DIR"
mkdir -p "$REPO_DIR/Docs"
(
  cd "$REPO_DIR"
  git init -q -b main
  cat > README.md <<EOF
# $NAME

$DESC

This repo has no spec yet -- the first product_spec request seeds one (see
Docs/PRODUCT_SPEC.md once it exists).
EOF
  git add README.md
  git commit -q -m "Initial commit: empty $NAME repo"
)

echo "[provision] creating GitHub repo $GH_OWNER/$NAME (private) and pushing"
(
  cd "$REPO_DIR"
  gh repo create "$GH_OWNER/$NAME" --private --description "$DESC" --source=. --remote=origin --push
)

echo "[provision] setting up dedicated pipeline dir $PIPELINE_DIR"
mkdir -p "$PIPELINE_DIR/queue/product-spec-requests"
cat > "$PIPELINE_DIR/task-domains.json" <<'JSONEOF'
{
  "default": {
    "workDirKind": "repoRoot",
    "successCheck": "git-branch-diff"
  }
}
JSONEOF
cat > "$PIPELINE_DIR/.env" <<EOF
export AGENT_MANAGER_REPO_ROOT=$REPO_DIR
export AGENT_MANAGER_PIPELINE_DIR=$PIPELINE_DIR
export ORNITH_MODEL=$ORNITH_MODEL_DEFAULT
EOF

if [[ -n "$SEED_REQUEST_FILE" ]]; then
  if [[ -f "$SEED_REQUEST_FILE" ]]; then
    cp "$SEED_REQUEST_FILE" "$PIPELINE_DIR/queue/product-spec-requests/bootstrap-1.json"
    echo "[provision] seeded product-spec-request from $SEED_REQUEST_FILE"
  else
    echo "[provision] WARNING: seed request file not found: $SEED_REQUEST_FILE -- skipping (repo/pipeline still provisioned)" >&2
  fi
else
  echo "[provision] no seed request given -- file one in $PIPELINE_DIR/queue/product-spec-requests/ before running product_spec"
fi

bash "$SCRIPT_DIR/register-project.sh" "$NAME" "$REPO_DIR" "$PIPELINE_DIR"

echo
echo "[provision] done. $NAME is now:"
echo "  - a real GitHub repo: https://github.com/$GH_OWNER/$NAME"
echo "  - selectable in the dashboard's Project tab dropdown"
echo "  - registered in projects.json with its own pipelineDir ($PIPELINE_DIR)"
echo
echo "Next: draft/review/confirm/apply the seeded product-spec-request (see this session's"
echo "crm-plugin proof for the manual CLI sequence), or wait for a daemon pointed at it."
