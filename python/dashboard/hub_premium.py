"""Set or clear premiumPriority on every unfinished piece of a hub (HUB0789 1/4).

The hub's piece list is `subTasks` (each entry a dict with an `id`). Finished pieces are left alone and
reported through `on_skip`. Missing pieces are reported in `missing_ids`. Only pieces whose value actually
changes are written. Storage is injected through `find_piece` and `write_piece`, so this module does no file
I/O and adds no timers or polling.

FINISHED_STATUSES is taken from the terminal statuses that test_hub_summary.py treats as good (merged,
noop, dismissed, superseded) plus done/closed/archived. Confirm this set against coordinator-sweep.js before
relying on it.
"""

FINISHED_STATUSES = frozenset({"done", "closed", "archived", "merged", "noop", "dismissed", "superseded"})


def set_hub_premium(hub, enabled, find_piece, write_piece, now_iso, *, on_skip=None):
    """Return (changed_ids, missing_ids).

    enabled=True sets premiumPriority to now_iso on unfinished pieces that have no value yet (an existing
    timestamp is kept). enabled=False clears it to None on unfinished pieces that have a value.
    """
    changed_ids = []
    missing_ids = []
    for entry in hub.get("subTasks") or []:
        piece_id = entry.get("id") if isinstance(entry, dict) else entry
        piece = find_piece(piece_id)
        if piece is None:
            missing_ids.append(piece_id)
            continue
        status = piece.get("status")
        if status in FINISHED_STATUSES:
            if on_skip is not None:
                on_skip(piece_id, status)
            continue
        current = piece.get("premiumPriority")
        if enabled:
            if current:
                continue
            piece["premiumPriority"] = now_iso
        else:
            if current is None:
                continue
            piece["premiumPriority"] = None
        write_piece(piece)
        changed_ids.append(piece_id)
    return changed_ids, missing_ids
