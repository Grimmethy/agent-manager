from flask import Blueprint
second_brain_bp = Blueprint("second-brain-bp", __name__)

import os
import shutil
import subprocess
from pathlib import Path
from flask import abort, jsonify, request

@second_brain_bp.route("/api/second-brain/task-refs")
def api_second_brain_task_refs():
    """Second-brain counterpart to the Brain Dump tab's live taskStatus badges
    (2026-08-16): a note can carry a task cross-reference naming a DIFFERENT project than
    whatever pipeline is currently active. That project's queue is looked up directly via
    projects.json (repoRoot/pipelineDir) rather than requiring it to be switched active
    first -- a real, live status is available regardless of what's currently running,
    same as any other registered project's queue files sitting right there on disk.
    Only when the project isn't registered at all, or its pipeline dir isn't reachable on
    this machine, does this fall back to a plain informational note instead of a real
    status -- see each branch below for the user-facing wording."""
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    note_path_str = (request.args.get("notePath") or "").strip()
    if not note_path_str:
        abort(400, description="notePath is required")
    full_path = _resolve_under_second_brain(root.resolve(), note_path_str)
    if not full_path.is_file():
        return jsonify([])

    content = full_path.read_text(encoding="utf-8")
    matches = _TASK_REF_RE.findall(content)
    if not matches:
        return jsonify([])

    registry = read_project_registry()
    active_root = get_active_repo_root()
    active_root_norm = os.path.normpath(active_root) if active_root else None

    # Cache per-project task-state indexes -- a note can reference the same project
    # multiple times (several entries queued into the same pipeline over time); no
    # reason to re-scan that project's queue dirs once per reference found.
    index_cache = {}
    results = []
    seen = set()
    for task_id, raw_label in matches:
        label = raw_label.strip()
        key = (task_id, label)
        if key in seen:
            continue
        seen.add(key)

        project = next((p for p in registry if p.get("label") == label), None)
        if not project:
            results.append({
                "taskId": task_id, "projectLabel": label, "projectFound": False,
                "isActiveProject": False, "taskStatus": None,
                "note": f'Project "{label}" is not currently registered -- open it once via the Project tab to enable status lookups for its tasks.',
            })
            continue

        is_active = bool(active_root_norm) and os.path.normpath(project.get("repoRoot", "")) == active_root_norm
        pipeline_dir_str = project.get("pipelineDir")
        pipeline_dir = Path(pipeline_dir_str) if pipeline_dir_str else None
        if not pipeline_dir or not pipeline_dir.is_dir():
            results.append({
                "taskId": task_id, "projectLabel": label, "projectFound": True,
                "isActiveProject": is_active, "taskStatus": None,
                "note": f'"{label}"\'s pipeline directory is not reachable on this machine right now.',
            })
            continue

        if pipeline_dir_str not in index_cache:
            index_cache[pipeline_dir_str] = _task_state_index(pipeline_dir / "queue")
        status = index_cache[pipeline_dir_str].get(task_id, "unknown")
        note = None
        if not is_active:
            note = f'Belongs to "{label}" -- switch to it via the Project tab for the pipeline to actively work on it further.'
        results.append({
            "taskId": task_id, "projectLabel": label, "projectFound": True,
            "isActiveProject": is_active, "taskStatus": status, "note": note,
        })

    return jsonify(results)

@second_brain_bp.route("/api/second-brain/discuss/for-note", methods=["GET"])
def api_second_brain_discuss_for_note():
    """Vault-note counterpart to /api/brain-dump/<id>/discuss/latest -- same "don't
    silently start a duplicate" check, surfaced next to Grill Me/Grill With Docs in the
    Second Brain file viewer."""
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    note_path = (request.args.get("notePath") or "").strip()
    if not note_path:
        abort(400, description="notePath is required")
    from discuss_sessions import latest_session_for_subject
    session = latest_session_for_subject(root, note_path)
    return jsonify(session)

@second_brain_bp.route("/api/second-brain/discuss/start", methods=["POST"])
def api_second_brain_discuss_start():
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    body = request.get_json(silent=True) or {}
    note_path = (body.get("notePath") or "").strip()
    if not note_path:
        abort(400, description="notePath is required")
    full_path = _resolve_under_second_brain(root.resolve(), note_path)
    note_content = full_path.read_text(encoding="utf-8") if full_path.is_file() else ""
    from discuss_sessions import start_session
    provider, model, effort = _discuss_provider_args(body)
    session = _call_discuss(start_session, root, note_path, note_content, kind="second-brain",
                             provider=provider, model=model, effort=effort, repo_root=get_active_repo_root(),
                             grep_dirs=get_active_grep_dirs(), instances_dir=instances_dir())
    return jsonify(session)

