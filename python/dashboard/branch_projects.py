"""Unmerged branches of EVERY registered project, not only the active one (Unmerged Branches tab, `?projects=all`).

The active project keeps its own cache in app.py (fresh, stale-while-revalidate). Every other project is listed here, one cache entry per repo root, refreshed by ONE
background thread that walks the stale projects one after another: a project's list costs a `git fetch` plus per-branch git work (seconds to tens of seconds), so
computing 20 of them inside a request would blow the tab's 30 s timeout. A request therefore never waits: it returns what is cached and names the projects that have no
list yet in `pending`.

Read-only by design: these branches are LISTED and labelled with their project; merge/discard stay with the active project (their endpoints, apply lock and live sync are
all active-project scoped). The one write is the same one the active project makes: deterministic verdicts into that project's own queue/branch-verdicts.json.

Standalone like branch_verdicts.py: app.py imports the route modules, so everything from app.py is imported lazily inside functions.
"""
import os
import sys
import threading
import time

_lock = threading.Lock()
_state = {"cache": {}, "thread": None}  # cache: real repo root -> {"at": epoch, "branches": [...], "error": str|None}


def _ttl_seconds():
    try:
        return max(30.0, float(os.environ.get("AGENT_MANAGER_BRANCH_OTHER_PROJECTS_TTL_SECONDS", "300")))
    except ValueError:
        return 300.0


def registered_projects(active_root):
    """Every registered project that is its own git repo, one per real repo root (projects.json lists some repos twice under two mount paths and some as a subfolder
    of another), active one flagged. A project the registry lacks but that is active still appears."""
    from app import read_project_registry
    entries = list(read_project_registry())
    active_real = os.path.realpath(active_root) if active_root else None
    if active_real and not any(os.path.realpath(e.get("repoRoot") or "") == active_real for e in entries):
        entries.append({"repoRoot": active_real, "label": os.path.basename(active_real)})
    seen, out = set(), []
    for e in entries:
        root = e.get("repoRoot")
        if not root:
            continue
        real = os.path.realpath(root)
        if real in seen or not os.path.exists(os.path.join(real, ".git")):
            continue
        seen.add(real)
        out.append({
            "label": e.get("label") or os.path.basename(real),
            "repoRoot": real,
            "pipelineDir": e.get("pipelineDir") or real,
            "active": real == active_real,
        })
    return out


def project_tag(project):
    return {"label": project["label"], "repoRoot": project["repoRoot"], "active": bool(project["active"])}


def _refresh_stale(projects):
    """Background thread body: recompute each stale project in turn. A failure stamps the entry anyway (keeping any previous list) so a broken repo is retried at the
    next TTL, not on every request."""
    import app
    try:
        for p in projects:
            err = None
            try:
                branches = app._list_unmerged_branches_uncached(force_fetch=True, repo_root=p["repoRoot"], pipeline_dir=p["pipelineDir"])
            except Exception as e:  # noqa: BLE001 -- one broken repo must not stop the others
                err = f"{type(e).__name__}: {e}"
                print(f"[branches] project {p['label']} failed (non-fatal): {err}", file=sys.stderr)
                with _lock:
                    branches = list((_state["cache"].get(p["repoRoot"]) or {}).get("branches") or [])
            with _lock:
                _state["cache"][p["repoRoot"]] = {"at": time.time(), "branches": branches, "error": err}
    finally:
        with _lock:
            _state["thread"] = None


def other_project_branches(active_root):
    """({project tag -> branches}, pending labels). Never blocks on git: returns the cache and starts the refresh thread for anything stale."""
    others = [p for p in registered_projects(active_root) if not p["active"]]
    ttl, now = _ttl_seconds(), time.time()
    with _lock:
        cache = dict(_state["cache"])
        stale = [p for p in others if now - (cache.get(p["repoRoot"]) or {}).get("at", 0.0) >= ttl]
        if stale and _state["thread"] is None:
            t = threading.Thread(target=_refresh_stale, args=(stale,), name="branch-projects-refresh", daemon=True)
            _state["thread"] = t
            t.start()
    result, pending = [], []
    for p in others:
        entry = cache.get(p["repoRoot"])
        if entry is None:
            pending.append(p["label"])
            continue
        result.append((p, entry["branches"]))
    return result, pending


def combined_branches(active_branches, active_root):
    """Active project's branches first (their existing order), then each other project's, projects A-Z and oldest push first within one. Every row is a copy carrying a
    `project` tag, so the cached lists are never mutated. Returns (rows, pending project labels)."""
    projects = registered_projects(active_root)
    active = next((p for p in projects if p["active"]), None)
    rows = []
    if active_branches:
        tag = project_tag(active) if active else {"label": "active project", "repoRoot": active_root or "", "active": True}
        rows.extend({**b, "project": tag} for b in active_branches)
    others, pending = other_project_branches(active_root)
    for p, branches in sorted(others, key=lambda pb: pb[0]["label"].lower()):
        tag = project_tag(p)
        rows.extend({**b, "project": tag} for b in sorted(branches, key=lambda b: b.get("pushedAt") or ""))
    return rows, pending


def find_other_project_branch(project_root, branch):
    """(project, branch row) for a cached branch of a NON-active project, else (None, None). The commits endpoint's "only act on what we offered" gate."""
    with _lock:
        cache = dict(_state["cache"])
    real = os.path.realpath(project_root or "")
    entry = cache.get(real)
    if not entry:
        return None, None
    row = next((b for b in entry["branches"] if b["branch"] == branch), None)
    return (real, row) if row else (None, None)
