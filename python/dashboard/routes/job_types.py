from flask import Blueprint, abort, jsonify, request

import json
import os
import subprocess

# The app.py helpers these views call (ALWAYS_ACTIVE_SOURCES, ENV_FILE_PATH, SOURCE_DESCRIPTIONS, SOURCE_DOMAIN_LABELS, SRC_DIR, VALID_APPROVAL_MODES, VALID_WORKER_TYPES, _SOURCE_TO_DOMAIN_KEY, _default_approval_mode, _job_log_outcome, _job_log_row_when, _job_log_task_dirs, _pipeline_live_counts, _pipeline_running, _resolve_source_name, _restart_pipeline, _task_cost_summary, available_candidate_counts, job_type_counters_path, queue_dir, read_active_job_types, read_approval_modes, read_env_file, read_job_type_counters, read_json_safe, read_task_priorities, read_worker_types, task_source_catalog, task_source_default_priorities, task_source_default_worker_types, task_source_families, task_source_family_label, task_source_family_of, write_env_value) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

job_types_bp = Blueprint("job-types-bp", __name__)

@job_types_bp.route("/api/pipeline-map")
def api_pipeline_map():
    """Pipeline Map tab (2026-08-26, Grimmethy: "I want a live pipeline map for
    architecture review... right now I don't have any way of visualizing the process").
    Topology comes straight from src/task-sources.js's own registry via `--dump-topology`
    (see that CLI mode's own header for why this, not another hand-maintained catalog like
    TASK_SOURCE_CATALOG below) -- read fresh on every call, so it can never drift the way
    the Job List tab's own hand-maintained lists already have (confirmed live via
    queue-watchdog's drift-scan the same night: missing backlog_decomposition/
    backlog_fulfillment/pipeline_health_audit/product_spec/ui_visibility_audit). Live counts
    come straight from the real queue/ directories, correlated by each task's own recorded
    `source` field -- never estimated, never cached across requests."""
    from app import ENV_FILE_PATH, SRC_DIR, _pipeline_live_counts, queue_dir, read_env_file
    script_path = SRC_DIR / "task-sources.js"
    # Same env the pipeline loops themselves get (agent-manager.env on top of os.environ):
    # --dump-topology needs AGENT_MANAGER_REPO_ROOT to run at all, and
    # AGENT_MANAGER_REGISTER_PATH so out-of-tree plugin sources (agent-manager-hygiene:
    # observability/performance/function-length/arch/unused-export) show up in the map,
    # not just this repo's built-ins. Also picks up any UI-set priority/allowlist overrides.
    child_env = {**os.environ, **read_env_file(ENV_FILE_PATH)}
    try:
        result = subprocess.run(
            ["node", str(script_path), "--dump-topology"],
            capture_output=True, text=True, timeout=15,
            cwd=str(SRC_DIR), env=child_env,
        )
    except subprocess.TimeoutExpired:
        return jsonify({"available": False, "reason": "task-sources.js --dump-topology timed out"}), 504
    if result.returncode != 0:
        return jsonify({"available": False, "reason": (result.stderr or "task-sources.js exited non-zero").strip()[:500]})
    try:
        topology = json.loads(result.stdout)
    except json.JSONDecodeError:
        return jsonify({"available": False, "reason": "task-sources.js --dump-topology returned non-JSON output"})

    live_counts = _pipeline_live_counts(queue_dir())
    # turnsStats (2026-08-26, Grimmethy: "add turnsUsed recording... a data point we
    # track for each job type in the Job List itself (min/max/average)") -- same
    # merge-by-source-name shape as liveCounts just below; None for any source that has
    # never recorded a real turnsUsed count (not instrumented, or a non-agentic source
    # that has no concept of "turns" at all), not a fabricated zero.
    from model_stats_client import get_turns_summary
    turns_by_source = {row["source"]: row for row in (get_turns_summary() or {}).get("bySource", [])}
    for source in topology:
        source["liveCounts"] = live_counts.pop(source["name"], {})
        source["turnsStats"] = turns_by_source.pop(source["name"], None)
    # Anything left in live_counts belongs to a source no longer registered (a renamed/
    # retired source with old tasks still sitting in the queue, or the "(unknown)" bucket
    # from a corrupt/pre-source-field file) -- surfaced separately rather than silently
    # dropped, so a real orphaned backlog stays visible instead of vanishing from the map.
    unregistered = [{"name": name, "liveCounts": c} for name, c in live_counts.items()]

    return jsonify({"available": True, "sources": topology, "unregistered": unregistered})


