#!/usr/bin/env python3
"""Renders graph.json (built by build_graph.py) as an interactive HTML network view,
colored by community, for human review -- open the output file in any browser.

Usage: python visualize_graph.py [output.html]
Reads the same AGENT_MANAGER_GRAPH_PATH / AGENT_MANAGER_COMMUNITY_COVERAGE_PATH env vars
as build_graph.py. Default output path: <graph_path's directory>/graph-visualization.html
"""

import json
import os
import sys
from pathlib import Path

from pyvis.network import Network

# Fixed, deterministic palette so the same community id always gets the same color across
# repeated runs -- makes it easier for a human to compare two visualizations over time.
PALETTE = [
    "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
    "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac",
]


def get_config():
    repo_root = os.environ.get("AGENT_MANAGER_REPO_ROOT")
    if not repo_root:
        raise SystemExit("AGENT_MANAGER_REPO_ROOT env var is required.")
    repo_root = Path(repo_root)
    pipeline_dir = Path(os.environ.get("AGENT_MANAGER_PIPELINE_DIR", str(repo_root)))
    graph_path = Path(os.environ.get("AGENT_MANAGER_GRAPH_PATH", str(repo_root / "graphify-out" / "graph.json")))
    coverage_path = Path(os.environ.get("AGENT_MANAGER_COMMUNITY_COVERAGE_PATH", str(pipeline_dir / "community-coverage.json")))
    return {"graph_path": graph_path, "coverage_path": coverage_path}


def main():
    cfg = get_config()
    if not cfg["graph_path"].is_file():
        raise SystemExit(f"{cfg['graph_path']} does not exist -- run build_graph.py first.")

    graph_data = json.loads(cfg["graph_path"].read_text(encoding="utf-8"))
    names_by_id = {}
    if cfg["coverage_path"].is_file():
        coverage = json.loads(cfg["coverage_path"].read_text(encoding="utf-8"))
        names_by_id = {c["id"]: c["name"] for c in coverage.get("communities", [])}

    net = Network(height="900px", width="100%", bgcolor="#1a1a1a", font_color="#eeeeee", notebook=False)
    net.barnes_hut(gravity=-3000, spring_length=120)

    for node in graph_data["nodes"]:
        community_id = node["community"]
        color = PALETTE[community_id % len(PALETTE)]
        title = f"{node['source_file']}\nCommunity: {names_by_id.get(community_id, community_id)}"
        net.add_node(node["id"], label=Path(node["source_file"]).name, title=title, color=color, group=community_id)

    node_ids = {n["id"] for n in graph_data["nodes"]}
    for link in graph_data["links"]:
        if link["source"] in node_ids and link["target"] in node_ids:
            net.add_edge(link["source"], link["target"])

    output_path = Path(sys.argv[1]) if len(sys.argv) > 1 else cfg["graph_path"].parent / "graph-visualization.html"
    net.write_html(str(output_path), notebook=False)
    print(f"Wrote {output_path} -- open it in a browser.")


if __name__ == "__main__":
    main()
