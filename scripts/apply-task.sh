#!/usr/bin/env bash
# Single-shot applier: runs src/apply-task.js once against every task currently sitting in
# queue/approved/, then files each result into queue/done/ or queue/blocked/ so it isn't
# re-applied on the next run. This is NOT a port of src/apply-runner.ps1 -- it skips that
# script's extra machinery (heartbeats, arch-discovery id repair, community-coverage
# bookkeeping) and just does the mechanical "apply what's approved, once" pass. Run it
# again (e.g. from the desktop shortcut) whenever you want to pick up newly-approved tasks.
set -u

# Same guard as orc-common.sh (see its own header) -- this script isn't one of the three
# daemons that source it, but has the identical "node -e ... console.log(<number>)"
# pattern feeding a bash numeric test, so it's just as exposed to an inherited
# FORCE_COLOR breaking that test with stray ANSI codes.
export NO_COLOR=1
export FORCE_COLOR=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# orc-common.sh requires these already exported; this script instead reads them straight out
# of agent-manager.env itself (same file launch.bat / the dashboard read), since it should
# also work as a one-off invocation with no daemon already running to have set them.
ENV_FILE="${REPO_DIR}/agent-manager.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${AGENT_MANAGER_REPO_ROOT:-}" ]]; then
  printf '[apply-task] ERROR: AGENT_MANAGER_REPO_ROOT is not set (no project configured yet -- set one via the dashboard'"'"'s Project tab, or fill in %s).\n' "$ENV_FILE" >&2
  exit 64
fi

# Mutex: refuse to run if another apply-task.sh is already mid-apply. Confirmed live
# 2026-08-17 (investigating a real queue/blocked/ backlog): every single apply-failed task
# there showed the same symptom -- `git index.lock: File exists`, `fatal: branch 'agent/...'
# already exists`, or a failed auto-stash -- and EVERY one of those already had a
# successful queue/done/ copy of the same task id sitting right next to it. That's the
# unmistakable signature of two apply-task.sh runs racing on the SAME shared git working
# tree: one wins and reaches done/, the other trips over the first one's still-open
# branch/index and gets misfiled into blocked/ as a "failure" that never actually was one.
# This script's own header already documents manual re-runs (desktop shortcut) as expected
# usage ALONGSIDE the launch.sh apply-task-loop daemon calling it every 30s -- exactly the
# two callers that can race. flock on a fixed, well-known lockfile (not scoped to this
# project's own pipelineDir, since the race is about the underlying git checkout /
# ~/.local/state pidfile convention, not per-project state) makes a second concurrent run
# exit immediately instead of fighting the first one for the same branch/index -- same
# non-fatal-skip convention as everything else in this pipeline (this is a normal outcome
# on a busy tick, not an error).
LOCK_DIR="${HOME}/.local/state/agent-manager/locks"
mkdir -p "$LOCK_DIR"
exec 9>"${LOCK_DIR}/apply-task.lock"
if ! flock -n 9; then
  printf '[apply-task] another apply-task run is already in progress -- skipping this tick.\n'
  exit 0
fi

PIPELINE_DIR="${AGENT_MANAGER_PIPELINE_DIR:-$AGENT_MANAGER_REPO_ROOT}"
QUEUE_DIR="${PIPELINE_DIR}/queue"
APPROVED_DIR="${QUEUE_DIR}/approved"
DONE_DIR="${QUEUE_DIR}/done"
BLOCKED_DIR="${QUEUE_DIR}/blocked"
AWAITING_CONFIRM_DIR="${QUEUE_DIR}/awaiting-confirm"
COORDINATING_DIR="${QUEUE_DIR}/coordinating"

if [[ ! -d "$APPROVED_DIR" ]]; then
  printf '[apply-task] nothing to do: %s does not exist yet.\n' "$APPROVED_DIR"
  exit 0
fi

