"""Caller-closed edge-resolution functions extracted from build_graph.py.

Moved verbatim from python/build_graph.py so a later pass can retire the original
and re-point callers here. Importing graph_constants gives this module every
module-level name the functions below reference, keeping it self-contained
without touching build_graph.py.
"""

import os
from pathlib import Path

import networkx as nx

from graph_constants import (
    MATCH_EXTENSIONS,
    EXCLUDE_DIRS,
    IMPORT_RE,
    IMPORT_RE_PY,
    LUA_INCLUDE_RE,
    LUA_STRLIT_RE,
    ZIG_IMPORT_RE,
    TEMPLATE_RE,
    _GENERIC_DIR_NAMES,
    JS_EXTENSIONS,
    PY_EXTENSIONS,
    LUA_EXTENSIONS,
    ZIG_EXTENSIONS,
)


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
_GENERIC_DIR_NAMES = {
    "src", "source", "lib", "app", "core", "common", "utils", "internal", "pkg", ".",
    "scripts", "bin", "tools", "helpers", "test", "tests", "config",
}
