from flask import Blueprint, abort, jsonify, request

import socket
import json
from pathlib import Path
import os
import string

# The app.py helpers these views call (BRAIN_DUMP_NEEDS_ATTENTION_STATES, QUEUE_STATES, _NEEDS_CLARIFICATION_REASON_TEXT, _adhoc_task_excerpt, _brain_dump_entries_with_task_status, _brain_dump_needs_attention_count, _fire_alert_webhook, _is_real_ship, _scan_recently_completed_tasks, alerts_path, list_unmerged_branches, logger, queue_dir, read_json_safe, read_project_history, task_summary) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

shared_misc_bp = Blueprint("shared-misc-bp", __name__)

@shared_misc_bp.route("/api/ping")
def api_ping():
    # Identity endpoint for the companion app's server-list health check. Shape mirrors
    # TheAgent's /api/ping ({app, name, version}) so one client convention covers both.
    return jsonify({"app": "agent-manager", "name": socket.gethostname(), "version": "1"})


@shared_misc_bp.route("/api/alerts")
def api_alerts():
    """Companion app's notification-bell feed (Android: AlertPoller.kt polls this every
    ~15 min while a machine's bell is on). Surfaces exactly the "needs a human" states
    the dashboard's own nav badges already flag -- blocked/needs-clarification/
    awaiting-confirm queue tasks, plus a stuck-actioned Brain Dump entry
    (BRAIN_DUMP_NEEDS_ATTENTION_STATES, the same set _brain_dump_needs_attention_count
    already uses) -- as individually-id'd alerts.

    Always returns the CURRENT full set, not a delta: the client already owns
    de-duplication and backlog suppression (a freshly-linked machine swallows existing
    history silently, only notifies from the next genuinely-new id onward -- see
    AlertPoller.pollAll's own comment), so this endpoint just needs to be an honest,
    stable-id snapshot of what's actually outstanding right now. Read-only, never gated
    (see lan_mutation_gate above -- GET is always ungated regardless of caller)."""
    from app import BRAIN_DUMP_NEEDS_ATTENTION_STATES, _NEEDS_CLARIFICATION_REASON_TEXT, _brain_dump_entries_with_task_status, _fire_alert_webhook, alerts_path, logger, queue_dir, read_json_safe
    alerts = []
    qdir = queue_dir()
    if qdir:
        for state, level in (
            ("blocked", "error"),
            ("needs-clarification", "warn"),
            ("awaiting-confirm", "error"),
        ):
            state_dir = qdir / state
            if not state_dir.is_dir():
                continue
            for f in state_dir.glob("*.json"):
                data = read_json_safe(f)
                if not data:
                    continue
                task_id = data.get("id", f.stem)
                title = (data.get("title") or task_id)[:120]
                if state == "blocked":
                    body = data.get("blockedReason") or "Blocked -- see dashboard for details."
                elif state == "needs-clarification":
                    reason = (data.get("needsClarification") or {}).get("reason")
                    body = _NEEDS_CLARIFICATION_REASON_TEXT.get(
                        reason, "Needs clarification -- see dashboard for details.")
                elif data.get("source") == "pipeline_forensics":
                    body = "Forensic root-cause report ready -- review it, then Confirm to file a pipeline-fix candidate."
                else:
                    body = "A delete-containing change is held for confirmation."
                alerts.append({
                    "id": f"task:{state}:{task_id}",
                    "title": title,
                    "level": level,
                    "body": body[:200],
                })

    for e in _brain_dump_entries_with_task_status():
        if e.get("status") == "actioned" and e.get("taskStatus") in BRAIN_DUMP_NEEDS_ATTENTION_STATES:
            entry_id = e.get("id")
            if not entry_id:
                continue
            alerts.append({
                "id": f"brain-dump:{entry_id}",
                "title": (e.get("rawText") or "Brain dump entry")[:120],
                "level": "warn",
                "body": f"Actioned entry's task is {e.get('taskStatus')} -- needs a look.",
            })

    # National-backfill event feed (progress-report.js writes alerts.json; see
    # alerts_path()). Was its own duplicate @app.route("/api/alerts") definition after
    # the 2026-08-22 master merge landed both this queue-derived feed (2c66a17) and the
    # file-based one (6de654c) -- Flask refuses to even start with two routes on one
    # rule, so the two sources are merged into this single endpoint instead. File
    # entries already carry their own stable ids ({id, at, level, title, body}), so the
    # client's id-based dedupe works unchanged across both sources.
    generated_at = None
    p = alerts_path()
    if p and p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            generated_at = data.get("generatedAt")
            alerts.extend(data.get("alerts") or [])
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Alert feed read failed: %s (%s)", p, exc)
        except Exception:
            logger.exception("Alert feed read failed unexpectedly: %s", p)

    # Webhook notification side-effect (see _fire_alert_webhook): fires for alerts not
    # seen on the previous call. No-op unless AGENT_MANAGER_ALERT_WEBHOOK_URL is set;
    # it never raises by contract, this guard is belt-and-suspenders so the feed itself
    # can't 500 over a notification bug.
    try:
        _fire_alert_webhook(alerts)
    except Exception:
        logger.exception("Alert webhook side-effect failed")

    return jsonify({"generatedAt": generated_at, "alerts": alerts})