@job_types_bp.route("/api/job-types")
def api_job_types():
    """Job List tab's isActive checkboxes: one row per src/task-sources.js registered
    source, independent of whichever project is currently active -- same "sits above any
    single project" reasoning as Brain Dump. Backed entirely by AGENT_MANAGER_TASK_SOURCES
    in agent-manager.env, the same allowlist src/task-sources.js's getNextTask() already
    reads; this is just a UI over that one persisted value."""
    from app import ALWAYS_ACTIVE_SOURCES, SOURCE_DESCRIPTIONS, SOURCE_DOMAIN_LABELS, _SOURCE_TO_DOMAIN_KEY, available_candidate_counts, read_active_job_types, read_approval_modes, read_job_type_counters, read_task_priorities, read_worker_types, task_source_catalog, task_source_default_priorities, task_source_family_label, task_source_family_of
    active = read_active_job_types()
    priorities = read_task_priorities()
    default_priorities = task_source_default_priorities()
    approval_modes = read_approval_modes()
    worker_types = read_worker_types()
    counters = read_job_type_counters()
    available_counts = available_candidate_counts()
    family_of = task_source_family_of()
    return jsonify([
        {
            "name": name,
            "active": name in active,
            "alwaysActive": name in ALWAYS_ACTIVE_SOURCES,
            "priority": priorities.get(name),
            "defaultPriority": default_priorities.get(name),
            # Job List family grouping (UI only) -- null for a source that isn't in a
            # >=2-member family. See task_source_families().
            "family": family_of.get(name),
            "familyLabel": task_source_family_label(family_of[name]) if name in family_of else None,
            "approvalMode": approval_modes.get(name),
            "workerType": worker_types.get(name),
            "timesPerformed": counters.get(name, 0),
            # None (-> null) for a source with no enumerable backlog doc -- see
            # available_candidate_counts()'s own comment; the frontend renders that as a
            # blank cell rather than a misleading 0.
            "available": available_counts.get(name),
            "domain": SOURCE_DOMAIN_LABELS.get(_SOURCE_TO_DOMAIN_KEY.get(name, name), _SOURCE_TO_DOMAIN_KEY.get(name, name)),
            "description": SOURCE_DESCRIPTIONS.get(name, ""),
        }
        for name in task_source_catalog()
    ])


@job_types_bp.route("/api/job-log/<source>")
def api_job_log(source):
    """Job List tab: click a source -> its last ~25 runs, newest first, each drillable to
    the task-detail modal via /api/task-anywhere. Sweeps every queue state + drafting/ +
    adhoc/ + the archive buckets, matching on the same resolved source name the pipeline
    map uses."""
    from app import _job_log_outcome, _job_log_row_when, _job_log_task_dirs, _resolve_source_name, _task_cost_summary, queue_dir, read_json_safe
    qdir = queue_dir()
    if not qdir:
        abort(404)
    seen: set[str] = set()
    rows: list[dict] = []
    for state_label, d in _job_log_task_dirs(qdir):
        if not d or not d.is_dir():
            continue
        for f in d.glob("*.json"):
            if f.stem in seen:
                continue
            data = read_json_safe(f)
            if not data or _resolve_source_name(data) != source:
                continue
            seen.add(f.stem)
            cost = _task_cost_summary(f.stem)
            rows.append({
                "id": data.get("id") or f.stem,
                "title": (data.get("title") or "").strip(),
                "state": state_label,
                "at": _job_log_row_when(data),
                "outcome": _job_log_outcome(data),
                "latencyMs": cost.get("totalLatencyMs") if cost else None,
            })
    rows.sort(key=lambda r: r["at"] or "", reverse=True)
    return jsonify({"source": source, "total": len(rows), "runs": rows[:25]})


