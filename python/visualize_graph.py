#!/usr/bin/env python3
"""Renders graph.json (built by build_graph.py) as an interactive HTML network view,
colored by community, for human review -- open the output file in any browser.

Usage: python visualize_graph.py [output.html]
Reads the same AGENT_MANAGER_GRAPH_PATH / AGENT_MANAGER_COMMUNITY_COVERAGE_PATH env vars
as build_graph.py. Default output path: <graph_path's directory>/graph-visualization.html
"""

import json
import math
import os
import random
import sys
from pathlib import Path
from urllib.parse import quote

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


def _group_by_community(nodes: list[dict]) -> dict[int, list[dict]]:
    by_community: dict[int, list[dict]] = {}
    for node in nodes:
        by_community.setdefault(node["community"], []).append(node)
    return by_community


def _seed_positions_by_community(nodes: list[dict]) -> dict[int, tuple[float, float]]:
    """Starting layout for a fresh (uncached) physics run: arrange each community's
    centroid on a ring and jitter its members around that spot, instead of vis.js's
    default fully-random placement. Physics still runs and refines from here, but starts
    close to the right answer instead of untangling total chaos -- faster convergence and
    a far less chaotic-looking initial frame."""
    by_community = _group_by_community(nodes)
    community_ids = sorted(by_community.keys())
    n = len(community_ids)
    ring_radius = max(600, n * 40)

    positions = {}
    for i, community_id in enumerate(community_ids):
        angle = 2 * math.pi * i / n if n else 0
        cx = ring_radius * math.cos(angle)
        cy = ring_radius * math.sin(angle)
        members = by_community[community_id]
        jitter_radius = 40 + 8 * math.sqrt(len(members))
        for node in members:
            r = jitter_radius * math.sqrt(random.random())
            a = random.uniform(0, 2 * math.pi)
            positions[node["id"]] = (cx + r * math.cos(a), cy + r * math.sin(a))
    return positions


# Injected right before </body> only when rendering WITHOUT cached positions (a fresh
# layout run) -- shows a loading overlay so the physics simulation resolves off-screen
# instead of visibly on it, then captures the settled coordinates exactly once and
# persists them server-side so every subsequent render can skip the simulation entirely.
# `network` is the vis.js Network instance pyvis's own generated script already declares
# as a top-level var; this appends to the same script scope, not a separate one. The
# 20s setTimeout is a fallback only -- stabilizationIterationsDone should fire well before
# that on any graph this tool has seen, but a stuck overlay would be worse than an early
# reveal of a still-settling graph.
STABILIZING_OVERLAY_HTML = """<div id="stabilizing-overlay" style="position:fixed;inset:0;background:#1a1a1a;display:flex;align-items:center;justify-content:center;color:#eeeeee;font-family:sans-serif;font-size:15px;z-index:9999;">Laying out graph&hellip;</div>"""

# pyvis's #mynetwork gets height:100% (see the Network(...) call below), but a percentage
# height only resolves if every ancestor in the chain has a real height too -- html/body
# default to auto, and pyvis's own .card wrapper has none either. overflow:hidden on
# html/body removes the page-level scrollbar entirely (vis-network's own pan-by-drag is
# the only way to navigate a graph bigger than the visible area now, not a second,
# redundant scrollbar on top of it).
FILL_ANCESTOR_HEIGHT_CSS = """<style>html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; } .card { height: 100%; }</style>"""

CAPTURE_SCRIPT_TEMPLATE = """<script>
if (typeof network !== 'undefined' && network) {{
  var hideOverlay = function() {{ var el = document.getElementById('stabilizing-overlay'); if (el) el.style.display = 'none'; }};
  network.once('stabilizationIterationsDone', function() {{
    hideOverlay();
    network.setOptions({{ physics: {{ enabled: false }} }});
    var positions = network.getPositions();
    // keepalive: true is load-bearing, not decorative -- the dashboard's Project tab
    // replaces the whole #main div (destroying this iframe's document) the instant you
    // switch tabs, and a plain fetch() gets cancelled mid-flight when its own document is
    // torn down. Without this, switching away right as stabilization finishes silently
    // drops the capture, so the next view redoes the full layout from scratch. Browsers
    // cap keepalive request bodies (~64KB in Chrome) -- large graphs may still lose the
    // race, but this fixes the common case with no added complexity.
    fetch('/project/positions?path={encoded_path}&grepDirs={encoded_grep_dirs}', {{ method: 'POST', headers: {{ 'Content-Type': 'application/json' }}, body: JSON.stringify(positions), keepalive: true }});
  }});
  setTimeout(hideOverlay, 20000);
}}
</script>"""

