#!/usr/bin/env python3
"""Second Brain wikilink graph builder. Sibling of build_graph.py: same output shape
({"graph": {"nodes": [...], "links": [...]}, "coverage": {"communities": [...]}}), same
networkx community-detection machinery, but the EDGES here come from Obsidian-style
`[[Note Name]]` wikilinks between markdown notes instead of source-file import/require
statements. This is a brand-new convention in this codebase (no wikilink parser existed
before this file, confirmed via grep) -- existing Second Brain notes have zero `[[...]]`
links until a human retrofits them; that is expected, not a bug, and this module makes no
attempt to auto-migrate old notes into the new convention.

Human design decision (Grimmethy, 2026-08-24): nodes = markdown notes under the Second
Brain root (see second_brain_dir() in python/dashboard/app.py), edges = `[[Note Name]]`
spans resolved to the target note's filename via a case-insensitive basename match --
mirrors the *shape* of build_graph.py's resolve_import/_extract_edges_for_file (parse ->
resolve -> filter to known nodes -> edge) without reusing it directly, since wikilink
syntax/resolution rules are unrelated to any import syntax build_graph.py already handles.

Usage: python build_note_graph.py --second-brain-dir <path> [--output <graph.json path>]
"""

import argparse
import json
import os
import re
from pathlib import Path

import networkx as nx
from networkx.algorithms.community import greedy_modularity_communities

from build_graph import (
    _community_member_signature,
    merge_coverage,
    name_community_heuristic,
)

NOTE_EXTENSIONS = {".md"}
EXCLUDE_DIRS = {
    ".git", ".obsidian", ".trash", "node_modules",
    "__pycache__", ".cache",
}

# `[[Note Name]]`, `[[Note Name|Display Text]]` (Obsidian alias) and `[[Note Name#Header]]`
# (link to a specific heading within the note) all resolve to the SAME target note -- only
# the text before the first `|` or `#` names it. `[^\]|#]+` stops at whichever of those
# comes first so a plain `[[Note Name]]` (no `|`/`#` at all) still matches via the trailing
# optional group being absent.
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")


def walk_note_files(second_brain_root: Path) -> list[Path]:
    files = []
    for dirpath, dirnames, filenames in os.walk(second_brain_root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS and not d.startswith(".")]
        for name in filenames:
            if Path(name).suffix in NOTE_EXTENSIONS:
                files.append(Path(dirpath) / name)
    return files


def _extract_wikilink_targets(text: str) -> list[str]:
    """Returns the raw note names referenced by every `[[...]]` span in text, trimmed of
    surrounding whitespace. Duplicate/self spans are left in -- deduping and self-edge
    filtering happen in build_note_import_graph, once the target is actually resolved to a
    file, matching build_graph.py's own edges-are-filtered-after-resolution order."""
    targets = []
    for match in WIKILINK_RE.finditer(text):
        name = match.group(1).strip()
        if name:
            targets.append(name)
    return targets


def resolve_wikilink(name: str, basename_index: dict) -> Path | None:
    """Case-insensitive match of a wikilink's note name against every note's basename
    (filename with the .md suffix stripped, per Obsidian's own convention that `[[Note
    Name]]` never includes the extension) -- the same "resolve a bare reference against the
    known file set" shape as build_graph.py's own resolvers, just keyed by basename instead
    of a path. A wikilink NAME shared by two or more notes in different folders is
    ambiguous -- correctly left unresolved (dangling) rather than guessing, same tolerance
    already given to build_graph.py's own resolve_lua_import basename-fallback case."""
    key = name.lower()
    # An explicit `.md` suffix in the link itself (rare, but valid Obsidian syntax) should
    # still match the same basename index -- strip it before lookup.
    if key.endswith(".md"):
        key = key[: -len(".md")]
    matches = basename_index.get(key)
    if not matches or len(matches) != 1:
        return None
    return matches[0]


def build_note_import_graph(second_brain_root: Path) -> nx.Graph:
    second_brain_root = second_brain_root.resolve()
    files = walk_note_files(second_brain_root)
    file_set = {f.resolve() for f in files}

    basename_index: dict[str, list[Path]] = {}
    for f in file_set:
        basename_index.setdefault(f.stem.lower(), []).append(f)

    graph = nx.Graph()
    for f in file_set:
        rel = str(f.relative_to(second_brain_root)).replace("\\", "/")
        graph.add_node(rel)

    for f in file_set:
        rel_from = str(f.relative_to(second_brain_root)).replace("\\", "/")
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue

        for name in _extract_wikilink_targets(text):
            target = resolve_wikilink(name, basename_index)
            # Dangling links (no matching note, or an ambiguous name matching more than
            # one) are silently dropped rather than reported -- this graph is a reading-order
            # aid for browsing the Second Brain, same accepted-gap tolerance build_graph.py's
            # own resolvers already document, not a linter that needs to surface every typo'd
            # or not-yet-created wikilink target.
            if target is None or target not in file_set:
                continue
            rel_to = str(target.relative_to(second_brain_root)).replace("\\", "/")
            if rel_to == rel_from:
                continue
            graph.add_edge(rel_from, rel_to)

    return graph


def build_note_graph_data(second_brain_root: Path, progress=print, file_cache=None,
                           old_coverage: dict = None, old_graph_nodes: list = None) -> dict:
    """Same return shape as build_graph.build_graph_data:
    {"graph": {"nodes": [{"id":..., "community":..., "source_file":...}], "links": [...]}},
    "coverage": {"communities": [...]}} -- so downstream community coloring/rendering in
    visualize_graph.py works unmodified regardless of which graph it's fed.

    file_cache is accepted for call-shape parity with build_graph_data but currently
    unused -- wikilink parsing (regex over one file's text) is cheap enough that the
    mtime/size-cache build_graph.py needs for its heavier import resolution isn't
    justified here yet.

    old_coverage/old_graph_nodes: same community-name-carry-forward behavior as
    build_graph.build_graph_data -- a community whose member-file set is unchanged from
    the previous build reuses its existing name instead of re-deriving one.
    """
    progress(f"Scanning Second Brain notes under {second_brain_root} ...")

    graph = build_note_import_graph(second_brain_root)
    progress(f"Found {graph.number_of_nodes()} notes, {graph.number_of_edges()} wikilink edges.")

    isolated = [n for n in graph.nodes if graph.degree(n) == 0]
    graph.remove_nodes_from(isolated)
    progress(f"Dropped {len(isolated)} isolated notes (no wikilinks in or out).")

    if graph.number_of_nodes() == 0:
        progress("No linked notes found -- nothing to cluster.")
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
            progress(f"  community {community_id}: {len(member_files)} notes -- unchanged, reusing existing name.")
        else:
            progress(f"  community {community_id}: {len(member_files)} notes -- naming...")
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--second-brain-dir", help="Second Brain root to scan. Falls back to the SECOND_BRAIN_DIR env var.")
    parser.add_argument("--output", help="Write the graph JSON here. Defaults to <second-brain-dir>/.note-graph.json.")
    args = parser.parse_args()

    root = Path(args.second_brain_dir) if args.second_brain_dir else None
    if root is None:
        env_val = os.environ.get("SECOND_BRAIN_DIR")
        root = Path(env_val) if env_val else None
    if root is None:
        raise SystemExit("--second-brain-dir or SECOND_BRAIN_DIR env var is required.")

    output_path = Path(args.output) if args.output else root / ".note-graph.json"

    result = build_note_graph_data(root)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result["graph"], indent=2), encoding="utf-8")
    print(f"Wrote {output_path} ({len(result['coverage']['communities'])} communities)")


if __name__ == "__main__":
    main()
