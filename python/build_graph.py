#!/usr/bin/env python3
"""Stripped-down, self-contained replacement for the graphify dependency arch_discovery
used to require. Walks the configured source directories, extracts a file-level import/
require graph (JS/TS + Python, see below), runs community detection, and writes graph.json
in the exact {nodes, links} shape task-sources.js's nextArchDiscoveryTask() already
consumes -- no changes needed there.

Usage: python build_graph.py
       python build_graph.py --check-due
       python build_graph.py --target-dir <path> --output <graph.json path> [--no-model-naming]
Without --target-dir, reads the same env vars as the rest of the package
(AGENT_MANAGER_REPO_ROOT, AGENT_MANAGER_GREP_DIRS, AGENT_MANAGER_GRAPH_PATH,
AGENT_MANAGER_COMMUNITY_COVERAGE_PATH, OLLAMA_URL, ORNITH_MODEL) -- no separate config
mechanism. --target-dir/--output let deep_dive (see docs/deep-dive-pipeline.md) point this
at an arbitrary cloned external repo without disturbing this repo's own
graphify-out/graph.json -- grep_dirs is forced to "scan the whole target dir" in that mode
since an external clone has no known frontend/src,backend/src convention. --no-model-naming
skips the Ornith community-naming call entirely (deep_dive's own design deliberately never
spends a model round-trip on naming -- see ADR-0019 -- unlike arch_discovery's default,
which tries Ornith first and falls back to the heuristic below only on failure).

Both the plain `python build_graph.py` and `--check-due` (Grimmethy, 2026-08-19: "This
should be a daily task so that the review steps keep up with the project") now MERGE the
freshly-built coverage into the existing one via merge_coverage() rather than blindly
overwriting it: each community's identity is the sorted set of its member file paths
(community `id`/position is NOT stable across two independent
greedy_modularity_communities() runs, even with no real code change), so a community whose
member files are unchanged keeps its lastReviewedAt/lastCandidateCount, and only a
genuinely new or changed community starts fresh at null/-1. `--check-due` additionally
tracks a last-built timestamp (AGENT_MANAGER_PIPELINE_DIR/instances/.graph-build-schedule.json)
and only rebuilds once GRAPH_BUILD_INTERVAL_SECONDS has elapsed -- wired into
queue-watcher.sh's tick loop so arch_discovery's candidate pool tracks real code changes
daily without a human remembering to click Build.
"""

import argparse
import json
import os
import re
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import networkx as nx
from networkx.algorithms.community import greedy_modularity_communities

JS_EXTENSIONS = {".js", ".jsx", ".ts", ".tsx"}
PY_EXTENSIONS = {".py"}
LUA_EXTENSIONS = {".lua"}
# Zig (2026-08-25, Grimmethy: "If Zig is going to exist in our project we need to be able
# to map it and work with it. We need to be able to pass anything we use through the
# Hygiene Plugin" -- deep_dive onboarded nullclaw/nullboiler, a Zig codebase, and this
# module came back with zero communities: every other language here had a parser, Zig had
# none, so the whole file-walk found nodes but no edges to cluster them by). See
# ZIG_IMPORT_RE/resolve_zig_import below for the resolution rules.
ZIG_EXTENSIONS = {".zig"}
# HTML (2026-08-18, needs-clarification sweep): added specifically so Flask template files
# (python/dashboard/templates/*.html) can appear in the graph at all -- confirmed live that
# this project's own dashboard UI (buttons, columns, worker panels, the graph view, theme
# colors) lives almost entirely in templates/index.html, not in any .py/.js file, and every
# one of a large batch of stuck brain-dump notes about that UI was rationale-blocked with
# some form of "none of the files are frontend/UI components." A .html file never has an
# `import`/`require` OF its own (nothing to scan text/IMPORT_RE for), so this only matters
# together with TEMPLATE_RE below giving it an INCOMING edge from whatever Python file
# renders it -- otherwise it would just be walked, found isolated (zero edges either way),
# and pruned right back out by build_graph_data's isolated-node cleanup, same fate the
# python/dashboard/*.py files had before that fix.
HTML_EXTENSIONS = {".html"}
MATCH_EXTENSIONS = JS_EXTENSIONS | PY_EXTENSIONS | LUA_EXTENSIONS | HTML_EXTENSIONS | ZIG_EXTENSIONS
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

# Best-effort only (see docs/deep-dive-pipeline.md's "Python import support" section) --
# this graph is a reading-order aid for deep_dive, not a correctness-critical artifact, so
# missed dynamic imports / conditional imports / star-imports-from-__init__ re-exports are
# an accepted gap, same tolerance already given to the JS/TS regex above. Two forms only:
# "import a.b.c" and "from a.b.c import x, y" (the "from . import x" / "from .foo import y"
# relative forms are handled by resolve_python_import below via the leading-dot count).
IMPORT_RE_PY = re.compile(
    r"""^\s*import\s+([\w.]+)"""
    r"""|^\s*from\s+(\.*[\w.]*)\s+import\s"""
    , re.MULTILINE,
)

