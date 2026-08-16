#!/usr/bin/env bash
# Ornith-worker daemon: claims drafts from pending/, invokes ornith-client to plan/implement, moves draft to drafting/. Port of src/orchid-worker.ps1.

set -u                                                                              # strict mode: catch unset var typos as failure (prevents silent "working on nothing" loop that PowerShell's lack-of-modes lets slide).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"                 # locate scripts/ dir so we can reference sibling files regardless of how this script was invoked by launch.sh / user.
readonly INSTANCE_ID="${1:-worker-0}"                                              # allow override via argv; default to 'worker-0' matching PowerShell's $env:INSTANCE_ID if undefined (same convention across all 4 daemons so operator can grep logs for specific loop instance).

source "${SCRIPT_DIR}/orc-common.sh"                                               # load-shared env, validate config — fail loudly here before doing any work so user sees clear error message vs daemon silently hanging on missing repo path.
# Note: this source is idempotent-safe because orc-common sets only unset vars (so subsequent sources don't override caller's environment).

# Graceful stop: bash defers a trapped signal until the current foreground command
# (e.g. the node ornith-draft.js call below) returns control to the shell, so this exits
# right after finishing whatever draft is in flight rather than mid-call -- no orphaned
# node child, no half-written task file. stop.sh's SIGTERM-then-grace-period-then-SIGKILL
# handles the case where a single call runs long enough that this isn't fast enough.
trap 'printf "[worker-%s] SIGTERM/SIGINT received -- exiting after current tick.\n" "$INSTANCE_ID" >&2; exit 0' TERM INT

HOME_LOGS="${HOME_LOGS:-$LOG_DIR}"                                                  # HOME_LOGS where we drop per-instance log files; same idea as PowerShell's $env:LocalStatePath/log/$env:InstanceID pattern so multiple runs don't clobber each other.
LOG_FILE="${HOME_LOGS}/ornith-worker-${INSTANCE_ID}.log"          # per-instance log file for daemon status; keeps logs grouped by worker so user can grep / watch progress of specific loop instance without wading through others' output (same pattern as PowerShell's `Start-Transcript -Path $logFile` per-job pattern).

# Infinite polling loop mimicking PowerShell's `while ($true) { ... Start-Sleep -Seconds 60 }` block structure exactly — same design philosophy: simple poll-and-do is easier to debug than event-driven alternatives for file-based state (which agent-manager uses exclusively, not databases or message queues that would benefit from true push mechanisms).
STARTED_AT="$(date -u '+%FT%T.%NZ' 2>/dev/null)"

# Runs the plan -> implement -> critique -> (revision) passes (ornith-draft.js) against a
# task JSON already sitting in queue/drafting/${INSTANCE_ID}/, then files the result into
# queue/review/ or queue/blocked/. Shared by both the freshly-claimed path below and the
# leftover-drafting-file resume pass at the top of each tick -- factored out so a task
# left behind by an interrupted previous run (this worker killed/restarted mid-draft-call,
# which happened repeatedly during 2026-08-14 development) gets processed the exact same
# way a brand-new claim does, not a second, drifted copy of this logic.
process_drafting_file() {
  local wpath="$1"
  local name task_id draft_result draft_succeeded draft_blocked
  name="$(basename "$wpath")"
  task_id="$(node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(o.id||"")}catch(e){}' "$wpath" 2>/dev/null)"

  write_heartbeat_file "$INSTANCE_ID" "working" "${ORNITH_MODEL:-}" "$task_id" "draft" "$STARTED_AT"
  draft_result="$(node "${PACKAGE_SRC_DIR}/ornith-draft.js" "$wpath" 2>>"$LOG_FILE")"
  draft_succeeded="$(echo "$draft_result" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.succeeded?"true":"false")}catch(e){console.log("false")}')"
  draft_blocked="$(echo "$draft_result" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.blocked?"true":"false")}catch(e){console.log("false")}')"

  if [[ "$draft_succeeded" == "true" && "$draft_blocked" == "true" ]]; then
    mkdir -p "${QUEUE_DIR}/blocked" >/dev/null 2>&1
    mv -n "$wpath" "${QUEUE_DIR}/blocked/${name}"
    printf '[worker-%s] blocked %s: %s\n' "$INSTANCE_ID" "$task_id" "$draft_result" >&2
  elif [[ "$draft_succeeded" == "true" ]]; then
    mkdir -p "${QUEUE_DIR}/review" >/dev/null 2>&1
    mv -n "$wpath" "${QUEUE_DIR}/review/${name}"
    printf '[worker-%s] ready for review: %s\n' "$INSTANCE_ID" "$task_id"
  else
    # Draft call itself failed (e.g. Ollama unreachable) -- leave the file in drafting/
    # rather than lose it; the leftover-drafting resume pass at the top of the NEXT tick
    # retries it automatically.
    printf '[worker-%s] draft call failed for %s: %s\n' "$INSTANCE_ID" "$task_id" "$draft_result" >&2
  fi
  write_heartbeat_file "$INSTANCE_ID" "idle" "${ORNITH_MODEL:-}" "" "" "$STARTED_AT"
}

