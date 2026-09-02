#!/usr/bin/env bash
# Queue-watchdog / pipeline-doctor daemon. Periodically checks draft items
# are progressing (not stuck in pending state after being picked up).
set -u

# Locate this scripts/ dir regardless of invocation origin — same reliability
# pattern all four daemons use so relative paths don't break us when bash is
# backgrounded with no specific cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load shared env + require AGENT_MANAGER_REPO_ROOT, MODEL_URL (same check
# applied to every daemon; logs [common] ERROR and exits if missing).
source "${SCRIPT_DIR}/orc-common.sh"

readonly INSTANCE_ID="${1:-watchdog}"    # same naming as PowerShell's $env:InstanceID per-daemon.

# Refuse to start if a live process already holds this instanceId -- see local-worker.sh's
# identical call and agent-manager-common.sh's check_instance_liveness for the full rationale.
# Applies to the watchdog's OWN identity here -- distinct from (and unrelated to) the
# dead-PROCESS restart logic this same daemon runs later in its loop for the OTHER daemons.
check_instance_liveness "$INSTANCE_ID" || exit 1

# Graceful stop: same reasoning as the other daemons' traps -- deferred until the current
# foreground tick (dead-process check / reject-retry check / stale scan) returns, so this
# never gets killed mid-restart-decision and leaves a half-restarted worker behind.
trap 'printf "[watchdog] SIGTERM/SIGINT received -- exiting after current tick.\n" >&2; exit 0' TERM INT

# Matches launch.sh's own STATE_DIR/PID_DIR exactly -- restarts here must write to the SAME
# pidfiles launch.sh uses, or stop.sh's/is_running()'s bookkeeping goes stale the moment
# this daemon restarts something.
PID_DIR="${HOME}/.local/state/agent-manager/pids"
mkdir -p "$PID_DIR" 2>/dev/null

# HOME_LOGS: temp dir for watchdog status logs (same shape PS pipeline-doctor.ps1 uses).
HOME_LOGS="$(mktemp -d)"

echo '[queue-watcher] loaded env, HOME_LOGS='"$HOME_LOGS" >&2
echo "[queue-watcher] instance=$INSTANCE_ID waiting ${ORC_TICK_SECS:-60}s for first tick." >&2

STARTED_AT="$(date -u '+%FT%T.%NZ' 2>/dev/null)"