@job_types_bp.route("/api/job-types/reset-counts", methods=["POST"])
def api_job_types_reset_counts():
    """Job List tab's "Reset counts" button. Deliberately resets EVERY job type's counter
    at once, never a single row -- see src/job-type-counters.js's header for why a per-type
    reset would leave the counters meaning different things depending on when each was last
    zeroed, defeating the point of a shared baseline."""
    from app import job_type_counters_path, read_job_type_counters
    p = job_type_counters_path()
    if not p:
        abort(400, description="no active pipeline directory to reset counters in")
    counters = read_job_type_counters()
    for name in counters:
        counters[name] = 0
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(counters, indent=2), encoding="utf-8")
    except OSError as e:
        abort(500, description=f"failed to write job-type-counters.json: {e}")
    return jsonify({"ok": True})


@job_types_bp.route("/api/job-types/toggle", methods=["POST"])
def api_job_types_toggle():
    from app import ALWAYS_ACTIVE_SOURCES, ENV_FILE_PATH, _pipeline_running, _restart_pipeline, read_active_job_types, task_source_catalog, write_env_value
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    active = bool(body.get("active"))
    if name not in task_source_catalog():
        abort(400, description=f"unknown job type '{name}'")
    if name in ALWAYS_ACTIVE_SOURCES:
        abort(400, description=f"'{name}' is always active and cannot be toggled off")

    current = read_active_job_types()
    if active:
        current.add(name)
    else:
        current.discard(name)

    # Collapse back to "unrestricted" (empty string) when every source ends up active --
    # an explicit list naming all of TASK_SOURCE_CATALOG means exactly the same thing as
    # no list at all, and staying in that tidy round-trip avoids the allowlist silently
    # drifting out of sync if TASK_SOURCE_CATALOG ever gains a new entry later.
    if current == set(task_source_catalog()):
        new_value = ""
    else:
        new_value = ",".join(sorted(current - ALWAYS_ACTIVE_SOURCES))
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_TASK_SOURCES", new_value)

    # Take effect immediately, not just on the run's next manual restart -- the whole
    # point of moving this into a live checkbox instead of a config file edit is that
    # flipping it actually changes what the running pipeline does. Filesystem-queue-based
    # crash-resume (ornith-worker.ps1's orphaned-claim recovery) already makes this safe.
    restarted = False
    if _pipeline_running():
        _restart_pipeline()
        restarted = True

    return jsonify({"name": name, "active": active, "restarted": restarted})


@job_types_bp.route("/api/job-types/priority", methods=["POST"])
def api_job_types_priority():
    """Job List tab's editable Priority column (click-to-type or +-1 arrow buttons).
    Mirrors api_job_types_toggle()'s exact shape -- persists to AGENT_MANAGER_TASK_PRIORITIES
    in agent-manager.env, which src/config.js's taskPriorityOverrides reads fresh on every
    `node task-sources.js` invocation (a new process each worker tick), so an edit here
    takes effect on the very next tick with no pipeline restart needed."""
    from app import ENV_FILE_PATH, read_task_priorities, task_source_catalog, task_source_default_priorities, write_env_value
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if name not in task_source_catalog():
        abort(400, description=f"unknown job type '{name}'")
    try:
        priority = int(body.get("priority"))
    except (TypeError, ValueError):
        abort(400, description="priority must be an integer")

    priorities = read_task_priorities()
    priorities[name] = priority

    # Collapse back to "no overrides" (empty string) when every source ends up at its own
    # default -- same tidy-round-trip reasoning as api_job_types_toggle()'s allowlist collapse.
    non_default = {n: p for n, p in priorities.items() if p != task_source_default_priorities().get(n)}
    new_value = ",".join(f"{n}:{p}" for n, p in sorted(non_default.items()))
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_TASK_PRIORITIES", new_value)

    return jsonify({"name": name, "priority": priority})


