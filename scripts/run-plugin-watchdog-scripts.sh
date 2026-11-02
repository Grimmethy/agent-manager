#!/usr/bin/env bash
# Runs every enabled plugin's declared watchdogScripts once (see src/plugin-watchdog-scripts.js). Called by scripts/queue-watcher.sh each tick.
# Each script gets a timeout (AGENT_MANAGER_PLUGIN_WATCHDOG_TIMEOUT_SECS, default 20), its stderr goes to ${HOME_LOGS}/watchdog-plugin-<plugin>.log,
# its FIRST stdout line is logged as "[watchdog] <plugin>:<script>: <line>", and a failure or timeout is logged once and never stops the tick or the
# scripts after it. Kill switch: AGENT_MANAGER_PLUGIN_WATCHDOG_SCRIPTS=off. Always exits 0.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_SRC_DIR="${PACKAGE_SRC_DIR:-${SCRIPT_DIR}/../src}"
HOME_LOGS="${HOME_LOGS:-${TMPDIR:-/tmp}}"
TIMEOUT_SECS="${AGENT_MANAGER_PLUGIN_WATCHDOG_TIMEOUT_SECS:-20}"

[[ "${AGENT_MANAGER_PLUGIN_WATCHDOG_SCRIPTS:-on}" == "off" ]] && exit 0

while IFS=$'\t' read -r _name _script; do
  [[ -n "$_name" && -n "$_script" ]] || continue
  # </dev/null: the child must not read the list this loop is iterating.
  _out="$(timeout "$TIMEOUT_SECS" node "$_script" 2>>"${HOME_LOGS}/watchdog-plugin-${_name}.log" </dev/null)"
  _rc=$?
  if [[ $_rc -eq 0 ]]; then
    printf '[watchdog] %s:%s: %s\n' "$_name" "$(basename "$_script")" "${_out%%$'\n'*}" >&2
  elif [[ $_rc -eq 124 ]]; then
    printf '[watchdog] %s:%s: timed out after %ss\n' "$_name" "$(basename "$_script")" "$TIMEOUT_SECS" >&2
  else
    printf '[watchdog] %s:%s: exit %s\n' "$_name" "$(basename "$_script")" "$_rc" >&2
  fi
done < <(node "${PACKAGE_SRC_DIR}/plugin-watchdog-scripts.js" 2>>"${HOME_LOGS}/plugin-watchdog-scripts.log")
exit 0