# Infinite polling loop — bash while : form identical to PowerShell's while ($true).
while :; do
    printf '[watchdog] %s tick: checking pending items for staleness\n' "${INSTANCE_ID}" >&2
    write_heartbeat_file "$INSTANCE_ID" "idle" "" "" "" "$STARTED_AT"   # previously never called anywhere in this script -- same "invisible to the dashboard even while alive" gap as the other two daemons.

    # Dead-process detection + restart: a daemon instance whose heartbeat has gone stale
    # (pid confirmed gone, or -- workers only -- pid alive but stuck well past a normal
    # call) gets killed if still lingering and relaunched, same pidfile convention
    # launch.sh itself uses so stop.sh stays accurate afterward. Port of
    # queue-watchdog.ps1's Invoke-DeadProcessCheck; decision logic (staleness/zombie/
    # cooldown) lives in dead-process-check.js, OS-level kill/spawn stays here in bash
    # where the rest of this pipeline's process control already lives. Without this,
    # nothing on Linux ever recovers from worker-1/reviewer crashing -- confirmed
    # 2026-08-14: repeated manual restarts were the ONLY thing keeping this pipeline
    # running for most of that day's development.
    while IFS= read -r action_line; do
      [[ -n "$action_line" ]] || continue
      action_kind="$(echo "$action_line" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.action||"")}catch(e){}')"
      action_instance="$(echo "$action_line" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.instanceId||"")}catch(e){}')"
      action_pid="$(echo "$action_line" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.pid||"")}catch(e){}')"
      action_reason="$(echo "$action_line" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.reason||"")}catch(e){}')"

      if [[ "$action_kind" == "flag" ]]; then
        printf '[watchdog] %s looks dead (%s) but no restart rule matches -- flagging only.\n' "$action_instance" "$action_reason" >&2
        continue
      fi

      # kill-orphan (2026-08-24, pipeline hardening): dead-process-check.js's own
      # findOrphanedModelCallProcesses() -- a `node local-draft.js` reparented to pid 1
      # (its real daemon parent confirmed gone) still holding real resources (the GPU
      # single-flight lock, most critically) with nothing left waiting on its result.
      # No script/pidfileName fields on this action kind at all -- just kill and move on,
      # never fall through to the restart logic below which expects those fields.
      if [[ "$action_kind" == "kill-orphan" && -n "$action_pid" ]]; then
        kill -9 "$action_pid" 2>/dev/null
        printf '[watchdog] killed orphaned model-call process pid %s (%s)\n' "$action_pid" "$action_reason" >&2
        continue
      fi

      action_script="$(echo "$action_line" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.script||"")}catch(e){}')"
      action_pidfile_name="$(echo "$action_line" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.pidfileName||"")}catch(e){}')"
      mapfile -t action_args < <(echo "$action_line" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));(o.args||[]).forEach(a=>console.log(a))}catch(e){}')

      if [[ "$action_kind" == "restart-after-kill" && -n "$action_pid" ]]; then
        kill -9 "$action_pid" 2>/dev/null    # zombie: the pid is still real and running (that's the whole problem) -- force-kill before restarting, or it keeps squatting the drafting claim/heartbeat file identity alongside the fresh replacement.

        # Verify the kill actually took before spawning a replacement -- confirmed live
        # 2026-08-26/27: a real duplicate worker-1 (spawned right here, believing the
        # original was a zombie) survived alongside its supposedly-killed predecessor
        # for over an hour, completely undetected, because this line never checked
        # whether action_pid actually died before moving on. Doubled GPU contention
        # from the two lanes independently drafting the same tasks is what caused that
        # night's whole run of blocked tasks (empty draft responses misclassified as
        # "infra outage"). SIGKILL can't be caught or ignored, so if the pid is still
        # here a moment later, action_pid was never the right target in the first
        # place (already stale/reused by the time dead-process-check.js read it) --
        # proceeding to spawn a replacement anyway recreates the exact incident.
        # Refuses instead of silently pressing on; a human should look at a pid that
        # won't die, not get a silent second daemon.
        kill_confirmed=false
        for _ in 1 2 3 4 5; do
          kill -0 "$action_pid" 2>/dev/null || { kill_confirmed=true; break; }
          sleep 1
        done
        if ! "$kill_confirmed"; then
          printf '[watchdog] REFUSING to restart %s -- kill -9 on pid %s did not take effect after 5s (still alive). Spawning a replacement now would create a duplicate daemon (confirmed live 2026-08-27: exactly this ran undetected for over an hour). Skipping this restart; investigate pid %s manually.\n' "$action_instance" "$action_pid" "$action_pid" >&2
          continue
        fi
      fi

      nohup bash "${SCRIPT_DIR}/${action_script}" "${action_args[@]}" > "${LOG_DIR}/${action_instance}.log" 2>&1 &
      new_pid=$!
      echo "$new_pid" > "${PID_DIR}/${action_pidfile_name}"
      printf '[watchdog] restarted %s (was pid %s, %s) -- new pid %s via %s\n' "$action_instance" "$action_pid" "$action_reason" "$new_pid" "$action_script" >&2
    done < <(node "${PACKAGE_SRC_DIR}/dead-process-check.js" 2>>"${HOME_LOGS}/dead-process-check.log")

    # Reject-retry-requeue: a task genuinely rejected by review (blockedStage:'review') gets
    # one more redraft attempt, up to reject-retry-check.js's own retry cap -- port of
    # queue-watchdog.ps1's Invoke-RejectRetryCheck (that script's OTHER job, dead-process
    # detection/restart, is not ported here; a separate, still-open gap). Runs every tick,
    # unconditionally, before the pending-staleness check below -- without this, EVERY
    # review-stage rejection was a permanent dead end on Linux (confirmed live 2026-08-14:
    # 17 real blocked tasks, zero retries, since nothing here ever looked at
    # ornithRejectCount at all).
    reject_retry_result="$(node "${PACKAGE_SRC_DIR}/reject-retry-check.js" 2>>"${HOME_LOGS}/reject-retry-check.log")"
    printf '[watchdog] reject-retry-check: %s\n' "$reject_retry_result" >&2

    # Apply-retry-requeue: the same idea as reject-retry-check.js above, for the apply
    # stage instead of review (blockedStage:'apply', not 'review' -- recordApplyOutcome
    # in apply-task.js deliberately stamps its own blockedStage so the two checks never
    # collide over the same task). 2026-08-24, pipeline hardening: caught live -- an
    # apply-failed task (a stale diff, conflicting with an unrelated sibling task's own
    # change landed on the same file in between draft and apply) sat in queue/blocked/
    # requiring a human to manually diagnose and requeue by hand, exactly the same
    # permanent-dead-end shape review rejections had before reject-retry-check.js
    # existed. apply-adhoc-diff.js's own --3way retry already resolves most of this
    # class automatically; this is the safety net for when even that can't reconcile.
    apply_retry_result="$(node "${PACKAGE_SRC_DIR}/apply-retry-check.js" 2>>"${HOME_LOGS}/apply-retry-check.log")"
    printf '[watchdog] apply-retry-check: %s\n' "$apply_retry_result" >&2

    # Coordinator sweep: a RESOLUTION: decompose parent lives in queue/coordinating/ with a
    # sub-task checklist; this reconciles each child's real state onto the parent and moves
    # the parent to done/ once every child is finished. Cheap (one small readdir), so it
    # runs every tick like the retry checks above.
    coordinator_result="$(node "${PACKAGE_SRC_DIR}/coordinator-sweep.js" 2>>"${HOME_LOGS}/coordinator-sweep.log")"
    printf '[watchdog] coordinator-sweep: %s\n' "$coordinator_result" >&2

    # Task-log reconcile: `applied` used to be the last event in a done task's history, so
    # an update audit could not tell from the log whether a task's code actually reached
    # origin/<main>, is still on an unmerged agent/<id> branch, or was applied to a branch
    # that has since vanished (lost work). This resolves the true state from git and appends
    # a terminal disposition event (merged / pending-merge / abandoned / filed / noop /
    # applied-direct). Incremental via queue/task-log-reconcile-state.json -- one git harvest
    # per run, then only new arrivals + the small pending-merge set are re-read, so it is
    # cheap enough to run every tick like the sweeps above. `npm run task-log-reconcile --
    # --report` (or -- --backfill) for the human-facing audit view.
    task_log_result="$(node "${PACKAGE_SRC_DIR}/task-log-reconcile.js" 2>>"${HOME_LOGS}/task-log-reconcile.log")"
    printf '[watchdog] task-log-reconcile: %s\n' "$task_log_result" >&2

    # Auto-confirm review: queue/awaiting-confirm/ is no longer a pure human gate. A held
    # task (a Group B delete batch, or a pipeline_forensics root-cause report) gets a small
    # local CONFIRM/DENY majority vote -- confident CONFIRM moves it back to approved/ for a
    # real apply re-run, confident DENY archives it, anything inconclusive stays here for a
    # human. Cheap when awaiting-confirm/ is empty (the common case). Disable with
    # AGENT_MANAGER_AUTO_CONFIRM_REVIEW=false.
    auto_confirm_result="$(node "${PACKAGE_SRC_DIR}/auto-confirm-review.js" 2>>"${HOME_LOGS}/auto-confirm-review.log")"
    printf '[watchdog] auto-confirm-review: %s\n' "$auto_confirm_result" >&2

    # Drift-scan (Brain Dump #83: "Reasoning tasks aren't represented in the job list...
    # make sure task visibility is a consistent part of the pipeline"). drift-scan.js
    # already existed to catch exactly this class of bug (a static list, e.g. the
    # dashboard's JOB_TYPES table, silently drifting from the live task-sources.js
    # registry) but was wired into nothing -- npm run drift-scan was the only way to run
    # it, so it caught nothing automatically and research_task shipped invisible in the
    # Job List tab for a full deployment before anyone noticed by hand. Cheap (a handful
    # of regex passes over a few static files, no LLM/network involved), so run it every
    # tick like reject-retry-check.js above rather than throttling it -- any future drift
    # then surfaces here within one tick (<=ORC_TICK_SECS) of the registration change that
    # caused it, not whenever someone next remembers to run the npm script by hand.
    drift_scan_output="$(node "${PACKAGE_SRC_DIR}/drift-scan.js" 2>>"${HOME_LOGS}/drift-scan.log")"
    drift_scan_rc=$?
    if [[ $drift_scan_rc -ne 0 ]]; then
      printf '[watchdog] drift-scan FLAGGED (see queue/drift-flags.json):\n%s\n' "$drift_scan_output" >&2
    else
      printf '[watchdog] %s\n' "$drift_scan_output" >&2
    fi

    # Uptime sampling + scheduled reports (Brain Dump: "start filing an hourly, daily and
    # weekly report into second brain... track downtimes and real time spent on junk tasks
    # vs real benefit", 2026-08-19). uptime-log.js's own header explains why THIS loop is
    # the only place a sample can be taken from: it's the one process running continuously
    # regardless of which worker/reviewer lane is up, so a gap here IS the downtime signal.
    # Pruning (dropping samples older than uptime-log.js's own MAX_LOG_AGE_DAYS) happens
    # probabilistically inside uptime-log.js's own --sample handler, not every tick --
    # pruneOldSamples rewrites the whole file, which is wasteful to do on every ~60s tick.
    node "${PACKAGE_SRC_DIR}/uptime-log.js" --sample 2>>"${HOME_LOGS}/uptime-log.log"
    system_report_output="$(node "${PACKAGE_SRC_DIR}/system-report.js" --check-due 2>>"${HOME_LOGS}/system-report.log")"
    if [[ -n "$system_report_output" ]]; then
      printf '[watchdog] %s\n' "$system_report_output" >&2
    fi

    # Daily queue/done/ archive pass (2026-08-22 production incident: done/ grew to ~3900
    # files with no rotation -- see done-archive.js's own header). Same --check-due shape
    # as system-report.js just above -- cheap every tick, the real move-files pass only
    # actually runs once per real day.
    done_archive_output="$(node "${PACKAGE_SRC_DIR}/done-archive.js" --check-due 2>>"${HOME_LOGS}/done-archive.log")"
    if [[ -n "$done_archive_output" ]]; then
      printf '[watchdog] %s\n' "$done_archive_output" >&2
    fi

    # Daily project-graph rebuild (Grimmethy, 2026-08-19: "This should be a daily task so
    # that the review steps keep up with the project" -- graph.json/community-coverage.json
    # feed arch_discovery's candidate generation, see build_graph.py's own check_due()).
    # Backgrounded, not awaited: check_due() itself returns almost instantly on every tick
    # except the rare one where a rebuild is actually due, and a real rebuild (community
    # detection plus one Ornith naming call per community) can run for MINUTES -- awaiting
    # it here would stall dead-process-check/reject-retry-check/drift-scan/pending-
    # staleness far past their own ~60s cadence. A PID lockfile guards against a slow
    # rebuild still running when the next tick fires and independently deciding the SAME
    # stale schedule state is still "due" -- without it, every ~60s tick during a multi-
    # minute rebuild would launch its own redundant, overlapping rebuild.
    GRAPH_BUILD_LOCK="${INSTANCES_DIR}/.graph-build.lock"
    if [[ -f "$GRAPH_BUILD_LOCK" ]] && kill -0 "$(cat "$GRAPH_BUILD_LOCK" 2>/dev/null)" 2>/dev/null; then
      : # a rebuild from an earlier tick is still running -- skip, don't pile up.
    else
      (
        "${SCRIPT_DIR}/../.venv/bin/python" "${SCRIPT_DIR}/../python/build_graph.py" --check-due >>"${HOME_LOGS}/graph-build.log" 2>&1
        rm -f "$GRAPH_BUILD_LOCK"
      ) &
      echo $! > "$GRAPH_BUILD_LOCK"
    fi

    _pending_dir="$QUEUE_DIR/pending"    # was "$AGENT_MANAGER_REPO_ROOT/_/pending" -- a stray "_/" prefix that matched neither local-worker.sh's own (also-wrong, now-fixed) path nor task-sources.js's real queue/pending convention. Now consistent with both.
    stale_count=0

    if [[ ! -d "$_pending_dir" ]]; then
        sleep "${ORC_TICK_SECS:-60}"
        continue
    fi

    # Iterate all pending .json files — null-delimited find for safety.
    now_seconds="$(date +%s)"
    processed_count=0

    while IFS= read -r -d '' file; do
        [[ "$(wc -c < "$file" 2>/dev/null || echo 0)" -gt 0 ]] || continue
        _created_at_raw="$(stat --format=%W "$file" 2>/dev/null \
                          || stat -f %m "$file" 2>/dev/null \
                          || echo "$now_seconds")"
        age=$(( now_seconds - _created_at_raw ))

        if [[ "$age" -gt ${ORC_STALE_SECS:-86400} ]]; then
            stale_count=$((stale_count + 1))
            printf '[watchdog] WARNING: %s is stale (%ds past threshold)\n' \
                "$(basename "$file")" "$age" >&2
            # Mirror PowerShell's Out-File to HOME_LOGS/stale/$id_age.txt
            mkdir -p "$HOME_LOGS/stale" 2>/dev/null || true
            printf '%s\n%s\n' "$age" "$(cat "$file" 2>/dev/null)" \
                >"$HOME_LOGS/stale/${INSTANCE_ID}_${age}s.txt"
        else
            processed_count=$((processed_count + 1))
            printf '[watchdog] %s: %ds old (ok)\n' "$(basename "$file")" "$age" >&2
        fi
    done < <(find "${_pending_dir}" -maxdepth 1 -name '*.json' \! -empty -type f \
                -print0 2>/dev/null | sort -z)    # -print0/sort -z: NUL-delimited throughout, matching the `read -r -d ''` loop below. Was plain `find | sort` (newline-delimited) feeding a NUL-delimited read -- with no NUL byte anywhere in the stream, `read -d ''` reads the ENTIRE piped output as one "line" on its first (and only) iteration, so $file became every filename joined by newlines, "$file" as a literal path never existed, `wc -c < "$file"` failed, and the loop body never ran for ANY real file, ever -- reproduced live 2026-08-14: this exact loop against 2 real dummy files still logged 0 iterations. Confirmed by every single watchdog tick this whole session logging "processed=0 stale=0" regardless of actual queue/pending/ contents.

    printf '[watchdog] %s tick result: processed=%d stale=%d\n' \
        "${INSTANCE_ID}" "$processed_count" "$stale_count" >&2
    [[ "$stale_count" -eq 0 ]] && all_clean=true || all_clean=false

    sleep "${ORC_TICK_SECS:-60}"
done