@second_brain_bp.route("/api/second-brain/browse")
def api_second_brain_browse():
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    root = second_brain_dir()
    if not root:
        return jsonify({"path": "", "parent": None, "entries": [], "configured": False})
    root = root.resolve()

    raw_path = request.args.get("path", "").strip()
    target = _resolve_under_second_brain(root, raw_path)
    if not target.is_dir():
        abort(404)

    project_links = read_project_links()
    active_repo_root = get_active_repo_root()

    entries = []
    try:
        for child in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            try:
                is_dir = child.is_dir()
                # Population count: direct children only (files + subfolders), not a deep
                # recursive total -- matches what a folder's own name badge should mean
                # ("what's immediately in here"), and stays cheap even on a large vault.
                # None (not 0) on a permission error so the frontend can tell "empty" apart
                # from "couldn't read it" rather than silently showing a wrong zero.
                count = None
                if is_dir:
                    try:
                        count = sum(1 for _ in child.iterdir())
                    except (PermissionError, OSError):
                        count = None
                # .as_posix(), not str() -- these paths round-trip through JSON to the
                # frontend, which splits on '/' (see the "jump to file" handler in
                # index.html). str() on Windows would emit '\\', silently breaking that.
                rel_path = child.relative_to(root).as_posix()
                repo_path = project_links.get(rel_path)
                entries.append({
                    "name": child.name,
                    "path": rel_path,
                    "isDir": is_dir,
                    "count": count,
                    "repoPath": repo_path,
                    "isActiveProject": bool(repo_path) and bool(active_repo_root) and Path(repo_path) == Path(active_repo_root),
                })
            except (PermissionError, OSError):
                continue
    except (PermissionError, OSError) as e:
        abort(403, description=str(e))

    rel = "" if target == root else target.relative_to(root).as_posix()
    # target.parent.relative_to(root).as_posix() would give "." for a one-level-deep
    # directory (its parent IS root) -- Path('.').as_posix() is '.', not '', which would
    # round-trip back through the jail check as a non-empty raw_path instead of "go to
    # root". Normalizing here keeps "up" from root's immediate children correct.
    parent = None if target == root else ("" if target.parent == root else target.parent.relative_to(root).as_posix())
    return jsonify({"path": rel, "parent": parent, "entries": entries, "configured": True})

@second_brain_bp.route("/api/second-brain/sync-github-projects", methods=["POST"])
def api_second_brain_sync_github_projects():
    """Ensures every git repo directly under GITHUB_PROJECTS_ROOT has a reference note
    under Projects/GitHub/ in the second brain, so every GitHub project is navigable from
    there (the actual ask: "All github projects should be referenced in Second Brain").
    Idempotent and non-destructive -- only CREATES a note when one doesn't already exist
    at that path; never overwrites something already there, so any personal notes/edits
    a user has since added to a repo's note are never touched by re-running this."""
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")

    repos = discover_github_repos()
    projects_dir = root / "Projects" / "GitHub"
    projects_dir.mkdir(parents=True, exist_ok=True)

    links = read_project_links()
    created = []
    for repo in repos:
        note_rel = f"Projects/GitHub/{repo['name']}.md"
        note_path = root / note_rel
        if not note_path.exists():
            note_path.write_text(
                f"# {repo['name']}\n\n**Repo path:** `{repo['path']}`\n",
                encoding="utf-8",
            )
            created.append(repo["name"])
        links[note_rel] = repo["path"]

    write_project_links(links)
    return jsonify({"synced": len(repos), "created": created, "totalLinked": len(links)})

@second_brain_bp.route("/api/second-brain/projects", methods=["GET"])
def api_second_brain_projects():
    """Projects referenced in the second brain (Projects/GitHub/*.md, built by
    sync-github-projects) for the Project tab's project dropdown. Falls back to a live
    filesystem scan (discover_github_repos) when the link index is empty/missing -- e.g.
    sync has never been run -- so the dropdown isn't stuck empty on a fresh install."""
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    links = read_project_links()
    if links:
        projects = [
            {"name": Path(note_rel).stem, "path": repo_path}
            for note_rel, repo_path in links.items()
        ]
    else:
        projects = discover_github_repos()
    projects.sort(key=lambda p: p["name"].lower())
    return jsonify({"projects": projects})

@second_brain_bp.route("/api/second-brain/grill/for-note", methods=["GET"])
def api_second_brain_grill_for_note():
    """Most recent existing session for this note, so the frontend can surface
    already-completed-but-un-enriched (or still-active) work instead of silently letting
    Grill Me start a fresh session next to it every time the note is reopened."""
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    note_path = (request.args.get("notePath") or "").strip()
    if not note_path:
        abort(400, description="notePath is required")
    from grill_sessions import latest_session_for_note
    session = latest_session_for_note(root, note_path)
    return jsonify(session)

