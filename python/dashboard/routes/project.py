from flask import Blueprint, abort, jsonify, request

from pathlib import Path
import threading
import os
import subprocess
import json
import visualize_graph  # noqa: E402

# The app.py helpers these views call (_acquire_apply_lock, _build_lock, _build_state, _grep_dirs_from_query, _migrate_legacy_cache_if_needed, _release_apply_lock, _run_build, _run_git, get_active_repo_root, project_cache_paths, read_json_safe, record_project_used, resolve_writable_cache) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

project_bp = Blueprint("project-bp", __name__)

@project_bp.route("/api/project/status")
def api_project_status():
    from app import _build_lock, _build_state, _grep_dirs_from_query, _migrate_legacy_cache_if_needed, project_cache_paths, read_json_safe
    raw_path = request.args.get("path", "").strip()
    if not raw_path:
        abort(400, description="path query param is required")

    cache = project_cache_paths(raw_path, _grep_dirs_from_query())
    _migrate_legacy_cache_if_needed(raw_path, cache)
    meta = read_json_safe(cache["meta"]) or {}
    with _build_lock:
        build = dict(_build_state.get(raw_path, {"running": False, "log": [], "error": None}))

    graph_exists = cache["graph"].is_file()
    community_count = 0
    file_count = 0
    if graph_exists:
        graph_data = read_json_safe(cache["graph"]) or {}
        file_count = len(graph_data.get("nodes", []))
        community_count = len({n.get("community") for n in graph_data.get("nodes", [])})

    return jsonify({
        "path": raw_path,
        "graphExists": graph_exists,
        "builtAt": meta.get("builtAt"),
        "fileCount": file_count,
        "communityCount": community_count,
        "build": build,
    })


@project_bp.route("/api/project/build", methods=["POST"])
def api_project_build():
    from app import _build_lock, _build_state, _run_build, record_project_used
    body = request.get_json(silent=True) or {}
    raw_path = (body.get("path") or "").strip()
    if not raw_path:
        abort(400, description="path is required")
    if not Path(raw_path).is_dir():
        abort(404, description="path does not exist")
    record_project_used(raw_path)

    raw_grep_dirs = body.get("grepDirs")
    if raw_grep_dirs:
        # Explicit grepDirs is a deliberate scope -- honor it, but fail loudly if none of
        # the given dirs actually exist rather than silently falling back to a full scan.
        grep_dirs = [d for d in raw_grep_dirs if (Path(raw_path) / d).is_dir()]
        if not grep_dirs:
            abort(400, description="none of the given grepDirs exist under this path")
    else:
        # No grepDirs given -- scan the whole path rather than guessing at a
        # frontend/src,backend/src layout that may not exist. build_graph.py's wider
        # EXCLUDE_DIRS list keeps this from picking up build output/vendor/cache noise.
        grep_dirs = []

    with _build_lock:
        if _build_state.get(raw_path, {}).get("running"):
            return jsonify({"started": False, "reason": "a build is already running for this path"})
        _build_state[raw_path] = {"running": True, "log": [], "error": None}

    thread = threading.Thread(target=_run_build, args=(raw_path, grep_dirs), daemon=True)
    thread.start()
    return jsonify({"started": True, "grepDirs": grep_dirs})


