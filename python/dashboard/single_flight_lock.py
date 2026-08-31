"""Python-side counterpart to src/single-flight-lock.js -- same real flock(2) mutex,
fully interoperable with the Node and bash versions (all three open the SAME lockfile
path; flock(2) locks are owned by the open file description, not the process, so any
combination of Python/Node/bash holding or waiting on it works correctly together).

Built 2026-08-24 after a live incident: clicking Discuss (local/Ornith provider) hit a
raw 500 because worker-1 was mid-draft on the same Ollama model at that exact moment --
Discuss had zero coordination with the worker lanes' own GPU-serialization discipline
(the .pipeline-single-flight.lock every Ollama-calling lane already uses, see
agent-manager-common.sh and single-flight-lock.js's own headers for why that lock
exists). The uncaught-timeout half of that incident was fixed separately in
discuss_sessions.py/app.py; this closes the actual resource-contention gap that caused
the timeout in the first place -- Discuss now waits its turn instead of racing a worker
lane for the one real GPU/model slot.

Only ONE lockfile, deliberately -- an earlier version of this also added a separate
.claude-single-flight.lock for the Claude Code subscription (worker-reasoning's adhoc
drafts / Discuss's Claude provider), on the theory that it needed the same coordination.
Reconsidered before shipping: unlike Ollama's single resident model, the Claude
subscription has no real single-execution-slot constraint -- separate `claude -p` calls
already run genuinely concurrently (same as two independent Claude Code sessions),
bounded only by Anthropic's own account-level rate limits, not a local hardware
bottleneck. Locking Claude calls against each other would have been a real regression,
not a fix: a multi-minute adhoc draft (real Bash/Edit/Write investigation) would block a
live chat, or vice versa, for a resource conflict that doesn't actually exist.

Priority for the human (2026-08-24, Grimmethy: "move the user interaction to the highest
priority possible... no matter what other tasks may be in queue, if a user interaction
shows up, it's next"): fairness alone still wasn't enough -- caught live, a Discuss
session lost race after race against worker-1 continuously reclaiming the lock for its
next queued task, and sat for minutes before ultimately failing. A held flock genuinely
can't be interrupted mid-call (and shouldn't be -- killing a half-finished generation
wastes real work), so this can't preempt whichever call is CURRENTLY running; what it CAN
do is stop a worker/reviewer lane from immediately racing to reclaim the lock for its
NEXT task the instant the current holder releases. held() below drops a per-waiter marker
file into instances/.discuss-waiting/ before blocking on flock, and removes it the moment
it actually acquires -- agent-manager-common.sh's acquire_single_flight_lock() and
single-flight-lock.js's acquire() both check whether that directory is non-empty and back
off a few seconds before attempting their own acquire, real headroom for Discuss's
already-parked blocking flock() call to win the wakeup race. A DIRECTORY of per-waiter
files, not one shared flag, so a second concurrent Discuss session doesn't have its
priority silently cleared the instant the first one gets the lock.

Split into acquire()/release() (2026-08-24, Chat panel's "fully reserve the reasoning
model" toggle) plus held(), a thin contextmanager wrapper around them -- a reservation has
to span multiple separate HTTP requests (toggle on, several chat messages, toggle off),
which a single `with` block can't do. held() stays the right shape for every OTHER caller
(Discuss, and Chat's own per-message calls when NOT reserved), where the lock's whole
life fits inside one function call.
"""
import fcntl
import os
import time
import uuid
from pathlib import Path
from contextlib import contextmanager

LOCK_NAME = ".pipeline-single-flight.lock"
PRIORITY_WAIT_DIR_NAME = ".discuss-waiting"


def _timeout_secs() -> float:
    """Bounded-wait parity with single-flight-lock.js / agent-manager-common.sh
    (2026-08-31). Both of those bound acquire() with `flock -w $SINGLE_FLIGHT_LOCK_TIMEOUT_SECS`
    (default 600) -- this twin was still an *unbounded* fcntl.flock(LOCK_EX), so a stuck
    holder (a dead PID that left the flock unreleased -- the exact 2026-08-27 incident
    the other two twins were bounded for) would hang a dashboard request forever. Same
    env var, same default."""
    try:
        return float(os.environ.get("SINGLE_FLIGHT_LOCK_TIMEOUT_SECS") or 600)
    except (TypeError, ValueError):
        return 600.0


def _lock_name(key: str | None) -> str:
    """Per-model locking (2026-08-25 -- see src/single-flight-lock.js's matching header
    for the full incident and reasoning; this mirrors it exactly so a Python caller and a
    JS caller hitting the SAME model still share the SAME lockfile). `key` is normally
    ollama_client.MODEL (== LOCAL_MODEL) -- the model this call will actually hit. Omitted
    (None), this returns the original global LOCK_NAME unchanged, so any caller not
    passing a key keeps today's behavior exactly."""
    if not key:
        return LOCK_NAME
    import re
    safe_key = re.sub(r"[^A-Za-z0-9._-]+", "_", str(key))
    return f".pipeline-single-flight.{safe_key}.lock"


def acquire(instances_dir: Path, key: str | None = None):
    """Blocking, exclusive acquire, bounded by SINGLE_FLIGHT_LOCK_TIMEOUT_SECS (default
    600) -- parity with single-flight-lock.js / agent-manager-common.sh's `flock -w`.
    Drops a per-waiter priority marker (see this module's own header) for the duration of
    the wait, clearing it the instant the lock is actually held. Returns the open file
    object -- it MUST stay open for as long as the lock should be held (the flock is owned
    by the open file description, not the process) and MUST be passed to release() when
    done, or the lock leaks for the life of the process. Raises TimeoutError (message
    contains "timed out", matching the JS twin's INFRA_FAILURE_PATTERN-shaped string) if
    the wait deadline elapses."""
    instances_dir.mkdir(parents=True, exist_ok=True)
    wait_dir = instances_dir / PRIORITY_WAIT_DIR_NAME
    wait_dir.mkdir(exist_ok=True)
    marker = wait_dir / uuid.uuid4().hex
    marker.touch()
    try:
        lock_path = instances_dir / _lock_name(key)
        fh = open(lock_path, "w")
        timeout = _timeout_secs()
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fh
            except OSError:
                if time.monotonic() >= deadline:
                    fh.close()
                    raise TimeoutError(
                        f"single-flight lock acquisition timed out after {timeout:.0f}s "
                        f"waiting for lock '{key or '(default)'}'"
                    )
                time.sleep(0.25)
    finally:
        # Acquired (or the open/flock call itself raised) -- either way no longer
        # "waiting". Not everyone's marker: another concurrent waiter may still be queued
        # behind us and its own priority claim must stay intact.
        marker.unlink(missing_ok=True)


def release(fh):
    """Releases a lock acquired above. Safe to call with None (best-effort, matching
    single-flight-lock.js's own release() semantics)."""
    if fh is None:
        return
    try:
        fcntl.flock(fh, fcntl.LOCK_UN)
    finally:
        fh.close()


@contextmanager
def held(instances_dir: Path, key: str | None = None):
    """Preferred entry point when the lock's whole life fits inside one function call --
    callers should wrap just the real model call, not any surrounding prompt-building/
    grep work, same discipline local-draft.js's own withLock() usage already follows.
    Pass `key` (normally ollama_client.MODEL) so this shares a lockfile with every other
    caller -- JS or Python -- hitting the SAME model; omitted, this locks against the
    original global lockfile."""
    fh = acquire(instances_dir, key)
    try:
        yield
    finally:
        release(fh)
