#!/usr/bin/env bash
# Provisions the pipeline directory of a NODE (multi-node plan, piece 7d): the machine that drafts tasks for wok. Run it on the node. It starts NOTHING (no worker,
# server or timer) and never writes a token (tokens live in files the owner creates, mode 600, see docs/agents/nodes.md).
#
# Usage: scripts/provision-node.sh <node-id> <pipeline-dir> <node-repo-dir>
#
# Creates (and keeps whatever already exists):
#   <pipeline-dir>/queue/{pending,adhoc,drafting,review,blocked,needs-clarification,done,node-outbox,node-sent}
#   <pipeline-dir>/task-domains.json  every standard domain (scripts/ensure-task-domains.sh: written when missing, missing domains added when present)
#   <pipeline-dir>/lanes.json         ONE lane, the cloud lane of lanes.example.json, DISABLED; an existing lanes.json is never overwritten
#   <pipeline-dir>/node.env           AGENT_MANAGER_NODE_ID, AGENT_MANAGER_PIPELINE_DIR, AGENT_MANAGER_REPO_ROOT, AGENT_MANAGER_DOMAINS_PATH, AGENT_MANAGER_LANES_PATH (rewritten identically)
# Exit 2 (nothing created) for a missing argument, an extra one, the id 'wok', an id that is not lowercase letters, digits and dashes (1 to 31 characters, not
# starting with a dash, the rule of src/node-registry.js), or a directory that is not an absolute path of plain characters (node.env is sourced by shells).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

refuse() { printf 'provision-node: %s\n' "$1" >&2; exit 2; }

[[ $# -eq 3 ]] || refuse "usage: scripts/provision-node.sh <node-id> <pipeline-dir> <node-repo-dir>"
NODE_ID="$1"; PIPELINE_DIR="$2"; REPO_DIR="$3"
[[ "$NODE_ID" != "wok" ]] || refuse "the node id 'wok' is the ledger owner, not a node"
[[ "$NODE_ID" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || refuse "the node id must be lowercase letters, digits and dashes (1 to 31 characters, not starting with a dash)"
for dir in "$PIPELINE_DIR" "$REPO_DIR"; do
  [[ "$dir" =~ ^/[A-Za-z0-9._/@+:-]*$ ]] || refuse "a directory must be an absolute path of letters, digits and . _ / @ + : - only: $dir"
done

NODE_QUEUES=(pending adhoc drafting review blocked needs-clarification done node-outbox node-sent)
for q in "${NODE_QUEUES[@]}"; do
  if [[ -d "$PIPELINE_DIR/queue/$q" ]]; then printf 'kept    %s\n' "$PIPELINE_DIR/queue/$q"; else mkdir -p "$PIPELINE_DIR/queue/$q"; printf 'created %s\n' "$PIPELINE_DIR/queue/$q"; fi
done

"$SCRIPT_DIR/ensure-task-domains.sh" "$PIPELINE_DIR"

LANES="$PIPELINE_DIR/lanes.json"
if [[ -e "$LANES" ]]; then
  printf 'kept    %s\n' "$LANES"
else
  node -e '
    const fs = require("fs");
    const lanes = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).filter((l) => l.provider === "cloud").slice(0, 1).map((l) => ({ ...l, enabled: false }));
    if (lanes.length !== 1) { process.stderr.write("provision-node: lanes.example.json has no cloud lane\n"); process.exit(1); }
    fs.writeFileSync(process.argv[2], JSON.stringify(lanes, null, 2) + "\n");
  ' "$PACKAGE_ROOT/lanes.example.json" "$LANES"
  printf 'created %s (the cloud lane, disabled)\n' "$LANES"
fi

printf 'AGENT_MANAGER_NODE_ID=%s\nAGENT_MANAGER_PIPELINE_DIR=%s\nAGENT_MANAGER_REPO_ROOT=%s\nAGENT_MANAGER_DOMAINS_PATH=%s\nAGENT_MANAGER_LANES_PATH=%s\n' \
  "$NODE_ID" "$PIPELINE_DIR" "$REPO_DIR" "$PIPELINE_DIR/task-domains.json" "$LANES" > "$PIPELINE_DIR/node.env"
printf 'wrote   %s\n' "$PIPELINE_DIR/node.env"

[[ -d "$REPO_DIR" ]] || printf 'note: %s does not exist yet (the node repo is cloned separately)\n' "$REPO_DIR"
printf 'Nothing was started: no worker, server or timer. Source node.env and start the node workers yourself.\n'
