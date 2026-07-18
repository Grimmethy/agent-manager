#!/usr/bin/env python3
"""Stripped-down, self-contained replacement for the graphify dependency arch_discovery
used to require. Walks the configured source directories, extracts a file-level import/
require graph (JS/TS scope, matching grep-codebase-tool.js's own extension list), runs
community detection, and writes graph.json in the exact {nodes, links} shape
task-sources.js's nextArchDiscoveryTask() already consumes -- no changes needed there.

This is a periodic, manually-run scanner (same pattern as unused-export-scan.js /
gis-probe.js), NOT run automatically on every task-generation tick -- the resulting
graph.json and community-coverage.json are the cache.

Usage: python build_graph.py
Reads the same env vars as the rest of the package (AGENT_MANAGER_REPO_ROOT,
AGENT_MANAGER_GREP_DIRS, AGENT_MANAGER_GRAPH_PATH, AGENT_MANAGER_COMMUNITY_COVERAGE_PATH,
OLLAMA_URL, ORNITH_MODEL) -- no separate config mechanism.

IMPORTANT: rebuilding resets community-coverage.json's rotation progress (lastReviewedAt/
lastCandidateCount). Community boundaries can genuinely shift between rebuilds, and a
stale id pointing at a different file set would silently corrupt arch_discovery's rotation
tracking -- worse than an honest fresh start. Re-run this only when you actually want that
reset (e.g. after a large refactor), not on every tick.
"""

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

import networkx as nx
from networkx.algorithms.community import greedy_modularity_communities

MATCH_EXTENSIONS = {".js", ".jsx", ".ts", ".tsx"}
EXCLUDE_DIRS = {
    "node_modules", ".git", "queue",
    # Only matters when walk_source_files falls back to scanning the whole repo_root
    # (empty grep_dirs) -- a targeted grep_dirs list is already scoped to real source,
    # so these never come up in that path.
    "dist", "build", "out", "target", "vendor", ".next", ".turbo", ".parcel-cache",
    ".venv", "venv", "__pycache__", ".cache", ".pytest_cache", "coverage",
    ".idea", ".vscode", "tmp", "temp",
}

IMPORT_RE = re.compile(
    r"""(?:require\(\s*['"]([^'"]+)['"]\s*\))"""
    r"""|(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"])"""
    r"""|(?:export\s+[\w*{}\s,]*\s+from\s+['"]([^'"]+)['"])"""
)


def get_config():
    repo_root = os.environ.get("AGENT_MANAGER_REPO_ROOT")
    if not repo_root:
        raise SystemExit("AGENT_MANAGER_REPO_ROOT env var is required.")
    repo_root = Path(repo_root)

    pipeline_dir = Path(os.environ.get("AGENT_MANAGER_PIPELINE_DIR", str(repo_root)))
    grep_dirs = [d.strip() for d in os.environ.get("AGENT_MANAGER_GREP_DIRS", "frontend/src,backend/src").split(",") if d.strip()]
    graph_path = Path(os.environ.get("AGENT_MANAGER_GRAPH_PATH", str(repo_root / "graphify-out" / "graph.json")))
    coverage_path = Path(os.environ.get("AGENT_MANAGER_COMMUNITY_COVERAGE_PATH", str(pipeline_dir / "community-coverage.json")))
    ollama_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    ornith_model = os.environ.get("ORNITH_MODEL", "ornith:9b")

    return {
        "repo_root": repo_root,
        "grep_dirs": grep_dirs,
        "graph_path": graph_path,
        "coverage_path": coverage_path,
        "ollama_url": ollama_url,
        "ornith_model": ornith_model,
    }


def walk_source_files(repo_root: Path, grep_dirs: list[str]) -> list[Path]:
    # Empty grep_dirs means "no specific source dirs given" -- scan the whole repo_root
    # instead of the frontend/src,backend/src guess, relying on the wider EXCLUDE_DIRS
    # list above to skip build output/vendor/cache noise a targeted grep_dirs list would
    # never have included in the first place.
    roots = [repo_root] if not grep_dirs else [repo_root / d for d in grep_dirs]
    files = []
    for root in roots:
        if not root.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for name in filenames:
                if Path(name).suffix in MATCH_EXTENSIONS:
                    files.append(Path(dirpath) / name)
    return files


def resolve_import(from_file: Path, spec: str, repo_root: Path) -> Path | None:
    """Only resolves relative imports ('./foo', '../bar') to a real file within the repo
    -- a bare package name ('react', 'lodash') has no internal file to link to and is
    correctly ignored, same as it would be for graphify's own internal-edges-only scope."""
    if not spec.startswith("."):
        return None
    candidate = (from_file.parent / spec).resolve()
    tried = [candidate] + [candidate.with_suffix(ext) for ext in MATCH_EXTENSIONS]
    tried += [candidate / f"index{ext}" for ext in MATCH_EXTENSIONS]
    for path in tried:
        if path.is_file():
            try:
                return path.resolve()
            except OSError:
                return None
    return None