# Beyond-All-Reason/Spring widgets load each other via VFS.Include/dofile/require/
# VFS.LoadFile, not a native `import` statement -- same call-then-string-literal shape
# this repo's own docs/build_dependency_graph.py already parses (see that file for the
# proven pattern this mirrors). LUA_STRLIT_RE is applied to whatever LUA_INCLUDE_RE
# captured as the call's argument, taking the LAST match, so `BASE .. "foo.lua"` still
# resolves via the literal even though BASE itself is a runtime value regex can't see.
LUA_INCLUDE_RE = re.compile(
    r"""(?:VFS\.Include|dofile|require|VFS\.LoadFile)\s*\(\s*([^\)]*?)\s*[,\)]"""
)
LUA_STRLIT_RE = re.compile(r'"([^"]*\.lua)"')

# Zig's @import("...") takes exactly one string literal argument (Zig has no single-quote
# strings and no dynamic import -- the argument is always a compile-time-known literal),
# covering two genuinely different things: a FILE import ('@import("foo.zig")',
# '@import("sub/bar.zig")' -- always ends in .zig, resolved relative to the importing
# file's own directory, no leading "./" required unlike JS) and a MODULE import
# ('@import("std")', '@import("build_options")', or any name declared as a dependency in
# build.zig/build.zig.zon -- never ends in .zig, not a local file at all). See
# resolve_zig_import below for how the two are told apart.
ZIG_IMPORT_RE = re.compile(r'@import\(\s*"([^"]+)"\s*\)')

# Flask's render_template('index.html', ...) is the one real link from a Python file to a
# .html template -- not an `import`, so IMPORT_RE_PY never sees it, but it's the exact
# relationship path-prefetch-resolve needs: without SOME edge into a template file, HTML_
# EXTENSIONS above is pointless (an edge-less template just gets pruned as isolated, same
# as every python/dashboard/*.py file was before that fix). f-string prefix included since
# a dynamic template name built from a fixed literal ('f"{page}.html"') is common enough
# elsewhere in this codebase's own style to be worth not silently missing, though only the
# plain-literal case actually resolves to anything (see resolve_template_import).
TEMPLATE_RE = re.compile(r"""render_template\(\s*f?['"]([^'"]+)['"]""")


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
    tried = [candidate] + [candidate.with_suffix(ext) for ext in JS_EXTENSIONS]
    tried += [candidate / f"index{ext}" for ext in JS_EXTENSIONS]
    for path in tried:
        if path.is_file():
            try:
                return path.resolve()
            except OSError:
                return None
    return None


def resolve_python_import(from_file: Path, spec: str, repo_root: Path) -> Path | None:
    """Best-effort Python resolution (see IMPORT_RE_PY's own comment for what's explicitly
    NOT handled). Two shapes:

    - Relative ('from . import x', 'from .foo import y', 'from ..pkg.sub import z'): walk
      up one directory per leading dot past the current file's own directory, then descend
      into whatever non-dot module path remains.
    - Absolute-looking ('import a.b.c', 'from a.b.c import x'): tried relative to repo_root
      first (the common case for an in-repo package import), matching how a bare JS package
      name is correctly ignored above -- a spec that doesn't resolve to a real file in this
      repo is just an external dependency (stdlib or third-party), not a graph edge.
    """
    if spec.startswith("."):
        dots = len(spec) - len(spec.lstrip("."))
        remainder = spec[dots:]
        base = from_file.parent
        # One dot ('.') means "this package" (from_file's own directory); each additional
        # dot climbs one more level, mirroring Python's own relative-import semantics.
        for _ in range(dots - 1):
            base = base.parent
        parts = remainder.split(".") if remainder else []
        candidate = base.joinpath(*parts) if parts else base
    else:
        parts = spec.split(".")
        candidate = repo_root.joinpath(*parts)

    tried = [candidate.with_suffix(ext) for ext in PY_EXTENSIONS]
    tried += [candidate / "__init__.py"]
    for path in tried:
        if path.is_file():
            try:
                return path.resolve()
            except OSError:
                return None

    # Same-directory sibling import ('from claude_client import X', no leading dot, no
    # repo-root-relative package path either) -- the common shape for this project's own
    # dashboard/*.py scripts, which aren't a real package (no __init__.py) and rely on
    # Python inserting the running script's own directory into sys.path[0] at runtime.
    # Without this fallback every such import resolves against repo_root instead of
    # from_file's own directory, never matches a real file, and silently produces no edge
    # -- which is exactly why python/dashboard/*.py all showed up with degree 0 (no
    # detected import edges at all) and were pruned as "isolated" from graph.json,
    # confirmed live 2026-08-18 while investigating why every brain-dump note about the
    # dashboard was permanently stuck in queue/needs-clarification/ (path-prefetch-resolve
    # reads its entire candidate file universe from graph.json's node list, which had
    # silently contained zero python/dashboard files as a result). Tried only for the
    # non-relative (no leading dot) branch above -- a real leading-dot relative import
    # already resolves correctly via the block above it.
    if not spec.startswith("."):
        same_dir_candidate = from_file.parent.joinpath(*parts)
        same_dir_tried = [same_dir_candidate.with_suffix(ext) for ext in PY_EXTENSIONS]
        same_dir_tried += [same_dir_candidate / "__init__.py"]
        for path in same_dir_tried:
            if path.is_file():
                try:
                    return path.resolve()
                except OSError:
                    return None
    return None


