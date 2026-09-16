#!/usr/bin/env python3
"""Caller root for the graph build pipeline: get_config / build_graph_data /
check_due / main, assembled from graph_constants, graph_edge_resolution, and
graph_communities. This is the new root that replaces the old build_graph.py
root (whose other functions were extracted into those three modules). Usage is
unchanged: `python graph_build.py`, `--check-due`, and
`--target-dir <path> --output <path> [--no-model-naming]` (see docs/PLUGIN_API.md
for the cross-repo contract)."""

import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from networkx.algorithms.community import greedy_modularity_communities

from graph_constants import GRAPH_BUILD_INTERVAL_SECONDS
from graph_edge_resolution import build_import_graph
from graph_communities import _community_member_signature, merge_coverage, name_community_heuristic, name_community_ornith

def get_config():
    repo_root = os.environ.get("AGENT_MANAGER_REPO_ROOT")
    if not repo_root:
        raise SystemExit("AGENT_MANAGER_REPO_ROOT env var is required.")
    repo_root = Path(repo_root)

    pipeline_dir = Path(os.environ.get("AGENT_MANAGER_PIPELINE_DIR", str(repo_root)))
    grep_dirs = [d.strip() for d in os.environ.get("AGENT_MANAGER_GREP_DIRS", "frontend/src,backend/src").split(",") if d.strip()]
    graph_path = Path(os.environ.get("AGENT_MANAGER_GRAPH_PATH", str(repo_root / "graphify-out" / "graph.json")))
    coverage_path = Path(os.environ.get("AGENT_MANAGER_COMMUNITY_COVERAGE_PATH", str(pipeline_dir / "community-coverage.json")))
    # 2026-08-24 (Brain Dump #155): per-file mtime/size -> resolved-edges cache, see
    # build_import_graph's own comment. Lives under instances/ alongside the OTHER
    # build-scheduling state (.graph-build-schedule.json) this module already writes
    # there, not next to graph.json itself -- it's build-process bookkeeping, not part of
    # the graph data any consumer (task-sources.js, the dashboard's graph view) reads.
    file_cache_path = Path(os.environ.get("AGENT_MANAGER_GRAPH_FILE_CACHE_PATH", str(pipeline_dir / "instances" / ".graph-file-cache.json")))
    ollama_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    ornith_model = os.environ.get("ORNITH_MODEL", "ornith:9b")

    return {
        "repo_root": repo_root,
        "pipeline_dir": pipeline_dir,
        "grep_dirs": grep_dirs,
        "graph_path": graph_path,
        "coverage_path": coverage_path,
        "file_cache_path": file_cache_path,
        "ollama_url": ollama_url,
        "ornith_model": ornith_model,
    }



def build_graph_data(repo_root: Path, grep_dirs: list[str], ollama_url: str, ornith_model: str, progress=print,
                      use_model_naming: bool = True, file_cache: dict = None,
                      old_coverage: dict = None, old_graph_nodes: list = None) -> dict:
    """Reusable core: everything main() does EXCEPT deciding where to write the result --
    the CLI entry point and the dashboard's on-demand build both call this, writing to
    their own paths (the pipeline's configured graph/coverage paths for the CLI; a
    per-project cache dir, decoupled from any live pipeline, for the dashboard). `progress`
    is a callable taking one string, swappable for a non-print sink (e.g. a status list a
    background thread appends to, for the dashboard's poll endpoint to read).

    use_model_naming=False skips name_community_ornith entirely and goes straight to the
    heuristic -- deep_dive's own design deliberately never spends a model round-trip on
    naming communities in an external, unfamiliar repo (see ADR-0019), unlike
    arch_discovery's default of trying Ornith first.

    file_cache (2026-08-24, Brain Dump #155: "Every time I build a project graph it
    starts from scratch... build on diff's so that we only have to modify what has
    actually been changed") is passed straight through to build_import_graph -- see that
    function's own comment. Mutated in place; the caller is responsible for
    loading/persisting it (this function has no opinion on where it lives).

    old_coverage/old_graph_nodes (same brain-dump entry, the bigger win): when given, a
    community whose member-file set is byte-identical to a community from the PREVIOUS
    build reuses that community's existing name instead of calling
    name_community_ornith/name_community_heuristic again -- skipping the naming step
    entirely for the common case where most communities haven't changed. This is the part
    that actually matters for wall-clock time: confirmed live (see check_due()'s own
    comment) a real naming pass across this repo's own ~15+ communities took 13+ minutes
    under real worker-lane GPU contention -- a name is a per-community LLM round-trip,
    while re-parsing an unchanged file's text (file_cache's own job) is comparatively
    free. Uses the exact same member-file-set signature merge_coverage() already
    establishes as a community's stable cross-build identity, so behavior stays
    consistent with how review-state carry-forward already works.

    Returns {"graph": {"nodes": [...], "links": [...]}, "coverage": {"communities": [...]}}.
    """
    scope = ', '.join(grep_dirs) if grep_dirs else "entire tree"
    progress(f"Scanning {scope} under {repo_root} ...")

    graph = build_import_graph(repo_root, grep_dirs, file_cache=file_cache)
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

    old_names_by_signature = {}
    if old_coverage and old_graph_nodes:
        old_names_by_signature = {
            _community_member_signature(c["id"], old_graph_nodes): c["name"]
            for c in old_coverage.get("communities", [])
            if c.get("name")
        }

    nodes = []
    links = []
    coverage_communities = []
    reused_names = 0

    for community_id, member_files in enumerate(communities):
        member_files = sorted(member_files)
        for f in member_files:
            nodes.append({"id": f, "community": community_id, "source_file": f})

        name = old_names_by_signature.get(tuple(member_files))
        if name:
            reused_names += 1
            progress(f"  community {community_id}: {len(member_files)} files -- unchanged, reusing existing name.")
        else:
            progress(f"  community {community_id}: {len(member_files)} files -- naming...")
            name = name_community_ornith(member_files, ollama_url, ornith_model) if use_model_naming else None
            if not name:
                name = name_community_heuristic(member_files)
        coverage_communities.append({
            "id": community_id,
            "name": name,
            "lastReviewedAt": None,
            "lastCandidateCount": -1,
        })

    if old_names_by_signature:
        progress(f"Reused {reused_names}/{len(communities)} community names from the previous build (unchanged membership).")

    for a, b in graph.edges:
        links.append({"source": a, "target": b})

    return {
        "graph": {"nodes": nodes, "links": links},
        "coverage": {"communities": coverage_communities},
    }