def build_import_graph(repo_root: Path, grep_dirs: list[str]) -> nx.Graph:
    files = walk_source_files(repo_root, grep_dirs)
    file_set = {f.resolve() for f in files}
    graph = nx.Graph()
    for f in file_set:
        rel = str(f.relative_to(repo_root)).replace("\\", "/")
        graph.add_node(rel)

    for f in file_set:
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        rel_from = str(f.relative_to(repo_root)).replace("\\", "/")
        for match in IMPORT_RE.finditer(text):
            spec = match.group(1) or match.group(2) or match.group(3)
            if not spec:
                continue
            target = resolve_import(f, spec, repo_root)
            if target and target in file_set:
                rel_to = str(target.relative_to(repo_root)).replace("\\", "/")
                if rel_to != rel_from:
                    graph.add_edge(rel_from, rel_to)

    return graph


def name_community_heuristic(files: list[str]) -> str:
    """Fallback when the model call fails or times out -- the shared directory prefix is
    a reasonable, cheap stand-in for a real semantic name."""
    parts_lists = [Path(f).parent.parts for f in files]
    if not parts_lists:
        return "Unnamed community"
    common = []
    for parts in zip(*parts_lists):
        if len(set(parts)) == 1:
            common.append(parts[0])
        else:
            break
    return "/".join(common) if common else Path(files[0]).parent.name or "root"


def name_community_ornith(files: list[str], ollama_url: str, ornith_model: str) -> str | None:
    prompt = (
        "These files form one tightly-connected cluster in a codebase's import graph:\n"
        + "\n".join(f"- {f}" for f in files[:20])
        + "\n\nRespond with ONLY a short (3-6 word) descriptive name for what this cluster "
        "does, nothing else, no punctuation at the end."
    )
    body = json.dumps({
        "model": ornith_model,
        "prompt": prompt,
        "think": False,
        "stream": False,
        "options": {"num_predict": 30, "temperature": 0.3},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{ollama_url}/api/generate", data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            name = (result.get("response") or "").strip().strip('."')
            return name or None
    except Exception as e:
        # Ollama serializes requests to its one resident model -- if a drafting worker is
        # mid-generation on the SAME Ollama instance, this call queues behind it and can
        # legitimately take a while, not just fail. Falling back silently here would leave
        # a confusing wall of directory-prefix names with no indication why. Run this
        # script while the pipeline is idle for real semantic names.
        print(f"    (model naming failed: {e} -- falling back to heuristic name)")
        return None


def build_graph_data(repo_root: Path, grep_dirs: list[str], ollama_url: str, ornith_model: str, progress=print) -> dict:
    """Reusable core: everything main() does EXCEPT deciding where to write the result --
    the CLI entry point and the dashboard's on-demand build both call this, writing to
    their own paths (the pipeline's configured graph/coverage paths for the CLI; a
    per-project cache dir, decoupled from any live pipeline, for the dashboard). `progress`
    is a callable taking one string, swappable for a non-print sink (e.g. a status list a
    background thread appends to, for the dashboard's poll endpoint to read).

    Returns {"graph": {"nodes": [...], "links": [...]}, "coverage": {"communities": [...]}}.
    """
    scope = ', '.join(grep_dirs) if grep_dirs else "entire tree"
    progress(f"Scanning {scope} under {repo_root} ...")

    graph = build_import_graph(repo_root, grep_dirs)
    progress(f"Found {graph.number_of_nodes()} files, {graph.number_of_edges()} import edges.")

    isolated = [n for n in graph.nodes if graph.degree(n) == 0]
    graph.remove_nodes_from(isolated)
    progress(f"Dropped {len(isolated)} isolated files (no internal import edges).")

    if graph.number_of_nodes() == 0:
        progress("No connected files found -- nothing to cluster.")
        return {"graph": {"nodes": [], "links": []}, "coverage": {"communities": []}}

    communities = list(greedy_modularity_communities(graph))
    communities.sort(key=len, reverse=True)
    progress(f"Found {len(communities)} communities.")

    nodes = []
    links = []
    coverage_communities = []

    for community_id, member_files in enumerate(communities):
        member_files = sorted(member_files)
        for f in member_files:
            nodes.append({"id": f, "community": community_id, "source_file": f})

        progress(f"  community {community_id}: {len(member_files)} files -- naming...")
        name = name_community_ornith(member_files, ollama_url, ornith_model)
        if not name:
            name = name_community_heuristic(member_files)
        coverage_communities.append({
            "id": community_id,
            "name": name,
            "lastReviewedAt": None,
            "lastCandidateCount": -1,
        })

    for a, b in graph.edges:
        links.append({"source": a, "target": b})

    return {
        "graph": {"nodes": nodes, "links": links},
        "coverage": {"communities": coverage_communities},
    }


def main():
    cfg = get_config()
    result = build_graph_data(cfg["repo_root"], cfg["grep_dirs"], cfg["ollama_url"], cfg["ornith_model"])

    cfg["graph_path"].parent.mkdir(parents=True, exist_ok=True)
    cfg["graph_path"].write_text(json.dumps(result["graph"], indent=2), encoding="utf-8")
    print(f"Wrote {cfg['graph_path']}")

    cfg["coverage_path"].parent.mkdir(parents=True, exist_ok=True)
    cfg["coverage_path"].write_text(json.dumps(result["coverage"], indent=2), encoding="utf-8")
    print(f"Wrote {cfg['coverage_path']} ({len(result['coverage']['communities'])} communities, rotation state reset)")


if __name__ == "__main__":
    main()
