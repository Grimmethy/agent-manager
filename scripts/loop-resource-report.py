#!/usr/bin/env python3
"""Loop resource report: parsers and markdown table builder.

Stdlib only. Nothing is read at import time. Kernel per-process files are read
only by read_proc_file(), which is called from no code path in main().

Format notes:
- tool-loop-audit.log (verified against src/tool-loop-audit.js): NDJSON, one
  object per line. Keys used: 'type' ('turn-end' | 'tool-outcome'), 'at' (ISO-8601),
  'source' (treated as the loop name), 'promptEvalCount', 'evalCount'.
- wakes.jsonl and *-drain.log: writers were NOT located in this pass. The parsers
  accept any JSON object per line (drain lines may be plain text, e.g. 'idle'). Keys 'at' or 'ts' (timestamp), 'loop' (name) and
  'acted' (bool) are ASSUMED, not verified. Columns whose data is absent print a
  'not recorded' or 'not measurable from history' label.
"""

import argparse
import datetime
import json
import re
import sys

NOT_RECORDED = "not recorded"
NOT_MEASURABLE = "not measurable from history"

# (header, metrics key, label printed when the value is absent).
# NOT_MEASURABLE: history logs cannot provide this at all (only live /proc snapshots
# or process accounting could). NOT_RECORDED: the column could come from logs but
# no log in this report carries it.
COLUMNS = [
    ("loop", "loop", NOT_RECORDED),
    ("wakes/h", "wakes_per_h", NOT_RECORDED),
    ("acted %", "acted_pct", NOT_RECORDED),
    ("CPU s/h", "cpu_s_per_h", NOT_MEASURABLE),
    ("RSS MB", "rss_mb", NOT_MEASURABLE),
    ("disk read MB/h", "disk_read_mb_per_h", NOT_MEASURABLE),
    ("disk write MB/h", "disk_write_mb_per_h", NOT_MEASURABLE),
    ("log MB/h", "log_mb_per_h", NOT_RECORDED),
    ("cloud calls/h", "cloud_calls_per_h", NOT_RECORDED),
    ("tokens/h", "tokens_per_h", NOT_RECORDED),
    ("git spawns/h", "git_spawns_per_h", NOT_MEASURABLE),
]


# ---------------------------------------------------------------- /proc parsers