def resolve_template_import(from_file: Path, template_name: str) -> Path | None:
    """Flask's default template_folder is 'templates', a sibling of the app module unless
    the app was constructed with an explicit template_folder= override (not done anywhere
    in this project -- Flask(__name__) is called with no such argument). Only handles a
    template living directly under that folder (the shape this project's own single-page
    dashboard uses); a subdirectory reference ('partials/foo.html') would need the same
    joinpath resolve.py's/JS's own resolvers already do, but no template in this codebase
    currently uses one."""
    candidate = from_file.parent / "templates" / template_name
    return candidate if candidate.is_file() else None


def resolve_lua_import(spec: str, repo_root: Path, file_set: set[Path]) -> Path | None:
    """Lua VFS.Include/require/dofile calls in this ecosystem show up in two shapes: a
    full repo-relative path string ('LuaUI/Widgets/foo/bar.lua') or a bare filename
    concatenated onto a BASE variable at runtime ('BASE .. "bar.lua"') -- regex can only
    ever see the string literal, not BASE's runtime value. Direct repo-relative
    resolution first; a basename-match fallback against the already-walked file set
    handles the concatenated case. Ambiguous if two files in the scanned scope share a
    basename (falls through to None rather than guessing) -- same accepted-gap tolerance
    already given to the JS/Python resolvers above, this graph is a reading-order aid,
    not a correctness-critical artifact."""
    direct = (repo_root / spec).resolve()
    if direct in file_set:
        return direct
    name = Path(spec).name
    matches = [f for f in file_set if f.name == name]
    if len(matches) == 1:
        return matches[0]
    return None


def resolve_zig_import(from_file: Path, spec: str) -> Path | None:
    """A spec ending in '.zig' is always a file import, resolved relative to from_file's
    own directory -- unlike JS, Zig requires NO leading './'/'../' to distinguish a local
    file from a named module ('foo.zig' and './foo.zig' are equally valid and identical in
    meaning); the '.zig' suffix itself is the only signal. Anything else ('std',
    'build_options', or a name declared as a dependency in build.zig/build.zig.zon) is a
    module/package reference with no single local file to point at -- correctly ignored,
    same as a bare JS package name or Python stdlib/third-party import above."""
    if not spec.endswith(".zig"):
        return None
    candidate = (from_file.parent / spec).resolve()
    return candidate if candidate.is_file() else None


def _extract_edges_for_file(f: Path, repo_root: Path, file_set: set, text: str) -> list[str]:
    """Returns the list of relative target paths f imports/requires/includes that also
    exist in file_set (excluding self-edges) -- the actual regex-scan-and-resolve work,
    pulled out of build_import_graph so it can be called only for files that actually
    need it (a cache miss) instead of unconditionally for every file on every build."""
    rel_from = str(f.relative_to(repo_root)).replace("\\", "/")
    is_python = f.suffix in PY_EXTENSIONS
    is_lua = f.suffix in LUA_EXTENSIONS
    is_zig = f.suffix in ZIG_EXTENSIONS
    edges = []

    if is_python:
        for match in IMPORT_RE_PY.finditer(text):
            spec = match.group(1) or match.group(2)
            if not spec:
                continue
            target = resolve_python_import(f, spec, repo_root)
            if target and target in file_set:
                rel_to = str(target.relative_to(repo_root)).replace("\\", "/")
                if rel_to != rel_from:
                    edges.append(rel_to)
        for match in TEMPLATE_RE.finditer(text):
            template_name = match.group(1)
            target = resolve_template_import(f, template_name)
            if target and target in file_set:
                rel_to = str(target.relative_to(repo_root)).replace("\\", "/")
                if rel_to != rel_from:
                    edges.append(rel_to)
    elif is_lua:
        for match in LUA_INCLUDE_RE.finditer(text):
            lit_matches = LUA_STRLIT_RE.findall(match.group(1))
            if not lit_matches:
                continue
            target = resolve_lua_import(lit_matches[-1], repo_root, file_set)
            if target and target in file_set:
                rel_to = str(target.relative_to(repo_root)).replace("\\", "/")
                if rel_to != rel_from:
                    edges.append(rel_to)
    elif is_zig:
        for match in ZIG_IMPORT_RE.finditer(text):
            spec = match.group(1)
            if not spec:
                continue
            target = resolve_zig_import(f, spec)
            if target and target in file_set:
                rel_to = str(target.relative_to(repo_root)).replace("\\", "/")
                if rel_to != rel_from:
                    edges.append(rel_to)
    else:
        for match in IMPORT_RE.finditer(text):
            spec = match.group(1) or match.group(2) or match.group(3)
            if not spec:
                continue
            target = resolve_import(f, spec, repo_root)
            if target and target in file_set:
                rel_to = str(target.relative_to(repo_root)).replace("\\", "/")
                if rel_to != rel_from:
                    edges.append(rel_to)

    return edges


