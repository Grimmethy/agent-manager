from flask import Blueprint, abort, jsonify, request

from pathlib import Path
from urllib.parse import urlparse
import os
import json
import re

# The app.py helpers these views call (_COMMUNITY_ID_SUFFIX_RE, _DEEP_DIVE_ITEM_RE, get_pipeline_dir, project_search_index_path, read_json_safe) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

deep_dive_bp = Blueprint("deep-dive-bp", __name__)

def deep_dive_coverage_path() -> Path | None:
    from app import get_pipeline_dir
    override = os.environ.get("AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH")
    if override:
        return Path(override)
    d = get_pipeline_dir()
    return (d / "deep-dive-coverage.json") if d else None


def deep_dive_analysis_dir() -> Path | None:
    from app import project_search_index_path
    override = os.environ.get("AGENT_MANAGER_DEEP_DIVE_ANALYSIS_DIR")
    if override:
        return Path(override)
    idx = project_search_index_path()
    return (idx.parent / "analysis") if idx else None


def parse_strong_leads(index_text: str) -> list[dict]:
    """Python port of task-sources.js's parseStrongLeadsFromIndex() (kept in sync by hand, same reasoning as
    project_search_index_path(): this dashboard is Python, the pipeline is Node). A table row is a Strong lead
    only when INDEX.md's `## Notes` has a matching `### <name>` subsection. Beyond what the Node side needs
    (name, url, relevantTo) this also keeps the description and the reason ("why it matters here") so the tab
    can show WHICH project each lead was scouted for and why.

    "Relevant to" is `<projectTag> -- <reason>`; the pipeline only works a lead for the project whose directory
    name equals projectTag exactly (nextDeepDiveTask), so that tag is what ties a scouted repo to its project."""
    if not index_text:
        return []
    notes_idx = index_text.find("## Notes")
    notes_text = index_text[notes_idx:] if notes_idx != -1 else ""
    strong = {m.group(1).strip() for m in re.finditer(r"^### (.+)$", notes_text, re.MULTILINE)}
    seen, leads = set(), []
    for line in index_text.split("\n"):
        m = re.match(r"^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|(.*)$", line)
        if not m:
            continue
        name = m.group(1).strip()
        if name not in strong or name in seen:
            continue
        seen.add(name)
        cells = [c.strip() for c in m.group(3).split("|")]
        description = cells[1] if len(cells) > 1 else ""
        relevant = cells[2] if len(cells) > 2 else ""
        tag, _, reason = relevant.partition(" -- ")
        leads.append({"name": name, "url": m.group(2).strip(), "description": description,
                      "relevantTo": tag.strip() or None, "reason": reason.strip()})
    return leads


@deep_dive_bp.route("/api/deep-dive/projects")
def api_deep_dive_projects():
    """List tab for deep_dive (ADR-0019): every project-search lead for the ACTIVE project, with a quick
    reviewed/total + action-item count so the list itself shows progress without opening each one.

    Each row carries `relevantTo` (the project it was scouted for), `reason` (why it matters there) and a
    `status`: `cloned` (onboarded, has communities), `queued` (a Strong lead tagged for the active project that
    the next worker tick will clone) or, only with `?scope=all`, `other-project` (tagged for a different project:
    this pipeline will not touch it). Without scope=all the list is exactly what this project's pipeline works on."""
    from app import get_active_repo_root, project_search_index_path, read_json_safe
    cov_path = deep_dive_coverage_path()
    coverage = (read_json_safe(cov_path) if cov_path else None) or {}
    projects = coverage.get("projects", {})

    idx_path = project_search_index_path()
    try:
        leads = parse_strong_leads(idx_path.read_text(encoding="utf-8")) if idx_path and idx_path.is_file() else []
    except OSError:
        leads = []
    by_slug = {_slugify_for_id(l["name"]): l for l in leads}
    repo_root = get_active_repo_root()
    active_tag = Path(repo_root).name if repo_root else None
    show_all = request.args.get("scope") == "all"

    results = []
    for slug, proj in projects.items():
        communities = proj.get("communities") or []
        reviewed = sum(1 for c in communities if c.get("lastReviewedAt"))
        total_items = sum((c.get("actionItemCount") or 0) for c in communities if c.get("actionItemCount") is not None)
        lead = by_slug.get(slug) or {}
        results.append({
            "slug": slug,
            "sourceUrl": proj.get("sourceUrl"),
            "clonedAt": proj.get("clonedAt"),
            "communityCount": len(communities),
            "reviewedCount": reviewed,
            "totalActionItems": total_items,
            "hotlist": bool(proj.get("hotlist")),
            "status": "cloned",
            "relevantTo": lead.get("relevantTo"),
            "reason": lead.get("reason") or "",
            "description": lead.get("description") or "",
        })
    for slug, lead in by_slug.items():
        if slug in projects:
            continue
        mine = lead["relevantTo"] == active_tag
        if not mine and not show_all:
            continue
        results.append({
            "slug": slug, "sourceUrl": lead["url"], "clonedAt": None, "communityCount": 0, "reviewedCount": 0,
            "totalActionItems": 0, "hotlist": False, "status": "queued" if mine else "other-project",
            "relevantTo": lead["relevantTo"], "reason": lead["reason"], "description": lead["description"],
        })
    # Hotlisted first (matches nextDeepDiveTask()'s own ordering in task-sources.js), then cloned before queued
    # before other projects' leads, alphabetical within each tier.
    tier = {"cloned": 0, "queued": 1, "other-project": 2}
    results.sort(key=lambda r: (not r["hotlist"], tier[r["status"]], r["slug"]))
    return jsonify(results)