@project_bp.route("/api/project/sync", methods=["POST"])
def api_project_sync():
    """Project tab's 'Sync with GitHub' button, next to Build Graph -- Grimmethy,
    2026-08-24: "I assume my currently live session is not caught up with github? I need
    a button ... that makes sure the project is up to date with github." Fetches origin
    and fast-forwards the CURRENTLY CHECKED-OUT branch onto its own origin tracking
    branch. Never resets/force-updates: a dirty tree, a detached HEAD, a branch with no
    matching one on origin, or local commits origin doesn't have are all reported and
    left untouched rather than discarded -- same git-safety norm as _sync_live_checkout
    above (never auto-discard uncommitted or local-only work)."""
    from app import _acquire_apply_lock, _release_apply_lock, _run_git, get_active_repo_root
    body = request.get_json(silent=True) or {}
    raw_path = (body.get("path") or "").strip()
    if not raw_path:
        abort(400, description="path is required")
    repo_root = Path(raw_path)
    if not repo_root.is_dir():
        abort(404, description="path does not exist")

    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=str(repo_root), capture_output=True, text=True, timeout=15,
    )
    if status.returncode != 0:
        return jsonify({"synced": False, "reason": "not a git repository"}), 400
    if status.stdout.strip():
        return jsonify({"synced": False, "reason": "uncommitted local changes -- left untouched, commit or stash first"})

    # If this path IS the active pipeline's repo root, take the same lock apply-task's
    # own apply step uses, so a sync click can't race an in-flight apply out from under it
    # (same lock, same reasoning as api_git_merge_branch above).
    active_root = get_active_repo_root()
    is_active = bool(active_root) and os.path.realpath(active_root) == os.path.realpath(str(repo_root))
    lock_fd = None
    if is_active:
        try:
            lock_fd = _acquire_apply_lock()
        except RuntimeError:
            abort(409, description="the pipeline is mid-apply right now -- try again in a few seconds")

    try:
        current_branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], repo_root).strip()
        if current_branch == "HEAD":
            return jsonify({"synced": False, "reason": "repo is in a detached HEAD state -- left untouched"})

        _run_git(["fetch", "origin"], repo_root)

        remote_ref = f"origin/{current_branch}"
        has_remote = subprocess.run(
            ["git", "show-ref", "--verify", "--quiet", f"refs/remotes/{remote_ref}"],
            cwd=str(repo_root), capture_output=True, timeout=10,
        )
        if has_remote.returncode != 0:
            return jsonify({"synced": False, "reason": f"no '{remote_ref}' on origin to sync against", "branch": current_branch})

        counts = _run_git(["rev-list", "--left-right", "--count", f"HEAD...{remote_ref}"], repo_root).strip()
        ahead_str, behind_str = (counts.split() + ["0", "0"])[:2]
        ahead, behind = int(ahead_str), int(behind_str)

        if behind == 0:
            return jsonify({"synced": True, "changed": False, "branch": current_branch, "ahead": ahead, "behind": behind})
        if ahead > 0:
            return jsonify({
                "synced": False,
                "reason": f"local '{current_branch}' has {ahead} commit(s) not on {remote_ref} -- left untouched, this isn't a safe fast-forward",
                "branch": current_branch, "ahead": ahead, "behind": behind,
            })

        before = _run_git(["rev-parse", "HEAD"], repo_root).strip()
        _run_git(["merge", "--ff-only", remote_ref], repo_root)
        after = _run_git(["rev-parse", "HEAD"], repo_root).strip()
        changed_files = _run_git(["diff", "--name-only", before, after], repo_root).splitlines()
        return jsonify({
            "synced": True, "changed": True, "branch": current_branch, "behind": behind, "changedFiles": changed_files,
        })
    except RuntimeError as e:
        return jsonify({"synced": False, "reason": str(e)}), 500
    finally:
        if lock_fd is not None:
            _release_apply_lock(lock_fd)


@project_bp.route("/project/visualization")
def project_visualization():
    from app import _grep_dirs_from_query, _migrate_legacy_cache_if_needed, project_cache_paths, read_json_safe
    raw_path = request.args.get("path", "").strip()
    if not raw_path:
        abort(400)
    grep_dirs = _grep_dirs_from_query()
    cache = project_cache_paths(raw_path, grep_dirs)
    _migrate_legacy_cache_if_needed(raw_path, cache)
    if not cache["graph"].is_file():
        return "<p style='font-family:sans-serif;padding:20px'>No graph built yet for this project.</p>", 404

    graph_data = json.loads(cache["graph"].read_text(encoding="utf-8"))
    coverage_data = read_json_safe(cache["coverage"])
    positions_data = read_json_safe(cache["positions"])
    html = visualize_graph.render_html(graph_data, coverage_data, positions=positions_data, project_path=raw_path, grep_dirs=grep_dirs)
    return html


@project_bp.route("/project/positions", methods=["POST"])
def api_project_positions():
    """Best-effort layout cache write from the visualization iframe's own capture script
    (see python/visualize_assets/capture-positions.js / community-drag.js) --
    same-origin, server-generated page posting back to its own dashboard, not external
    user input.

    Merges into the existing file rather than overwriting wholesale: the community-drag
    feature intentionally posts only the moved community's node positions (a small
    fraction of the graph), not the full network.getPositions() -- browsers cap
    keepalive fetch bodies at ~64KB, and a large graph's full position payload can exceed
    that (a real graph in this project measured 271KB), causing the save to silently fail
    with no timing race needed at all. An overwrite semantics here would also have wiped
    out every other node's cached position whenever only one community's subset was
    posted."""
    from app import _grep_dirs_from_query, read_json_safe, resolve_writable_cache
    raw_path = request.args.get("path", "").strip()
    if not raw_path:
        abort(400, description="path query param is required")
    positions = request.get_json(silent=True)
    if positions is None:
        abort(400, description="request body must be JSON")
    grep_dirs = _grep_dirs_from_query()
    cache = resolve_writable_cache(raw_path, grep_dirs)
    existing = read_json_safe(cache["positions"]) or {}
    existing.update(positions)
    cache["positions"].write_text(json.dumps(existing), encoding="utf-8")
    return jsonify({"saved": True})
