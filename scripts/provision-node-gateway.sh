#!/usr/bin/env bash
# Writes the systemd user unit for the cloud-providers gateway on a NODE (multi-node plan, piece 8c). Run it on the node. It writes two text files and nothing else:
# it does not enable or start anything, never runs systemctl or claude, and never writes a key or token.
#
# Usage: scripts/provision-node-gateway.sh <cloud-providers-dir> <unit-dir> [port]      (port defaults to 7450; the gateway itself listens on loopback only)
#
#   <unit-dir>/am-cloud-gateway.service                            the unit: the gateway on the logged-in Claude account (provider claude-subscription), WITHOUT the confirmation.
#   <unit-dir>/am-cloud-gateway.confirm-subscription.conf.example  a drop-in TEMPLATE (the .example suffix keeps systemd from reading it). Copying it into
#                                                                  am-cloud-gateway.service.d/ is the owner's explicit confirmation; docs/agents/cloud-lane.md says why that is a decision.
# Without the confirmation the gateway refuses to start. Rewriting is idempotent (identical bytes). Exit 2 (nothing written) for a missing or extra argument, a
# cloud-providers-dir that is not an absolute path of plain characters or has no executable run.sh or no bin/cloud-providers.js, a unit-dir that is not such a path,
# or a port that is not an integer from 1024 to 65535.
set -euo pipefail

refuse() { printf 'provision-node-gateway: %s\n' "$1" >&2; exit 2; }

[[ $# -ge 2 && $# -le 3 ]] || refuse "usage: scripts/provision-node-gateway.sh <cloud-providers-dir> <unit-dir> [port]"
GATEWAY_DIR="$1"; UNIT_DIR="$2"; PORT="${3-7450}"
for dir in "$GATEWAY_DIR" "$UNIT_DIR"; do
  [[ "$dir" =~ ^/[A-Za-z0-9._/@+:-]*$ ]] || refuse "a directory must be an absolute path of letters, digits and . _ / @ + : - only: $dir"
done
[[ -x "$GATEWAY_DIR/run.sh" ]] || refuse "no executable run.sh in $GATEWAY_DIR"
[[ -f "$GATEWAY_DIR/bin/cloud-providers.js" ]] || refuse "no bin/cloud-providers.js in $GATEWAY_DIR"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( 10#$PORT >= 1024 && 10#$PORT <= 65535 )) || refuse "the port must be an integer from 1024 to 65535: $PORT"
PORT=$((10#$PORT))
GATEWAY_DIR="${GATEWAY_DIR%/}"

mkdir -p "$UNIT_DIR"
UNIT="$UNIT_DIR/am-cloud-gateway.service"
TEMPLATE="$UNIT_DIR/am-cloud-gateway.confirm-subscription.conf.example"

cat > "$UNIT" <<EOF
[Unit]
Description=Agent Manager cloud-providers gateway (loopback only)

[Service]
WorkingDirectory=$GATEWAY_DIR
Environment=CLOUD_PROVIDERS_PORT=$PORT
Environment=CLOUD_PROVIDER=claude-subscription
ExecStart=$GATEWAY_DIR/run.sh
Restart=on-failure
Nice=10

[Install]
WantedBy=default.target
EOF

cat > "$TEMPLATE" <<'EOF'
# Copying this file to am-cloud-gateway.service.d/confirm-subscription.conf is YOUR explicit confirmation that the gateway may run
# Claude Haiku calls on the Claude account logged in on this machine (a Pro or Max subscription, no API key).
# Anthropic's consumer terms may not permit automated use of such a login (docs/agents/cloud-lane.md, "Billing"). Do it only if you accept that.
[Service]
Environment=CLOUD_SUBSCRIPTION_CONFIRMED=1
EOF

printf 'wrote   %s\n' "$UNIT"
printf 'wrote   %s\n' "$TEMPLATE"
printf 'Nothing was enabled or started, and the confirmation was NOT given: the gateway refuses to start until you copy the template into am-cloud-gateway.service.d/ and run claude auth login.\n'