# Injected before </body> in BOTH render branches (unlike CAPTURE_SCRIPT_TEMPLATE, which is
# uncached-only) -- dragging should work whether the page loaded fresh or from cache.
# Opt-in via a checkbox: unchecked leaves vis-network's normal single-node drag completely
# untouched; checked snapshots the dragged node's whole community and reapplies its delta
# to every other member on each 'dragging' tick, so the group moves as one visible unit
# instead of vis.js's built-in clusterByGroup() collapse-to-one-node behavior. Physics is
# paused for the duration of the drag so the simulation doesn't fight the manual
# repositioning, then re-enabled and the result persisted via the same
# /project/positions endpoint and keepalive convention CAPTURE_SCRIPT_TEMPLATE already
# uses -- a plain (checkbox-off) single-node drag is NOT persisted, same as today.
COMMUNITY_DRAG_TOGGLE_HTML = """<label style="position:fixed;top:10px;left:10px;z-index:9998;background:#1a1a1a;color:#eeeeee;padding:6px 10px;border-radius:4px;font-family:sans-serif;font-size:13px;display:flex;align-items:center;gap:6px;"><input type="checkbox" id="community-drag-toggle"> Drag entire community</label>"""

COMMUNITY_DRAG_SCRIPT_TEMPLATE = """<script>
if (typeof network !== 'undefined' && network) {{
  var COMMUNITY_GROUPS = {community_groups_json};
  var nodeToCommunity = {{}};
  Object.keys(COMMUNITY_GROUPS).forEach(function(cid) {{
    COMMUNITY_GROUPS[cid].forEach(function(nid) {{ nodeToCommunity[nid] = cid; }});
  }});
  var dragGroup = null;

  network.on('dragStart', function(params) {{
    var toggle = document.getElementById('community-drag-toggle');
    if (!toggle || !toggle.checked || params.nodes.length !== 1) return;
    var draggedId = params.nodes[0];
    var cid = nodeToCommunity[draggedId];
    if (cid === undefined) return;
    var groupIds = COMMUNITY_GROUPS[cid];
    dragGroup = {{ draggedId: draggedId, startPositions: network.getPositions(groupIds) }};
    network.setOptions({{ physics: {{ enabled: false }} }});
  }});

  network.on('dragging', function(params) {{
    if (!dragGroup || params.nodes.length !== 1 || params.nodes[0] !== dragGroup.draggedId) return;
    var start = dragGroup.startPositions;
    var draggedStart = start[dragGroup.draggedId];
    var current = network.getPositions([dragGroup.draggedId])[dragGroup.draggedId];
    var dx = current.x - draggedStart.x;
    var dy = current.y - draggedStart.y;
    Object.keys(start).forEach(function(nid) {{
      if (nid == dragGroup.draggedId) return;
      network.moveNode(nid, start[nid].x + dx, start[nid].y + dy);
    }});
  }});

  network.on('dragEnd', function(params) {{
    if (!dragGroup) return;
    // Only this community's node ids, not network.getPositions() for the WHOLE graph --
    // browsers cap keepalive fetch bodies at ~64KB, and a large graph's full position set
    // can exceed that on its own (271KB measured on a real graph in this project), which
    // silently drops the save with no timing race even needed. The moved community is a
    // small fraction of the graph, so this stays well under any size limit.
    var groupIds = Object.keys(dragGroup.startPositions);
    dragGroup = null;
    network.setOptions({{ physics: {{ enabled: true }} }});
    var positions = network.getPositions(groupIds);
    fetch('/project/positions?path={encoded_path}&grepDirs={encoded_grep_dirs}', {{ method: 'POST', headers: {{ 'Content-Type': 'application/json' }}, body: JSON.stringify(positions), keepalive: true }});
  }});
}}
</script>"""