@deep_dive_bp.route("/api/deep-dive/projects/<slug>/hotlist", methods=["POST"])
def api_deep_dive_set_hotlist(slug):
    """Toggles a project onto/off the research priority list -- nextDeepDiveTask() reads
    this same field to draft every hotlisted project's remaining communities before any
    non-hotlisted one, regardless of how long they've been waiting in the normal
    oldest-first rotation (see task-sources.js)."""
    from app import read_json_safe
    body = request.get_json(silent=True) or {}
    hotlist = bool(body.get("hotlist"))

    cov_path = deep_dive_coverage_path()
    if not cov_path:
        abort(404)
    coverage = read_json_safe(cov_path) or {"projects": {}}
    proj = coverage.get("projects", {}).get(slug)
    if not proj:
        abort(404, description=f"unknown project: {slug}")

    proj["hotlist"] = hotlist
    cov_path.write_text(json.dumps(coverage, indent=2), encoding="utf-8")
    return jsonify({"slug": slug, "hotlist": hotlist})


def _slugify_for_id(text: str) -> str:
    """Python port of task-sources.js's slugifyForId() -- MUST stay byte-for-byte
    equivalent, since onboardDeepDiveProject() derives deep-dive-coverage.json's project
    key the same way from the same lead.name, and the two need to agree on the same slug
    for a given name or a manually-added lead would silently mismatch its own coverage
    entry once onboarded."""
    s = text.lower()
    s = re.sub(r"^[^a-z0-9]+|[^a-z0-9]+$", "", s)
    return re.sub(r"[^a-z0-9]+", "-", s)


def _parse_github_org_repo(url: str) -> tuple[str, str] | None:
    """Pulls org/repo out of a pasted GitHub URL, tolerating a trailing slash, a .git
    suffix, or extra path segments (e.g. /tree/main). Returns None for anything that
    doesn't look like a real github.com repo URL -- deliberately narrow (this deployment's
    project_search/deep_dive pipeline has only ever cloned github.com URLs; widening it to
    other forges is a separate decision, not a silent side effect of this endpoint)."""
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or parsed.netloc.lower() not in ("github.com", "www.github.com"):
        return None
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2:
        return None
    org, repo = parts[0], parts[1]
    if repo.endswith(".git"):
        repo = repo[:-4]
    if not org or not repo:
        return None
    return org, repo