@job_types_bp.route("/api/job-types/priority-family", methods=["POST"])
def api_job_types_priority_family():
    """Job List tab's family-level Priority control. Shifts EVERY member of a source
    family (arch_discovery / arch_import / arch_review / arch_import_review, ...) by the
    same delta so `base` becomes the new lowest effective priority across the family,
    leaving the internal offsets -- which encode the deliberate consumer-outranks-generator
    ordering (70/71 vs 80/81 for arch) -- exactly as they were, manual per-row tweaks
    included. Writes all N member overrides to AGENT_MANAGER_TASK_PRIORITIES in one shot;
    a member that lands back on its registry default is dropped from the override string
    (same tidy round-trip as api_job_types_priority). Purely a convenience over that
    per-source endpoint -- nothing here the operator couldn't do by editing each row by
    hand. No pipeline restart: src/config.js's taskPriorityOverrides re-reads the env file
    on the next `node task-sources.js` tick."""
    from app import ENV_FILE_PATH, read_task_priorities, task_source_default_priorities, task_source_families, write_env_value
    body = request.get_json(silent=True) or {}
    family = (body.get("family") or "").strip()
    members = task_source_families().get(family)
    if not members:
        abort(400, description=f"unknown source family '{family}'")
    try:
        base = int(body.get("base"))
    except (TypeError, ValueError):
        abort(400, description="base must be an integer")

    priorities = read_task_priorities()  # every catalog source -> effective priority
    delta = base - min(priorities[m] for m in members)
    for m in members:
        priorities[m] = priorities[m] + delta

    defaults = task_source_default_priorities()
    non_default = {n: p for n, p in priorities.items() if p != defaults.get(n)}
    new_value = ",".join(f"{n}:{p}" for n, p in sorted(non_default.items()))
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_TASK_PRIORITIES", new_value)

    return jsonify({
        "family": family,
        "base": base,
        "members": {m: priorities[m] for m in members},
    })


@job_types_bp.route("/api/job-types/approval-mode", methods=["POST"])
def api_job_types_approval_mode():
    """Job List tab's editable Approval Mode column (auto/prompt/approve). Mirrors
    api_job_types_priority()'s exact shape -- persists to AGENT_MANAGER_APPROVAL_MODES in
    agent-manager.env, which src/config.js's approvalModeOverrides reads fresh on every
    `node task-sources.js` invocation, so apply-runner.ps1's next automatic-loop tick
    (via --approval-modes) picks up the change with no pipeline restart needed."""
    from app import ENV_FILE_PATH, VALID_APPROVAL_MODES, _default_approval_mode, read_approval_modes, task_source_catalog, write_env_value
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    mode = (body.get("mode") or "").strip()
    if name not in task_source_catalog():
        abort(400, description=f"unknown job type '{name}'")
    if mode not in VALID_APPROVAL_MODES:
        abort(400, description=f"mode must be one of {VALID_APPROVAL_MODES}")

    modes = read_approval_modes()
    modes[name] = mode

    # Collapse back to "no overrides" (empty string) when every source ends up at the
    # current global default -- same tidy-round-trip reasoning as the priority/allowlist
    # collapses above.
    default = _default_approval_mode()
    non_default = {n: m for n, m in modes.items() if m != default}
    new_value = ",".join(f"{n}:{m}" for n, m in sorted(non_default.items()))
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_APPROVAL_MODES", new_value)

    return jsonify({"name": name, "approvalMode": mode})


@job_types_bp.route("/api/job-types/worker-type", methods=["POST"])
def api_job_types_worker_type():
    """Job List tab's editable Worker Type column (ornith/reasoning) -- lets a human
    reassign which worker claims a given task type's tasks. Mirrors
    api_job_types_priority()'s exact shape -- persists to AGENT_MANAGER_TASK_TIERS in
    agent-manager.env (as the Node-side low/high tier names), which src/config.js's
    taskTierOverrides reads fresh on every `node task-sources.js` invocation and
    model-provider.js's reasoningTierFor() consults, so an edit here takes effect on the
    very next worker tick with no pipeline restart needed."""
    from app import ENV_FILE_PATH, VALID_WORKER_TYPES, read_worker_types, task_source_catalog, task_source_default_worker_types, write_env_value
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    worker_type = (body.get("workerType") or "").strip()
    if name not in task_source_catalog():
        abort(400, description=f"unknown job type '{name}'")
    if worker_type not in VALID_WORKER_TYPES:
        abort(400, description=f"workerType must be one of {VALID_WORKER_TYPES}")

    worker_types = read_worker_types()
    worker_types[name] = worker_type

    # Collapse back to "no overrides" (empty string) when every source ends up at its own
    # default -- same tidy-round-trip reasoning as the priority/approval-mode collapses above.
    worker_type_to_tier = {"ornith": "low", "reasoning": "high"}
    non_default = {
        n: worker_type_to_tier[wt] for n, wt in worker_types.items() if wt != task_source_default_worker_types().get(n)
    }
    new_value = ",".join(f"{n}:{t}" for n, t in sorted(non_default.items()))
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_TASK_TIERS", new_value)

    return jsonify({"name": name, "workerType": worker_type})
