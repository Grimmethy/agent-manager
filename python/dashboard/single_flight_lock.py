"""Python-side counterpart to src/single-flight-lock.js -- same real flock(2) mutex,
fully interoperable with the Node and bash versions (all three open the SAME lockfile
path; flock(2) locks are owned by the open file description, not the process, so any
combination of Python/Node/bash holding or waiting on it works correctly together).

Built 2026-08-24 after a live incident: clicking Discuss (local/Ornith provider) hit a
raw 500 because worker-1 was mid-draft on the same Ollama model at that exact moment --
Discuss had zero coordination with the worker lanes' own GPU-serialization discipline
(the .pipeline-single-flight.lock every Ollama-calling lane already uses, see
agent-manager-common.ps1 and single-flight-lock.js's own headers for why that lock
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
"""
import fcntl
from pathlib import Path
from contextlib import contextmanager

LOCK_NAME = ".pipeline-single-flight.lock"


@contextmanager
def held(instances_dir: Path):
    """Blocking, exclusive acquire -- no timeout, matching single-flight-lock.js's own
    acquire() exactly (a caller that wants a bounded wait should wrap this itself). Held
    only for the body of the `with` block -- callers should wrap just the real model call,
    not any surrounding prompt-building/grep work, same discipline local-draft.js's own
    withLock() usage already follows."""
    instances_dir.mkdir(parents=True, exist_ok=True)
    lock_path = instances_dir / LOCK_NAME
    with open(lock_path, "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)