@deep_dive_bp.route("/api/project-search/manual-lead", methods=["POST"])
def api_project_search_manual_lead():
    """"+ Add repo" bar on the Scouted Repos tab (Grimmethy, 2026-09-14: "I need a way to
    enter new github repos into the Scouted Repos tab... processed the same as any other
    scouted repo"). Deliberately does NOT touch deep-dive-coverage.json directly -- that
    would also require faking a real git clone + .deep-dive-graph.json community graph, or
    the per-community review rotation in task-sources.js's nextDeepDiveTask() breaks. This
    reuses the actual, existing entry point instead: append the same row + `## Notes`
    subsection shape apply-group-a-report-appenders.js's applyProjectSearchFindings()
    writes for an auto-discovered Strong lead (kept in sync by hand -- see
    project_search_index_path()'s own comment, same reasoning: this dashboard is Python,
    the writer is Node, and there's no import across that boundary). The very next
    local-worker.sh tick's nextDeepDiveTask() picks it up, clones it, and graphs it exactly
    like anything project_search found on its own.

    Body: {"url": "https://github.com/org/repo", "description": "<optional>"}."""
    from app import get_active_repo_root, project_search_index_path

    body = request.get_json(silent=True) or {}
    url = (body.get("url") or "").strip()
    if not url:
        abort(400, description="url is required")

    org_repo = _parse_github_org_repo(url)
    if not org_repo:
        abort(400, description="expected a github.com/<org>/<repo> URL")
    org, repo = org_repo
    name = f"{org}/{repo}"
    clean_url = f"https://github.com/{org}/{repo}"

    repo_root = get_active_repo_root()
    if not repo_root:
        abort(404, description="no active project configured")
    project_tag = Path(repo_root).name

    idx_path = project_search_index_path()
    if not idx_path:
        abort(404, description="no project-search index configured")

    index_text = idx_path.read_text(encoding="utf-8") if idx_path.is_file() else (
        "# Index\n\n| Project | Source | Description | Relevant to | Status |\n|---|---|---|---|---|\n\n## Notes\n"
    )

    # Dedup: a lead is "the same repo" if its link text already matches -- same identity
    # parseStrongLeadsFromIndex() itself keys leads on (case-sensitive name text, first
    # occurrence wins), so re-submitting the same URL must be a no-op, not a duplicate row
    # project_search's own dedup (a `seen` Set scoped to one parse) would silently pick
    # only the first of anyway.
    if re.search(r"^\|\s*\[" + re.escape(name) + r"\]", index_text, re.MULTILINE):
        slug = _slugify_for_id(name)
        return jsonify({"slug": slug, "name": name, "alreadyPresent": True})

    description = (body.get("description") or "").strip() or "Manually added via the Scouted Repos tab."

    row = f"| [{name}]({clean_url}) | github | {description} | {project_tag} -- manually added via dashboard | lead |"
    header_line = "|---|---|---|---|---|"
    header_idx = index_text.find(header_line)
    if header_idx == -1:
        index_text += "\n" + row + "\n"
    else:
        insert_at = header_idx + len(header_line)
        index_text = index_text[:insert_at] + "\n" + row + index_text[insert_at:]

    # The `### <name>` subsection under `## Notes` is what makes parseStrongLeadsFromIndex()
    # treat this row as Strong -- without it the row just sits in the table forever, never
    # picked up. See that function's own header comment in task-sources.js.
    subsection = f"### {name}\n\nManually added via the Scouted Repos tab."
    notes_idx = index_text.find("## Notes")
    if notes_idx == -1:
        index_text += "\n## Notes\n\n" + subsection + "\n"
    else:
        insert_at = notes_idx + len("## Notes")
        index_text = index_text[:insert_at] + "\n" + subsection + "\n" + index_text[insert_at:]

    idx_path.parent.mkdir(parents=True, exist_ok=True)
    idx_path.write_text(index_text, encoding="utf-8")

    slug = _slugify_for_id(name)
    return jsonify({"slug": slug, "name": name, "relevantTo": project_tag, "alreadyPresent": False})


def parse_deep_dive_analysis(analysis_text: str) -> list[dict]:
    """Splits analysis.md (apply-group-a.js's applyDeepDiveFindings own output format) into
    structured items so the dashboard can filter by the exact community a user clicked,
    rather than showing the whole file as one undifferentiated block. Items written before
    the "(community #N)" tagging was added (see apply-group-a.js) have communityId: null --
    the frontend falls back to matching those by community name alone, which is ambiguous
    when multiple communities share the same directory-based name but is still better than
    nothing for pre-existing entries."""
    from app import _COMMUNITY_ID_SUFFIX_RE, _DEEP_DIVE_ITEM_RE
    items = []
    for m in _DEEP_DIVE_ITEM_RE.finditer(analysis_text or ""):
        community_raw = m.group("community").strip()
        id_match = _COMMUNITY_ID_SUFFIX_RE.match(community_raw)
        community_name = id_match.group("name") if id_match else community_raw
        community_id = int(id_match.group("id")) if id_match else None
        items.append({
            "title": m.group("title").strip(),
            "community": community_name,
            "communityId": community_id,
            "rating": m.group("rating").strip(),
            "files": (m.group("files") or "").strip() or None,
            "rationale": m.group("rationale").strip(),
        })
    return items


@deep_dive_bp.route("/api/deep-dive/projects/<slug>")
def api_deep_dive_project_detail(slug):
    """Detail view: per-community review progress plus the actual write-up
    (UsefulProjectIndex/analysis/<slug>.md) apply-group-a.js's applyDeepDiveFindings
    appended -- this IS "what our workers picked from that repo," rendered as-is rather
    than re-parsed, since the markdown itself is already the operator-facing artifact."""
    from app import read_json_safe
    cov_path = deep_dive_coverage_path()
    coverage = (read_json_safe(cov_path) if cov_path else None) or {}
    proj = coverage.get("projects", {}).get(slug)
    if not proj:
        abort(404)

    analysis_dir = deep_dive_analysis_dir()
    analysis_text = None
    if analysis_dir:
        analysis_path = analysis_dir / f"{slug}.md"
        if analysis_path.is_file():
            analysis_text = analysis_path.read_text(encoding="utf-8")

    return jsonify({
        "slug": slug,
        "sourceUrl": proj.get("sourceUrl"),
        "clonePath": proj.get("clonePath"),
        "clonedAt": proj.get("clonedAt"),
        "hotlist": bool(proj.get("hotlist")),
        "communities": proj.get("communities") or [],
        "analysisMarkdown": analysis_text,
        "items": parse_deep_dive_analysis(analysis_text) if analysis_text else [],
    })
