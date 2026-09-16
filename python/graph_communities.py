"""Caller-closed community naming/coverage helpers, moved verbatim from build_graph.py.

These five functions only depend on their arguments plus a handful of module-level
standards-library names (Path, Counter, json, urllib) and the _GENERIC_DIR_NAMES
constant; the sibling graph_constants.py leaf provides the shared constants this
package splits out of build_graph.py. Retiring build_graph.py (the "Create
graph_build.py root" sibling) is what eventually re-points callers here.
"""

from graph_constants import MATCH_EXTENSIONS

from collections import Counter
from pathlib import Path
import json
import urllib.request

from graph_constants import _GENERIC_DIR_NAMES


def _distinguishing_basenames(files: list[str], limit: int = 3) -> list[str]:
    """Most common file stems (basename minus extension) across a community -- the
    fallback disambiguator for a generic directory whose files sit directly in it with
    no shared subdirectory to descend into (e.g. everything flat under "scripts/"), where
    next_segments in name_community_heuristic comes back empty. Directory structure has
    nothing left to say at that point, so the file names themselves are the only
    remaining signal distinguishing this community from another "scripts" community."""
    stems = [Path(f).stem for f in files if Path(f).stem]
    return [stem for stem, _ in Counter(stems).most_common(limit)]


def name_community_heuristic(files: list[str]) -> str:
    """Fallback when the model call fails or times out -- the shared directory prefix is
    a reasonable, cheap stand-in for a real semantic name, EXCEPT when that prefix is
    itself a generic bucket name (e.g. bare "src") that many unrelated communities could
    also share -- there we descend one more level and list the most common subdirectories
    actually distinguishing this cluster's files."""
    parts_lists = [Path(f).parent.parts for f in files]
    if not parts_lists:
        return "Unnamed community"
    common = []
    for parts in zip(*parts_lists):
        if len(set(parts)) == 1:
            common.append(parts[0])
        else:
            break

    if not common:
        return Path(files[0]).parent.name or "root"

    if common[-1].lower() not in _GENERIC_DIR_NAMES:
        return "/".join(common)

    depth = len(common)
    next_segments = [parts[depth] for parts in parts_lists if len(parts) > depth]
    if next_segments:
        top_segments = [seg for seg, _ in Counter(next_segments).most_common(3)]
        return "/".join(common) + "/{" + ",".join(top_segments) + "}"

    # Flat generic directory (e.g. files sitting directly in "scripts/" with no
    # subfolder) -- no subdirectory left to disambiguate with, so name it after the
    # files themselves instead of leaving the bare, duplicate-prone directory name.
    basenames = _distinguishing_basenames(files)
    if not basenames:
        return "/".join(common)
    return "/".join(common) + "/(" + ",".join(basenames) + ")"


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


def _community_member_signature(community_id, graph_nodes):
    """A community's stable identity across two independent builds -- the sorted set of
    its member file paths. `id` itself is just an enumerate() position over communities
    sorted by size (see build_graph_data above), which can shift between two builds even
    when nothing meaningfully changed (a near-size-tie reordering, one new file nudging a
    community's rank) -- matching by id across builds would silently attach the wrong
    community's review history to a different one."""
    return tuple(sorted(n["id"] for n in graph_nodes if n.get("community") == community_id))


def merge_coverage(old_coverage: dict, old_graph_nodes: list, new_coverage: dict, new_graph_nodes: list) -> dict:
    """Carries lastReviewedAt/lastCandidateCount forward from old_coverage into
    new_coverage for every community whose member-file SET is byte-identical across both
    builds -- a real code change that moves even one file into/out of a community starts
    that community's review state fresh (deliberately conservative: a stale
    lastReviewedAt on a community that actually changed would let arch_discovery skip real
    new content, which is worse than reviewing a handful of unchanged files again).
    Communities with no matching old signature (genuinely new or changed) keep
    new_coverage's own fresh lastReviewedAt=None/lastCandidateCount=-1."""
    old_by_signature = {
        _community_member_signature(c["id"], old_graph_nodes): c
        for c in old_coverage.get("communities", [])
    }

    merged = []
    for c in new_coverage.get("communities", []):
        signature = _community_member_signature(c["id"], new_graph_nodes)
        old = old_by_signature.get(signature)
        if old:
            merged.append({
                **c,
                "lastReviewedAt": old.get("lastReviewedAt"),
                "lastCandidateCount": old.get("lastCandidateCount", -1),
            })
        else:
            merged.append(c)
    return {"communities": merged}
