"""Fold memory-pressure journal entries (memory_pressure_trail.read_entries) into episodes, the processes that were biggest when pressure hit, and a daily view.

An episode opens on a relief `pause` (it carries `top`, the five largest processes then), collects the state changes and would-refuse entries until the `resume`, and closes.
The summary's top_offenders ranking is the point: what to optimise. Pure functions, no I/O.
"""
import re
from datetime import datetime, timezone

from memory_pressure_trail import process_label

LEVEL_RANK = {"tight": 1, "critical": 2}


def _iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _numbers_min(entry, key):
    value = (entry.get("numbers") or {}).get(key)
    return value if isinstance(value, (int, float)) else None


def _lowest(current, value):
    return value if value is not None and (current is None or value < current) else current


def fold(entries):
    """{episodes (oldest first), summary} from journal entries (see the module docstring)."""
    episodes, current = [], None
    for e in entries:
        kind, event = e.get("kind"), e.get("event")
        if kind == "relief" and event == "pause" and current is None:
            top = [dict(p, label=process_label(p.get("cmd"))) for p in (e.get("top") or []) if isinstance(p, dict)]
            current = {"start": _iso(e["_ts"]), "_start": e["_ts"], "end": None, "pause_s": None, "open": True, "level": e.get("state") or "tight",
                       "reason": e.get("reason"), "mode": e.get("mode"), "numbers": e.get("numbers"), "available_before_mb": e.get("available_before_mb"),
                       "min_available_mb": _numbers_min(e, "available_mb"), "min_swap_free_mb": _numbers_min(e, "swap_free_mb"), "state_changes": 0, "refused": 0, "top": top}
        elif current is None:
            continue
        elif kind == "state":
            current["state_changes"] += 1
            if LEVEL_RANK.get(e.get("to"), 0) > LEVEL_RANK.get(current["level"], 0):
                current["level"] = e["to"]
            current["min_available_mb"] = _lowest(current["min_available_mb"], _numbers_min(e, "available_mb"))
            current["min_swap_free_mb"] = _lowest(current["min_swap_free_mb"], _numbers_min(e, "swap_free_mb"))
        elif kind == "relief" and event == "would-refuse":
            current["refused"] += 1
        elif kind == "relief" and event == "resume":
            length = e.get("pause_s")
            current.update(end=_iso(e["_ts"]), open=False, pause_s=length if isinstance(length, (int, float)) else round(e["_ts"] - current["_start"], 1))
            episodes.append(current)
            current = None
    if current is not None:
        episodes.append(current)
    for ep in episodes:
        ep.pop("_start", None)
    return {"episodes": episodes, "summary": _summary(episodes, entries)}


def _summary(episodes, entries):
    done = [e["pause_s"] for e in episodes if e["pause_s"] is not None]
    by_day, reasons, offenders = {}, {}, {}
    for ep in episodes:
        day = by_day.setdefault(ep["start"][:10], {"day": ep["start"][:10], "episodes": 0, "paused_s": 0, "peak_level": "tight"})
        day["episodes"] += 1
        day["paused_s"] = round(day["paused_s"] + (ep["pause_s"] or 0), 1)
        if LEVEL_RANK.get(ep["level"], 0) > LEVEL_RANK[day["peak_level"]]:
            day["peak_level"] = ep["level"]
        key = re.sub(r"\d+(\.\d+)?", "N", str(ep["reason"] or "(none)"))
        reasons[key] = reasons.get(key, 0) + 1
        for label in {p["label"] for p in ep["top"]}:
            sizes = [p.get("rss_mb") for p in ep["top"] if p["label"] == label and isinstance(p.get("rss_mb"), (int, float))]
            off = offenders.setdefault(label, {"label": label, "episodes": 0, "_sizes": []})
            off["episodes"] += 1
            off["_sizes"].extend(sizes)
    ranked = []
    for off in offenders.values():
        sizes = off.pop("_sizes")
        ranked.append(dict(off, share=round(off["episodes"] / len(episodes), 3), max_rss_mb=max(sizes, default=0), avg_rss_mb=round(sum(sizes) / len(sizes), 1) if sizes else 0))
    ranked.sort(key=lambda o: (-o["episodes"], -o["avg_rss_mb"]))
    available = [v for v in (_numbers_min(e, "available_mb") for e in entries) if v is not None]
    return {"episodes": len(episodes), "open": sum(1 for e in episodes if e["open"]), "total_pause_s": round(sum(done), 1), "longest_pause_s": max(done, default=0),
            "by_level": {lv: sum(1 for e in episodes if e["level"] == lv) for lv in LEVEL_RANK}, "refused_total": sum(e["refused"] for e in episodes),
            "min_available_mb": min(available, default=None), "reasons": [{"reason": r, "count": n} for r, n in sorted(reasons.items(), key=lambda kv: -kv[1])[:8]],
            "by_day": [by_day[d] for d in sorted(by_day)], "top_offenders": ranked[:10]}
