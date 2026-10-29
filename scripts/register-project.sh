#!/usr/bin/env bash
# Shared registration steps for any project the pipeline should be able to target --
# factored out of provision-plugin-repo.sh (which builds a brand-new repo) so
# adopt-existing-project.sh (which points the pipeline at a repo that already exists,
# e.g. a third-party dependency we have contributor access to) registers through the
# exact same two places instead of a second, drifting copy. Both are real, both matter:
# projects.json is what _start_pipeline resolves pipelineDir/domainsPath from; Second
# Brain's link index is what the dashboard's visible Project-tab dropdown actually reads
# (/api/second-brain/projects) -- missing either one silently breaks a different part of
# the dashboard (this session already hit that gap once).
#
# Usage: scripts/register-project.sh <name> <repo_dir> <pipeline_dir>
set -euo pipefail

NAME="${1:?usage: $0 <name> <repo_dir> <pipeline_dir>}"
REPO_DIR="${2:?usage: $0 <name> <repo_dir> <pipeline_dir>}"
PIPELINE_DIR="${3:?usage: $0 <name> <repo_dir> <pipeline_dir>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECTS_JSON="$PACKAGE_ROOT/projects.json"
SECOND_BRAIN_DIR="${SECOND_BRAIN_DIR:-/media/wok/model-cache/SecondBrain}"

echo "[register-project] ensuring task-domains.json has every standard domain"
# If the file exists, merge missing standard domains (preserve existing entries).
# If it does not exist, write the full set from task-domains-registry.js.
DOMAINS_PATH="$PIPELINE_DIR/task-domains.json"
if [[ -f "$DOMAINS_PATH" ]]; then
  "$SCRIPT_DIR/ensure-task-domains.sh" "$PIPELINE_DIR"
else
  node -e '
    const { getStandardDomains } = require("'"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"'/src/task-domains-registry.js");
    const fs = require("fs");
    const domains = getStandardDomains();
    fs.writeFileSync(process.argv[1], JSON.stringify(domains, null, 2) + "\n");
  ' "$DOMAINS_PATH"
  echo "[register-project] wrote $DOMAINS_PATH from task-domains-registry.js"
fi

echo "[register-project] registering in projects.json"
python3 - "$PROJECTS_JSON" "$REPO_DIR" "$PIPELINE_DIR" "$NAME" <<'PYEOF'
import json, sys, os

projects_json, repo_dir, pipeline_dir, name = sys.argv[1:5]
try:
    with open(projects_json) as f:
        entries = json.load(f)
    if not isinstance(entries, list):
        entries = []
except (FileNotFoundError, json.JSONDecodeError):
    entries = []

norm = os.path.normpath(repo_dir)
entries = [e for e in entries if os.path.normpath(e.get("repoRoot", "")) != norm]
entries.insert(0, {
    "repoRoot": repo_dir,
    "pipelineDir": pipeline_dir,
    "domainsPath": f"{pipeline_dir}/task-domains.json",
    "label": name,
})

with open(projects_json, "w") as f:
    json.dump(entries, f, indent=2)
print(f"  registered {name} -> {projects_json}")
PYEOF

echo "[register-project] registering in Second Brain (this is what the Project tab dropdown actually reads)"
mkdir -p "$SECOND_BRAIN_DIR/Projects/GitHub"
NOTE_PATH="$SECOND_BRAIN_DIR/Projects/GitHub/$NAME.md"
if [[ ! -f "$NOTE_PATH" ]]; then
  printf '# %s\n\n**Repo path:** `%s`\n' "$NAME" "$REPO_DIR" > "$NOTE_PATH"
fi
LINKS_PATH="$SECOND_BRAIN_DIR/.agent-manager-project-links.json"
python3 - "$LINKS_PATH" "$NAME" "$REPO_DIR" <<'PYEOF'
import json, sys

links_path, name, repo_dir = sys.argv[1:4]
try:
    with open(links_path) as f:
        links = json.load(f)
    if not isinstance(links, dict):
        links = {}
except (FileNotFoundError, json.JSONDecodeError):
    links = {}

links[f"Projects/GitHub/{name}.md"] = repo_dir

with open(links_path, "w") as f:
    json.dump(links, f, indent=2)
print(f"  linked Projects/GitHub/{name}.md -> {repo_dir}")
PYEOF
