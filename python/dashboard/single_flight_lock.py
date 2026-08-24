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
import uuid
from pathlib import Path
from contextlib import contextmanager

LOCK_NAME = ".pipeline-single-flight.lock"
PRIORITY_WAIT_DIR_NAME = ".discuss-waiting"


def acquire(instances_dir: Path):
    """Blocking, exclusive acquire -- no timeout, matching single-flight-lock.js's own
    acquire() exactly (a caller that wants a bounded wait should wrap this itself). Drops
    a per-waiter priority marker (see this module's own header) for the duration of the
    wait, clearing it the instant the lock is actually held. Returns the open file object
    -- it MUST stay open for as long as the lock should be held (the flock is owned by
    the open file description, not the process) and MUST be passed to release() when
    done, or the lock leaks for the life of the process."""
    instances_dir.mkdir(parents=True, exist_ok=True)
    wait_dir = instances_dir / PRIORITY_WAIT_DIR_NAME
    wait_dir.mkdir(exist_ok=True)
    marker = wait_dir / uuid.uuid4().hex
    marker.touch()
    try:
        lock_path = instances_dir / LOCK_NAME
        fh = open(lock_path, "w")
        fcntl.flock(fh, fcntl.LOCK_EX)
        return fh
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
def held(instances_dir: Path):
    """Preferred entry point when the lock's whole life fits inside one function call --
    callers should wrap just the real model call, not any surrounding prompt-building/
    grep work, same discipline local-draft.js's own withLock() usage already follows."""
    fh = acquire(instances_dir)
    try:
        yield
    finally:
        release(fh)
