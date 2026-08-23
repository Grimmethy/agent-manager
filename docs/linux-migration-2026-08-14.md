# Linux migration / fresh-install notes, 2026-08-14

Context: this deployment's `agent-manager` was ported from Windows (where every daemon
has a complete PowerShell implementation under `src/*.ps1`) to Linux (bash ports under
`scripts/*.sh`). The bash ports existed as files before this date, but most of them were
never actually finished or tested end-to-end — several were stubs or contained bugs that
made the whole pipeline silently do nothing. This doc is the retained record of
everything that had to be found and fixed to get a genuinely working, self-sustaining
pipeline running on Linux, so the next fresh install (or the next migration to a third
platform) doesn't have to re-discover all of this by hand.

**If you're setting this up fresh on Linux, skip straight to "Fresh-install checklist"
below.** The rest of this doc is the incident log — why each item on that checklist
matters, for whoever needs to debug something new later.

## Fresh-install checklist

Do these *before* starting the pipeline, in order. Every one of them was something that
failed silently (no crash, no error dialog) until specifically investigated.

1. **`npm install`** in the repo root. `node_modules/` did not exist at all on this
   machine — `better-sqlite3` (needed for `src/model-stats-db.js`, which powers the
   dashboard's Models tab) was declared in `package.json` but never actually installed.
   Uses prebuilt binaries; no compiler needed on a normal Linux box.
2. **Python venv**: `python3 -m venv .venv && .venv/bin/pip install -r
   python/requirements.txt`. Needed for both the dashboard (`flask`) and `deep_dive`'s
   community-graph builder (`networkx`, `pyvis`). `launch.sh` already expects
   `.venv/bin/python` to exist and will refuse to start the dashboard without it.
3. **`SECOND_BRAIN_DIR`** must be set in `agent-manager.env` to a real, writable
   directory before Brain Dump / `secondbrain`/`brain_dump_sort` tasks can do anything —
   see "SECOND_BRAIN_DIR never configured" below for what breaks silently without it.
4. **`AGENT_MANAGER_INCLUDE_APPLY=true`** in `agent-manager.env` if you want approved
   tasks to actually get applied automatically, not just sit in `queue/approved/`
   forever. Defaults to `false` (a deliberate safety default — "nothing will touch git"
   — not a bug), so this is an intentional opt-in, not something to "fix," but easy to
   forget on a fresh install.
5. If this repo lives on a **separate drive/mount** from `$HOME` (as it does here — an
   internal SATA disk mounted via `/etc/fstab`), add `nofail,x-systemd.device-timeout=30`
   to that fstab line. Without it, a boot-time race between systemd trying to mount the
   drive and udev finishing device enumeration can silently fail the mount, and nothing
   that depends on the drive (including this whole pipeline) will be there after a
   reboot. See "Drive not mounting at boot" below.
6. **Desktop shortcut path**: if `agent-manager-dashboard.sh` (or whatever launches this)
   hardcodes a path like `/media/$USER/<label>` (the convention when a drive was set up
   via an interactive file-manager mount rather than `/etc/fstab`), and you *also* have
   an `/etc/fstab` entry for the same drive at a different mountpoint, reconcile them
   (matching mountpoints, or a symlink) before the shortcut will find anything.
7. Verify `python3` (not `python`) is what's on `PATH` before trusting any Node code that
   shells out to a Python script — see "python vs python3" below. This class of bug is
   easy to reintroduce in new code; grep for bare `` `python `` in a `execSync`/backtick
   template before shipping anything new that shells out to Python.

## Failure modes found, in the order they were discovered

### 1. Drive not mounting at boot

The drive holding this whole repo (`model-cache`, an internal SATA disk, UUID-mounted via
`/etc/fstab` to `/media/model-cache/github`) wasn't mounted when the desktop shortcut was
double-clicked — `cd "$PROJECT_DIR"` failed under `set -e` before the launch script ever
started the dashboard server, with no visible error (the shortcut just did nothing).

Root cause: not a slow/missing disk — `journalctl` showed the mount attempt failing
*instantly* at boot with `special device ... does not exist`, meaning systemd tried the
mount before udev had finished creating the `/dev/disk/by-uuid/...` symlink for it. A
boot-ordering race, not a hardware problem.

**Fix:** added `nofail,x-systemd.device-timeout=30` to the fstab line — explicitly wait
up to 30s for the device unit before attempting the mount, and don't block/fail the rest
of boot even if it's still not ready.

### 2. Desktop shortcut pointed at the wrong mountpoint

The launch script hardcoded `/media/wok/model-cache/agent-manager` (the udisks
auto-mount convention for a drive plugged in and mounted via the file manager), but the
real `/etc/fstab` entry mounts the same drive at `/media/model-cache/github`. Two
different, unrelated mount mechanisms for the same physical disk.

**Fix:** `ln -sfn /media/model-cache/github /media/wok/model-cache` — a symlink bridging
the two conventions, rather than editing the shortcut (safer/more reversible, and it's a
real symlink so it survives reboots on its own).

### 3. `local-worker.sh`'s claim loop: three stacked bugs, each independently sufficient to fully block the pipeline

Found together while debugging "worker shows running but never picks up any task." All
three had to be fixed before *any* of them stopped mattering — fixing one alone showed no
visible improvement, which made this the hardest issue in this whole migration to
diagnose (each fix looked like it did nothing).

- **Inverted file filter**: `[[ ! "$name" == *.json ]] || continue` had the negation
  backwards — it skipped every `.json` file (the real task files) and only ever
  "processed" non-JSON entries, which never existed. Fix: drop the `!`.
- **Wrong field names**: the claim logic extracted a task ID via
  `j.taskId||j.draftId`, but `task-sources.js`'s `writeTask()` always writes the field as
  plain `id`. Fix: add `||j.id` as a fallback.
- **A `JSON.parse` reviver that unconditionally throws**: `JSON.parse(text, (x) => { throw
  x })` — the second argument to `JSON.parse` is a reviver function invoked on every
  parsed value; this one immediately re-threw whatever it was given, so parsing failed
  for *every* file, valid JSON or not, silently swallowed by a surrounding `catch(e){}`.
  Fix: drop the reviver entirely (it added no validation, only broke parsing).

### 4. The actual drafting orchestration (plan → implement → critique → revision) was never ported to Linux at all

`local-worker.sh` only ever claimed a task (moved it from `queue/pending/` to
`queue/drafting/<instance>/`) and stopped — the real per-task work lived only in
`src/ornith-worker.ps1` (867 lines), never translated to the Linux side. Symmetric gap in
`review-runner.sh`: it correctly found `needs-review` items but had a hardcoded "no
review logic ported yet" stub (previously called a nonexistent `src/reviewer.js`).

**Fix:** new `src/local-draft.js` (worker side — plan/implement/critique/revision
against Ornith, moves the task to `queue/review/` or `queue/blocked/`) and
`src/review-task.js` (review side — deterministic gates, fact-check, 3-vote unanimous
Ornith majority vote, moves to `queue/approved/` or `queue/blocked/`). Both are ports of
the `.ps1` reference, trimmed to the domains this deployment's `task-domains.json`
actually wires up (`deep_dive`, `project_search`, `brain_dump_sort`, `secondbrain`,
`default`, `adhoc`) — `arch_discovery`/`arch_import`'s extra structural-check pass and the
`'claude'` review-provider path (a different mode this deployment doesn't use) were
deliberately left out as out of scope, not missed.

### 5. `AGENT_MANAGER_INCLUDE_APPLY` and `SECOND_BRAIN_DIR` both needed manual configuration

Not bugs — deliberate opt-in defaults — but easy to lose a full day to if you don't know
they exist:

- **`AGENT_MANAGER_INCLUDE_APPLY=false`** by default means `queue/approved/` just
  accumulates forever with nothing ever applying it, even though every other stage of the
  pipeline looks like it's working. `launch.sh` already has a full continuous apply-loop
  built in (re-runs `apply-task.sh` on a fixed interval) — it just needs the env var
  flipped to `true` and the pipeline restarted.
- **`SECOND_BRAIN_DIR` unset** means `applyBrainDumpSort` (`src/apply-group-a.js`)
  returns `{ skipped: true, reason: 'SECOND_BRAIN_DIR is not configured' }` for every
  brain-dump note — and that "skip" gets treated as a *success* by `apply-task.js`, so the
  task silently lands in `queue/done/` looking complete. Worse: the brain-dump entry
  itself never gets marked `sorted` (only happens on a real file write), so it stays
  `status: "captured"` forever, and `task-sources.js` will regenerate a fresh task for the
  *same* entry indefinitely — an unrecoverable loop until the env var is set.
  **If this already happened to you**: setting the env var alone isn't enough to unstick
  already-"done" entries — `taskIdExistsInQueue()` checks `queue/done/` too, so a stale
  done-file permanently blocks regeneration for that entry. Move (don't delete) the
  stale done-file out of the queue tree to let it retry.

### 6. A stray, un-restarted dashboard process silently absorbed every config change for hours

Config changes (`SECOND_BRAIN_DIR`, `AGENT_MANAGER_INCLUDE_APPLY`, etc.) kept not taking
effect in the dashboard UI despite being correctly set in `agent-manager.env` and despite
`stop.sh`/`launch.sh` reporting success on every restart.

Root cause: the dashboard process actually bound to port 7420 was a stray, manually
started process from *before* `launch.sh` was ever used properly in this session — never
tracked in `launch.sh`'s pidfile system. Every subsequent `stop.sh`/`launch.sh` cycle was
correctly killing and restarting a *different* dashboard process that could never
actually bind the port (already held by the orphan) and silently died on every attempt,
while the orphan — never touched, never re-reading the env file — kept serving stale
config indefinitely.

**Fix:** find the real port holder (`ss -ltnp | grep 7420`), kill it directly by PID (not
via `stop.sh`, which only knows about its own tracked pidfiles), then relaunch normally.
**Lesson for next time:** if a config change doesn't take effect after a clean restart,
verify which PID is *actually* bound to the port before assuming the restart script is
broken.

### 7. `task-sources.js`'s backlog throttle only ever checked `queue/pending/`, never `queue/drafting/`

A claimed task moves out of `pending/` into `drafting/<instance>/` almost instantly (same
tick it's claimed), well before the real multi-minute plan/implement/critique work behind
it finishes. The throttle that's supposed to stop new tasks from piling up while the
queue is backed up only ever looked at `pending/`, which reads "empty" again within
seconds of every claim — so it kept seeding a brand new task on every ~30s tick
regardless of how deep the real backlog in `drafting/` already was. 17+ tasks piled up
this way before it was caught.

**Fix:** broadened the check in `src/task-sources.js` to also treat any `.json` sitting
in any `queue/drafting/<instance>/` subfolder as "already has work queued." (Two
narrower, deliberate exceptions — `adhoc` and `brain_dump_sort` — still bypass this
throttle by design, since both are human-initiated and rate-bounded, not unbounded
background generators; that bypass is intentional, not a gap.)

### 8. No crash-resume: a claimed task that outlived its worker process was lost until manually noticed

`local-worker.sh`'s claim loop only ever looked at `queue/pending/` for *new* work — it
never revisited a task already sitting in its own `queue/drafting/<instance>/` from a
previous run that got interrupted (the worker process killed/restarted mid-draft-call,
which happened repeatedly during this same day's development). The Windows reference has
explicit "orphaned claim: recovered automatically at the next worker startup" behavior;
the Linux port never implemented the equivalent, so 16+ tasks sat claimed-but-untouched
in `drafting/` indefinitely.

**Fix:** added a resume pass at the top of every tick (not just at process startup) that
processes any leftover file in the instance's own `drafting/` folder through the same
draft logic a freshly claimed item gets, before claiming anything new.

### 9. `queue-watcher.sh`'s staleness check silently processed zero files, always

`find "$dir" ... | sort` (newline-delimited output) was piped into `while read -r -d ''`
(a NUL-delimited read). With no NUL byte anywhere in the stream, the read consumes the
*entire* piped output as one "line" on its first and only iteration — the loop body never
ran for any real file, ever, regardless of what was actually in `queue/pending/`. Matched
exactly what every watchdog log line showed the whole session: `processed=0 stale=0`,
unconditionally.

**Fix:** `-print0` on `find` and `sort -z`, keeping the pipeline NUL-delimited end to end
to match the `read -d ''` loop. Verified by reproducing the bug against real dummy files
(0 iterations before, correct iteration count after) before trusting the live fix.

### 10. Reject-retry-requeue was never ported — every review rejection was a permanent dead end

The Windows reference's `queue-watchdog.ps1` automatically requeues a genuine
review-stage rejection (`blockedStage: "review"`) for one more redraft attempt, up to a
retry cap, feeding the rejection reason back into the next attempt via
`priorRejectionFeedback` (which `src/prompts.js`'s `priorRejectionBlock()` already
consumes — no prompt changes needed). None of this existed on the Linux side; a rejected
task just sat in `queue/blocked/` forever, no matter how long the pipeline ran. 29 real
tasks were stuck this way before it was fixed.

**Fix:** new `src/reject-retry-check.js`, wired into `queue-watcher.sh`, running every
tick. Ported the `deep_dive` coverage-exhaustion stamping (so a community that exhausts
its retries doesn't starve that project's rotation forever) since that domain is actually
reachable here; skipped the equivalent `arch_discovery`/`arch_import` stamping since
neither domain is wired up in this deployment's `task-domains.json`.

**A second, more serious bug found while fixing this one:** `local-draft.js`'s
"already has content, skip regeneration" check was keyed on whether `implementResponse`
merely *existed* on the task, not on an explicit `preDrafted` flag. Since
`reject-retry-check.js` intentionally does *not* clear the old (rejected) content when
requeuing — `priorRejectionFeedback` is what's supposed to inform the next attempt — this
meant **every retried task silently reused its already-rejected content and skipped
regeneration entirely**. The retry mechanism looked like it worked (files moved queues
correctly, retry counts incremented) but never actually produced a fresh redraft. Fixed
by matching the reference exactly: gate the pre-drafted skip on an explicit
`task.preDrafted === true` flag, never on incidental field presence.

### 11. No dead-process auto-restart

The other half of `queue-watchdog.ps1`'s job (detecting a crashed worker/reviewer by
stale heartbeat and restarting it) also had no Linux port — nothing recovered a crashed
daemon automatically; repeated manual restarts were the only thing keeping the pipeline
running for most of this day's development.

**Fix:** new `src/dead-process-check.js` (staleness/zombie detection, restart cooldown to
avoid the exact "two workers racing after a restart" duplicate-instance bug the Windows
reference itself once hit) wired into `queue-watcher.sh`, which owns the actual
kill/spawn/pidfile mechanics using the *same* pidfile conventions `launch.sh` itself uses,
so `stop.sh` stays accurate after an automatic restart. Verified live: simulated a
genuinely dead `worker-2` (fake stale heartbeat, non-existent pid) and confirmed a real
replacement process got spawned within one tick. Windows-specific parts of the reference
(orphaned `llama-server.exe` VRAM-squatter cleanup, a `-NoExit` shell surviving its own
script's crash) were not ported — no direct Linux equivalent in how these bash daemons or
systemd-managed Ollama actually fail here.

### 12. `project_search`'s real-search harness step was never ported — Ornith hallucinated instead

The plan pass proposes search queries only (Ornith has no network access); a harness step
is supposed to run between plan and implement, executing those queries for real against
GitHub/Hugging Face (`src/project-search-fetch.js`, which already existed and worked
fine) and handing real results to the implement pass. `local-draft.js`'s first version
never called this step at all, so `task.promptContext.searchResults` stayed `undefined`
for every `project_search` draft. Ornith — explicitly instructed "write findings from the
REAL results — do not invent" — responded by inventing well-known project names from its
own training data instead (one draft's own text admitted: *"actual web search tools are
not available in this interface"*), and in the wrong format besides, so the deterministic
apply-time parser found zero real findings in every one of 17+ completed tasks.

**Fix:** added the missing fetch step to `local-draft.js` (extract `QUERY:` lines from
the plan response via regex, run them through `runSearches()`, attach the real results to
`promptContext.searchResults` before building the implement prompt). Verified against the
exact query text from a real stuck task — confirms some queries genuinely return zero
real results (not a bug, just a niche/awkward phrasing not matching anything real), and
post-fix the model started honestly reporting "no usable results" instead of hallucinating
once given real (even if empty) search data to work from.

### 13. Model-stats tracking (the dashboard's Models tab) was fully disconnected

Two separate causes, both silent:

- `src/model-stats-db.js` requires `better-sqlite3` — see item 1 in the checklist above.
  `npm install` had simply never been run in this repo on this machine.
- Even with the dependency present, nothing in the ported pipeline ever called
  `record-call`/`record-outcome` at all — this instrumentation was skipped earlier in
  this same migration effort as "analytics, not core correctness," which undersold how
  load-bearing it is for the dashboard's Models tab (`/api/models` just returns `[]`
  when the underlying table has no rows).

**Fix:** `npm install`, plus a new `src/model-stats-client.js` (a thin subprocess wrapper
— `model-stats-db.js` can't be `require()`'d directly, it executes unconditionally at
load time) wired into `local-draft.js` (records the call right after the implement
pass, stamping `task.abCallId`) and into every verdict branch of `review-task.js` plus
`reject-retry-check.js`'s requeue path (records the eventual outcome against that same
`callId`). Verified live: `/api/models` went from `[]` to real per-model call counts,
approve/reject rates, latency, and tokens/sec, with no daemon restart needed (the Node
scripts run as fresh subprocesses on every tick, so they pick up code changes on their
very next invocation).

### 14. `deep_dive` onboarding — two more stacked Linux-vs-Windows dependency bugs

Even after `project_search` started producing real, well-grounded "Strong" leads with
real URLs, `queue/drafting`'s sibling feature — cloning a Strong lead and community-graphing
it for `deep_dive` to pick apart — never actually onboarded anything. `deep-dive-coverage.json`
never got created, and the dashboard's Scouted Repos tab stayed empty no matter how many
completed tasks accumulated.

- **`python` vs `python3`**: `task-sources.js`'s `onboardDeepDiveProject()` shelled out to
  the community-graph builder as bare `python` — resolves fine via the Windows launcher,
  but this (and most) Linux distros only ever install a `python3` binary, no `python`
  alias. Every single onboarding attempt failed instantly with `python: not found`.
- **Missing `networkx` even after fixing the binary name**: the system `python3` doesn't
  have `networkx` (the graph library `build_graph.py` needs) installed — only this repo's
  own `.venv` does (see checklist item 2). The fetch/graph code needed to point at
  `PACKAGE_ROOT/.venv/bin/python` explicitly, the same interpreter `launch.sh` already
  uses for the dashboard, not a bare `python3` off `PATH`.

Both failures were caught and logged via `console.error`, but were invisible for most of
this migration because `local-worker.sh` was discarding `task-sources.js`'s entire
stderr to `/dev/null` until item 4's logging fix landed separately — a good example of
why routing a subprocess's real output somewhere durable matters even when nothing looks
obviously broken.

**Fix:** resolve `PACKAGE_ROOT/.venv/bin/python` (or `.venv\Scripts\python.exe` on
Windows) if it exists, falling back to a bare `python3`/`python` off `PATH` otherwise.
Verified directly against the real accumulated backlog of 8 Strong leads: real clones,
real `networkx` community graphs, a real `deep_dive` task returned with genuine extracted
file content — 12 projects onboarded and visible via `/api/deep-dive/projects` on the
first successful run.

## Threads intentionally left open

Not fixed in this pass — flagged here so they don't need rediscovering:

- **`apply-task.sh` is a deliberately simplified stand-in** for the Windows reference's
  `apply-runner.ps1` (already documented in its own header) — missing heartbeats (so it
  never shows on the dashboard's Workers tab), arch-discovery ID repair, and
  community-coverage bookkeeping. Low impact today since none of the domains this
  deployment wires up need that bookkeeping.
- **`pipeline-doctor.ps1`** (a manual diagnostic/repair tool referenced by the 2026-07-19
  incident doc above) has no Linux equivalent at all. This session effectively did its
  job by hand, repeatedly.
- **Strong/Weak lead-rating calibration** for `project_search` hasn't been tuned — early
  evidence suggests the model may be conservative about rating things Strong even when a
  finding reads as fairly concrete/actionable, but this wasn't investigated further once
  the actual plumbing bugs (this doc's items 12 and 14) turned out to be the real
  blockers.