while :; do                                                                     # `while :; do` is bash idiom for 'true/forever' loop — equivalent of PowerShell's `while ($true)` syntax we're matching here. Bash doesn't have boolean literals natively so ':' (the POSIX-no-op command that always returns 0=success) serves as the true condition in loops like this one; identical semantic meaning in practice to while-true block we use elsewhere.
  did_work=false                                                                 # tracks whether this tick actually processed anything -- drives the idle-only backoff at the bottom of the loop (see its own comment). Reset fresh every tick.
  printf '[worker-%s] tick at %s — searching for new drafts...\n' "$INSTANCE_ID" "$(date -u '+%FT%T.%NZ' 2>/dev/null)"    # status message at top of each iteration — same information PowerShell's Write-Verbose emits but using printf for format-safety (avoids issues if variable contents include '%' characters which would be interpreted as string-formatting directives by `echo -e` on some systems, breaking log output).
  write_heartbeat_file "$INSTANCE_ID" "idle" "${ORNITH_MODEL:-}" "" "" "$STARTED_AT"   # so the dashboard's Workers tab sees this instance exists even on a tick that claims nothing -- previously never called anywhere in this script, which is why no workers ever showed up regardless of whether the process was alive.

  mkdir -p "$HOME_LOGS" 2>/dev/null                                              # ensure base home logs dir exists — PowerShell's New-Item creates the folder automatically when it doesn't exist (we mirror that behavior explicitly here because bash's redirection won't auto-create parent dirs the way PS does).
  [[ -r "$HOME_LOGS" ]]                                                          || mkdir -p "$HOME_LOGS"                  # ensure log dir exists (might not have been created yet between launch.sh running and this script actually reaching this step). Same pattern as PowerShell's `$logFolder = if (-not (Test-Path $dir)) { New-Item ... } else { $dir }` conditional creation block which is what we're replacing with simpler shell here.

  # Seed pending/ with a new task if the queue has room to generate one -- ornith-worker.ps1
  # calls this every tick (task-sources.js's own CLI header: "Safe to call on every worker
  # tick"). Previously never called anywhere in this bash port, so pending/ could never
  # receive work regardless of how correct the claim logic below was.
  # >>"$LOG_FILE" (not >/dev/null): this call does real side-effecting work on every tick
  # -- generating a new pending/ task AND deep_dive's lazy lead-onboarding (git clone +
  # build_graph.py against a newly-Strong project_search lead, see task-sources.js's
  # onboardLead()) -- and both can fail in ways worth seeing. Confirmed live 2026-08-14: an
  # onboarding clone failed (project_search wrote a lead with url "N/A", not a real repo)
  # and the real `deep_dive: failed to onboard "...": ...` error task-sources.js logs via
  # console.error was silently discarded here, with no trace anywhere that onboarding had
  # ever been attempted or why Scouted Repos stayed empty despite tasks completing.
  node "${PACKAGE_SRC_DIR}/task-sources.js" >>"$LOG_FILE" 2>&1 || true

  # Resume any task already sitting in THIS instance's own drafting/ folder before claiming
  # anything new -- a claim only ever gets processed by whichever worker process happened
  # to be running at that moment; if that process was killed or crashed mid-draft-call
  # (confirmed live 2026-08-14: repeated worker restarts during that day's development left
  # 16+ tasks claimed but never drafted), nothing previously re-attempted them, since the
  # claim loop below only ever looks at pending/ for NEW work. Matches ornith-worker.ps1's
  # own "orphaned claim: recovered automatically at the next worker startup" behavior,
  # except run every tick (not just at startup) so it also self-heals from an interrupted
  # draft call without a full process restart being needed.
  drafting_instance_dir="${QUEUE_DIR}/drafting/${INSTANCE_ID}"
  if [[ -d "$drafting_instance_dir" ]]; then
    while IFS= read -r name; do
      [[ "$name" == *.json ]]                                                  || continue
      wpath="${drafting_instance_dir}/${name}"
      [[ -f "$wpath" && -s "$wpath" ]]                                        || continue
      printf '[worker-%s] resuming leftover drafting item: %s\n' "$INSTANCE_ID" "$name"
      process_drafting_file "$wpath"
      did_work=true
    done < <(ls -1 "$drafting_instance_dir" 2>/dev/null)
  fi

  # Read pending/ directory listing for work items to claim — equivalent logic of PowerShell's `Get-ChildItem -Path $PENDING_DIR -Filter "*.json" | Where-Object { $_.LastWriteTime > $cutoff }` filter (we keep it simpler by reading all .json entries since our pending/ folder should only contain valid draft-state JSON files anyway; if someone dropped non-.json content that's a separate bug).
  # array to collect pending/ file names matching our claim criteria — bash arrays declared via `local items=()` and populated by appending with ${items+=...} syntax. Each entry is just basename (no path) since we'll reconstruct full path inside the loop below using "$PENDING/$name" pattern for the same reason PowerShell's foreach ($item in $files){ ... } iterates over base-name entries not full paths.
  items=()                                                                      # no `local` here because we're at script scope (not function), so declare without keyword — PowerShell would use just `$items = @()` directly with no type keyword either.
  pdir="$QUEUE_DIR/pending"                                                    # compute pending dir once — matches task-sources.js's own writeTask() destination (queue/pending), not the old bare "pending/" this script used to read from (which task-sources.js never wrote to, so this claim loop always found nothing).

  if [[ -r "$pdir" ]]; then                                                     # check readability before attempting readdir (same safety pattern as PowerShell's Test-Path before foreach — user might have permissions-restricted dir that should be skipped not crash-the-loop).
    while IFS= read -r name; do                                                # IFS= strips only the TRIMMING of whitespace bash would otherwise apply to each line via `read`'s default field-splitting behavior — we want raw base-names from directory listing even if they somehow have leading/trailing ws (unlikely but not impossible in pathological case).
      [[ "$name" == *.json ]]                                                || continue    # only process JSON files — matches PowerShell's `Where-Object { $_.Extension -eq '.json' }` filter on Get-ChildItem output; non-.json entries could be binary state files / README.md / anything else user or external consumer dropped there that should be left alone (and we'd silently corrupt if we tried to parse as JSON).
      # (Previously also required filenames to match ^draft-[a-f0-9-]+$ -- but task-sources.js's
      # writeTask() names files after the task source, e.g. deep-dive-<slug>-<id>.json or
      # brain_dump_sort-<n>.json, never "draft-...". That regex matched nothing real, so every
      # pending task was silently skipped regardless of how the rest of this loop was wired.)
      items+=("$name")                                                          # append basename (no path) to our collected list — same as adding element via `$drafts += $item.Name` in PowerShell foreach block since we need an array we can iterate over in next step. Bash arrays use ${items[@]} for expansion; populated by += operator which is bash-intrinsic for this purpose.
    done < <(ls -1 "$pdir" 2>/dev/null)                                       # `< <(...)` is process substitution: runs `ls` command and feeds its output line-by-line into stdin of our while-read loop (so we don't spin up a subshell or temporary file for the ls output — cleaner than redirect-or-pipe alternatives). Error-redirect stderr from ls so any 'permission denied' reading files there doesn't show operator error noise in normal operation.

    # Iterate each pending draft, process if ready:
    for name in "${items[@]}"; do                                             # loop over collected filenames one at a time — bash array iteration via `${array[@]}` syntax (each element becomes separate word when quoted). Equivalent of PowerShell's `foreach ($item in $drafts)` which we're mirroring here since both languages use the same conceptual model for "do this to every X in collection".
      wpath="${pdir:?}/$name"                                                     # full path to file being processed — ${pdir?} forces pdir to be defined (prevents silently using empty var that would otherwise expand to /filename with leading slash). We're inside process substitution so pdir is available via outer-shell variable inheritance; bash doesn't strictly enforce this for local scopes but we use ? expansion for safety since typos in $pdir could write files to unexpected locations which would be confusing debugging story.

      if [[ ! -f "$wpath" || ! -s "$wpath" ]]; then                          # skip non-files / empty draft file (likely crashed during partial-write by some other loop; we don't want to process half-written state). PowerShell uses `-File` test operator plus `Test-Path` check for same condition — bash's [[ -f && -s ]] is equivalent shorter form.
        printf '[worker-%s] skipping non-file or empty: %s\n' "$INSTANCE_ID" "$name" >&2    # informational message on stderr since this isn't an actual failure (just a skipped item), but we want operator to see why certain files weren't processed without them thinking something's broken.
        continue;                                                               # next item in for loop; bash continues by default after any test block unless we break/return to exit the whole function — but 'continue' is the right one here since we want this worker-loop overall to keep running, just skip this iteration's work (same semantics of PowerShell's `continue` statement within its foreach which does identical skipping behavior at inner loop level).
      fi

      # Try to parse as JSON using node (we use Node CLI rather than jq because agent-manager's other CLIs run in Node already; keeping same runtime avoids adding system deps).
      task_id=""                                                                 # initialize each fetch attempt fresh — bash doesn't auto-reset variables inside loops so we must explicitly clear each iteration. Same pattern PowerShell uses: $id = ""; try { ... } catch {}; `if ($null -ne $id) {...}` would also work but this more direct form is what we pick here since both equivalent anyway.
      claim_succeeded=false                                                      # default to false until task_id successfully extracted — same design philosophy as PowerShell's `$success = ... ; if($success){...}; continue` flow where initial state starts in "didn't process anything yet" until proven otherwise.
      parsed_payload="$(cat "$wpath" 2>/dev/null)"                             # read file content into shell variable; bash $( command ) captures stdout of subcommand to assign to a var (we use it for small files < few KB which our drafts never exceed). 2>/dev/null redirects any read-error messages OUT of the captured output so operator doesn't see them in normal status log when some draft might be mid-write by another loop at same time.

      if [[ -n "${parsed_payload:-}" ]]; then                                   # check file had content (we don't want to process 0-byte drafts since they'd just run ornith-client on nothing — same safety check as PowerShell's `$content = $file.OpenText().ReadToEnd(); if ($content.Length -gt 0)` block inside foreach. Without this, one empty draft could cause `node: command not found` or similar cascading error message downstream that looks like an orchestrator bug but isn't.
        task_id="$(echo "$parsed_payload" | node -e 'try{var j=JSON.parse(require("fs").readFileSync("/dev/stdin","utf8")); console.log(j.taskId||j.draftId||j.id)}catch(e){}' 2>/dev/null)"    # extract taskId (or fallback draftId, or fallback id -- task-sources.js's writeTask() writes the task's identifier under "id", never "taskId"/"draftId", so those two alone always came back empty) from parsed JSON with node CLI; bash captures stdout back into task_id (was overwriting parsed_payload instead, leaving task_id permanently "" so the -n check below could never pass regardless of what the JSON contained). JSON.parse's second arg was a reviver `(x)=>{throw x}` that unconditionally re-throws every value it's given, so parsing failed for every file regardless of content -- dropped it; JSON.parse needs no reviver here, we just want the plain parsed object. Same semantics as PowerShell's `var id = JSON.parse($json).taskId` except that one-line Node invocation gets redirected into a script context where the parsing logic has no top-level await so we wrap it in try-catch to swallow parse errors (which would otherwise crash this bash worker loop since the exit code non-zero terminates outer while).
        if [[ -n "$task_id" ]]; then                                            # guard: only mark success if some task id came back — same pattern as PowerShell's `$id = $result | ConvertTo-Json -Depth 3 | ... ; if ($null -ne $Id){...}; }'` conditional check that follows the data flow from parsing through to use.
          claim_succeeded=true                                                   # set to true only after successful extraction — mirrors what `try { $ok = true; ... } catch {}; if($ok)...` would do in PowerShell for same intent. We use explicit boolean assignment via string-true/strings-false rather than relying on exit codes being reliable because node's output can silently fail without non-zero exit code (e.g. malformed JSON that returns undefined taskId).
        fi
      fi

      if "$claim_succeeded"; then                                               # actual claim action: rename pending/$name -> drafting/${INSTANCE_ID}/$name (use mv because we don't want to COPY — mv is atomic on same filesystem which prevents race where another loop picks up the same draft after we 'claimed' it). Bash's `mv` works for this; equivalent of PowerShell's `Move-Item -Force` which would do identical work under its file-system abstraction but bash doesn't need `-Force`.
        printf '[worker-%s] claiming %s\n' "$INSTANCE_ID" "$name"               # log that we're about to attempt claim — same kind of status emit as PowerShell's `$null = Write-Host "Processing $draftName"` block which prints progress to operator console so they know daemon IS doing something (otherwise they'd wonder if it hung silently).
        write_heartbeat_file "$INSTANCE_ID" "working" "${ORNITH_MODEL:-}" "$task_id" "claim" "$STARTED_AT"

        mkdir -p "${QUEUE_DIR}/drafting/${INSTANCE_ID}" >/dev/null 2>&1 # ensure destination exists before moving into it — bash's mv doesn't auto-create parent dirs; if we didn't mkdir we'd get 'No such file or directory' error on first claim attempt which would look like daemon failed but actually just meant the folder wasn't created yet (same issue PowerShell hits too and they handle with pre-creation pattern via -Force flag on New-Item).

        orig_name="$name"                                                         # captures current value of $name variable which bash would overwrite on next loop iteration's assignment, same trick PowerShell uses when it stores off the original path in a separate variable before mutating the input.
        new_wpath="${QUEUE_DIR}/drafting/${INSTANCE_ID}/${orig_name}"     # destination file path (same name but moved to drafting/ folder under this instance, matching task-sources.js's own "queue/drafting/<InstanceId>/<id>.json" convention -- was previously "$AGENT_MANAGER_REPO_ROOT/drafting/..." with no queue/ prefix at all, a path nothing else in the system reads from).

        mv -n "$wpath" "$new_wpath"                                                # atomic move: -n flag prevents overwriting target if exists already (same behavior as PowerShell's `Move-Item -NoClobber` for same intent — don't clobber whatever's at destination because could be stale file from previous crashed run which operator would want to investigate before losing).
        printf '[worker-%s] claimed %s -> %s\n' "$INSTANCE_ID" "$wpath" "$new_wpath"     # log claim action with old+new paths — same information PowerShell's `$null = Write-Host "Claimed $src for $dest"` writes but using file redirection operator to send our printf output directly into stderr (which gets captured by launch.sh later via `nohup ... > /dev/null 2>&1 &` and tee'd into HOME_LOGS directory so user can review claim history later in log files even if their terminal is closed or busy).

        # Run the actual plan -> implement -> critique -> (revision) passes against Ornith,
        # via ornith-draft.js (a port of ornith-worker.ps1's equivalent sequence -- see that
        # file's header comment for scope: the 6 domains task-domains.json actually wires up
        # on Linux, not arch_discovery/arch_import's extra structural-check pass). Mutates
        # new_wpath's task JSON in place with pass results and status:"needs-review" on
        # success; leaves task JSON untouched on a thrown error so it isn't corrupted. If
        # THIS process gets killed/restarted before process_drafting_file returns, the
        # leftover-drafting resume pass at the top of the next tick (any instance's next
        # tick, not just this one's) picks the file back up automatically.
        process_drafting_file "$new_wpath"
        did_work=true
      fi

    done                                                                         # end per-filename loop within current tick — bash doesn't auto-close the `for name in "${items[@]}"` scope; 'done' keyword terminates it same way PowerShell closes each block with } or closing brace pattern (we use bash's explicit 'done' syntax which is required).
  fi                                                                            # close if -r "$pdir" conditional check block — same structure as PowerShell's `if (( Test-Path $pending )) { ... }` where body only runs test succeeds; we mirror that with [[ ]] && {} pattern using braces around body.

  # Idle-only backoff: only pay the full poll interval when this tick genuinely found
  # nothing to do. Previously slept the full ORC_TICK_SECS (30s) unconditionally at the
  # end of EVERY tick regardless of whether more work was sitting right there waiting --
  # confirmed live 2026-08-15: a real backlog with tasks completing in well under 30s each
  # still spent the majority of wall-clock time asleep between them, under 50% utilization.
  # A brief sleep even when work was done avoids a true zero-delay busy-loop hammering the
  # filesystem tick after tick when a large backlog is draining.
  if "$did_work"; then
    sleep 1
  else
    sleep "${ORC_TICK_SECS:-60}"                                                   # wait between polls (default: 60s) — same delay PowerShell uses via its `Start-Sleep -Seconds $env:TICK_INTERVAL` inside main daemon loop body (we read from ORC_TICK_SECS env var so user can customize per-instance without editing the script; bash ${VAR:-default} form is exactly that kind of fallback assignment which matches what PowerShell's `$interval = if ($null -ne $env:INTERVAL) { $env:INTERVAL } else { 60}` does for same purpose.
  fi
done                                                                             # end top-level 'while' loop here — bash `do...done` syntax pair; mirror of PowerShell's `while (...){ ... }` curly-brace structure we're replacing (bash has no native boolean true so ':' used as the always-true condition).
