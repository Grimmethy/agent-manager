#!/usr/bin/env python3
"""Static preflight for one file-decompose move.

Given a Python source file and the module-level symbols a `moves[]` entry wants to
relocate verbatim, answer three questions the plan author only *asserts*:

  1. Are all the named symbols actually defined at module scope in this file?
  2. After they are removed, does anything *else* in this file still reference them?
     (a stray call site -> the move breaks the source file)
  3. Do the moved bodies read any *other* module-level name defined in this file that
     is NOT itself being moved? (e.g. `second_brain_dir` -> the new module will need
     `from app import second_brain_dir`, which is the circular-import hazard the wiring
     step has to handle deliberately rather than by a hardcoded placement)

Output: a single JSON object on stdout. Exit 0 whenever the file parsed, regardless of
findings (the caller decides what blocks); exit 2 only if the file could not be read or
parsed, so the caller can fall back to advisory-only.

    decompose-plan-check.py <source.py> <symbol> [<symbol> ...]
"""

import ast
import builtins
import json
import sys

BUILTIN_NAMES = set(dir(builtins))


def main(argv):
    if len(argv) < 3:
        print(json.dumps({"error": "usage: decompose-plan-check.py <source.py> <symbol>..."}))
        return 2
    path, symbols = argv[1], argv[2:]
    try:
        src = open(path, "r", encoding="utf-8").read()
        tree = ast.parse(src, filename=path)
    except (OSError, SyntaxError, ValueError) as exc:
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 2

    wanted = set(symbols)

    # Module-level name -> its top-level node. Covers def / async def / class / simple
    # assignments (`_REPORT_PERIODS = (...)`).
    module_defs = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            module_defs.setdefault(node.name, node)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    module_defs.setdefault(t.id, node)

    defined = [s for s in symbols if s in module_defs]
    missing = [s for s in symbols if s not in module_defs]

    moved_nodes = [module_defs[s] for s in defined]
    moved_lines = set()
    for n in moved_nodes:
        lo = getattr(n, "lineno", None)
        hi = getattr(n, "end_lineno", lo)
        if lo is not None:
            moved_lines.update(range(lo, (hi or lo) + 1))

    # Q2: references to a moved symbol that live OUTSIDE every moved body.
    external_refs = {s: [] for s in defined}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in external_refs:
            if node.lineno not in moved_lines:
                external_refs[node.id].append(node.lineno)
    external_refs = {s: sorted(set(v)) for s, v in external_refs.items() if v}

    # Q3: free names read inside the moved bodies that resolve to a module-level def in
    # this file and are NOT themselves being moved. These become cross-module imports.
    moved_name_set = set(defined)
    local_bound = set()
    read_names = set()
    for n in moved_nodes:
        for sub in ast.walk(n):
            if isinstance(sub, ast.Name):
                if isinstance(sub.ctx, ast.Store):
                    local_bound.add(sub.id)
                else:
                    read_names.add(sub.id)
            elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                local_bound.add(sub.name)
            elif isinstance(sub, (ast.arg,)):
                local_bound.add(sub.arg)

    shared_deps = sorted(
        name for name in read_names
        if name in module_defs
        and name not in moved_name_set
        and name not in local_bound
        and name not in BUILTIN_NAMES
    )

    # Imports the moved bodies rely on, so the wiring/move step can copy the right lines.
    import_targets = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for a in node.names:
                import_targets.add((a.asname or a.name).split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for a in node.names:
                import_targets.add(a.asname or a.name)
    needed_imports = sorted(read_names & import_targets)

    print(json.dumps({
        "defined": defined,
        "missing": missing,
        "externalRefs": external_refs,
        "sharedDeps": shared_deps,
        "neededImports": needed_imports,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
