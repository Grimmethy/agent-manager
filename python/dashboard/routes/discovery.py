from flask import Blueprint, jsonify

import logging
import re

# The app.py helpers these views call (QUEUE_STATES, arch_candidates_path, community_coverage_path, parse_arch_candidates, queue_dir, read_json_safe) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

discovery_bp = Blueprint("discovery-bp", __name__)

@discovery_bp.route("/api/discovery")
def api_discovery():
    """Everything the Discovery tab shows in one call: arch_discovery's community
    coverage (what the job is working through), every arch-discovery task currently in
    the queue (including done/ -- located by the filename convention
    'arch-discovery-community-<id>.json' rather than reading all ~4k done files, the
    exact trap api_adhoc_tasks' includeDone comment documents), and the AC-N candidate
    entries the job has produced so far."""
    from app import QUEUE_STATES, arch_candidates_path, community_coverage_path, parse_arch_candidates, queue_dir, read_json_safe
    result = {
        "available": False,
        "communities": [],
        "nextCommunityId": None,
        "tasks": [],
        "candidates": [],
        "candidatesPath": None,
    }

    coverage_file = community_coverage_path()
    coverage = read_json_safe(coverage_file) if coverage_file else None
    if coverage and isinstance(coverage.get("communities"), list):
        result["available"] = True
        result["communities"] = [
            {
                "id": c.get("id"),
                "name": c.get("name"),
                "lastReviewedAt": c.get("lastReviewedAt"),
                "lastCandidateCount": c.get("lastCandidateCount"),
            }
            for c in coverage["communities"]
        ]

    qdir = queue_dir()
    in_flight_by_community = {}
    if qdir:
        found = []  # (state, path) pairs; filename IS the task id for these
        drafting_root = qdir / "drafting"
        if drafting_root.is_dir():
            for f in drafting_root.rglob("arch-discovery-*.json"):
                found.append(("drafting", f))
        for state in QUEUE_STATES:
            state_dir = qdir / state
            if state_dir.is_dir():
                for f in state_dir.glob("arch-discovery-*.json"):
                    found.append((state, f))
        for state, f in found:
            data = read_json_safe(f)
            if not data:
                continue
            task_id = data.get("id", f.stem)
            community_id = None
            m = re.match(r"arch-discovery-community-(\d+)$", task_id)
            if m:
                community_id = int(m.group(1))
                if state not in ("done",):
                    in_flight_by_community[community_id] = state
            result["available"] = True
            result["tasks"].append({
                "id": task_id,
                "title": data.get("title") or task_id,
                "state": state,
                "communityId": community_id,
                "createdAt": data.get("createdAt"),
                "draftedAt": data.get("draftedAt"),
                "appliedAt": data.get("appliedAt"),
                "doneMarker": data.get("doneMarker"),
                "blockedReason": data.get("blockedReason"),
                "localRejectCount": data.get("localRejectCount", data.get("ornithRejectCount")),
                # Cheap "is there anything to read yet" signals for the list view --
                # the click-through detail modal (api_task_anywhere) carries the full
                # readouts, same split task_summary() uses.
                "hasPlan": bool(data.get("planResponse")),
                "hasImplement": bool((data.get("implementResponse") or "").strip()),
            })
        result["tasks"].sort(key=lambda t: t.get("createdAt") or "", reverse=True)

    # Which community nextArchDiscoveryTask() would pick next: oldest lastReviewedAt
    # first (never-reviewed sorts before any real timestamp), skipping communities that
    # already have a non-done task in the queue -- same rule as the Node side.
    eligible = [
        c for c in result["communities"]
        if c.get("id") is not None and c["id"] not in in_flight_by_community
    ]
    if eligible:
        eligible.sort(key=lambda c: c.get("lastReviewedAt") or "")
        result["nextCommunityId"] = eligible[0]["id"]
    for c in result["communities"]:
        c["inFlightState"] = in_flight_by_community.get(c.get("id"))

    cand_file = arch_candidates_path()
    if cand_file and cand_file.is_file():
        try:
            text = cand_file.read_text(encoding="utf-8", errors="replace")
            result["candidates"] = parse_arch_candidates(text)
            result["candidatesPath"] = str(cand_file)
            result["available"] = True
        except OSError as exc:
            logging.getLogger(__name__).warning("Failed to load arch candidates from %s: %s", cand_file, exc, exc_info=exc)

    return jsonify(result)