def render_html(graph_data: dict, coverage_data: dict | None = None, positions: dict | None = None, project_path: str | None = None, grep_dirs: list[str] | None = None) -> str:
    """Reusable core: builds the pyvis network and returns its HTML source as a string --
    the CLI entry point writes this to a file; the dashboard's Project tab serves it
    directly in an iframe, generated fresh from whatever graph is currently cached for the
    browsed project, no separate 'run visualize_graph.py' step required.

    `positions` (node id -> {x, y}, as captured by CAPTURE_SCRIPT_TEMPLATE from a previous
    render) starts every node already at its previously-settled spot instead of scattered
    randomly, so the graph paints looking finished immediately instead of resimulating from
    scratch on every iframe load -- physics stays ON, though, so it's still a live,
    interactive graph (drag a node and its neighbors respond), not a frozen image; nothing
    visibly moves on load since it's already at equilibrium. Without cached `positions`,
    the layout runs for real (seeded by community, not fully random -- see
    _seed_positions_by_community), and the resulting HTML captures its own settled
    positions back to the server so the NEXT render has them."""
    names_by_id = {}
    if coverage_data:
        names_by_id = {c["id"]: c["name"] for c in coverage_data.get("communities", [])}

    # height="100%" (not a fixed px value) -- the iframe embedding this page already sizes
    # itself to fill whatever room is available in the dashboard window, and vis-network's
    # own pan-by-drag already covers moving around a graph bigger than the visible area,
    # so a mismatched fixed height here just meant a second, redundant scrollbar on top of
    # that. Requires FILL_ANCESTOR_HEIGHT_CSS below -- percentage heights only resolve if
    # every ancestor (html, body, the .card wrapper pyvis generates) has a real height too.
    net = Network(height="100%", width="100%", bgcolor="#1a1a1a", font_color="#eeeeee", notebook=False)
    net.barnes_hut(gravity=-3000, spring_length=120)
    # Dynamic edge smoothing gives each edge an invisible support node that takes part in
    # the physics simulation (pyvis's own docs) -- real per-step compute, not just a
    # rendering cost, and disabling it is exactly what those docs recommend once a graph
    # has "a lot of edges." Combined with community-seeded starting positions (below), the
    # simulation both starts closer to converged AND does less work per step to get there.
    net.options.edges.smooth.enabled = False
    # Default is 1000 -- generous for nodes starting at random positions, wasteful now that
    # they start pre-clustered by community. Stabilization still stops early via vis.js's
    # own energy-threshold check; this just caps the worst case.
    net.options.physics.stabilization.iterations = 200

    seed_positions = None if positions else _seed_positions_by_community(graph_data["nodes"])

    for node in graph_data["nodes"]:
        community_id = node["community"]
        color = PALETTE[community_id % len(PALETTE)]
        title = f"{node['source_file']}\nCommunity: {names_by_id.get(community_id, community_id)}"
        pos = positions.get(str(node["id"])) if positions else None
        if pos:
            # physics stays ON here (unlike the first, uncached render) -- these
            # coordinates are already at equilibrium, so leaving physics on doesn't cost a
            # visible resettle, but it does keep the graph interactive: drag a node and its
            # neighbors respond, instead of every node being frozen in place permanently.
            net.add_node(node["id"], label=Path(node["source_file"]).name, title=title, color=color, group=community_id, x=pos["x"], y=pos["y"])
        else:
            seed_x, seed_y = seed_positions[node["id"]]
            net.add_node(node["id"], label=Path(node["source_file"]).name, title=title, color=color, group=community_id, x=seed_x, y=seed_y)

    node_ids = {n["id"] for n in graph_data["nodes"]}
    for link in graph_data["links"]:
        if link["source"] in node_ids and link["target"] in node_ids:
            net.add_edge(link["source"], link["target"])

    html = net.generate_html(notebook=False)
    html = html.replace("</head>", FILL_ANCESTOR_HEIGHT_CSS + "</head>")

    encoded_grep_dirs = quote(",".join(grep_dirs or []), safe="")

    if not positions and project_path:
        script = CAPTURE_SCRIPT_TEMPLATE.format(encoded_path=quote(project_path, safe=""), encoded_grep_dirs=encoded_grep_dirs)
        html = html.replace("</body>", STABILIZING_OVERLAY_HTML + script + "</body>")

    if project_path:
        community_groups = {cid: [n["id"] for n in members] for cid, members in _group_by_community(graph_data["nodes"]).items()}
        drag_script = COMMUNITY_DRAG_SCRIPT_TEMPLATE.format(
            encoded_path=quote(project_path, safe=""),
            encoded_grep_dirs=encoded_grep_dirs,
            community_groups_json=json.dumps(community_groups),
        )
        html = html.replace("</body>", COMMUNITY_DRAG_TOGGLE_HTML + drag_script + "</body>")

    return html


def main():
    cfg = get_config()
    if not cfg["graph_path"].is_file():
        raise SystemExit(f"{cfg['graph_path']} does not exist -- run build_graph.py first.")

    graph_data = json.loads(cfg["graph_path"].read_text(encoding="utf-8"))
    coverage_data = None
    if cfg["coverage_path"].is_file():
        coverage_data = json.loads(cfg["coverage_path"].read_text(encoding="utf-8"))

    html = render_html(graph_data, coverage_data)
    output_path = Path(sys.argv[1]) if len(sys.argv) > 1 else cfg["graph_path"].parent / "graph-visualization.html"
    output_path.write_text(html, encoding="utf-8")
    print(f"Wrote {output_path} -- open it in a browser.")


if __name__ == "__main__":
    main()
