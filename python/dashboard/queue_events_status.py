"""The queue-events journal's health number for the dashboard summary (ADR-0024 S1, HUB0330 piece 8).

The sweeps that react to the journal (redo-supersede, branch-defect-readmit, branch-conflict-readmit) still run a slow safety-net scan every 30 minutes. When that
scan finds work no event announced, the sweep adds one to a counter in <pipelineDir>/queue-events/reconcile.json (src/queue-events.js recordCorrection).

What the number means for the owner: `total` is how many times a safety-net pass found something the producers did not announce. ZERO means every producer emits
(the verdict route and the merge route both do). A number that keeps rising names, in `byConsumer`, the sweep that keeps finding work on its own, which points at a
producer that forgot to emit (for example a direct push to main that the dashboard never saw). `lastAt` is when the last one was found; `journalBytes` is the size
of the live journal file (it rotates at 5 MB).

/api/summary adds this beside the host-memory state (memory_status.py): two tiny file reads per refresh, no timer, no request to anything, and it never raises.
"""
import json
import os


def _pipeline_dir(queue_dir):
    return os.path.dirname(os.path.abspath(str(queue_dir)))


def queue_events_status(queue_dir):
    """-> {"total": int, "byConsumer": {name: int}, "lastAt": str|None, "journalBytes": int}. Zeros when the files are absent; never raises."""
    empty = {"total": 0, "byConsumer": {}, "lastAt": None, "journalBytes": 0}
    try:
        if not queue_dir:
            return empty
        directory = os.path.join(_pipeline_dir(queue_dir), "queue-events")
        out = dict(empty)
        try:
            with open(os.path.join(directory, "reconcile.json"), encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                total = data.get("total")
                out["total"] = total if isinstance(total, int) and not isinstance(total, bool) and total >= 0 else 0
                by = data.get("byConsumer")
                out["byConsumer"] = {str(k): v for k, v in by.items() if isinstance(v, int) and not isinstance(v, bool) and v >= 0} if isinstance(by, dict) else {}
                last = data.get("lastAt")
                out["lastAt"] = last if isinstance(last, str) else None
        except (OSError, ValueError):
            pass
        try:
            out["journalBytes"] = os.stat(os.path.join(directory, "journal.jsonl")).st_size
        except OSError:
            pass
        return out
    except Exception:   # noqa: BLE001 -- the page's refresh must never fail because of the journal counter
        return empty
