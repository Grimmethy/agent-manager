"""Stall counters for the pipeline status panel.

Tracks how many times each stall-related event occurs: hub retirement, hub
restoration, piece escalation, needs-clarification resolution (by path), and
blocked reroute. Counters are in-memory and persist across requests via the
module-level dict. A future enhancement could add persistence to a file or
database.

Exported functions:
  increment_hub_retire()
  increment_hub_restore()
  increment_piece_escalate()
  increment_nc_resolve()
  increment_nc_readmit()
  increment_nc_owner()
  increment_blocked_reroute()
  get_counts() -> dict
"""

_counts = {
    "hub_retire": 0,
    "hub_restore": 0,
    "piece_escalate": 0,
    "nc_resolve": 0,
    "nc_readmit": 0,
    "nc_owner": 0,
    "blocked_reroute": 0,
}


def increment_hub_retire():
    """Increment the hub retirement counter."""
    _counts["hub_retire"] += 1


def increment_hub_restore():
    """Increment the hub restoration counter."""
    _counts["hub_restore"] += 1


def increment_piece_escalate():
    """Increment the piece escalation counter."""
    _counts["piece_escalate"] += 1


def increment_nc_resolve():
    """Increment the needs-clarification resolution (bot) counter."""
    _counts["nc_resolve"] += 1


def increment_nc_readmit():
    """Increment the needs-clarification re-admission counter."""
    _counts["nc_readmit"] += 1


def increment_nc_owner():
    """Increment the needs-clarification resolution (owner) counter."""
    _counts["nc_owner"] += 1


def increment_blocked_reroute():
    """Increment the blocked reroute counter."""
    _counts["blocked_reroute"] += 1


def get_counts():
    """Return a copy of the current counts dict."""
    return dict(_counts)
