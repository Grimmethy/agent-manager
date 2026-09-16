"""Module-level constants for the code-graph builder.

Extracted verbatim from build_graph.py as a pure leaf module: extension sets,
exclusion dirs, the import/template regexes, and two misc constants.
No functions, no side-effects.
"""

import re

JS_EXTENSIONS = {".js", ".jsx", ".ts", ".tsx"}
PY_EXTENSIONS = {".py"}
LUA_EXTENSIONS = {".lua"}
ZIG_EXTENSIONS = {".zig"}
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

IMPORT_RE_PY = re.compile(
    r"""^\s*import\s+([\w.]+)"""
    r"""|^\s*from\s+(\.*[\w.]*)\s+import\s"""
    , re.MULTILINE,
)

LUA_INCLUDE_RE = re.compile(
    r"""(?:VFS\.Include|dofile|require|VFS\.LoadFile)\s*\(\s*([^\)]*?)\s*[,\)]"""
)
LUA_STRLIT_RE = re.compile(r'"([^"]*\.lua)"')

ZIG_IMPORT_RE = re.compile(r'@import\(\s*"([^"]+)"\s*\)')

TEMPLATE_RE = re.compile(r"""render_template\(\s*f?['"]([^'"]+)['"]""")

_GENERIC_DIR_NAMES = {
    "src", "source", "lib", "app", "core", "common", "utils", "internal", "pkg", ".",
    "scripts", "bin", "tools", "helpers", "test", "tests", "config",
}

GRAPH_BUILD_INTERVAL_SECONDS = 24 * 60 * 60