def read_proc_file(pid, name):
    """Return the text of /proc/<pid>/<name>, or None if unreadable."""
    try:
        with open(f"/proc/{pid}/{name}", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def parse_proc_io(text):
    """Parse the io file: rchar, wchar, read_bytes, write_bytes. Missing keys are None."""
    keys = ("rchar", "wchar", "read_bytes", "write_bytes")
    out = {k: None for k in keys}
    for line in (text or "").splitlines():
        key, sep, val = line.partition(":")
        key = key.strip()
        if sep and key in out:
            try:
                out[key] = int(val.strip())
            except ValueError:
                pass
    return out


def parse_proc_stat(text):
    """Parse utime and stime (clock ticks) from the stat file.

    comm may contain spaces and parentheses, so split only after the LAST ')'.
    After it, the first token is field 3 (state); utime is field 14 and stime is
    field 15, i.e. indexes 11 and 12 of the remainder.
    Returns None if the line is malformed.
    """
    if not text:
        return None
    close = text.rfind(")")
    if close < 0:
        return None
    fields = text[close + 1:].split()
    if len(fields) < 13:
        return None
    try:
        return {"utime": int(fields[11]), "stime": int(fields[12])}
    except ValueError:
        return None


def parse_proc_status(text):
    """Parse VmRSS and optional VmSwap, both in kB. Absent keys are None."""
    out = {"VmRSS": None, "VmSwap": None}
    for line in (text or "").splitlines():
        key, sep, val = line.partition(":")
        if sep and key in out:
            parts = val.split()
            if parts and parts[0].isdigit():
                out[key] = int(parts[0])
    return out


_PRESSURE_RE = re.compile(r"^(some|full)\s.*?avg10=([0-9]+(?:\.[0-9]+)?)")


def parse_pressure(text):
    """Parse a pressure file. Returns {'some': avg10 or None, 'full': avg10 or None}."""
    out = {"some": None, "full": None}
    for line in (text or "").splitlines():
        m = _PRESSURE_RE.match(line.strip())
        if m:
            out[m.group(1)] = float(m.group(2))
    return out


# ---------------------------------------------------------------- log parsers

def _parse_jsonl(lines, is_valid=None):
    """Return (records, malformed_count). Blank lines are skipped, not counted."""
    records, malformed = [], 0
    for line in lines:
        s = line.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            malformed += 1
            continue
        if not isinstance(obj, dict) or (is_valid is not None and not is_valid(obj)):
            malformed += 1
            continue
        records.append(obj)
    return records, malformed


def parse_wakes_jsonl(lines):
    return _parse_jsonl(lines)


def parse_drain_log(lines):
    """Parse a *-drain.log. Repo fixtures show plain-text status lines (e.g. 'idle'),
    so a non-JSON line is a status record, not a malformed one. A line starting with
    '{' must be a JSON object or it is counted as malformed. Returns (records, malformed).
    """
    records, malformed = [], 0
    for line in lines:
        s = line.strip()
        if not s:
            continue
        if s[0] in "{[":
            try:
                obj = json.loads(s)
            except ValueError:
                malformed += 1
                continue
            if isinstance(obj, dict):
                records.append(obj)
            else:
                malformed += 1
            continue
        records.append({"status": s})
    return records, malformed


def parse_tool_loop_audit(lines):
    return _parse_jsonl(lines, is_valid=lambda o: isinstance(o.get("type"), str))


# ---------------------------------------------------------------- summaries

def _parse_at(value):
    """Parse an ISO-8601 timestamp into an aware datetime (naive is taken as UTC)."""
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def _window_hours(stamps):
    """Hours between the earliest and latest timestamp, or None if there is no window."""
    stamps = [s for s in stamps if s is not None]
    if len(stamps) < 2:
        return None
    hours = (max(stamps) - min(stamps)).total_seconds() / 3600.0
    return hours if hours > 0 else None


def summarise_audit(records):
    """Group turn-end audit records by 'source'. Each group: stamps, cloud_calls, tokens."""
    groups = {}
    for r in records:
        if r.get("type") != "turn-end":
            continue
        g = groups.setdefault(str(r.get("source") or "unknown"),
                              {"stamps": [], "cloud_calls": 0, "tokens": None})
        g["stamps"].append(_parse_at(r.get("at")))
        g["cloud_calls"] += 1
        nums = [t for t in (r.get("promptEvalCount"), r.get("evalCount"))
                if isinstance(t, int) and not isinstance(t, bool)]
        if nums:
            g["tokens"] = (g["tokens"] or 0) + sum(nums)
    return groups


def summarise_wakes(records):
    """Group wake records by 'loop' (ASSUMED key). acted is counted only if 'acted' is present."""
    groups = {}
    for r in records:
        g = groups.setdefault(str(r.get("loop") or "unknown"),
                              {"stamps": [], "wakes": 0, "acted": 0, "has_acted": False})
        g["wakes"] += 1
        g["stamps"].append(_parse_at(r.get("at") or r.get("ts")))
        if "acted" in r:
            g["has_acted"] = True
            if r["acted"]:
                g["acted"] += 1
    return groups


def build_rows(audit_records, wake_records, hours_override=None):
    """Return one metrics dict per loop. Rates are per hour. None means absent.

    The window is the first-to-last timestamp span for the loop, unless
    hours_override is given, which applies to every loop.
    """
    audit = summarise_audit(audit_records)
    wakes = summarise_wakes(wake_records)
    rows = []
    for loop in sorted(set(audit) | set(wakes)):
        a = audit.get(loop)
        w = wakes.get(loop)
        stamps = (a["stamps"] if a else []) + (w["stamps"] if w else [])
        hours = hours_override if hours_override else _window_hours(stamps)

        def per_h(value):
            return value / hours if (value is not None and hours) else None

        wake_count = w["wakes"] if w else None
        acted_pct = None
        if w and w["has_acted"] and wake_count:
            acted_pct = 100.0 * w["acted"] / wake_count
        rows.append({
            "loop": loop,
            "wakes_per_h": per_h(wake_count),
            "acted_pct": acted_pct,
            "cpu_s_per_h": None,
            "rss_mb": None,
            "disk_read_mb_per_h": None,
            "disk_write_mb_per_h": None,
            "log_mb_per_h": None,
            "cloud_calls_per_h": per_h(a["cloud_calls"]) if a else None,
            "tokens_per_h": per_h(a["tokens"]) if a else None,
            "git_spawns_per_h": None,
        })
    return rows


# ---------------------------------------------------------------- table and ranking

def _cell(value, absent, digits=2):
    if value is None:
        return absent
    if isinstance(value, str):
        return value
    return f"{value:.{digits}f}"


def build_table(rows):
    """Render the markdown table, with the eleven columns in COLUMNS order."""
    header = "| " + " | ".join(h for h, _, _ in COLUMNS) + " |"
    sep = "| " + " | ".join("---" for _ in COLUMNS) + " |"
    body = []
    for m in rows:
        cells = []
        for header_name, key, absent in COLUMNS:
            if key == "loop":
                cells.append(str(m.get("loop") or absent))
            else:
                cells.append(_cell(m.get(key), absent))
        body.append("| " + " | ".join(cells) + " |")
    return "\n".join([header, sep] + body)


_RANK_KEYS = ("cpu_s_per_h", "disk_write_mb_per_h", "cloud_calls_per_h")


def rank_by_cost(rows):
    """Sort by CPU s/h, then disk write MB/h, then cloud calls/h, all descending.

    Each key is (0, -value) when numeric, so larger values come first. A missing or
    non-numeric value is (1, 0), which sorts after every numeric value.
    """
    def key(m):
        parts = []
        for k in _RANK_KEYS:
            v = m.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                parts.append((0, -v))
            else:
                parts.append((1, 0))
        return tuple(parts)
    return sorted(rows, key=key)


def render_ranked(rows):
    lines = ["Cost-ranked (CPU s/h, then disk write MB/h, then cloud calls/h):"]
    for i, m in enumerate(rank_by_cost(rows), 1):
        lines.append(f"{i}. {m.get('loop')}")
    return "\n".join(lines)


# ---------------------------------------------------------------- CLI

def _read_jsonl(path, parser):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return parser(fh.read().splitlines())


def main(argv=None):
    ap = argparse.ArgumentParser(description="Loop resource report (history-based).")
    ap.add_argument("--audit", action="append", default=[],
                    help="tool-loop-audit.log path (repeatable)")
    ap.add_argument("--wakes", action="append", default=[],
                    help="wakes.jsonl path (repeatable)")
    ap.add_argument("--drain", action="append", default=[],
                    help="*-drain.log path (repeatable)")
    ap.add_argument("--hours", type=float, default=None,
                    help="fixed observation window in hours (overrides timestamps)")
    args = ap.parse_args(argv)
    if not (args.audit or args.wakes or args.drain):
        ap.error("give at least one of --audit, --wakes, --drain")
    if args.hours is not None and args.hours <= 0:
        ap.error("--hours must be positive")

    audit_recs, wake_recs = [], []
    malformed = {"audit": 0, "wakes": 0, "drain": 0}
    for p in args.audit:
        recs, bad = _read_jsonl(p, parse_tool_loop_audit)
        audit_recs += recs
        malformed["audit"] += bad
    for p in args.wakes:
        recs, bad = _read_jsonl(p, parse_wakes_jsonl)
        wake_recs += recs
        malformed["wakes"] += bad
    for p in args.drain:
        _, bad = _read_jsonl(p, parse_drain_log)
        malformed["drain"] += bad

    rows = build_rows(audit_recs, wake_recs, args.hours)
    print(build_table(rows))
    print()
    print(render_ranked(rows))
    for name, n in malformed.items():
        if n:
            print(f"malformed lines skipped in {name}: {n}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