def build_import_graph(repo_root: Path, grep_dirs: list[str], file_cache: dict = None) -> nx.Graph:
    # Resolve up front, matching file_set's own f.resolve() below -- repo_root can be a
    # symlink (e.g. this project's own self-hosted setup: AGENT_MANAGER_REPO_ROOT points
    # at /media/wok/model-cache/agent-manager-apply-target, a symlink to
    # /media/model-cache/github/agent-manager-apply-target). Without this, every f in
    # file_set carries the REAL resolved path while repo_root stays as the symlink path,
    # so f.relative_to(repo_root) raises ValueError ("... is not in the subpath of ...")
    # for every single file -- confirmed live 2026-08-19, dashboard "Build" button.
    repo_root = repo_root.resolve()
    files = walk_source_files(repo_root, grep_dirs)
    file_set = {f.resolve() for f in files}
    graph = nx.Graph()
    for f in file_set:
        rel = str(f.relative_to(repo_root)).replace("\\", "/")
        graph.add_node(rel)

    # 2026-08-24 (Grimmethy, Brain Dump #155: "Every time I build a project graph it
    # starts from scratch. Can we instead build on diff's so that we only have to modify
    # what has actually been changed"): file_cache (mtime+size -> previously-resolved
    # edge list), keyed by the SAME relative path used everywhere else in this module.
    # An unchanged file's edges are reused as-is, skipping the read_text()+regex+resolve
    # work entirely -- only files that are new or whose mtime/size actually changed since
    # the last build get re-parsed. file_set membership can shift between builds too (a
    # file added/removed changes what NEIGHBORS resolve to, even for an untouched file's
    # own text), but that only affects which of a file's already-extracted target paths
    # are still valid nodes -- filtered back in below, not by re-parsing.
    cache_entries = file_cache.setdefault("files", {}) if file_cache is not None else None

    for f in file_set:
        rel_from = str(f.relative_to(repo_root)).replace("\\", "/")
        try:
            stat = f.stat()
        except OSError:
            continue

        cached = cache_entries.get(rel_from) if cache_entries is not None else None
        if cached and cached.get("mtime") == stat.st_mtime and cached.get("size") == stat.st_size:
            edges = cached["edges"]
        else:
            try:
                text = f.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            edges = _extract_edges_for_file(f, repo_root, file_set, text)
            if cache_entries is not None:
                cache_entries[rel_from] = {"mtime": stat.st_mtime, "size": stat.st_size, "edges": edges}

        for rel_to in edges:
            # A cached edge's target might no longer be in the CURRENT file_set (the
            # target file was deleted/moved since this file's own text was last parsed,
            # even though this file's own content didn't change) -- re-check membership
            # rather than trusting the cached edge blindly.
            if graph.has_node(rel_to):
                graph.add_edge(rel_from, rel_to)

    if cache_entries is not None:
        # Drop cache entries for files that no longer exist -- otherwise a deleted file's
        # stale entry lingers in the cache file forever, harmless but unbounded growth.
        live_rels = {str(f.relative_to(repo_root)).replace("\\", "/") for f in file_set}
        for stale_rel in [r for r in cache_entries if r not in live_rels]:
            del cache_entries[stale_rel]

    return graph


# Directory names common enough across unrelated repos (and, per this repo's own
# frontend/src + backend/src layout, common enough WITHIN one repo) that landing on one
# alone as a community name is ambiguous rather than descriptive.
_GENERIC_DIR_NAMES = {"src", "source", "lib", "app", "core", "common", "utils", "internal", "pkg", "."}


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
    if not next_segments:
        return "/".join(common)

    top_segments = [seg for seg, _ in Counter(next_segments).most_common(3)]
    return "/".join(common) + "/{" + ",".join(top_segments) + "}"


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


GRAPH_BUILD_INTERVAL_SECONDS = 24 * 60 * 60


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
