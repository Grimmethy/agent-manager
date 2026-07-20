# Incident: overnight pipeline instability, 2026-07-19

Context: an architect session queued `project_search` (ADR-0018) for Ornith and
monitored the pipeline every 30 minutes overnight while the operator slept. Most of the
night went into firefighting pipeline infrastructure rather than that task making
progress. This doc is the retained playbook so the next incident (or the next fresh
session with no memory of this one) doesn't have to re-derive it by hand.

**Companion tool:** [`src/pipeline-doctor.ps1`](../src/pipeline-doctor.ps1) — run it
first, before doing any of this by hand. It encodes everything below as a single
invocation: `powershell -File src/pipeline-doctor.ps1` (needs `AGENT_MANAGER_REPO_ROOT`
set). It reports and does a small set of well-established safe repairs; it does not
auto-block crash-looping tasks or auto-restart Ollama, since those are judgment calls.

**Resolution update (same night):** both root-cause fixes below were implemented directly
(Ornith/Ollama were paused for a machine reboot at the time) rather than left as blocked
tasks -- see `src/ornith-worker.ps1`'s claim-race backoff and `src/queue-watchdog.ps1`'s
zombie-restart logic. A formalized **5-minute ceiling** on every Ornith-call and
worker-liveness timeout in this pipeline came out of that work -- see the header comment
on `src/ollama-http.js` for the authoritative statement of the rule and why it exists
(two separate near-misses the same night: a 15-min zombie threshold that was over-cautious
for no real benefit, and a pre-existing 30-min tool-calling timeout that was actively
harmful). Check that comment before setting any new timeout in this codebase.

## Failure modes hit, in the order they were found

### 1. Duplicate `ornith-worker.ps1` instances racing each other

Up to **four** concurrent processes were seen all claiming `instanceId: worker-1`,
sharing one `instances/worker-1.json` heartbeat file and one `queue/drafting/worker-1/`
folder. Root cause: manual restarts (by the architect session) racing the automatic
ones `queue-watchdog.ps1` performs on its own 10s poll cycle — both react to the same
"stale heartbeat, pid confirmed dead" signal within moments of each other and each
spawns a replacement.

**Fix that worked:** stop manually restarting hung workers. Kill a confirmed-hung
process if you must, but then *wait* for `queue-watchdog.ps1` to restart it on its own
rather than racing it. Once this session stopped racing the watchdog, duplicates
stopped appearing.

**Diagnosing "is this duplicate genuinely working or a stale zombie":** check for a
live `node.exe` child process under the candidate pid (`ornith-worker.ps1` shells out to
`node ornith-client.js ...` for every Ollama call). A duplicate with a live node child
is genuinely mid-task — killing it destroys real, unrecoverable progress (nothing is
persisted to disk between plan/implement/critique passes). A duplicate with no node
child AND no claimed file in the shared drafting folder is safe to retire. **A mistake
was made once this session**: killed a process based on a stale heartbeat read instead
of re-checking live ownership at the moment of action, destroying real in-progress work
on the actual target task. No data was lost (nothing persists mid-task anyway) but it
cost a wasted cycle. Always re-verify live state immediately before killing, not from an
earlier snapshot.

**Likely secondary effect, not fully confirmed:** several *different*, unrelated tasks
failed with `"Plan pass degenerate: empty"` in the same window duplicate workers were
racing. Plausible that concurrent requests against a single 8GB-VRAM GPU degrade output
quality, not just cause hangs/crashes. Worth deliberate testing once the duplicate-race
bug itself is fixed in code (see "Root cause fixes still needed" below).

### 2. Ollama's own server process wedging — two distinct variants

**Variant A:** `ollama ps` shows the model loaded and looks healthy, but `/api/generate`
hangs indefinitely. `ollama ps`/`api/tags` are not sufficient evidence of health — always
confirm with a real generate call.

**Variant B:** `ollama ps` shows no model loaded (`{"models":[]}`), `/api/generate`
hangs or later 500s.