@second_brain_bp.route("/api/second-brain/grill/start", methods=["POST"])
def api_second_brain_grill_start():
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    body = request.get_json(silent=True) or {}
    note_path = (body.get("notePath") or "").strip()
    mode = body.get("mode")
    source_url = body.get("sourceUrl")
    if not note_path or mode not in ("grill-me", "grill-with-docs"):
        abort(400, description="notePath and a valid mode ('grill-me' or 'grill-with-docs') are required")
    from grill_sessions import start_session
    session = start_session(root, note_path, mode, source_url)
    return jsonify(session)

@second_brain_bp.route("/api/second-brain/grill/<session_id>/answer", methods=["POST"])
def api_second_brain_grill_answer(session_id):
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    body = request.get_json(silent=True) or {}
    answer = (body.get("answer") or "").strip()
    if not answer:
        abort(400, description="answer is required")
    from grill_sessions import submit_answer
    session = submit_answer(root, session_id, answer)
    if not session:
        abort(404)
    return jsonify(session)

@second_brain_bp.route("/api/second-brain/grill/<session_id>", methods=["GET"])
def api_second_brain_grill_get(session_id):
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    from grill_sessions import get_session
    session = get_session(root, session_id)
    if not session:
        abort(404)
    return jsonify(session)

@second_brain_bp.route("/api/second-brain/grill/<session_id>/enrich", methods=["POST"])
def api_second_brain_grill_enrich(session_id):
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    from grill_sessions import enrich_note
    session = enrich_note(root, session_id)
    if not session:
        abort(404, description="session not found or not complete")
    return jsonify(session)

@second_brain_bp.route("/api/second-brain/create-github-project", methods=["POST"])
def api_second_brain_create_github_project():
    """Turns a Second Brain "project starter" note into a real GitHub project: a new repo
    directory under GITHUB_PROJECTS_ROOT, git-initialized, seeded with a README carrying
    the note's own content over as the starting point. Then links the note to that new
    repo the same way sync-github-projects links a discovered one, so it immediately gets
    the browse view's "Set Active"/"Active Project" treatment -- the actual ask: "turn
    these project starters into actual projects" via a button next to the note."""
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    root = second_brain_dir()
    if not root:
        abort(400, description="SECOND_BRAIN_DIR is not configured")
    root = root.resolve()

    body = request.get_json(silent=True) or {}
    note_rel = (body.get("notePath") or "").strip()
    if not note_rel:
        abort(400, description="notePath is required")
    note_path = _resolve_under_second_brain(root, note_rel)
    if not note_path.is_file():
        abort(404, description="note not found")

    links = read_project_links()
    if note_rel in links:
        abort(409, description=f"this note is already linked to {links[note_rel]}")

    project_name = _slugify_project_name(note_path.stem)
    repo_path = GITHUB_PROJECTS_ROOT / project_name
    if repo_path.exists():
        abort(409, description=f"{repo_path} already exists -- pick a different note name or remove it first")

    note_content = note_path.read_text(encoding="utf-8")

    try:
        repo_path.mkdir(parents=True)
        subprocess.run(["git", "init"], cwd=str(repo_path), capture_output=True, check=True, timeout=15)
        (repo_path / "README.md").write_text(note_content, encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=str(repo_path), capture_output=True, check=True, timeout=15)
        subprocess.run(
            ["git", "commit", "-m", f"Initial commit -- seeded from Second Brain note {note_rel}"],
            cwd=str(repo_path), capture_output=True, check=True, timeout=15,
        )
    except subprocess.CalledProcessError as e:
        # Best-effort cleanup on failure -- don't leave a half-initialized repo directory
        # behind that would then block a retry via the "already exists" check above.
        shutil.rmtree(repo_path, ignore_errors=True)
        detail = (e.stderr or b"").decode("utf-8", errors="replace").strip()
        abort(500, description=f"git setup failed: {detail or e}")
    except OSError as e:
        shutil.rmtree(repo_path, ignore_errors=True)
        abort(500, description=str(e))

    links[note_rel] = str(repo_path)
    write_project_links(links)

    return jsonify({"created": True, "repoPath": str(repo_path), "projectName": project_name})

@second_brain_bp.route("/api/second-brain/file")
def api_second_brain_file():
    from app import GITHUB_PROJECTS_ROOT, _TASK_REF_RE, _call_discuss, _discuss_provider_args, _resolve_under_second_brain, _slugify_project_name, _task_state_index, discover_github_repos, get_active_grep_dirs, get_active_repo_root, instances_dir, read_project_links, read_project_registry, second_brain_dir, write_project_links
    root = second_brain_dir()
    if not root:
        abort(500, description="SECOND_BRAIN_DIR is not configured")
    root = root.resolve()

    raw_path = request.args.get("path", "").strip()
    if not raw_path:
        abort(400, description="path is required")
    target = _resolve_under_second_brain(root, raw_path)
    if not target.is_file():
        abort(404)
    try:
        content = target.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        abort(400, description=f"could not read file as text: {e}")
    return jsonify({"path": raw_path, "content": content})
