#!/usr/bin/env bash
# Per-project housekeeping for a BORROWED project (docs/idle-pool-borrowing.md, step 4). queue-watcher.sh runs its sweeps against the ACTIVE
# project only; a project whose tasks lanes borrow also needs them, or a borrowed task that blocks is never retried, a borrowed hub is never
# reconciled and a borrowed needs-clarification pile is never triaged. queue-watcher.sh runs this once per pool project (in the background, at most
# every AGENT_MANAGER_POOL_SWEEP_INTERVAL_SECS, default 300) under that project's env (pool-projects.js --env-args).
#
# Only PROJECT-scoped sweeps run here. Machine-scoped ones stay with the watchdog's home pass: daemon supervision (dead-process-check),
# uptime samples, the Second Brain report/graph build, the pipeline-health audit and drift scan (they audit agent-manager itself), and the proactive
# file-decompose sweep (it MANUFACTURES work for a project -- not something to do to a project the operator is not looking at).
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PACKAGE_SRC_DIR="${SCRIPT_DIR}/../src"
HOME_LOGS="${HOME_LOGS:-${HOME}/.local/state/agent-manager/logs}"
mkdir -p "$HOME_LOGS" 2>/dev/null || true

if [[ -z "${AGENT_MANAGER_BORROWING_FROM:-}" || -z "${AGENT_MANAGER_PIPELINE_DIR:-}" ]]; then
  printf '[pool-sweeps] refusing to run outside a borrowed-project context (AGENT_MANAGER_BORROWING_FROM / _PIPELINE_DIR unset)\n' >&2
  exit 64
fi
LABEL="$AGENT_MANAGER_BORROWING_FROM"
QUEUE_DIR="${AGENT_MANAGER_PIPELINE_DIR}/queue"
MARKER="${AGENT_MANAGER_PIPELINE_DIR}/instances/.pool-sweeps-last"   # project-local due marker (instances/ is per project for logs and markers)

interval="${AGENT_MANAGER_POOL_SWEEP_INTERVAL_SECS:-300}"
now="$(date +%s)"
if [[ "${POOL_SWEEPS_FORCE:-}" != "true" && -f "$MARKER" ]] && (( now - $(stat -c %Y "$MARKER" 2>/dev/null || echo 0) < interval )); then
  exit 0
fi
mkdir -p "$(dirname "$MARKER")" 2>/dev/null || true
touch "$MARKER" 2>/dev/null || true

# A project with nothing in any stage that housekeeping acts on costs nothing: skip the ~20 node startups.
active=false
for d in blocked needs-clarification coordinating awaiting-confirm approved review; do
  compgen -G "${QUEUE_DIR}/${d}/*.json" >/dev/null && { active=true; break; }
done
if ! "$active" && compgen -G "${QUEUE_DIR}/drafting/*/*.json" >/dev/null; then active=true; fi
if ! "$active"; then exit 0; fi

# Order matters the same way it does in queue-watcher.sh: retries and reconciliation first, triage after.
SWEEPS=(
  reject-retry-check apply-retry-check coordinator-sweep rejected-hub-disposition-backfill fix-signature-sweep derived-premise-sweep fabricated-path-recheck-sweep expiry-sweep
  blocked-cluster-sweep task-log-reconcile auto-confirm-review adhoc-staleness-flag context-trim-sweep
  side-finding-sweep context-log-sweep needs-clarification-triage product-spec-to-hub file-decompose-to-hub
  decompose-move-determinism-backfill decompose-loop-autoroute merged-work-sweep
)

# Several sweeps above moved out of this repo's own src/ into a plugin -- the
# file-decompose family to agent-manager-hygiene (S4a, 2026-09-24), coordinator-sweep /
# rejected-hub-disposition-backfill to agent-manager-hub-tasks (S5e, 2026-09-25). The
# `[[ -f ... ]] || continue` guard below used to skip a moved sweep FOREVER for every
# borrowed pool project with no error at all -- confirmed live while fixing S5e: the S4a
# move already broke this exact loop for four sweeps (product-spec-to-hub,
# file-decompose-to-hub, decompose-move-determinism-backfill, decompose-loop-autoroute),
# undetected until now. Resolve each family's plugin root by NAME (S5a's
# resolve-plugin-root.js) once, same as queue-watcher.sh's own equivalent fix.
_resolve_plugin_root() { node "${PACKAGE_SRC_DIR}/resolve-plugin-root.js" "$1" 2>/dev/null; }
_hygiene_root="$(_resolve_plugin_root agent-manager-hygiene)"
_hub_tasks_root="$(_resolve_plugin_root agent-manager-hub-tasks)"
HYGIENE_SWEEPS=(product-spec-to-hub file-decompose-to-hub decompose-move-determinism-backfill decompose-loop-autoroute)
HUB_TASKS_SWEEPS=(coordinator-sweep rejected-hub-disposition-backfill)

for s in "${SWEEPS[@]}"; do
  base="$PACKAGE_SRC_DIR"
  if [[ " ${HYGIENE_SWEEPS[*]} " == *" $s "* ]]; then
    if [[ -z "$_hygiene_root" ]]; then continue; fi  # optional family -- silently skip if not installed, same as queue-watcher.sh
    base="${_hygiene_root}/src"
  elif [[ " ${HUB_TASKS_SWEEPS[*]} " == *" $s "* ]]; then
    if [[ -z "$_hub_tasks_root" ]]; then
      printf '[pool-sweeps:%s] ERROR: agent-manager-hub-tasks plugin not found/enabled -- %s NOT running for this borrowed project this tick.\n' "$LABEL" "$s" >&2
      continue
    fi
    base="${_hub_tasks_root}/src"
  fi
  [[ -f "${base}/${s}.js" ]] || continue
  out="$(node "${base}/${s}.js" 2>>"${HOME_LOGS}/pool-${s}.log")"
  printf '[pool-sweeps:%s] %s: %s\n' "$LABEL" "$s" "$out"
done
node "${PACKAGE_SRC_DIR}/done-archive.js" --check-due >>"${HOME_LOGS}/pool-done-archive.log" 2>&1 || true
node "${PACKAGE_SRC_DIR}/reclaim-orphaned-drafts.js" --retired-lanes >>"${HOME_LOGS}/pool-reclaim-orphaned-drafts.log" 2>&1 || true