**Fix:** `Stop-Process` the `ollama.exe` (serve) pid — not `ollama app.exe`, which is the
tray-managed supervisor that respawns `ollama.exe` automatically within seconds. Verify
recovery with a real generate call (up to 90s timeout — a cold model reload after
restart genuinely takes 30-40s, that's not a wedge).

**The gap that cost the most time tonight:** killing `ollama.exe` alone is not always
enough. It can orphan its `llama-server.exe` child process, which keeps holding VRAM on
this 8GB card. A second `ollama.exe` restart then fails to load the model — observed as
a **500 Internal Server Error** on `/api/generate`, not a timeout, easy to mistake for a
new/different problem. **Always check for orphaned `llama-server.exe` processes and kill
them too**, not just `ollama.exe`, especially if this is not the first restart of the
night. `pipeline-doctor.ps1` now checks for this automatically.

### 3. Crash-loop tasks (4 confirmed tonight)

A task can crash the same worker repeatedly — 5 to 9 times each, roughly every 6-7
minutes — always failing at the same point. Root cause: `ornith-client.js`'s
`REQUEST_TIMEOUT_MS` (4 minutes) crashes the whole worker process when it fires (a
deliberate, documented design choice — see the comment block above
`nextArchDiscoveryTask` context-prefetch logic and `ornith-client.js` itself). Because no
pass's output is persisted to disk until the task reaches `queue/review/`, every restart
redoes the entire plan→implement→critique sequence from scratch and can hit the same
wall again.

**Fix used tonight:** after confirming a task has failed 5+ times with the same
signature (check `D:\Users\Grimmethy\Temp\agent-manager-live-log.md` — or wherever
`$env:TEMP\agent-manager-live-log.md` resolves for whoever's running this — for repeated
`WATCHDOG -- [RESTARTED]` entries naming the same task), manually move it to
`queue/blocked/` with a clear `blockedReason` explaining the pattern, and set
`blockedStage` to anything **other than `"review"`** — `queue-watchdog.ps1`'s
reject-retry-requeue logic (`Test-ReviewRejection`) only re-queues genuine review-stage
rejections, so this reliably prevents the exact same crash loop from resuming on its own.

Before blocking, watch one live attempt (check for a `node.exe` child under the worker's
pid) — a couple of the tasks tonight *did* make real progress on a given attempt (further
into the pass sequence than prior attempts) before still failing, which is worth knowing
even if the eventual disposition is the same.

### 4. Orphaned drafting claims within an occupied folder

Crash-resume recovery (the block at the top of `ornith-worker.ps1`, before the main
loop) only recovers files from a drafting subfolder whose *owning instance* is
confirmed dead — it operates at folder granularity. If a live process currently occupies
`queue/drafting/worker-1/` but a *different* file in that same folder belongs to no one
(e.g. left behind by a process that died and got replaced before it could claim
anything), that file is invisible to recovery forever — the folder isn't "dead," so the
scan skips it entirely.

**Fix:** check the live process's heartbeat `currentTaskId` against every file actually
sitting in its drafting folder. Anything not matching the current claim, when the
process itself is confirmed alive, is safe to move back to `queue/pending/` directly —
you are not touching anything the live process considers its own.

## Root cause fixes — DONE (implemented directly, same night)

Two tasks originally queued for Ornith targeted the actual code-level fixes for the
duplicate-instance-race family of bugs above. Both crash-looped when Ornith tried to
draft them (see the crash-loop section above) and were implemented directly instead,
while Ornith/Ollama were paused for a machine reboot — moved to `queue/done/` with a note
that they weren't Ornith-drafted:

- **"ornith-worker: add backoff on lost claim races"** — `ornith-worker.ps1`'s
  claim-race-loss branch now sleeps 3s instead of busy-looping at zero delay. The deeper
  question (should a lock/registry prevent duplicate instances outright?) is documented
  as still open, not fixed — see the comment at that site.
- **"queue-watchdog: restart workers on stale heartbeat even if PID lingers"** —
  `queue-watchdog.ps1` now has a second check, worker-only, that restarts a worker whose
  heartbeat is stale past `$WorkerZombieThresholdSeconds` even when its PID is still
  alive (an idle `-NoExit` shell after the script inside it crashed) — kills the zombie
  first, then restarts. Initially set to 15 minutes "to be safe," corrected down to 5
  (matching `$StaleHeartbeatSeconds`) per operator feedback — see the 5-minute-ceiling
  note above and `ollama-http.js`'s header comment for the full reasoning. Deliberately
  NOT applied to `review-runner`/`apply-runner` — see the code comment for why.

`pipeline-doctor.ps1` still exists and is still useful for the *symptom* (detecting and
safely retiring genuinely-idle duplicates, and other checks below) — these two fixes
address the underlying race, not every way a duplicate could still theoretically arise.

## What NOT to do

- Don't manually restart a worker the instant you kill it — you will race the watchdog.
  Kill and wait, or use `pipeline-doctor.ps1`'s retirement logic (idle-only, no restart).
- Don't kill any process — worker, duplicate, or otherwise — without checking for a live
  `node.exe` child first. A missing child is necessary but not sufficient evidence of
  "safe to kill" (see the orphaned-drafting-folder case) — also check heartbeat/claim
  ownership before acting.
- Don't assume `ollama ps` reporting a loaded model means Ollama is healthy.
- Don't stop at "restarted ollama.exe" if this is not the first restart tonight — check
  for orphaned `llama-server.exe` processes too.
- Don't requeue a task with `blockedStage: "review"` unless it's a genuine review-stage
  rejection — that flag is what makes `queue-watchdog.ps1`'s auto-retry logic pick it
  back up, and a crash-loop task set to that stage will just resume looping.
