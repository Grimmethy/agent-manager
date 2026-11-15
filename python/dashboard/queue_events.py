"""Python writer for the queue-events journal (ADR-0024 stage S1; the reader and the contract live in src/queue-events.js, piece 1 of HUB0330).

The dashboard's verdict and merge routes are Python; the sweeps that react to them are Node. This is the Python half of the journal: it appends ONE line in exactly
the format src/queue-events.js `append` writes, so a Node consumer's drain() reads it unchanged (a committed cross-language test, test_queue_events.py, proves it).

  <pipelineDir>/queue-events/journal.jsonl   one JSON object per line, newline-terminated, always under 3500 bytes: one os.write on an O_APPEND descriptor is atomic
  line keys, in this order: at, type, branch, taskId, sha, verdict, source, project (realpath of the pipeline dir)

append_event never raises to its caller for I/O problems (the journal must never break a verdict or a merge): it logs and returns False. It DOES raise ValueError for
a programming mistake (an unknown event type, or an event whose line would be 3500 bytes or more). AGENT_MANAGER_QUEUE_EVENTS=off makes it do nothing and return False.
"""
import json
import logging
import os
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

TYPES = ("verdict_recorded", "branch_merged")
MAX_LINE_BYTES = 3500
DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024


def _iso_now():
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (now.microsecond // 1000)


def _line(pipeline_dir, event):
    if not isinstance(event, dict) or event.get("type") not in TYPES:
        raise ValueError("unknown event type: %r" % (event.get("type") if isinstance(event, dict) else event,))
    try:
        project = os.path.realpath(pipeline_dir)
    except (OSError, ValueError, TypeError):
        project = str(pipeline_dir)
    rec = {
        "at": event.get("at") or _iso_now(),
        "type": event["type"],
        "branch": event.get("branch") or None,
        "taskId": event.get("taskId") or None,
        "sha": event.get("sha") or None,
        "verdict": event.get("verdict") or None,
        "source": event.get("source") or None,
        "project": project,
    }
    # Same bytes as JSON.stringify: compact separators, non-ASCII left as UTF-8.
    line = json.dumps(rec, separators=(",", ":"), ensure_ascii=False) + "\n"
    if len(line.encode("utf-8")) >= MAX_LINE_BYTES:
        raise ValueError("event line is %d bytes; the limit is %d" % (len(line.encode("utf-8")), MAX_LINE_BYTES - 1))
    return line


def append_event(pipeline_dir, event, rotate_bytes=DEFAULT_ROTATE_BYTES):
    """Append one event; -> True when written, False when skipped (kill switch) or when the journal could not be written (logged)."""
    line = _line(pipeline_dir, event)          # validation errors surface to the caller
    if os.environ.get("AGENT_MANAGER_QUEUE_EVENTS", "on").strip().lower() == "off":
        return False
    try:
        directory = os.path.join(pipeline_dir, "queue-events")
        os.makedirs(directory, exist_ok=True)
        journal = os.path.join(directory, "journal.jsonl")
        try:
            if os.path.getsize(journal) >= rotate_bytes:
                os.replace(journal, os.path.join(directory, "journal.1.jsonl"))   # replaces the old journal.1.jsonl, like the Node writer
        except OSError:
            pass                                                                    # no journal yet, or another writer rotated it first
        fd = os.open(journal, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o644)
        try:
            os.write(fd, line.encode("utf-8"))                                      # ONE write: a single appended line under the 3500-byte limit is not interleaved with another writer's line
        finally:
            os.close(fd)
        return True
    except OSError as exc:
        logger.warning("queue-events: could not append to %s: %s", pipeline_dir, exc)
        return False