@shared_misc_bp.route("/api/tasks/completed")
def api_tasks_completed():
    """Global 'all tasks completed' log across every instance, for the Workers tab
    (2026-09-08, Grimmethy: "an in-app representation of that all tasks completed log
    under the workers... only loads the most recent 25 tasks until I scroll to the
    bottom"). Cursor-paginated via _scan_recently_completed_tasks -- see that function's
    own header for why this reads real task history rather than model_calls."""
    from app import _scan_recently_completed_tasks
    limit = min(max(request.args.get("limit", 25, type=int) or 25, 1), 100)
    before = request.args.get("before")
    rows, next_cursor = _scan_recently_completed_tasks(limit, before_iso=before)
    return jsonify({"tasks": rows, "nextCursor": next_cursor})


@shared_misc_bp.route("/api/queue/<state>")
def api_queue_state(state):
    """Returns {items: [...], total: N}. Incremental loading (2026-07-26, Grimmethy:
    "long task lists take a while to load"): optional ?limit=N&offset=M page the result --
    file METADATA is sorted first (cheap, no content read) and only the requested slice
    ever gets read_json_safe'd, so a 200+-item done/ folder no longer means reading and
    JSON-parsing every single file on every 5s poll, just the page actually being shown."""
    from app import QUEUE_STATES, queue_dir, read_json_safe, task_summary
    qdir = queue_dir()
    if not qdir:
        return jsonify({"items": [], "total": 0})

    if state == "drafting":
        # Never paginated -- an in-flight claim count is always small (bounded by worker
        # count), nothing like done/'s unbounded historical backlog.
        entries = []
        drafting_root = qdir / "drafting"
        if drafting_root.is_dir():
            for sub in drafting_root.iterdir():
                if not sub.is_dir():
                    continue
                for f in sub.glob("*.json"):
                    data = read_json_safe(f)
                    if data:
                        s = task_summary(data, f.stem)
                        s["claimedBy"] = sub.name
                        entries.append(s)
            for f in drafting_root.glob("*.json"):  # legacy: no subfolder
                data = read_json_safe(f)
                if data:
                    entries.append(task_summary(data, f.stem))
        return jsonify({"items": entries, "total": len(entries)})

    if state not in QUEUE_STATES:
        abort(404)

    limit = request.args.get("limit", type=int)
    offset = request.args.get("offset", default=0, type=int)
    source_filter = (request.args.get("source") or "").strip()

    if state == "coordinating":
        # Never paginated before ordering -- hub counts are small (same "in-flight, bounded"
        # reasoning the drafting branch above already uses), and a family tree can only be
        # built correctly with every hub in hand at once. Builds a parent->children map on
        # `parentHub` (see decompose-loop-autoroute.js / apply-task.js's recordApplyOutcome)
        # and walks it pre-order so a child always renders immediately beneath its parent,
        # tagging `hubDepth` for the frontend's indent -- then pages the flattened result.
        state_dir = qdir / "coordinating"
        by_id = {}
        if state_dir.is_dir():
            for f in state_dir.glob("*.json"):
                data = read_json_safe(f)
                if data and (not source_filter or data.get("source") == source_filter):
                    by_id[data.get("id", f.stem)] = task_summary(data, f.stem)
        explicit_parent = {}
        for tid, entry in by_id.items():
            parent = entry.get("parentHub")
            # A dangling/self/foreign parentHub (parent not among today's coordinating
            # records -- already resolved and moved on, or a cycle) is not used.
            if parent and parent in by_id and parent != tid:
                explicit_parent[tid] = parent
        # Fallback: a hub id sitting in another hub's subTasks[] is ALSO a real parent link
        # -- rewireCoordinatorParent() (src/decompose-loop-autoroute.js) has rewritten
        # subTasks entries to point at a rescuing hub since before `parentHub` existed
        # (2026-09-08), so real families already live in the data this way with no backfill
        # needed; explicit `parentHub` wins when both are present.
        derived_parent = {}
        for tid, entry in by_id.items():
            for st in entry.get("subTasks") or []:
                sid = st.get("id") if isinstance(st, dict) else None
                if sid and sid in by_id and sid != tid:
                    derived_parent.setdefault(sid, tid)

        children_of = {}
        for tid in by_id:
            parent = explicit_parent.get(tid) or derived_parent.get(tid)
            children_of.setdefault(parent, []).append(tid)
        for kids in children_of.values():
            kids.sort(key=lambda tid: by_id[tid].get("createdAt") or "", reverse=True)

        # Root-hub ordering (2026-09-09, Grimmethy: "I'd like the hubs to be sortable
        # either alphabetically by name or by priority ... The highest priority hub should
        # always be worked on next"). Only the ROOT list is reordered -- each family's
        # subtree keeps its newest-first child order from the loop above, so families stay
        # contiguous. `sort=priority` (default): explicit `hubPriority` ascending (LOWER =
        # more urgent), then unranked hubs oldest-first by createdAt (FIFO -- the direct
        # answer to "new hubs being worked before old hubs are finished"). `sort=name`:
        # case-insensitive by title. The same rule the worker claim path uses for this
        # hub's children (src/hub-priority.js), so the tab shows the real work order.
        sort_mode = (request.args.get("sort") or "priority").strip().lower()
        roots = children_of.get(None, [])
        if sort_mode == "name":
            roots.sort(key=lambda tid: (by_id[tid].get("title") or tid).casefold())
        else:
            def _root_key(tid):
                hp = by_id[tid].get("hubPriority")
                rank = hp if isinstance(hp, (int, float)) and not isinstance(hp, bool) else float("inf")
                return (rank, by_id[tid].get("createdAt") or "￿")
            roots.sort(key=_root_key)
        children_of[None] = roots

        ordered = []
        visited = set()

        def walk(tid, depth, family_label):
            if tid in visited:
                return
            visited.add(tid)
            entry = dict(by_id[tid])
            entry["hubDepth"] = depth
            # hubFamily: the topmost hub's own title, carried onto every descendant so the
            # frontend can render a family-header row even on a page that doesn't include
            # the root itself.
            entry["hubFamily"] = family_label if depth > 0 else entry.get("title") or tid
            ordered.append(entry)
            for child_id in children_of.get(tid, []):
                walk(child_id, depth + 1, entry["hubFamily"])

        for root_id in children_of.get(None, []):
            walk(root_id, 0, None)
        # Any hub left unvisited only happens via a parentHub cycle -- append as a root so
        # it still shows up instead of disappearing.
        for tid in by_id:
            if tid not in visited:
                walk(tid, 0, None)

        total = len(ordered)
        page = ordered[offset:offset + limit] if limit is not None else ordered[offset:]
        return jsonify({"items": page, "total": total})

    entries = []
    total = 0
    state_dir = qdir / state
    if state_dir.is_dir():
        files = sorted(state_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        if source_filter:
            # Filtering by task type (Job Status > Done tab, 2026-08-17: "Done is getting
            # huge, need to filter by task type") needs each file's own `source` field --
            # unlike sorting, that's not derivable from the filename/mtime alone, so this
            # reads every file in the state dir instead of just the requested page. Only
            # pays that cost when a filter is actually selected; the default unfiltered
            # request below keeps the cheap stat-only-sort-then-page-only-read behavior.
            filtered = []
            for f in files:
                data = read_json_safe(f)
                if data and data.get("source") == source_filter:
                    filtered.append((f, data))
            total = len(filtered)
            page = filtered[offset:offset + limit] if limit is not None else filtered[offset:]
            entries = [task_summary(data, f.stem) for f, data in page]
        else:
            total = len(files)
            page = files[offset:offset + limit] if limit is not None else files[offset:]
            for f in page:
                data = read_json_safe(f)
                if data:
                    entries.append(task_summary(data, f.stem))
    return jsonify({"items": entries, "total": total})


@shared_misc_bp.route("/api/adhoc-tasks")
def api_adhoc_tasks():
    """Every domain:'adhoc' task across the whole pipeline, in one flat list, with
    whichever queue state it's currently sitting in -- the cross-cutting view
    api_task_anywhere already has the right traversal shape for (drafting/ first,
    per-instance, then every other QUEUE_STATES dir), generalized here from 'find one
    task by id' to 'collect every adhoc task found along the way'. Also checks
    queue/adhoc/ itself, the one real state api_task_anywhere never had to check --
    task-sources.js's own nextAdhocTask() reads directly from there, before a claimed
    task ever reaches pending/, so a task sitting there unclaimed would otherwise be
    invisible to this view.

    An 'adhoc' task is identified by domain=='adhoc' OR an id starting with 'adhoc-'
    (queue-adhoc-task.js's own id convention, also used by the Brain Dump tab's
    'Process Now' button injection) -- domain alone isn't reliable since a caller can
    omit --domain (queue-adhoc-task.js then falls back to the first key in
    task-domains.json, not necessarily 'adhoc').

    done/ is SKIPPED by default (?includeDone=1 opts in) -- confirmed live 2026-08-22
    this endpoint was timing out (reported "timed out after 8s" from the dashboard
    itself) once queue/done/ grew to ~3900 files: reading+parsing every one of them on
    every single poll of this tab, on Flask's single-threaded dev server, starved
    concurrent requests (nav badge polling, other tabs, the phone app) regardless of
    how fast any one request actually was in isolation. done/ tasks aren't what this
    view exists to track anyway -- the whole point is active (in-progress) and stuck
    (blocked) work, both already excluded from that giant folder."""
    from app import QUEUE_STATES, _adhoc_task_excerpt, queue_dir, read_json_safe
    qdir = queue_dir()
    if not qdir:
        return jsonify({"tasks": []})
    include_done = request.args.get("includeDone") == "1"

    def is_adhoc(data, task_id):
        return data.get("domain") == "adhoc" or task_id.startswith("adhoc-")

    # dependsOn visibility (2026-08-22, Grimmethy: "systematic way to prioritize what
    # order adhoc tasks get completed in") -- mirrors task-sources.js's own
    # isDependencySatisfied() exactly (satisfied only once mergedAt is stamped on the
    # dependency's queue/done/ record, not just done -- see that function's comment for
    # why reaching done/ alone isn't enough), so a human looking at this list sees the
    # SAME "is this actually unblocked" answer the claim logic itself uses.
    def dependency_status(depends_on):
        if not depends_on:
            return None
        out = []
        for dep_id in depends_on:
            satisfied = False
            for candidate in (qdir / "done" / f"{dep_id}.json", qdir / "done" / "_archived_no_action" / f"{dep_id}.json"):
                dep_data = read_json_safe(candidate)
                if dep_data and dep_data.get("mergedAt"):
                    satisfied = True
                    break
            out.append({"id": dep_id, "satisfied": satisfied})
        return out

    def task_row(data, task_id, state):
        return {
            "id": task_id,
            "title": data.get("title") or task_id,
            "state": state,
            "createdAt": data.get("createdAt"),
            "excerpt": _adhoc_task_excerpt(data),
            "dependsOn": dependency_status(data.get("dependsOn")),
        }

    tasks = []

    adhoc_dir = qdir / "adhoc"
    if adhoc_dir.is_dir():
        for f in adhoc_dir.glob("*.json"):
            data = read_json_safe(f)
            if data and is_adhoc(data, f.stem):
                tasks.append(task_row(data, data.get("id", f.stem), "adhoc"))

    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        for f in drafting_root.rglob("*.json"):
            data = read_json_safe(f)
            if not data:
                continue
            task_id = data.get("id", f.stem)
            if not is_adhoc(data, task_id):
                continue
            tasks.append(task_row(data, task_id, f"drafting:{f.parent.name}"))

    for state in QUEUE_STATES:
        if state == "done" and not include_done:
            continue
        state_dir = qdir / state
        if not state_dir.is_dir():
            continue
        for f in state_dir.glob("*.json"):
            data = read_json_safe(f)
            if not data:
                continue
            task_id = data.get("id", f.stem)
            if not is_adhoc(data, task_id):
                continue
            tasks.append(task_row(data, task_id, state))

    tasks.sort(key=lambda t: t.get("createdAt") or "", reverse=True)
    return jsonify({"tasks": tasks})


@shared_misc_bp.route("/api/summary")
def api_summary():
    from app import QUEUE_STATES, _brain_dump_entries_with_task_status, _brain_dump_needs_attention_count, _is_real_ship, list_unmerged_branches, queue_dir, read_json_safe
    qdir = queue_dir()
    counts = {s: 0 for s in QUEUE_STATES}
    counts["drafting"] = 0
    bd_entries = _brain_dump_entries_with_task_status()
    # Split human notes from machine-raised findings (2026-09-14: Brain Dump tab went
    # human-only, everything with a `raisedBy` moved to Filed Findings -- see
    # routes/brain_dump.py's _filtered_brain_dump_view for the full reasoning) so each
    # nav badge counts only its own half.
    human_bd_entries = [e for e in bd_entries if not e.get("raisedBy")]
    filed_entries = [e for e in bd_entries if e.get("raisedBy")]
    # Unprocessed (captured/sorted) PLUS actioned-but-stuck -- see
    # BRAIN_DUMP_NEEDS_ATTENTION_STATES's own header for why the latter half exists: a
    # stuck-actioned entry previously gave zero nav-level signal at all.
    counts["brain-dump"] = (
        sum(1 for e in human_bd_entries if e.get("status") != "actioned")
        + _brain_dump_needs_attention_count(human_bd_entries)
    )
    counts["filed"] = (
        sum(1 for e in filed_entries if e.get("status") != "actioned")
        + _brain_dump_needs_attention_count(filed_entries)
    )
    # Cached (list_unmerged_branches(force=False)) -- this route is polled every 5s by
    # the nav badge cycle, and a live `git fetch` on every single poll would be both slow
    # and needlessly hammer the remote. The dedicated /api/git/unmerged-branches route
    # (used when the tab is actually open) always forces a fresh fetch instead.
    counts["branches"] = len(list_unmerged_branches(force=False))
    if not qdir:
        return jsonify(counts)

    for state in QUEUE_STATES:
        state_dir = qdir / state
        counts[state] = len(list(state_dir.glob("*.json"))) if state_dir.is_dir() else 0
    # "Done" headline split (2026-08-25, "24 of 25 'shipped' tasks produced zero
    # code"): a raw queue/done/ count treats no-ops -- 0-char drafts closed by
    # deterministic-empty-approve or a 3/3 vote on nothing -- as shipped, so the
    # effective ship rate reads 25/25 when it is really 1/25. doneShipped only counts
    # records _is_real_ship() says actually merged code; doneNoop is the rest, so a
    # consumer can show BOTH numbers instead of one misleading "completed" total.
    done_dir = qdir / "done"
    shipped = noop = 0
    if done_dir.is_dir():
        for f in done_dir.glob("*.json"):
            rec = read_json_safe(f)
            if isinstance(rec, dict) and _is_real_ship(rec):
                shipped += 1
            else:
                noop += 1
    counts["doneShipped"] = shipped
    counts["doneNoop"] = noop
    drafting_root = qdir / "drafting"
    if drafting_root.is_dir():
        counts["drafting"] = len(list(drafting_root.rglob("*.json")))
    # Adhoc Tasks nav badge: two separate counts, not one folded-together number
    # (Grimmethy, 2026-08-22: "It's just as important to know how many in process there
    # are so that we know how much work the system already has to work on" -- the badge
    # used to be JUST the awaiting-confirm count, which read as a flat "0" any time
    # nothing needed a confirm click even while real work was actively blocked or
    # in flight, exactly the "inaccurately showing 0" complaint this replaces).
    # adhocBlocked: blocked + needs-clarification + awaiting-confirm -- every state that
    # means a human's attention is the thing standing between this task and progress,
    # same states api_task_archive() already treats as one bucket for that reason.
    # adhocInProgress: everything else still moving on its own (queue/adhoc/ itself,
    # unclaimed; pending; drafting; review; approved) -- not a problem, just backlog size.
    def is_adhoc_record(data, task_id):
        return data.get("domain") == "adhoc" or task_id.startswith("adhoc-")

    def count_adhoc_in(dir_path):
        if not dir_path.is_dir():
            return 0
        n = 0
        for f in dir_path.glob("*.json"):
            data = read_json_safe(f)
            if data and is_adhoc_record(data, data.get("id", f.stem)):
                n += 1
        return n

    adhoc_blocked = sum(count_adhoc_in(qdir / s) for s in ("blocked", "needs-clarification", "awaiting-confirm"))
    adhoc_in_progress = sum(count_adhoc_in(qdir / s) for s in ("pending", "review", "approved")) \
        + count_adhoc_in(qdir / "adhoc")
    if drafting_root.is_dir():
        for f in drafting_root.rglob("*.json"):
            data = read_json_safe(f)
            if data and is_adhoc_record(data, data.get("id", f.stem)):
                adhoc_in_progress += 1
    counts["adhocBlocked"] = adhoc_blocked
    counts["adhocInProgress"] = adhoc_in_progress
    return jsonify(counts)


@shared_misc_bp.route("/api/browse")
def api_browse():
    """Lists immediate subdirectories of the given path, for the Project tab's folder
    browser. No path -> lists drive letters (Windows) as browsing roots. Permission
    errors on individual entries are skipped, not fatal -- a locked system folder
    shouldn't break browsing everything else alongside it."""
    raw_path = request.args.get("path", "").strip()

    if not raw_path:
        if os.name == "nt":
            drives = [f"{letter}:\\" for letter in string.ascii_uppercase if Path(f"{letter}:\\").exists()]
            return jsonify({"path": "", "parent": None, "entries": [{"name": d, "path": d, "isDir": True, "isGitRepo": False} for d in drives]})
        raw_path = "/"

    path = Path(raw_path)
    if not path.is_dir():
        abort(404)

    entries = []
    try:
        for child in sorted(path.iterdir(), key=lambda p: p.name.lower()):
            try:
                if child.is_dir():
                    entries.append({
                        "name": child.name,
                        "path": str(child),
                        "isDir": True,
                        "isGitRepo": (child / ".git").exists(),
                    })
            except (PermissionError, OSError):
                continue
    except (PermissionError, OSError) as e:
        abort(403, description=str(e))

    parent = str(path.parent) if path.parent != path else None
    return jsonify({"path": str(path), "parent": parent, "entries": entries})


@shared_misc_bp.route("/api/projects/history")
def api_projects_history():
    """Backs the Project tab's dropdown/search of previously-loaded projects. Paths that
    no longer exist on disk are still returned (a project on an unplugged drive, or one
    you're about to reconnect, is still worth remembering) -- filtering happens client-
    side if wanted, this endpoint is just the raw history."""
    from app import read_project_history
    return jsonify({"projects": read_project_history()})
