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
  reject-retry-check apply-retry-check coordinator-sweep rejected-hub-disposition-backfill fix-signature-sweep
  blocked-cluster-sweep task-log-reconcile auto-confirm-review adhoc-staleness-flag context-trim-sweep
  side-finding-sweep context-log-sweep needs-clarification-triage product-spec-to-hub file-decompose-to-hub
  decompose-move-determinism-backfill decompose-loop-autoroute merged-work-sweep
)
for s in "${SWEEPS[@]}"; do
  [[ -f "${PACKAGE_SRC_DIR}/${s}.js" ]] || continue
  out="$(node "${PACKAGE_SRC_DIR}/${s}.js" 2>>"${HOME_LOGS}/pool-${s}.log")"
  printf '[pool-sweeps:%s] %s: %s\n' "$LABEL" "$s" "$out"
done
node "${PACKAGE_SRC_DIR}/done-archive.js" --check-due >>"${HOME_LOGS}/pool-done-archive.log" 2>&1 || true
node "${PACKAGE_SRC_DIR}/reclaim-orphaned-drafts.js" --retired-lanes >>"${HOME_LOGS}/pool-reclaim-orphaned-drafts.log" 2>&1 || true
