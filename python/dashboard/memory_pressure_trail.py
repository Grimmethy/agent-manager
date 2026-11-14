"""Read the gpu-broker's host memory-pressure journal into a data trail: episodes, the processes that were biggest when pressure hit, and a daily view.

The broker (agent-manager-gpu-broker, server/core/mem_triggers.py and mem_relief.py) appends one JSON line per pressure change to
~/.local/state/gpu-broker/mem-pressure-journal.jsonl: {kind:'state', from, to, reason, numbers, via} for every classification change and, when an episode opens or
closes, {kind:'relief', event:'pause'|'resume'|'would-refuse'|..., ...}. A `pause` carries `top`, the five largest processes at that moment. This module only READS
that file (the last DEFAULT_MAX_BYTES of it) and never writes. The fold into episodes and the offender ranking (what to optimise) is memory_pressure_fold.py.
Fails soft: a missing file reads as empty.
"""
import json
import os
import re
from datetime import datetime, timezone

DEFAULT_MAX_BYTES = 8 * 1024 * 1024
_INTERPRETERS = {"node", "python", "python3", "bash", "sh"}


def journal_path():
    for name in ("MEM_RELIEF_JOURNAL", "MEM_TRIGGERS_JOURNAL"):
        if os.environ.get(name):
            return os.path.expanduser(os.environ[name])
    return os.path.expanduser("~/.local/state/gpu-broker/mem-pressure-journal.jsonl")


def parse_time(text):
    """Seconds since the epoch for an ISO-8601 time (a trailing Z accepted), or None."""
    if not isinstance(text, str):
        return None
    try:
        dt = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def read_entries(path, since_ts=0, max_bytes=DEFAULT_MAX_BYTES):
    """(entries in time order with at >= since_ts, truncated). Reads only the last max_bytes; a partial first line, corrupt lines and non-dict lines are dropped."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            truncated = size > max_bytes
            if truncated:
                fh.seek(size - max_bytes)
            raw = fh.read()
    except OSError:
        return [], False
    lines = raw.decode("utf-8", "replace").split("\n")
    if truncated:
        lines = lines[1:]  # the first line is cut in the middle
    entries = []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        ts = parse_time(entry.get("at")) if isinstance(entry, dict) else None
        if ts is not None and ts >= since_ts:
            entry["_ts"] = ts
            entries.append(entry)
    entries.sort(key=lambda e: e["_ts"])
    return entries, truncated


def process_label(cmd):
    """A short stable label for a command line: the executable's basename, or the script for an interpreter, or qemu:<guest>."""
    tokens = str(cmd or "").split()
    if not tokens:
        return "(unknown)"
    exe = os.path.basename(tokens[0])
    if exe.startswith("qemu-system"):
        guest = re.search(r"-name\s+guest=([^,\s]+)", str(cmd))
        return "qemu:" + guest.group(1) if guest else exe
    if exe in _INTERPRETERS:
        script = next((t for t in tokens[1:] if not t.startswith("-")), None)
        return f"{exe} {os.path.basename(script)}" if script else exe
    return exe
