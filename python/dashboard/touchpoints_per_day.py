"""Owner touchpoints per day (HUB0361 piece 2).

Pure function over requeue_causes rows. Only requeues carry an actor today, so only
operator-manual requeues are counted; every other operator action is reported as not
countable yet with the gap in docs/design-notes/owner-touchpoints.md that blocks it.
"""
from datetime import datetime, timedelta, timezone

COUNTED_ACTOR = "operator-manual"

NOT_COUNTABLE = [
    {"action": "merge", "gap": "gap 1: ledger actor is the constant dashboard-merge"},
    {"action": "discard", "gap": "gap 1: ledger actor is the constant dashboard-discard"},
    {"action": "verdict", "gap": "gap 6: source is caller-declared and defaults to manual"},
    {"action": "retire / archive / apply / early hub merge / brain-dump prioritize",
     "gap": "gap 4: no caller recorded"},
]


def touchpoints_per_day(rows, days=14, now=None):
    """rows: iterable of (actor, at_iso). Returns {"days": [{"date", "requeues"}], "notCountable": [...]}.

    One entry per calendar day (UTC) of the window, oldest first, zero-filled.
    A missing actor counts as pipeline-mechanism, as in the dashboard's ghost telemetry.
    """
    now = now or datetime.now(timezone.utc)
    today = now.date()
    dates = [(today - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    counts = {d: 0 for d in dates}
    for actor, at in rows:
        if (actor or "pipeline-mechanism") != COUNTED_ACTOR:
            continue
        day = (at or "")[:10]
        if day in counts:
            counts[day] += 1
    return {
        "days": [{"date": d, "requeues": counts[d]} for d in dates],
        "notCountable": [dict(n) for n in NOT_COUNTABLE],
    }