shopt -s nullglob
files=("$APPROVED_DIR"/*.json)
shopt -u nullglob

if [[ ${#files[@]} -eq 0 ]]; then
  printf '[apply-task] nothing to do: no approved tasks in %s.\n' "$APPROVED_DIR"
  exit 0
fi

mkdir -p "$DONE_DIR" "$BLOCKED_DIR" "$AWAITING_CONFIRM_DIR" "$COORDINATING_DIR"

# Split approved tasks into directToMain triage tasks (candidate-doc appends -- batchable
# into ONE commit+push) and everything else (per-task apply to an agent/<id> branch).
# Without this, a backlog of N reviewed triage tasks becomes N tiny commits pushed to main
# one at a time (each forced to push because an unpushed commit ahead of origin is wiped by
# the next task's resetToMain). See apply-task.js applyDirectToMainBatch.
partition="$(node "${REPO_DIR}/src/apply-task.js" --partition "${files[@]}")"
mapfile -t direct_files < <(printf '%s' "$partition" | node -e 'try{JSON.parse(require("fs").readFileSync(0,"utf8")).direct.forEach((f)=>console.log(f))}catch(e){}')
mapfile -t other_files  < <(printf '%s' "$partition" | node -e 'try{JSON.parse(require("fs").readFileSync(0,"utf8")).other.forEach((f)=>console.log(f))}catch(e){}')

# If --partition itself failed (empty output / both arrays empty despite having files),
# fall back to treating everything as individual -- never silently skip approved work.
if [[ ${#direct_files[@]} -eq 0 && ${#other_files[@]} -eq 0 ]]; then
  other_files=("${files[@]}")
fi

if [[ ${#direct_files[@]} -gt 0 ]]; then
  printf '[apply-task] batching %s directToMain triage task(s) into one commit...\n' "${#direct_files[@]}"
  batch_result="$(node "${REPO_DIR}/src/apply-task.js" --batch "${direct_files[@]}")"
  # One TSV line per task: <path>\t<succeeded 1|0>\t<needsConfirmation 1|0>\t<coordinating 1|0>\t<note>
  # needsConfirmation / coordinating are checked BEFORE succeeded, exactly like the per-task
  # path below: a directToMain source (pipeline_forensics) whose apply returns
  # { succeeded:false, needsConfirmation:true } is a hold for a human, NOT a failure --
  # routing it to blocked/ buries the ranked root-cause report where nobody confirms it
  # (confirmed live 2026-09-01). `coordinating` is defensive-only here -- adhoc decompose
  # never takes the directToMain batch path -- but the precedence must match.
  printf '%s' "$batch_result" | node -e '
    try {
      const o = JSON.parse(require("fs").readFileSync(0, "utf8"));
      for (const r of (o.results || [])) {
        console.log([r.path, r.succeeded ? "1" : "0", r.needsConfirmation ? "1" : "0", r.coordinating ? "1" : "0", String(r.doneMarker || r.reason || "").replace(/\s+/g, " ")].join("\t"));
      }
    } catch (e) { /* handled below: any direct_file not printed stays in approved/ for next tick */ }
  ' | while IFS=$'\t' read -r bpath bok bneedsconfirm bcoordinating bnote; do
      [[ -z "$bpath" ]] && continue
      btid="$(basename "$bpath" .json)"
      if [[ "$bcoordinating" == "1" ]]; then
        mv "$bpath" "${COORDINATING_DIR}/${btid}.json"
        printf '[apply-task] %s: coordinating sub-tasks (triage batch) -- %s\n' "$btid" "$bnote"
      elif [[ "$bneedsconfirm" == "1" ]]; then
        mv "$bpath" "${AWAITING_CONFIRM_DIR}/${btid}.json"
        printf '[apply-task] %s: awaiting human confirmation (triage batch) -- %s\n' "$btid" "$bnote"
      elif [[ "$bok" == "1" ]]; then
        mv "$bpath" "${DONE_DIR}/${btid}.json"
        printf '[apply-task] %s: applied (triage batch) -- %s\n' "$btid" "$bnote"
      else
        mv "$bpath" "${BLOCKED_DIR}/${btid}.json"
        printf '[apply-task] %s: FAILED (triage batch) -- %s\n' "$btid" "$bnote" >&2
      fi
    done
fi

for file in "${other_files[@]}"; do
  task_id="$(basename "$file" .json)"
  printf '[apply-task] applying %s...\n' "$task_id"

  result="$(node "${REPO_DIR}/src/apply-task.js" "$file")"
  succeeded="$(printf '%s' "$result" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.succeeded?"true":"false")}catch(e){console.log("false")}')"
  # Checked BEFORE succeeded -- a delete-containing Group B batch reports succeeded:false
  # (nothing was touched, so it genuinely isn't a success) but this is a hold for a human,
  # not a failure; routing it to blocked/ would bury it among real apply failures instead of
  # its own queue/awaiting-confirm/ stage. See apply-task.js's own gate comment.
  needs_confirmation="$(printf '%s' "$result" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.needsConfirmation?"true":"false")}catch(e){console.log("false")}')"
  # A decomposed adhoc parent becomes a coordinator -- it tracks its sub-tasks in
  # queue/coordinating/ and auto-completes (coordinator-sweep.js) once they all reach done/.
  # Checked before succeeded/failed: it reports succeeded:false but is neither.
  coordinating="$(printf '%s' "$result" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.coordinating?"true":"false")}catch(e){console.log("false")}')"

  if [[ "$coordinating" == "true" ]]; then
    mv "$file" "${COORDINATING_DIR}/${task_id}.json"
    printf '[apply-task] %s: coordinating sub-tasks -> %s\n' "$task_id" "$result"
  elif [[ "$needs_confirmation" == "true" ]]; then
    mv "$file" "${AWAITING_CONFIRM_DIR}/${task_id}.json"
    printf '[apply-task] %s: awaiting human confirmation (delete in batch) -> %s\n' "$task_id" "$result"
  elif [[ "$succeeded" == "true" ]]; then
    mv "$file" "${DONE_DIR}/${task_id}.json"
    printf '[apply-task] %s: applied -> %s\n' "$task_id" "$result"
  else
    mv "$file" "${BLOCKED_DIR}/${task_id}.json"
    printf '[apply-task] %s: FAILED -> %s\n' "$task_id" "$result" >&2
  fi
done

# Housekeeping: drop per-task work logs (queue/worklogs/) for tasks that have left the
# pre-merge queue. local-draft.js prunes too, but this covers a deployment where drafts
# are rare and the apply loop is the regularly-running daemon.
node "${REPO_DIR}/src/work-log.js" --prune >/dev/null 2>&1 || true
