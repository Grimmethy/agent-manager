#!/usr/bin/env bash
# Provisions the pipeline directory of a NODE (multi-node plan, piece 7d): the machine that drafts tasks for wok. Run it on the node. It starts NOTHING (no worker,
# server or timer) and never writes a token (tokens live in files the owner creates, mode 600, see docs/agents/nodes.md).
#
# Usage: scripts/provision-node.sh <node-id> <pipeline-dir> <node-repo-dir> [unit-dir]
#   [unit-dir] is optional and defaults to $HOME/.config/systemd/user (the systemd user unit directory).
#
# Creates (and keeps whatever already exists):
#   <pipeline-dir>/queue/{pending,adhoc,drafting,review,blocked,needs-clarification,done,node-outbox,node-sent}
#   <pipeline-dir>/task-domains.json  every standard domain (scripts/ensure-task-domains.sh: written when missing, missing domains added when present)
#   <pipeline-dir>/lanes.json         ONE lane, the cloud lane of lanes.example.json, DISABLED; an existing lanes.json is never overwritten
#   <pipeline-dir>/node.env           AGENT_MANAGER_NODE_ID, AGENT_MANAGER_PIPELINE_DIR, AGENT_MANAGER_REPO_ROOT, AGENT_MANAGER_DOMAINS_PATH, AGENT_MANAGER_LANES_PATH (rewritten identically; the commented AGENT_MANAGER_CLAIM_URL, AGENT_MANAGER_NODE_TOKEN_FILE and AGENT_MANAGER_NODE_REPOS_DIR lines are appended)
#   [unit-dir]/am-node-pull.service, am-node-send.path, am-node-send.service (written only, never enabled or started; an existing unit file is kept, never overwritten)
#     Both services run <node-repo-dir>/src/... with the absolute node binary found by `command -v node` and read <pipeline-dir>/node.env as an EnvironmentFile. The send service passes
#     --url ${AGENT_MANAGER_PACKAGE_URL} and --token-file ${AGENT_MANAGER_NODE_TOKEN_FILE} (systemd fills them from node.env once the operator uncomments them), --node-id <node-id> and --outbox <pipeline-dir>/queue/node-outbox.
# Exit 1 (nothing created) when node is not on PATH as an absolute path. Exit 2 (nothing created) for a missing argument, an extra one, the id 'wok', an id that is not lowercase letters, digits and dashes (1 to 31 characters, not
# starting with a dash, the rule of src/node-registry.js), or a directory that is not an absolute path of plain characters (node.env is sourced by shells).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

refuse() { printf 'provision-node: %s\n' "$1" >&2; exit 2; }

[[ $# -ge 3 && $# -le 4 ]] || refuse "usage: scripts/provision-node.sh <node-id> <pipeline-dir> <node-repo-dir> [unit-dir]"
NODE_ID="$1"; PIPELINE_DIR="$2"; REPO_DIR="$3"; UNIT_DIR="${4:-$HOME/.config/systemd/user}"
[[ "$NODE_ID" != "wok" ]] || refuse "the node id 'wok' is the ledger owner, not a node"
[[ "$NODE_ID" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || refuse "the node id must be lowercase letters, digits and dashes (1 to 31 characters, not starting with a dash)"
for dir in "$PIPELINE_DIR" "$REPO_DIR" "$UNIT_DIR"; do
  [[ "$dir" =~ ^/[A-Za-z0-9._/@+:-]*$ ]] || refuse "a directory must be an absolute path of letters, digits and . _ / @ + : - only: $dir"
done

# The unit files run the absolute node binary, so resolve it before any write. A missing node is an environment failure (exit 1), not a usage refusal (exit 2).
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { printf 'provision-node: node is not on PATH; install node first\n' >&2; exit 1; }
case "$NODE_BIN" in /*) ;; *) printf 'provision-node: node path is not absolute: %s\n' "$NODE_BIN" >&2; exit 1 ;; esac

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

# The three units are written, never enabled or started, and an existing unit file is never overwritten (it may be a working hand-written unit).
# Both services run from the node repo (the clone), with the absolute node binary and the pipeline's node.env as an EnvironmentFile.
mkdir -p "$UNIT_DIR"

# Writes the unit read from stdin only when the path is absent; an existing file (or symlink/directory at the path) is kept, never overwritten.
write_unit_if_absent() {
  local path="$1"
  if [[ -e "$path" ]]; then printf 'kept    %s\n' "$path"; return 0; fi
  cat > "$path"
  printf 'wrote   %s\n' "$path"
}

write_unit_if_absent "$UNIT_DIR/am-node-pull.service" <<EOF
[Unit]
Description=Agent Manager node pull (asks wok for work when a worker is free)

[Service]
WorkingDirectory=$REPO_DIR
EnvironmentFile=$PIPELINE_DIR/node.env
ExecStart=$NODE_BIN $REPO_DIR/src/node-pull.js --daemon
Nice=19
IOSchedulingClass=idle
CPUSchedulingPolicy=idle
Restart=on-failure

[Install]
WantedBy=default.target
EOF

write_unit_if_absent "$UNIT_DIR/am-node-send.path" <<EOF
[Unit]
Description=Agent Manager node send trigger (watches queue/node-outbox)

[Path]
PathChanged=$PIPELINE_DIR/queue/node-outbox
Unit=am-node-send.service

[Install]
WantedBy=default.target
EOF

# systemd expands ${VAR} in ExecStart from the EnvironmentFile, so --url and --token-file come from node.env (the operator uncomments them there).
write_unit_if_absent "$UNIT_DIR/am-node-send.service" <<EOF
[Unit]
Description=Agent Manager node send (ships queue/node-outbox to wok)

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
EnvironmentFile=$PIPELINE_DIR/node.env
ExecStart=$NODE_BIN $REPO_DIR/src/node-package-send.js --url \${AGENT_MANAGER_PACKAGE_URL} --token-file \${AGENT_MANAGER_NODE_TOKEN_FILE} --node-id $NODE_ID --outbox $PIPELINE_DIR/queue/node-outbox
Nice=19
IOSchedulingClass=idle
CPUSchedulingPolicy=idle
EOF

printf 'AGENT_MANAGER_NODE_ID=%s\nAGENT_MANAGER_PIPELINE_DIR=%s\nAGENT_MANAGER_REPO_ROOT=%s\nAGENT_MANAGER_DOMAINS_PATH=%s\nAGENT_MANAGER_LANES_PATH=%s\n' \
  "$NODE_ID" "$PIPELINE_DIR" "$REPO_DIR" "$PIPELINE_DIR/task-domains.json" "$LANES" > "$PIPELINE_DIR/node.env"
printf '# AGENT_MANAGER_CLAIM_URL=\n# AGENT_MANAGER_NODE_TOKEN_FILE=\n# AGENT_MANAGER_NODE_REPOS_DIR=\n# AGENT_MANAGER_PACKAGE_URL=\n' >> "$PIPELINE_DIR/node.env"
printf 'wrote   %s\n' "$PIPELINE_DIR/node.env"

[[ -d "$REPO_DIR" ]] || printf 'note: %s does not exist yet (the node repo is cloned separately)\n' "$REPO_DIR"
printf 'Nothing was started: the units were written but not enabled or started, and no worker, server or timer runs. Source node.env and start the node workers yourself.\n'