def _graph_build_schedule_path(pipeline_dir: Path) -> Path:
    return pipeline_dir / "instances" / ".graph-build-schedule.json"



def _read_json_or_default(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default



def check_due(progress=print) -> bool:
    """Rebuilds the pipeline's own graph.json/community-coverage.json if
    GRAPH_BUILD_INTERVAL_SECONDS has elapsed since the last build (or it has never been
    built) -- called once per queue-watcher.sh tick, same "cheap check, rare real work"
    shape as system-report.js's own --check-due. Returns True if a build actually ran.

    Used to always run with use_model_naming=False (the directory-prefix heuristic)
    rather than arch_discovery's usual Ornith-first naming: community.name is purely a
    display label, not worth spending a real Ollama round-trip PER COMMUNITY contending
    with the live pipeline's actual drafting/review work every single day. Confirmed live
    2026-08-19: a manual full run (with naming on) against this repo's own ~15+
    communities was still running after 13+ minutes, genuinely queued behind real worker
    traffic on the same Ollama instance.

    2026-08-24 (Brain Dump #155): now runs with use_model_naming=True -- safe again since
    build_graph_data's own old_coverage/old_graph_nodes params (passed below) skip the
    naming call entirely for any community whose membership hasn't changed since the last
    build. The expensive case above only recurs on a genuinely large/first-ever change;
    routine daily runs now spend real Ollama round-trips only on the FEW communities that
    actually changed, instead of either all of them (slow) or none of them (the old
    heuristic-only workaround, real but strictly worse names).
    """
    cfg = get_config()
    schedule_path = _graph_build_schedule_path(cfg["pipeline_dir"])
    schedule = _read_json_or_default(schedule_path, {})

    last_built_at = schedule.get("lastBuiltAt")
    now = datetime.now(timezone.utc)
    if last_built_at:
        try:
            last = datetime.fromisoformat(last_built_at.replace("Z", "+00:00"))
        except ValueError:
            last = None
        if last and (now - last) < timedelta(seconds=GRAPH_BUILD_INTERVAL_SECONDS):
            return False

    old_graph = _read_json_or_default(cfg["graph_path"], {"nodes": [], "links": []})
    old_coverage = _read_json_or_default(cfg["coverage_path"], {"communities": []})
    file_cache = _read_json_or_default(cfg["file_cache_path"], {})

    result = build_graph_data(
        cfg["repo_root"], cfg["grep_dirs"], cfg["ollama_url"], cfg["ornith_model"], progress=progress,
        use_model_naming=True, file_cache=file_cache,
        old_coverage=old_coverage, old_graph_nodes=old_graph.get("nodes", []),
    )
    merged_coverage = merge_coverage(old_coverage, old_graph.get("nodes", []), result["coverage"], result["graph"]["nodes"])

    cfg["graph_path"].parent.mkdir(parents=True, exist_ok=True)
    cfg["graph_path"].write_text(json.dumps(result["graph"], indent=2), encoding="utf-8")
    cfg["coverage_path"].parent.mkdir(parents=True, exist_ok=True)
    cfg["coverage_path"].write_text(json.dumps(merged_coverage, indent=2), encoding="utf-8")
    cfg["file_cache_path"].parent.mkdir(parents=True, exist_ok=True)
    cfg["file_cache_path"].write_text(json.dumps(file_cache, indent=2), encoding="utf-8")

    schedule_path.parent.mkdir(parents=True, exist_ok=True)
    schedule_path.write_text(json.dumps({"lastBuiltAt": now.isoformat()}, indent=2), encoding="utf-8")

    carried = sum(1 for c in merged_coverage["communities"] if c.get("lastReviewedAt"))
    progress(
        f"[graph-build] rebuilt: {len(result['graph']['nodes'])} nodes, "
        f"{len(merged_coverage['communities'])} communities "
        f"({carried} carried forward existing review state, "
        f"{len(merged_coverage['communities']) - carried} new/changed)"
    )
    return True



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-dir", help="Scan this directory instead of AGENT_MANAGER_REPO_ROOT (whole tree, no grep_dirs scoping -- for deep_dive's cloned external repos, which have no known frontend/src,backend/src convention).")
    parser.add_argument("--output", help="Write the graph JSON here instead of AGENT_MANAGER_GRAPH_PATH. With --target-dir and no --output, defaults to <target-dir>/.deep-dive-graph.json. No coverage-tracker file is written in --target-dir mode -- deep_dive uses its own deep-dive-coverage.json, populated by task-sources.js, not this script.")
    parser.add_argument("--no-model-naming", action="store_true", help="Skip the Ornith community-naming call, go straight to the directory-prefix heuristic (deep_dive's default -- see ADR-0019).")
    parser.add_argument("--check-due", action="store_true", help="Rebuild only if GRAPH_BUILD_INTERVAL_SECONDS has elapsed since the last build (see check_due()'s own docstring) -- the mode queue-watcher.sh calls every tick. Ignores --target-dir/--output/--no-model-naming.")
    args = parser.parse_args()

    if args.check_due:
        check_due()
        return

    if args.target_dir:
        target_dir = Path(args.target_dir)
        output_path = Path(args.output) if args.output else target_dir / ".deep-dive-graph.json"
        ollama_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
        ornith_model = os.environ.get("ORNITH_MODEL", "ornith:9b")

        result = build_graph_data(target_dir, [], ollama_url, ornith_model, use_model_naming=not args.no_model_naming)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        # deep_dive wants nodes+links AND the community name list together (it has no
        # separate community-coverage.json-style tracker to cross-reference against, unlike
        # arch_discovery) -- write both under one file instead of graph.json's nodes/links-only
        # shape.
        combined = {"nodes": result["graph"]["nodes"], "links": result["graph"]["links"], "communities": result["coverage"]["communities"]}
        output_path.write_text(json.dumps(combined, indent=2), encoding="utf-8")
        print(f"Wrote {output_path} ({len(result['coverage']['communities'])} communities)")
        return

    cfg = get_config()
    old_graph = _read_json_or_default(cfg["graph_path"], {"nodes": [], "links": []})
    old_coverage = _read_json_or_default(cfg["coverage_path"], {"communities": []})
    file_cache = _read_json_or_default(cfg["file_cache_path"], {})

    result = build_graph_data(
        cfg["repo_root"], cfg["grep_dirs"], cfg["ollama_url"], cfg["ornith_model"],
        use_model_naming=not args.no_model_naming, file_cache=file_cache,
        old_coverage=old_coverage, old_graph_nodes=old_graph.get("nodes", []),
    )
    merged_coverage = merge_coverage(old_coverage, old_graph.get("nodes", []), result["coverage"], result["graph"]["nodes"])

    cfg["graph_path"].parent.mkdir(parents=True, exist_ok=True)
    cfg["graph_path"].write_text(json.dumps(result["graph"], indent=2), encoding="utf-8")
    print(f"Wrote {cfg['graph_path']}")

    cfg["coverage_path"].parent.mkdir(parents=True, exist_ok=True)
    cfg["coverage_path"].write_text(json.dumps(merged_coverage, indent=2), encoding="utf-8")
    carried = sum(1 for c in merged_coverage["communities"] if c.get("lastReviewedAt"))
    print(f"Wrote {cfg['coverage_path']} ({len(merged_coverage['communities'])} communities, {carried} carried forward existing review state)")

    cfg["file_cache_path"].parent.mkdir(parents=True, exist_ok=True)
    cfg["file_cache_path"].write_text(json.dumps(file_cache, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
